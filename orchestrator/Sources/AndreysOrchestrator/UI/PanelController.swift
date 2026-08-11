// PanelController — hosts `RootView` in the borderless always-on-top
// non-activating NSPanel and keeps the window anchored to the circle in the
// top-right, resizing as panes expand LEFTWARD (PLAN.md §3). Position is
// persisted per-screen to config for multi-monitor recall.

import AppKit
import SwiftUI
import Combine

/// A borderless, non-activating panel that takes the keyboard ONLY while the
/// embedded orchestrator terminal is on screen.
///
/// This gate is load-bearing, not a style choice. A `.nonactivatingPanel` that
/// is key receives keyboard input *without its app being frontmost* — that is
/// the whole point of the style mask. Measured: with another app frontmost and
/// typing into it, the moment this panel became key every keystroke was
/// delivered here instead, while the other app kept showing its caret. That is
/// exactly the "the right tab is focused but I can't type" report: a hover HUD
/// that is key silently swallows the editor's keystrokes (and ⌘Q with them).
///
/// So the panel is key-capable only when something in it genuinely wants
/// keyboard input, i.e. the orchestrator's terminal. In every other stage
/// `canBecomeKey` is false, which also makes a stray `makeKey()` a harmless
/// no-op rather than a keyboard hijack.
final class CirclePanel: NSPanel {
    /// True only while the orchestrator pane (terminal) is showing. Turning it
    /// off while the panel happens to be key hands the keyboard straight back.
    var wantsKeyboard = false {
        didSet {
            guard oldValue, !wantsKeyboard, isKeyWindow else { return }
            // No public "give up key" exists for a window whose app the system
            // does not treat as frontmost. `resignKey()` carries a "never invoke
            // directly" note, but it is what actually works here: measured, it
            // clears both `isKeyWindow` and `NSApp.keyWindow`, so the frontmost
            // app receives the next keystroke. Ordering the window out and back
            // in clears it too, but flickers the pane and disturbs the hover
            // tracking that keeps it open.
            resignKey()
        }
    }
    override var canBecomeKey: Bool { wantsKeyboard }
    override var canBecomeMain: Bool { wantsKeyboard }
}

