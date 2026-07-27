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
    private let paneH: CGFloat = 560

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

        panel.level = .floating
        panel.isFloatingPanel = true
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
        return NSSize(width: w + 2 * pad, height: h + 2 * pad)
    }

    /// Largest expanded window (orchestrator stage) — used to pick a side with
    /// enough room so opening the orchestrator later won't overflow the screen.
    private func maxContentSize() -> NSSize {
        let w = circleW + spacing + SessionPaneView.width + spacing + OrchestratorPaneView.width
        return NSSize(width: w + 2 * pad, height: paneH + 2 * pad)
    }

    /// visibleFrame of the screen the circle currently sits on (robust to the
    /// panel not yet being placed — resolves by the point, not `panel.screen`).
    private func visibleFrame(for point: CGPoint) -> CGRect {
        for s in NSScreen.screens where NSMouseInRect(point, s.frame, false) {
            return s.visibleFrame
        }
        return (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? .zero
    }

    /// Re-decide unfold directions from the circle's position; push to the model
    /// so `RootView` arranges the panes on the correct side.
    private func updateDirections() {
        let vf = visibleFrame(for: circleCenter)
        guard vf != .zero else { return }
        let d = PanelPlacement.decideExpansion(
            circleCenter: circleCenter, maxContent: maxContentSize(), circleBox: circleBox, in: vf)
        if model.panesLeft != d.panesLeft { model.panesLeft = d.panesLeft }
        if model.contentDown != d.contentDown { model.contentDown = d.contentDown }
    }

    /// Window origin that keeps the circle centered on `circleCenter` while the
    /// window grows away from it per the chosen directions; clamped on-screen.
    private func originFor(size: NSSize) -> NSPoint {
        let r = circleBox / 2
        var x = model.panesLeft ? (circleCenter.x + r - size.width) : (circleCenter.x - r)
        var y = model.contentDown ? (circleCenter.y + r - size.height) : (circleCenter.y - r)
        let vf = visibleFrame(for: circleCenter)
        if vf != .zero {
            if x < vf.minX { x = vf.minX }
            if x + size.width > vf.maxX { x = vf.maxX - size.width }
            if y < vf.minY { y = vf.minY }
            if y + size.height > vf.maxY { y = vf.maxY - size.height }
        }
        return NSPoint(x: x, y: y)
    }

    private func relayout() {
        // Only the orchestrator stage hosts something that wants typing.
        panel.wantsKeyboard = model.stage == .orchestrator
        let size = contentSize()
        let frame = NSRect(origin: originFor(size: size), size: size)
        if panel.frame != frame {
            panel.setFrame(frame, display: true, animate: false)
        }
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
        panel.setFrame(NSRect(origin: originFor(size: size), size: size), display: true)
    }

    /// Snapshot the attached screens as pure `ScreenDesc`s for `PanelPlacement`.
    private static func screenDescs() -> [ScreenDesc] {
        NSScreen.screens.map { screen in
            ScreenDesc(
                displayID: Self.displayID(of: screen),
                name: screen.localizedName,
                visibleFrame: screen.visibleFrame)
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
        hoverRects().contains { NSMouseInRect(p, $0, false) }
    }

    /// Push the pointer's current verdict into the model, on change only.
    private func sampleHover() {
        let inside = shellContains(NSEvent.mouseLocation)
        guard inside != lastHoverInside else { return }
        lastHoverInside = inside
        model.setHover(inside)
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
            target, discBox: circleW, in: visibleFrame(for: target))
        relayout()
    }

    /// Is `p` (window coords, origin bottom-left) inside the circle's corner? The
    /// circle sits at the corner chosen by the current unfold directions.
    private func circleHit(_ p: NSPoint) -> Bool {
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
}
