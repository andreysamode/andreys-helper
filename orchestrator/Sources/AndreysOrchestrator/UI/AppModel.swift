// AppModel — the single observable the SwiftUI shell renders (Workstream W2).
//
// It merges the two producers of UI state: the broker (aggregated
// window→worktree→session tree + the non-alert part of the circle state) and the
// daemon (alert queue + pending-jobs strip). The final `CircleState` applies §4
// precedence with the daemon's alert count on top. All mutation happens on the
// main actor; the app hops broker/daemon callbacks to main before calling in.

import Foundation

/// Which of the three §3 stages the shell is currently showing.
public enum Stage: Equatable {
    case collapsed     // state 1: circle only
    case session       // state 2: session pane + circle
    case orchestrator  // state 3: orchestrator + session pane + circle
}

/// Observed on the main thread only; all producers marshal to main before
/// mutating it, so it needs no actor isolation.
public final class AppModel: ObservableObject {
    // Rendered state
    @Published public private(set) var tree = SessionTree()
    /// `internal(set)` rather than private only so `CircleRender` can pose the
    /// circle in a given state without having to fabricate a whole broker tree.
    /// Every real producer still goes through `applyBroker`/`applyAlerts`.
    @Published public internal(set) var circleState = CircleState(category: .idle, count: 0, alertCount: 0)
    @Published public private(set) var pendingJobs: [Job] = []
    @Published public private(set) var alerts: [Alert] = []
    /// Plan usage windows for the header bars; nil until the first probe lands.
    @Published public private(set) var quota: QuotaSnapshot?

    // Presentation control
    @Published public private(set) var hovering = false
    /// True while the user is dragging the circle to reposition it. The panes
    /// collapse for the duration so the movable window is just the small circle
    /// box — otherwise a tall open pane pins the window against the screen edge
    /// and traps the circle in a lower corner (it can't be dragged back up).
    @Published public var dragging = false
    /// Pending collapse (hover-out) work, so the pane doesn't flap while the
    /// pointer crosses the 8pt gap between the circle and a pane — geometrically
    /// "outside" for a moment. Cancelled if the pointer re-enters.
    private var collapseWork: DispatchWorkItem?
    /// User-chosen base stage (collapsed/session/orchestrator).
    @Published public var baseStage: Stage = .collapsed
    /// W5 contract: while any orchestrator tab runs, state 3 stays open.
    @Published public var hasRunningOrchestrator = false
    /// Whether the alert bubble is showing (click-to-ack surface).
    @Published public var showAlertBubble = false
    /// Moon mode: the circle is a cartoon moon and the working indicator is
    /// stars on its rim. Mirrors `moonMode` in `~/.andreys-helper/config.json`,
    /// which the extension writes from `andreysHelper.orchestrator.moonMode`;
    /// `ConfigWatcher` keeps this in step while the app runs.
    @Published public var moonMode = false
    /// Moon mode only: the moon has been clicked and is showing at ten times its
    /// parked size. Click again to put it back. Purely a display state — it
    /// changes nothing about what the circle reports.
    @Published public private(set) var moonZoomed = false

    // Corner-aware unfolding (PLAN §3): the panel controller sets these from the
    // circle's on-screen position so panes grow toward whichever side has room.
    /// Panes unfold to the LEFT (circle sits on the right). False → unfold right.
    @Published public var panesLeft = true
    /// Height the session pane needs to show its whole list without scrolling —
    /// its unscrollable chrome plus the list's natural height, reported by
    /// `SessionPaneView` once laid out (nil before that). `PanelController` grows
    /// the panes to it for as long as the circle's display has the room; past
    /// that the list scrolls as before.
    @Published public var desiredPaneHeight: CGFloat?
    /// Content grows DOWNWARD (circle at the top). False → grows up (circle bottom).
    @Published public var contentDown = true

    // Intents (wired by the app; stubbed in fixtures)
    public var revealIntent: (SessionInfo) -> Void = { _ in }
    public var ackAlertIntent: (String) -> Void = { _ in }
    /// Open the onboarding/settings window (wired by the app).
    public var openSettingsIntent: () -> Void = {}
    /// Quit the app (wired by the app; `NSApp.terminate` under AppKit).
    public var quitIntent: () -> Void = {}
    /// Ask for a fresh usage probe if the current snapshot is stale (wired by the
    /// app to `QuotaMonitor`; the monitor decides whether it's worth spawning).
    public var refreshQuotaIntent: () -> Void = {}

    /// The embedded orchestrator host (W5). Owns the tabbed `claude` PTYs and
    /// drives `hasRunningOrchestrator` so state-3 stays open while any tab runs.
    let orchestrator = Orchestrator()

    private var rawWindows: [RegisteredWindow] = []
    /// The broker's tree before the optimistic-reveal overlay. `tree` is this
    /// with `pendingReveal` applied, so the overlay can be dropped at any time by
    /// republishing this.
    private var rawTree = SessionTree()