/// Hosting view that accepts the FIRST mouse click. Without this, a click on the
/// non-activating panel while it isn't key is consumed just making it key — so a
/// session box needed two clicks. Returning true delivers that first click
/// straight to the SwiftUI button, so one click reveals the session.
private final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class PanelController: NSObject, NSWindowDelegate {
    let panel: CirclePanel
    private let model: AppModel
    private var cancellables = Set<AnyCancellable>()

    // Layout constants (mirror the SwiftUI views).
    private let pad: CGFloat = 8
    private let spacing: CGFloat = 8
    private let circleW: CGFloat = 45 // mirrors CircleView.size
    private let bubbleW: CGFloat = 240
    private let bubbleH: CGFloat = 180
    /// Height of an unexpanded pane — also the floor, since the panes only ever
    /// grow past it.
    private static let defaultPaneH: CGFloat = 560

    /// Height of the panes. The default, grown to whatever the session pane needs
    /// to show its whole list (`model.desiredPaneHeight`) but never past what the
    /// circle's display can give it; beyond that the list scrolls, as it always
    /// has. Both panes share it, so state 3 stays a single rectangle.
    private var paneH: CGFloat {
        let wanted = max(model.desiredPaneHeight ?? 0, Self.defaultPaneH)
        return min(wanted, max(maxPaneH(), Self.defaultPaneH))
    }

    /// The tallest pane the circle's display can show WITHOUT displacing the
    /// circle — the invariant `originFor` keeps and the reason the panes grow
    /// away from it. Room is measured on both sides because `decideExpansion`
    /// unfolds toward the roomier one; matching its arithmetic exactly (`needY`
    /// against the room beyond the circle box) means a pane grown to this cap
    /// still satisfies the same test, so the on-screen clamp stays a no-op and
    /// the circle keeps its parked spot.
    private func maxPaneH() -> CGFloat {
        let pf = parkFrame(for: circleCenter)
        guard pf != .zero else { return Self.defaultPaneH }
        let r = circleBox / 2
        let down = circleCenter.y + r - pf.minY - 2 * pad
        let up = pf.maxY - circleCenter.y + r - 2 * pad
        return max(down, up)
    }

    /// The circle's fixed CENTER in screen coords — the invariant the window
    /// keeps as it resizes; the panes unfold away from it. Updated on user drag.
    private var circleCenter: NSPoint = .zero
    private var circleBox: CGFloat { circleW + 2 * pad }

    init(model: AppModel) {
        self.model = model
        self.panel = CirclePanel(
            contentRect: NSRect(x: 0, y: 0, width: circleW + 2 * pad, height: circleW + 2 * pad),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        super.init()

        panel.isFloatingPanel = true
        // Above every strip the system reserves, not `.floating` (3). The circle
        // parks flush to all four screen edges (PanelPlacement.ParkRegion), and
        // both the bottom and top edges are occupied: the Dock (level 20) and the
        // menu bar (24) with its status items (25). At `.floating` a circle parked
        // on either would sit *behind* that furniture — and an auto-hidden Dock is
        // summoned by the very flick-to-the-corner gesture parking there is for, so
        // the circle would vanish exactly when reached for. One step above status
        // items clears all of it while staying far below pop-up menus (101), so an
        // open menu still draws over the circle rather than under it.
        //
        // Assigned AFTER `isFloatingPanel`, which is not just a flag: setting it
        // true writes `.floating` into `level`. Measured with the order reversed —
        // `CGWindowListCopyWindowInfo` reported the panel back at layer 3.
        panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.statusWindow)) + 1)
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        // Drag-to-move is handled by our own circle-only drag (see the drag
        // monitor below), NOT window-background dragging: dragging the whole
        // (possibly tall) window pinned it against a screen edge and trapped the
        // circle in a lower corner. Our drag collapses the pane and moves a small
        // window in screen coordinates, so the circle can reach any corner.
        panel.isMovableByWindowBackground = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.delegate = self
        // Pinned to the light appearance, the way samodeus-mac resolves every
        // frosted surface from its OWN theme rather than the system's. The whole
        // palette here is warm-light (cream/white box fills, white rims) and
        // `FrostedBackground` pins its vibrancy to `.aqua`, so letting `.primary`
        // /`.secondary` text follow macOS dark mode would put white labels on a
        // light frost. One appearance for the panel keeps frost, fills, and text
        // in the same world.
        panel.appearance = NSAppearance(named: .aqua)

        let host = FirstMouseHostingView(rootView: RootView(model: model))
        host.frame = panel.contentView!.bounds
        host.autoresizingMask = [.width, .height]
        panel.contentView = host

        placeInitial()

        // Re-layout the window frame whenever presentation-affecting state changes.
        model.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] in self?.relayout() }
            .store(in: &cancellables)

        installDragMonitor()
        installHoverTracking()

        // Off the launch path, so the circle appears immediately.
        DispatchQueue.main.async { [weak self] in self?.prewarmSessionPane() }
    }

    /// Build the session pane's SwiftUI tree once, at launch, in a hosting view
    /// that is never shown.
    ///
    /// The pane is created from scratch on every hover and torn down on every
    /// exit (`stage` gates it in `RootView`), and the FIRST build is by far the
    /// most expensive: measured, the first hover spent ~40ms inside
    /// `panel.setFrame` versus ~10ms for every hover after it. That is two extra
    /// frames of the panel sitting at its new size while its contents are still
    /// being assembled — precisely the window in which a stale backdrop is on
    /// screen. Paying it up front makes the first hover behave like the tenth.
    ///
    /// Deliberately only the session pane. The orchestrator pane's `onAppear`
    /// calls `ensureStarted()`, which spawns a real `claude`; pre-warming that
    /// would launch a process nobody asked for.
    private func prewarmSessionPane() {
        let host = NSHostingView(rootView: SessionPaneView(model: model))
        host.frame = NSRect(x: 0, y: 0, width: SessionPaneView.width, height: paneH)
        host.layoutSubtreeIfNeeded()
        // Intentionally not retained: the pane's countdown strip publishes a 1s
        // timer, and the warm caches we want (SwiftUI's view graph for these
        // types, resolved fonts, glyph rasterization) live in process-wide
        // caches that outlive this view.
    }

    deinit {
        if let m = dragMonitor { NSEvent.removeMonitor(m) }
        hoverMonitors.forEach(NSEvent.removeMonitor)
        hoverTimer?.invalidate()
    }

    func show() {
        // Ordered front, never made key: a background HUD must not hold the
        // keyboard (see `CirclePanel`). The orchestrator terminal takes it by
        // being clicked, once `wantsKeyboard` allows it.
        panel.orderFront(nil)
    }

    // MARK: Layout

    private func contentSize() -> NSSize {
        // The zoomed moon takes the window over: a plain square big enough for
        // the disc AND the star tips that break past its rim. Nothing else is on
        // screen (`AppModel.stage` collapses while zoomed), so none of the pane
        // arithmetic below applies.
        if model.moonZoomed {
            let side = CircleView.box(for: CircleView.zoomedSize) + 2 * pad
            return NSSize(width: side, height: side)
        }

        var w = model.showAlertBubble ? bubbleW : circleW
        var h: CGFloat
        switch model.stage {
        case .collapsed:
            h = circleW + (model.showAlertBubble ? spacing + bubbleH : 0)
        case .session:
            w += spacing + SessionPaneView.width
            h = paneH
        case .orchestrator:
            w += spacing + SessionPaneView.width + spacing + OrchestratorPaneView.width
            h = paneH
        }
        // Rounded UP to whole points, like `originFor` rounds the origin — see the
        // note there. Growing rather than shrinking, so a pane never loses the
        // fraction of a point it asked for (`paneH` can land on a half via
        // `maxPaneH`, whose arithmetic carries the same half-integral `r`).
        return NSSize(width: (w + 2 * pad).rounded(.up), height: (h + 2 * pad).rounded(.up))
    }

    /// Largest expanded window (orchestrator stage) — used to pick a side with
    /// enough room so opening the orchestrator later won't overflow the screen.
    private func maxContentSize() -> NSSize {
        let w = circleW + spacing + SessionPaneView.width + spacing + OrchestratorPaneView.width
        return NSSize(width: w + 2 * pad, height: paneH + 2 * pad)
    }

    /// Park region of the screen the circle currently sits on — the whole display,
    /// Dock strip and menu bar included, minus the notch. Robust to the panel not
    /// yet being placed: resolves by the point, not `panel.screen`.
    private func parkRegion(for point: CGPoint) -> PanelPlacement.ParkRegion {
        guard let s = screen(for: point) else { return .init(bounds: .zero) }
        return .init(bounds: s.frame, notch: Self.notch(of: s))
    }

    /// Just the bounds of `parkRegion(for:)` — for the callers that lay out the
    /// window box, which the notch does not constrain (only the disc must dodge it;
    /// the panes may pass behind it like any other window).
    private func parkFrame(for point: CGPoint) -> CGRect {
        parkRegion(for: point).bounds
    }

    /// The camera-housing cutout, for displays whose menu bar is split around one.
    private static func notch(of screen: NSScreen) -> CGRect? {
        PanelPlacement.notch(
            auxTopLeft: screen.auxiliaryTopLeftArea, auxTopRight: screen.auxiliaryTopRightArea)
    }

    /// The screen `point` belongs to, falling back to the NEAREST screen rather
    /// than the main one. A drag that pushes the circle against an edge routinely
    /// asks about a point just outside every screen frame (the pointer overshoots,
    /// the clamp is what pulls it back), and answering "main screen" for those
    /// would yank a circle parked at the edge of a secondary display onto the
    /// primary one mid-drag.
    private func screen(for point: CGPoint) -> NSScreen? {
        if let hit = NSScreen.screens.first(where: { NSMouseInRect(point, $0.frame, false) }) {
            return hit
        }
        return NSScreen.screens.min(by: {
            Self.distanceSquared(from: point, to: $0.frame)
                < Self.distanceSquared(from: point, to: $1.frame)
        }) ?? NSScreen.main
    }

    /// Squared distance from a point to the nearest point of a rect (0 if inside).
    private static func distanceSquared(from p: CGPoint, to r: CGRect) -> CGFloat {
        let dx = max(r.minX - p.x, 0, p.x - r.maxX)
        let dy = max(r.minY - p.y, 0, p.y - r.maxY)
        return dx * dx + dy * dy
    }

    /// Re-decide unfold directions from the circle's position; push to the model
    /// so `RootView` arranges the panes on the correct side.
    private func updateDirections() {
        let vf = parkFrame(for: circleCenter)
        guard vf != .zero else { return }
        let d = PanelPlacement.decideExpansion(
            circleCenter: circleCenter, maxContent: maxContentSize(), circleBox: circleBox, in: vf)
        if model.panesLeft != d.panesLeft { model.panesLeft = d.panesLeft }
        if model.contentDown != d.contentDown { model.contentDown = d.contentDown }
    }

    /// Window origin that keeps the circle centered on `circleCenter` while the
    /// window grows away from it per the chosen directions; clamped on-screen.
    ///
    /// The clamp is against the park region OUTSET by `pad`, not the region
    /// itself. The window box carries `pad` of transparent shadow margin on every
    /// side, so a circle parked flush to an edge legitimately puts that margin
    /// past the edge — clamping the box there would slide the window (and the disc
    /// with it) `pad` back inside, which is what used to leave a gap in the corner
    /// no drag could close. The outset lets the invisible margin hang over while
    /// still keeping every visible pixel — disc and panes alike — on the display.
    private func originFor(size: NSSize) -> NSPoint {
        // Zoomed, the window is CENTRED on the parked circle rather than pinned
        // by one edge to it — a disc that grew ten times in place would push
        // most of itself off whichever edge it is parked against. `circleCenter`
        // is left untouched, so unzooming drops the circle back on its own spot
        // however far the clamp below had to slide the big window.
        if model.moonZoomed {
            var x = circleCenter.x - size.width / 2
            var y = circleCenter.y - size.height / 2
            let pf = parkFrame(for: circleCenter)
            if pf != .zero {
                let b = PanelPlacement.windowBounds(parkFrame: pf, pad: pad)
                x = min(max(x, b.minX), max(b.minX, b.maxX - size.width))
                y = min(max(y, b.minY), max(b.minY, b.maxY - size.height))
            }
            return NSPoint(x: x.rounded(), y: y.rounded())
        }

        let r = circleBox / 2
        var x = model.panesLeft ? (circleCenter.x + r - size.width) : (circleCenter.x - r)
        var y = model.contentDown ? (circleCenter.y + r - size.height) : (circleCenter.y - r)
        let pf = parkFrame(for: circleCenter)
        if pf != .zero {
            let b = PanelPlacement.windowBounds(parkFrame: pf, pad: pad)
            if x < b.minX { x = b.minX }
            if x + size.width > b.maxX { x = b.maxX - size.width }
            if y < b.minY { y = b.minY }
            if y + size.height > b.maxY { y = b.maxY - size.height }
        }
        // Snapped to whole points, because a half-point origin is not a rect the
        // window server will hold still at. `circleBox` is odd (45 + 2×8 = 61), so
        // `r` is 30.5 and EVERY origin derived from it lands on a half — and a
        // half-point rect gets committed at one integer and then re-resolved at the
        // other once the new surface lands. Measured on a hover: the panel opened at
        // x = 944, corrected itself to 945 180ms later, and did the same in reverse
        // on close, so the circle sat one pixel left for a beat on every resize and
        // then jumped back. Only `x` showed it — a circle parked flush to the top
        // edge has its `y` overwritten by the clamp above with an integral value,
        // which is exactly the accident that hid the same defect vertically.
        //
        // Rounding preserves the pinning invariant exactly rather than approximately:
        // the circle's anchored edge is `x + size.width` = `circleCenter.x + r`,
        // which does not depend on the width at all, and `size` arrives here already
        // rounded to whole points — so every stage rounds the SAME fraction and the
        // disc lands on the identical pixel whether the panes are open or shut.
        return NSPoint(x: x.rounded(), y: y.rounded())
    }

    private func relayout() {
        // Only the orchestrator stage hosts something that wants typing.
        panel.wantsKeyboard = model.stage == .orchestrator
        let size = contentSize()
        let frame = NSRect(origin: originFor(size: size), size: size)
        guard panel.frame != frame else {
            geometryDeferred = false
            return
        }
        // A resize the window server will not honor is WORSE than no resize: it
        // leaves the drawn surface and the on-screen rect disagreeing, and it is
        // the surface that gets scaled to fit (see `windowServerHonorsGeometry`).
        // Hold the current frame and re-apply once geometry is live again.
        guard windowServerHonorsGeometry() else {
            geometryDeferred = true
            return
        }
        geometryDeferred = false
        handOffFrame(frame)
    }

    /// Give the window server a new frame, remembering when — its own commit lags
    /// ours by a runloop pass, and that lag must not read as a freeze.
    private func handOffFrame(_ frame: NSRect) {
        lastFrameHandOff = Date()
        frameCommitPending = true
        // Cleared on the next runloop turn, i.e. once the window server has had a
        // chance to take the change. In a headless self-test the runloop never
        // spins, so this stays true and the freeze check stays out of the way.
        DispatchQueue.main.async { [weak self] in self?.frameCommitPending = false }
        panel.setFrame(frame, display: true, animate: false)
    }

    private func placeInitial() {
        let config = Bootstrap.loadConfig().circle
        let screens = Self.screenDescs()
        let mainIndex = NSScreen.main.flatMap { m in
            NSScreen.screens.firstIndex(where: { $0 === m })
        }
        circleCenter = PanelPlacement.resolveCircleCenter(
            config: config, discBox: circleW, screens: screens, mainIndex: mainIndex)
        updateDirections()
        let size = contentSize()
        handOffFrame(NSRect(origin: originFor(size: size), size: size))
    }

    /// Snapshot the attached screens as pure `ScreenDesc`s for `PanelPlacement`.
    private static func screenDescs() -> [ScreenDesc] {
        NSScreen.screens.map { screen in
            ScreenDesc(
                displayID: Self.displayID(of: screen),
                name: screen.localizedName,
                frame: screen.frame,
                visibleFrame: screen.visibleFrame,
                notch: Self.notch(of: screen))
        }
    }

    private static func displayID(of screen: NSScreen) -> Int? {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        return (screen.deviceDescription[key] as? NSNumber)?.intValue
    }

    // MARK: Pointer-truth hover (the pane MUST close when the cursor leaves)

    /// Last value handed to the model, so the sampler only reports transitions.
    private var lastHoverInside: Bool?
    private var hoverTimer: Timer?
    private var hoverMonitors: [Any] = []

    /// Screen rects whose union counts as "the pointer is on the shell": the
    /// circle, its alert bubble, and whichever panes are on screen. Mirrors the
    /// arrangement `RootView` draws from the same constants.
    ///
    /// Deliberately not the whole window: with a pane open, the window's bounding
    /// box also spans the empty column beside/below the circle, which reads as
    /// outside to the eye and must not hold the pane open.
    private func hoverRects() -> [NSRect] {
        let c = panel.frame.insetBy(dx: pad, dy: pad)
        let columnW = model.showAlertBubble ? bubbleW : circleW
        let columnX = model.panesLeft ? c.maxX - columnW : c.minX
        let circleX = model.panesLeft ? c.maxX - circleW : c.minX
        let circleY = model.contentDown ? c.maxY - circleW : c.minY
        var rects = [NSRect(x: circleX, y: circleY, width: circleW, height: circleW)]

        if model.showAlertBubble {
            // The bubble hangs on the far side of the circle from the content.
            let bubbleY = model.contentDown
                ? circleY - spacing - bubbleH
                : circleY + circleW + spacing
            rects.append(NSRect(x: columnX, y: bubbleY, width: bubbleW, height: bubbleH))
        }

        // The panes always span the full content height in the stages that show
        // them, so they inherit the content box's vertical extent.
        guard model.stage != .collapsed else { return rects }
        let sessionX = model.panesLeft
            ? columnX - spacing - SessionPaneView.width
            : columnX + columnW + spacing
        rects.append(
            NSRect(x: sessionX, y: c.minY, width: SessionPaneView.width, height: c.height))

        guard model.stage == .orchestrator else { return rects }
        let orchX = model.panesLeft
            ? sessionX - spacing - OrchestratorPaneView.width
            : sessionX + SessionPaneView.width + spacing
        rects.append(
            NSRect(x: orchX, y: c.minY, width: OrchestratorPaneView.width, height: c.height))
        return rects
    }

    /// Is `p` (screen coords) on one of the visible regions?
    private func shellContains(_ p: NSPoint) -> Bool {
        hoverRects().contains { NSMouseInRect(p, spilledToScreenEdges($0), false) }
    }

    /// A hover region flush against a screen edge is extended PAST that edge.
    ///
    /// Two reasons, both about the outermost row of pixels. `NSMouseInRect` is
    /// half-open, so a pointer exactly on a rect's bottom or right edge reads as
    /// outside it — and that is precisely where the pointer ends up when it is
    /// flicked at a corner, since the cursor stops at the screen edge. Without
    /// this, a circle parked flush in a corner could be sat on and still not open
    /// its pane, which defeats the whole point of parking it there. The extension
    /// only ever covers coordinates outside the display, so it cannot make some
    /// other part of the screen falsely count as "on the shell".
    private func spilledToScreenEdges(_ r: NSRect) -> NSRect {
        let region = parkRegion(for: circleCenter)
        let pf = region.bounds
        guard pf != .zero else { return r }
        let slack: CGFloat = 2 // "flush" allows for a half-pixel of rounding
        let spill: CGFloat = 4
        let minX = r.minX - pf.minX <= slack ? pf.minX - spill : r.minX
        let maxX = pf.maxX - r.maxX <= slack ? pf.maxX + spill : r.maxX
        let minY = r.minY - pf.minY <= slack ? pf.minY - spill : r.minY
        var maxY = pf.maxY - r.maxY <= slack ? pf.maxY + spill : r.maxY
        // A circle parked under the notch is as high as it can go, but its top is
        // a notch-height below the screen's, so the rule above doesn't fire and a
        // flick up that column would sail over it. The strip between the two is the
        // cutout — nothing else can be under the pointer there — so claim it.
        if let notch = region.notch, notch.minY - r.maxY <= slack,
           r.maxX > notch.minX, r.minX < notch.maxX {
            maxY = pf.maxY + spill
        }
        return NSRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    /// Push the pointer's current verdict into the model, on change only.
    private func sampleHover() {
        // A frame the window server refused earlier is owed; this sampler is the
        // only thing that runs unconditionally, so it is what eventually pays it.
        if geometryDeferred { relayout() }

        let inside = shellContains(NSEvent.mouseLocation)
        guard inside != lastHoverInside else { return }
        // Opening (or closing) the pane resizes the window, so a hover transition
        // needs the same permission a resize does. Deliberately does NOT record
        // the verdict: the next sample (≤0.2s) retries it, so the pane opens the
        // instant the desktop reveal ends without needing an event to arrive.
        guard windowServerHonorsGeometry() else { return }
        lastHoverInside = inside
        model.setHover(inside)
    }

    // MARK: The window server's geometry freeze (Show Desktop / Mission Control)

    /// When we last handed the window server a frame, and whether it has had a
    /// runloop turn to take it.
    private var lastFrameHandOff = Date.distantPast
    private var frameCommitPending = false
    /// A frame change skipped because geometry was frozen — owed to the panel.
    private var geometryDeferred = false

    /// Does the window server still put this panel where AppKit says it is?
    ///
    /// This is the "the circle turns into a square while the desktop is revealed"
    /// bug, and the square was never the disc: it is the whole session pane,
    /// scaled down into the disc's footprint. Measured with the top-right hot
    /// corner (Show Desktop) engaged: the moment the desktop is revealed the
    /// window server takes this panel under a transform of its own — it reported
    /// the collapsed panel 10pt right and 7pt up from its AppKit frame — and from
    /// then on it IGNORES geometry. A 61×61 → 369×576 hover resize was refused for
    /// the full five seconds the pointer sat on the circle: AppKit grew the
    /// hosting view and drew a 369×576 surface, the window server kept its 61×61
    /// rect, and a surface that does not match its rect gets scaled to fit. When
    /// the reveal ended the window server snapped back to the AppKit frame on its
    /// own, which is why the artifact healed the moment the windows came back.
    ///
    /// So the question asked here is deliberately NOT "is Show Desktop active"
    /// (there is no API for that, and the answer would be wrong again the day
    /// Apple ships another such mode — Mission Control and Exposé freeze geometry
    /// the same way) but "is my geometry being honored right now", which is the
    /// thing that actually has to be true before this panel may change size.
    /// Self-test seam: stands in for a real Show Desktop, which cannot be summoned
    /// headlessly. Nil in production.
    var forcedGeometryVerdict: Bool?

    private func windowServerHonorsGeometry() -> Bool {
        if let forced = forcedGeometryVerdict { return forced }
        // Its commit lags ours by a runloop pass (measured: still the old rect
        // immediately after `setFrame`, correct ~50ms later), so a disagreement
        // that young is that lag rather than a freeze. Also the escape hatch that
        // keeps the headless self-tests — which never spin the runloop, and so
        // never let the window server catch up — out of this code path.
        if frameCommitPending || Date().timeIntervalSince(lastFrameHandOff) < 0.15 { return true }
        guard let bounds = Self.windowServerBounds(of: panel) else { return true }
        return Self.geometryAgrees(
            appFrame: panel.frame, wsBounds: bounds, primaryTop: Self.primaryTop())
    }

    /// The panel's rect as the window server has it, in the global display space
    /// (y down from the top of the primary display). Nil when it cannot say — an
    /// unanswerable question must not be read as a freeze.
    private static func windowServerBounds(of window: NSWindow) -> CGRect? {
        let id = CGWindowID(window.windowNumber)
        guard id != 0,
              let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id)
                  as? [[String: Any]])?.first,
              let dict = info[kCGWindowBounds as String] as? [String: CGFloat],
              let x = dict["X"], let y = dict["Y"],
              let w = dict["Width"], let h = dict["Height"]
        else { return nil }
        return CGRect(x: x, y: y, width: w, height: h)
    }

    /// Top of the primary display — the origin the global display space flips
    /// around. `screens.first` is the screen with the menu bar (NOT `.main`, which
    /// follows the key window).
    private static func primaryTop() -> CGFloat {
        NSScreen.screens.first?.frame.maxY ?? 0
    }

    /// Do an AppKit frame (y up) and a window-server rect (y down from
    /// `primaryTop`) describe the same rectangle? Split out as pure geometry so
    /// the self-test can present the measured signature of a reveal without
    /// needing a real Show Desktop.
    static func geometryAgrees(appFrame: NSRect, wsBounds: CGRect, primaryTop: CGFloat) -> Bool {
        let flippedY = primaryTop - appFrame.maxY
        let slack: CGFloat = 1 // half-pixel rounding on a Retina display
        return abs(wsBounds.minX - appFrame.minX) < slack
            && abs(wsBounds.minY - flippedY) < slack
            && abs(wsBounds.width - appFrame.width) < slack
            && abs(wsBounds.height - appFrame.height) < slack
    }

    /// Hover is decided by asking where the pointer *is*, not by waiting for an
    /// exit event to arrive.
    ///
    /// The pane used to close on SwiftUI's `onHover(false)`, i.e. on an
    /// `NSTrackingArea` exit, and an exit is a thing that can simply fail to
    /// arrive: clicking a session hands the foreground to the editor and rebuilds
    /// the rows under the pointer at the same time, and a region that is torn
    /// down or handed over while the pointer sits inside it never reports
    /// leaving. Its flag then stays `true` forever, which wedges the pane open —
    /// and re-entering can't clear it, since a region that never exited never
    /// enters again either. Sampling geometry has no such state to get stuck in:
    /// the worst a lost event can cost is one 0.2s tick of latency.
    private func installHoverTracking() {
        panel.acceptsMouseMovedEvents = true
        // Monitors keep entering/leaving instant. Global sees other apps' moves
        // (mouse events need no accessibility grant), local sees our own.
        let types: NSEvent.EventTypeMask = [
            .mouseMoved, .leftMouseDragged, .rightMouseDragged, .leftMouseUp,
        ]
        if let g = NSEvent.addGlobalMonitorForEvents(matching: types, handler: { [weak self] _ in
            self?.sampleHover()
        }) {
            hoverMonitors.append(g)
        }
        if let l = NSEvent.addLocalMonitorForEvents(matching: types, handler: { [weak self] e in
            self?.sampleHover()
            return e
        }) {
            hoverMonitors.append(l)
        }
        // The guarantee: even with no events at all (cursor warped, another app
        // swallowing the stream, the window resized under a still pointer), the
        // verdict is re-derived five times a second.
        let t = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in self?.sampleHover() }
        RunLoop.main.add(t, forMode: .common)
        hoverTimer = t
    }

    // MARK: Drag-to-move (circle-only, screen-coordinate based)

    private var dragMonitor: Any?
    /// A drag that began on the circle is pending the movement threshold.
    private var dragPending = false
    /// Movement passed the start threshold — a real drag is in progress.
    private var dragActive = false
    /// Screen position where the pending drag began, and the circle's offset from
    /// it, so the circle keeps its grab point under the cursor for the whole drag.
    private var dragStartMouse: NSPoint = .zero
    private var dragOffset: NSPoint = .zero

    private func installDragMonitor() {
        // Deliberately NOT matching `.leftMouseDown`: intercepting the down event
        // broke first-mouse delivery to the SwiftUI session buttons (the panel is
        // non-activating, so the first click just needs to reach the control). A
        // circle drag is detected from the first `.leftMouseDragged` instead.
        dragMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDragged, .leftMouseUp]
        ) { [weak self] event in
            self?.handleDragEvent(event) ?? event
        }
    }

    /// Runs the circle drag in screen coordinates. Returns nil to swallow the
    /// event (during an active drag) or the event to pass it through to SwiftUI
    /// (so clicks, taps to pin, and the context menu keep working).
    private func handleDragEvent(_ e: NSEvent) -> NSEvent? {
        guard e.window === panel else { return e }
        switch e.type {
        case .leftMouseDragged:
            let m = NSEvent.mouseLocation
            if dragActive {
                applyDrag(mouse: m)
                return nil
            }
            // Not yet dragging: only the circle is a drag handle. The frame is
            // still the resting (expanded) frame here, so hit-test in its coords.
            if !dragPending {
                guard circleHit(e.locationInWindow) else { return e }
                dragPending = true
                dragStartMouse = m
                return e
            }
            // Small threshold so a click that jitters still registers as a tap.
            if hypot(m.x - dragStartMouse.x, m.y - dragStartMouse.y) < 3 { return e }
            dragActive = true
            dragOffset = NSPoint(x: circleCenter.x - dragStartMouse.x,
                                 y: circleCenter.y - dragStartMouse.y)
            model.dragging = true  // collapse the pane so the window is small
            relayout()             // apply the collapse immediately
            applyDrag(mouse: m)
            return nil
        case .leftMouseUp:
            defer { dragPending = false }
            if dragActive {
                dragActive = false
                finishDrag()
                return nil
            }
            return e
        default:
            return e
        }
    }

    /// Move the circle so the grab point stays under `mouse` (screen coords),
    /// keeping the circle on whichever screen the cursor is over.
    private func applyDrag(mouse m: NSPoint) {
        let target = NSPoint(x: m.x + dragOffset.x, y: m.y + dragOffset.y)
        circleCenter = PanelPlacement.clampCenter(
            target, discBox: circleW, in: parkRegion(for: target))
        relayout()
    }

    /// Is `p` (window coords, origin bottom-left) inside the circle's corner? The
    /// circle sits at the corner chosen by the current unfold directions.
    private func circleHit(_ p: NSPoint) -> Bool {
        // The zoomed moon is not a drag handle. It is centred in a window ten
        // times the size, so this corner box lands on empty margin beside it —
        // a grab there would silently drag the PARKED circle out from under the
        // moon. Click to dismiss, then drag as usual.
        if model.moonZoomed { return false }
        let side = circleBox + pad // a little slack around the disc
        let w = panel.frame.width, h = panel.frame.height
        let xIn = model.panesLeft ? (p.x >= w - side) : (p.x <= side)
        let yIn = model.contentDown ? (p.y >= h - side) : (p.y <= side)
        return xIn && yIn
    }

    /// End of a drag: re-decide unfold directions for the new corner, re-expand
    /// the pane, and persist the center + screen identity for recall.
    private func finishDrag() {
        updateDirections()
        model.dragging = false // re-expands on the correct side, clamped on-screen
        relayout()
        var config = Bootstrap.loadConfig()
        config.circle = CircleConfig(
            screen: panel.screen?.localizedName ?? "",
            displayID: panel.screen.flatMap { Self.displayID(of: $0) },
            x: circleCenter.x, y: circleCenter.y)
        Bootstrap.saveConfig(config)
    }

    // MARK: Key-policy self-test (regression: the pane swallowed the editor's keys)

    /// Assert the panel can only ever take the keyboard in the orchestrator
    /// stage. A key `.nonactivatingPanel` receives keystrokes aimed at whatever
    /// app is frontmost, so a hover pane that is key makes the editor untypable
    /// while still showing its caret — the exact bug this guards.
    static func keyPolicySelfTest() -> Bool {
        _ = NSApplication.shared
        let model = AppModel()
        let c = PanelController(model: model)
        var pass = true
        func check(_ name: String, _ cond: Bool) {
            print("\(cond ? "PASS" : "FAIL")[key]: \(name)")
            if !cond { pass = false }
        }

        c.panel.orderFront(nil)

        model.baseStage = .collapsed
        c.relayout()
        check("collapsed circle cannot take the keyboard", !c.panel.canBecomeKey)

        model.baseStage = .session
        c.relayout()
        check("session pane cannot take the keyboard", !c.panel.canBecomeKey)
        c.panel.makeKey()  // what the old hover handler did
        check("makeKey() on the session pane is a no-op", !c.panel.isKeyWindow)

        model.baseStage = .orchestrator
        c.relayout()
        check("orchestrator stage may take the keyboard", c.panel.canBecomeKey)
        c.panel.makeKey()
        check("orchestrator terminal can be keyed", c.panel.isKeyWindow)

        // Rendering state 3 starts a real orchestrator tab, and a running tab
        // legitimately holds the stage open (§3) — close it so the stage can fall
        // back, exactly as it does when the user closes the last tab.
        for tab in model.orchestrator.tabs { model.orchestrator.closeTab(tab.id) }
        model.baseStage = .session
        c.relayout()
        check("back in the session pane the keyboard is refused", !c.panel.canBecomeKey)
        check("leaving the orchestrator hands the keyboard back", !c.panel.isKeyWindow)
        check("…and the app holds no key window", NSApp.keyWindow == nil)

        c.panel.orderOut(nil)
        return pass
    }

    // MARK: Hover-region self-test (regression: pane wedged open after a click)

    /// Assert the pointer verdict the pane opens and closes on, at both a
    /// top-right and a bottom-left corner: the circle and the pane count as
    /// inside, the empty column beside the circle and anywhere off the window
    /// count as outside. Geometry is the whole mechanism now, so this covers the
    /// "moved the cursor out and it stayed open" failure directly.
    static func hoverRegionSelfTest() -> Bool {
        _ = NSApplication.shared
        guard let vf = NSScreen.main?.visibleFrame, vf.width > 800, vf.height > 700 else {
            print("hoverRegionSelfTest: no usable screen"); return false
        }
        let model = AppModel()
        model.applyBroker(
            tree: Aggregator.buildTree(windows: Fixtures.windows(), upfront: "win-core"),
            windows: Fixtures.windows())
        let c = PanelController(model: model)
        var pass = true
        func check(_ name: String, _ cond: Bool) {
            print("\(cond ? "PASS" : "FAIL")[hover]: \(name)")
            if !cond { pass = false }
        }

        let r = c.circleBox / 2
        for corner in ["top-right", "bottom-left"] {
            c.circleCenter = corner == "top-right"
                ? NSPoint(x: vf.maxX - r, y: vf.maxY - r)
                : NSPoint(x: vf.minX + r, y: vf.minY + r)
            c.updateDirections()

            model.baseStage = .collapsed
            c.relayout()
            check("\(corner): the circle itself is inside", c.shellContains(c.circleCenter))
            check(
                "\(corner): a point off the window is outside",
                !c.shellContains(NSPoint(x: vf.midX, y: vf.midY)))

            // Open the pane and probe its middle, plus the dead column that the
            // window's bounding box covers but the eye reads as empty.
            model.baseStage = .session
            c.relayout()
            let paneMidX = model.panesLeft
                ? c.circleCenter.x - r - c.spacing - SessionPaneView.width / 2
                : c.circleCenter.x + r + c.spacing + SessionPaneView.width / 2
            check(
                "\(corner): the open pane is inside",
                c.shellContains(NSPoint(x: paneMidX, y: c.circleCenter.y)))
            let belowCircleY = model.contentDown
                ? c.circleCenter.y - c.circleBox
                : c.circleCenter.y + c.circleBox
            check(
                "\(corner): the empty column beside the circle is outside",
                !c.shellContains(NSPoint(x: c.circleCenter.x, y: belowCircleY)))
            check(
                "\(corner): a point past the pane's far edge is outside",
                !c.shellContains(NSPoint(
                    x: model.panesLeft ? paneMidX - SessionPaneView.width : paneMidX + SessionPaneView.width,
                    y: c.circleCenter.y)))
        }

        // The other half of "the pane closes when the pointer leaves": nothing may
        // latch state 2 behind the user's back. Hover is the only thing that opens
        // it, and dismissing the orchestrator hands it straight back to hover —
        // parking `baseStage` on `.session` there wedged it open exactly like the
        // old click-to-pin did.
        model.baseStage = .collapsed
        check("with the pointer away the shell is collapsed", model.stage == .collapsed)
        model.openOrchestrator()
        model.closeOrchestrator()
        check("dismissing the orchestrator doesn't latch the pane open", model.stage == .collapsed)

        c.panel.orderOut(nil)
        return pass
    }

    // MARK: Frozen-geometry self-test (regression: the circle became a tiny pane)

    /// Assert the panel refuses to change size while the window server is not
    /// honoring geometry, and catches up the moment it is again.
    ///
    /// The bug this guards: with the desktop revealed (top-right hot corner), the
    /// window server ignored the hover resize while AppKit went ahead and drew the
    /// 369×576 pane, so the window server scaled that surface into the 61×61 rect
    /// it still held — the circle became a shrunken copy of the session pane. Both
    /// halves are checked: the geometry comparison that recognizes the state (with
    /// the numbers measured off a real reveal), and the hold-and-catch-up behavior
    /// built on it.
    static func geometryFreezeSelfTest() -> Bool {
        _ = NSApplication.shared
        guard let vf = NSScreen.main?.visibleFrame, vf.width > 400 else {
            print("geometryFreezeSelfTest: no usable screen"); return false
        }
        let model = AppModel()
        model.applyBroker(
            tree: Aggregator.buildTree(windows: Fixtures.windows(), upfront: "win-core"),
            windows: Fixtures.windows())
        let c = PanelController(model: model)
        var pass = true
        func check(_ name: String, _ cond: Bool) {
            print("\(cond ? "PASS" : "FAIL")[frozen]: \(name)")
            if !cond { pass = false }
        }

        // 1. The comparison itself, on the numbers a real reveal produced: the
        // panel's AppKit frame said (1245,825 61×61) on an 878pt-tall display, the
        // window server said (1255,-15 61×61) — 10pt right, 7pt up — and kept
        // saying it through a resize to 369×576.
        let top: CGFloat = 878
        let parked = NSRect(x: 1245, y: 825, width: 61, height: 61)
        check("a settled panel agrees with the window server",
              geometryAgrees(appFrame: parked,
                             wsBounds: CGRect(x: 1245, y: -8, width: 61, height: 61),
                             primaryTop: top))
        check("the reveal's 10pt/7pt shift is caught",
              !geometryAgrees(appFrame: parked,
                              wsBounds: CGRect(x: 1255, y: -15, width: 61, height: 61),
                              primaryTop: top))
        check("a resize the window server ignored is caught",
              !geometryAgrees(appFrame: NSRect(x: 937, y: 310, width: 369, height: 576),
                              wsBounds: CGRect(x: 1255, y: -15, width: 61, height: 61),
                              primaryTop: top))

        // 2. The behavior, driven synchronously: the runloop is deliberately NOT
        // spun here, so the only hover decisions made are the ones this test asks
        // for — the controller's own 0.2s sampler and its event monitors need a
        // running runloop, and `hovering` can only be cleared by a debounced block
        // that would need one too.
        //
        // The circle is parked under wherever the pointer already is, so the real
        // hover path runs without warping the user's cursor.
        c.forcedGeometryVerdict = true
        c.circleCenter = PanelPlacement.clampCenter(
            NSEvent.mouseLocation, discBox: c.circleW,
            in: c.parkRegion(for: NSEvent.mouseLocation))
        c.updateDirections()
        c.relayout()
        let collapsedFrame = c.panel.frame
        check("the pointer is on the circle to begin with",
              c.shellContains(NSEvent.mouseLocation))
        check("the pane starts closed", model.stage == .collapsed)

        // Frozen: the hover must not open the pane, because opening it resizes the
        // window and the window server would not take the new rect.
        c.forcedGeometryVerdict = false
        c.sampleHover()
        check("frozen: hover does not open the pane", model.stage == .collapsed)
        check("frozen: the window keeps its frame", c.panel.frame == collapsedFrame)

        // Live again: the very next sample opens it — the refused verdict was not
        // recorded, so no new pointer event is needed. (`relayout` stands in for
        // the model's own change subscription, which is delivered on the runloop.)
        c.forcedGeometryVerdict = true
        c.sampleHover()
        c.relayout()
        check("live again: the same sample opens the pane", model.stage == .session)
        check("live again: the window took the wider frame",
              c.panel.frame.width > collapsedFrame.width)

        // 3. A frame change refused while frozen is owed, and paid by the sampler.
        c.forcedGeometryVerdict = false
        let openFrame = c.panel.frame
        c.circleCenter.x -= 60
        c.updateDirections()
        c.relayout()
        check("frozen: a pending frame change is skipped", c.panel.frame == openFrame)
        check("frozen: …and remembered as owed", c.geometryDeferred)
        c.forcedGeometryVerdict = true
        c.sampleHover()
        check("live again: the owed frame change is applied", c.panel.frame != openFrame)
        check("live again: nothing stays owed", !c.geometryDeferred)

        // 4. Live, against the real window server: a settled on-screen panel must
        // read as honored, or the gate above would wedge the pane shut in normal
        // use. Parked in the corner furthest from the pointer so the hover tracking
        // this finally lets run has nothing to open.
        c.forcedGeometryVerdict = nil
        let m = NSEvent.mouseLocation
        c.circleCenter = PanelPlacement.clampCenter(
            NSPoint(x: m.x < vf.midX ? vf.maxX : vf.minX, y: m.y < vf.midY ? vf.maxY : vf.minY),
            discBox: c.circleW, in: c.parkRegion(for: NSPoint(x: vf.midX, y: vf.midY)))
        c.updateDirections()
        c.panel.orderFront(nil)
        c.relayout()
        RunLoop.main.run(until: Date().addingTimeInterval(0.35))
        check("a real settled panel reads as honored", c.windowServerHonorsGeometry())

        c.panel.orderOut(nil)
        return pass
    }

    // MARK: Moon-zoom self-test (click-to-enlarge, PLAN.md moon mode)

    /// The blown-up moon has to survive the same corner the parked circle lives
    /// in: it grows tenfold, so pinning it by an edge the way the panes are
    /// pinned would push most of it off the display. Asserts it lands wholly on
    /// screen, takes the window over from the panes, and hands the circle back
    /// its exact parked spot when dismissed.
    static func moonZoomSelfTest() -> Bool {
        _ = NSApplication.shared
        guard let vf = NSScreen.main?.frame,
            vf.width > CircleView.zoomedSize, vf.height > CircleView.zoomedSize
        else {
            print("moonZoomSelfTest: no screen big enough for a \(CircleView.zoomedSize)pt moon")
            return false
        }
        var pass = true
        func check(_ what: String, _ ok: Bool) {
            print("  \(ok ? "ok  " : "FAIL") \(what)")
            if !ok { pass = false }
        }

        let model = AppModel()
        model.moonMode = true
        model.baseStage = .session  // pane OPEN — the zoom must take the window over
        let c = PanelController(model: model)

        // Top-right corner: the worst case for growing in place.
        let r = PanelPlacement.clampRadius(discBox: c.circleW)
        c.circleCenter = NSPoint(x: vf.maxX - r, y: vf.maxY - r)
        c.updateDirections()
        c.relayout()
        let parkedCenter = c.circleCenter
        let parkedFrame = c.panel.frame
        check("the pane is open before zooming", model.stage == .session)

        model.toggleMoonZoom()
        c.updateDirections()
        c.relayout()
        let zoomed = c.panel.frame

        check("the panes give up the window", model.stage == .collapsed)
        check(
            "the window fits the moon and the star tips that overhang it",
            min(zoomed.width, zoomed.height) >= CircleView.box(for: CircleView.zoomedSize))
        // The frame carries `pad` of transparent shadow margin that is allowed to
        // hang over the edge; every visible pixel must be on the display.
        check(
            "every visible pixel is on screen",
            vf.contains(zoomed.insetBy(dx: c.pad, dy: c.pad)))
        check(
            "the parked spot is remembered, not overwritten by the clamp",
            c.circleCenter == parkedCenter)

        model.toggleMoonZoom()
        c.updateDirections()
        c.relayout()
        check("dismissing restores the pane", model.stage == .session)
        check("…and the exact frame it had", c.panel.frame == parkedFrame)
        check("…on the exact spot it was parked", c.circleCenter == parkedCenter)

        c.panel.orderOut(nil)
        return pass
    }

    // MARK: Headless drag self-test (regression: circle trapped in a low corner)

    /// Drive the real drag path (grab → move → release) with the pane open,
    /// starting the circle at a bottom corner and dragging to the top of the
    /// screen. Asserts the circle actually reaches the top — i.e. the tall open
    /// pane no longer pins the window against the screen edge and traps it.
    static func dragSelfTest() -> Bool {
        _ = NSApplication.shared
        guard let vf = NSScreen.main?.visibleFrame, vf.height > 200 else {
            print("dragSelfTest: no usable screen"); return false
        }
        let model = AppModel()
        model.applyBroker(
            tree: Aggregator.buildTree(windows: Fixtures.windows(), upfront: "win-core"),
            windows: Fixtures.windows())
        model.baseStage = .session // pane OPEN — the trap condition
        // The drag persists the new position; leave the user's config as it was.
        let savedConfig = Bootstrap.loadConfig()
        defer { Bootstrap.saveConfig(savedConfig) }
        let c = PanelController(model: model)
        let r = PanelPlacement.clampRadius(discBox: c.circleW)

        // Park the circle at the bottom-right corner with the pane open.
        c.circleCenter = NSPoint(x: vf.maxX - r, y: vf.minY + r)
        c.updateDirections()
        c.relayout()
        let startY = c.circleCenter.y

        // Simulate grabbing the circle and dragging straight up to the screen top.
        let grab = c.circleCenter
        c.dragOffset = NSPoint(x: c.circleCenter.x - grab.x, y: c.circleCenter.y - grab.y)
        model.dragging = true
        c.relayout()
        for frac in stride(from: 0.25, through: 1.0, by: 0.25) {
            c.applyDrag(mouse: NSPoint(x: grab.x, y: vf.minY + vf.height * frac))
        }
        c.finishDrag()
        let endY = c.circleCenter.y

        let reachedTop = endY >= vf.maxY - r - 2
        print("dragSelfTest: startY=\(Int(startY)) endY=\(Int(endY)) top=\(Int(vf.maxY - r)) reachedTop=\(reachedTop)")
        return reachedTop && endY > startY + 100
    }

    // MARK: - Corner-park self-test (regression: an 8pt gap in every corner)

    /// Drive the real drag path with the pointer OVERSHOOTING each bottom corner
    /// and assert what the user actually asked for: the disc ends up flush against
    /// the physical screen edges, and a pointer slammed into the corner is hovering
    /// it. Two separate bugs used to conspire against that — the drag clamp
    /// reserved the Dock's strip even with the Dock hidden, and the window clamp
    /// then pushed the box back on-screen, converting its 8pt of transparent
    /// shadow padding into a dead band beside the disc.
    static func cornerParkSelfTest() -> Bool {
        _ = NSApplication.shared
        guard let main = NSScreen.main, main.frame.height > 200 else {
            print("cornerParkSelfTest: no usable screen"); return false
        }
        let frame = main.frame
        let notch = Self.notch(of: main)
        // The drag persists the new position; leave the user's config as it was.
        let savedConfig = Bootstrap.loadConfig()
        defer { Bootstrap.saveConfig(savedConfig) }

        let model = AppModel()
        model.applyBroker(
            tree: Aggregator.buildTree(windows: Fixtures.windows(), upfront: "win-core"),
            windows: Fixtures.windows())
        model.baseStage = .session // pane OPEN — the state the window clamp acts on
        let c = PanelController(model: model)
        var pass = true
        func check(_ name: String, _ cond: Bool) {
            print("\(cond ? "PASS" : "FAIL")[corner]: \(name)")
            if !cond { pass = false }
        }

        /// Drag the circle from the middle of the screen to `mouse` (overshooting
        /// off-screen) and report where its disc came to rest.
        func park(at mouse: NSPoint) -> NSRect {
            c.circleCenter = NSPoint(x: frame.midX, y: frame.midY)
            c.updateDirections()
            c.relayout()
            c.dragOffset = .zero
            model.dragging = true
            c.relayout()
            c.applyDrag(mouse: mouse)
            c.finishDrag()
            // hoverRects()[0] IS the disc's bounding square — the region a pointer
            // has to be inside for the pane to open.
            return c.hoverRects()[0]
        }

        // All four corners: the Dock's strip and the menu bar's are both parkable,
        // so every corner of the glass is reachable.
        let half = c.circleW / 2
        for corner in ["bottom-left", "bottom-right", "top-left", "top-right"] {
            let bottom = corner.hasPrefix("bottom")
            let left = corner.hasSuffix("left")
            // Overshoot well past the corner: the clamp is what stops the circle.
            let disc = park(at: NSPoint(x: left ? frame.minX - 300 : frame.maxX + 300,
                                       y: bottom ? frame.minY - 300 : frame.maxY + 300))
            let cornerPoint = NSPoint(x: left ? frame.minX : frame.maxX - 1,
                                      y: bottom ? frame.minY : frame.maxY - 1)
            let edgeY = bottom ? frame.minY : frame.maxY
            check("\(corner): center reaches the physical \(bottom ? "bottom" : "top") edge",
                  abs(c.circleCenter.y - (bottom ? edgeY + half : edgeY - half)) < 0.51)
            check("\(corner): disc sits flush on the \(bottom ? "bottom" : "top") edge",
                  abs((bottom ? disc.minY : disc.maxY) - edgeY) < 0.51)
            check("\(corner): disc sits flush on the side edge",
                  left ? abs(disc.minX - frame.minX) < 0.51 : abs(disc.maxX - frame.maxX) < 0.51)
            check("\(corner): a pointer slammed into the corner is on the circle",
                  c.shellContains(cornerPoint))
            print("  \(corner): disc=\(disc) screen=\(frame)")
        }

        // The notch is the one part of the glass that is out of bounds — there are
        // no pixels behind the camera housing. Dragged up its column the circle
        // stops a hair below it, whole, and the cutout's strip still counts as
        // hovering it so a flick up that column is not wasted.
        if let notch {
            let disc = park(at: NSPoint(x: notch.midX, y: frame.maxY + 300))
            check("under the notch the circle stops below the cutout",
                  abs(disc.maxY - notch.minY) < 0.51)
            check("the notch's own strip still counts as hovering the circle",
                  c.shellContains(NSPoint(x: notch.midX, y: frame.maxY - 1)))
            print("  notch: disc=\(disc) notch=\(notch)")
        } else {
            print("  notch: none on this display — skipped")
        }

        c.panel.orderOut(nil)
        return pass
    }
}