    /// A click-to-reveal the broker hasn't confirmed yet (see `reveal`).
    private struct PendingReveal {
        /// `SessionInfo.id` (`sessionId ?? tabId`) of the clicked session.
        let sessionKey: String
        /// The window that owns it — the one being brought forward.
        let windowId: WindowId
        /// Which window was upfront when the click happened. Lets us tell "the
        /// raise is still in flight" from "the user went somewhere else".
        let originWindowId: WindowId?
    }
    private var pendingReveal: PendingReveal?
    private var pendingRevealTimeout: DispatchWorkItem?
    /// Ceiling on the optimistic highlight. Comfortably past the broker's 3s
    /// `whenFocused` timeout, so a reveal that never lands reverts to broker
    /// truth instead of pinning the accent to a tab that was never focused.
    /// A `var` only so the self-test can shorten the wait.
    var revealTimeout: TimeInterval = 5

    public init() {
        orchestrator.onRunningChanged = { [weak self] running in
            self?.hasRunningOrchestrator = running
        }
    }

    /// Effective stage after applying hover and the keep-open-if-running rule.
    ///
    /// State 2 is HOVER-DRIVEN, full stop (PLAN.md §3: "hover the circle →
    /// session pane slides out"). There used to be a `pinned` flag a click on the
    /// circle toggled, and it is what actually wedged the pane open in practice:
    /// invisible (nothing on screen says "pinned"), trivially set by a stray
    /// click on the way to a session row, and immune to moving the pointer away —
    /// which reads as "the hover pane won't close" and is indistinguishable from
    /// a hover bug. Only state 3 latches, and it announces itself by being a
    /// whole terminal pane.
    public var stage: Stage {
        // While dragging, collapse to the circle so the window moves freely.
        if dragging { return .collapsed }
        // The zoomed moon owns the window: the panes would have to unfold off a
        // 450pt disc that is already most of the screen, and the pointer is
        // inside the circle's own hover region the whole time it is up.
        if moonZoomed { return .collapsed }
        if baseStage == .orchestrator || hasRunningOrchestrator { return .orchestrator }
        if baseStage == .session || hovering { return .session }
        return .collapsed
    }

    // MARK: Producers

    /// From the broker: new tree + raw windows. Recomputes the circle.
    public func applyBroker(tree: SessionTree, windows: [RegisteredWindow]) {
        self.rawTree = tree
        self.rawWindows = windows
        resolvePendingReveal()
        self.tree = overlayPendingReveal(on: rawTree)
        recomputeCircle()
    }

    /// From the daemon: the current alert queue. Recomputes the circle and
    /// surfaces the click-to-ack bubble when a new alert arrives (PLAN.md §4:
    /// "fired alerts → circle `!` + bubble").
    public func applyAlerts(_ alerts: [Alert]) {
        let grew = alerts.count > self.alerts.count
        self.alerts = alerts
        if alerts.isEmpty {
            showAlertBubble = false
        } else if grew {
            showAlertBubble = true
        }
        recomputeCircle()
    }

    /// From the daemon: the pending-jobs strip.
    public func applyPending(_ jobs: [Job]) {
        self.pendingJobs = jobs
    }

    /// From the quota monitor: the header's usage windows.
    public func applyQuota(_ snapshot: QuotaSnapshot) {
        self.quota = snapshot
    }

    private func recomputeCircle() {
        circleState = Aggregator.aggregate(windows: rawWindows, alertCount: alerts.count)
    }

    // MARK: Interactions

    /// Hover enter/exit, sampled from the pointer's position by `PanelController`
    /// (never from an AppKit/SwiftUI tracking area — see "Pointer-truth hover"
    /// there). Enter is immediate; exit is debounced, which bridges the 8pt gaps
    /// between the circle and the panes as the pointer crosses them.
    public func setHover(_ inside: Bool) {
        collapseWork?.cancel()
        collapseWork = nil
        if inside {
            hovering = true
            // The pane (and its usage bars) is about to be on screen — top the
            // numbers up if they've gone stale since the last look.
            refreshQuotaIntent()
        } else {
            let work = DispatchWorkItem { [weak self] in self?.hovering = false }
            collapseWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: work)
        }
    }

    public func toggleAlertBubble() { showAlertBubble.toggle() }

    /// Click-to-zoom the moon. The alert bubble is dismissed on the way in — it
    /// is anchored beside a 45pt disc and has nowhere to sit beside a 450pt one;
    /// the "!" itself stays on the moon, and unzooming brings the bubble back
    /// within a click.
    public func toggleMoonZoom() {
        moonZoomed.toggle()
        if moonZoomed { showAlertBubble = false }
    }

    /// Leave the zoomed moon, if it is up. Called when moon mode itself is
    /// switched off, so the panel can't be left holding a 450pt frosted disc.
    public func exitMoonZoom() {
        if moonZoomed { moonZoomed = false }
    }

    public func ackAlert(_ id: String) {
        ackAlertIntent(id)
        if alerts.count <= 1 { showAlertBubble = false }
    }

    /// Click-to-reveal from the session pane.
    ///
    /// The highlight moves to the clicked box IMMEDIATELY, before the broker
    /// knows anything about it. Without that, revealing a session in a background
    /// window visibly selects the wrong row first: the reveal is two ordered
    /// steps (raise the editor window, then switch its tab — see `App.swift`), so
    /// for the ~1.3s the raise takes, the target window is already upfront while
    /// its OLD tab is still the active one — and `active && isUpfront` is exactly
    /// the pane's full-accent state. The user sees a box they didn't click light
    /// up, then the one they did.
    ///
    /// So the pane renders the intent, not the intermediate truth: the clicked
    /// box takes the accent now and every other window drops out of `isUpfront`
    /// at the same moment (exactly one full-accent box throughout). Broker
    /// snapshots keep flowing into `rawTree` underneath; the overlay is dropped
    /// the instant the broker agrees, or `revealTimeout` later if the reveal
    /// never lands.
    public func reveal(_ session: SessionInfo) {
        beginPendingReveal(session)
        revealIntent(session)
    }

    private func beginPendingReveal(_ session: SessionInfo) {
        let key = session.id
        guard let window = rawTree.windows.first(where: { w in
            w.worktrees.contains { $0.sessions.contains { $0.id == key } }
        }) else { return }

        pendingRevealTimeout?.cancel()
        pendingReveal = PendingReveal(
            sessionKey: key,
            windowId: window.windowId,
            originWindowId: rawTree.windows.first(where: { $0.isUpfront })?.windowId)
        tree = overlayPendingReveal(on: rawTree)

        let work = DispatchWorkItem { [weak self] in self?.clearPendingReveal() }
        pendingRevealTimeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + revealTimeout, execute: work)
    }

    /// Drop the overlay once it has served its purpose (called on every broker
    /// snapshot, before the overlay is re-applied).
    private func resolvePendingReveal() {
        guard let pending = pendingReveal else { return }
        guard let window = rawTree.windows.first(where: { $0.windowId == pending.windowId }),
            let session = window.worktrees
                .flatMap({ $0.sessions }).first(where: { $0.id == pending.sessionKey })
        else {
            // Window or tab is gone — nothing left to hold the accent on.
            clearPendingReveal()
            return
        }
        // The broker now reports what we optimistically drew: done.
        if session.active && window.isUpfront {
            clearPendingReveal()
            return
        }
        // Some third window came upfront: the user moved on themselves rather
        // than the raise still being in flight. Stop overriding them.
        if let upfront = rawTree.windows.first(where: { $0.isUpfront })?.windowId,
            upfront != pending.windowId, upfront != pending.originWindowId {
            clearPendingReveal()
        }
    }

    private func clearPendingReveal() {
        pendingRevealTimeout?.cancel()
        pendingRevealTimeout = nil
        guard pendingReveal != nil else { return }
        pendingReveal = nil
        tree = rawTree
    }

    /// Apply the pending reveal to a broker tree: the clicked session is the
    /// active tab of the one upfront window. Only the target window's own
    /// sessions are touched — a background window's active tab keeps `active`
    /// (state 2, terracotta outline) and simply loses `isUpfront`.
    private func overlayPendingReveal(on raw: SessionTree) -> SessionTree {
        guard let pending = pendingReveal else { return raw }
        var out = raw
        for w in out.windows.indices {
            let isTarget = out.windows[w].windowId == pending.windowId
            out.windows[w].isUpfront = isTarget
            guard isTarget else { continue }
            for t in out.windows[w].worktrees.indices {
                for s in out.windows[w].worktrees[t].sessions.indices {
                    // At most one panel per window is `active` (it mirrors
                    // Claude's `panelTab.active`), so the clicked one taking it
                    // means every sibling gives it up.
                    let session = out.windows[w].worktrees[t].sessions[s]
                    out.windows[w].worktrees[t].sessions[s].active =
                        session.id == pending.sessionKey
                }
            }
        }
        return out
    }

    public func openSettings() { openSettingsIntent() }
    public func quit() { quitIntent() }

    public func collapse() { baseStage = .collapsed }
    public func openSession() { baseStage = .session }
    public func openOrchestrator() { baseStage = .orchestrator }
    /// Back to hover-driven: the pointer is on the pane when the orchestrator is
    /// dismissed, so state 2 stays up until the pointer leaves. Parking
    /// `baseStage` on `.session` instead would latch the pane open for good.
    public func closeOrchestrator() { baseStage = .collapsed }
}
