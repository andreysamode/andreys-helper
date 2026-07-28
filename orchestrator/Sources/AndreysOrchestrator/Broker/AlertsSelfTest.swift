// Alert fire/ack + CircleState re-derivation self-test (PLAN.md §4, Phase 3
// item 1) and multi-monitor placement checks (item 7). Driven by `--selftest-alerts`.
//
// Faithfully mirrors the production path: the daemon's Scheduler owns the alert
// queue; each change re-derives the aggregate CircleState via `Aggregator`
// exactly as `AppModel.recomputeCircle` does. Asserts the "!" category + count
// track the queue and that acking the LAST alert falls back to the underlying
// §4 category. Uses the deterministic ManualClock — no wall clock, no GUI.

import CoreGraphics
import Foundation

enum AlertsSelfTest {
    static func run() -> Bool {
        var pass = true
        func check(_ name: String, _ cond: Bool) {
            print("\(cond ? "PASS" : "FAIL")[alerts]: \(name)")
            if !cond { pass = false }
        }

        // Underlying window state: one done-unseen session (so the non-alert
        // category is `done-unseen` with count 1) + one idle session.
        let windows = [
            RegisteredWindow(
                windowId: "w1", host: .cursor,
                repo: RepoRef(name: "core", trunkPath: "/tmp/core"),
                worktrees: [],
                sessions: [
                    SessionInfo(tabId: "t1", sessionId: "s1", cwd: "/tmp/core",
                                title: "done job", status: .done, seen: false, col: 1, active: false),
                    SessionInfo(tabId: "t2", sessionId: "s2", cwd: "/tmp/core",
                                title: "idle", status: .idle, seen: false, col: 1, active: false),
                ]),
        ]

        // Re-derive CircleState from current queue length, as AppModel does.
        func circle(alertCount: Int) -> CircleState {
            Aggregator.aggregate(windows: windows, alertCount: alertCount)
        }

        let store = JobStore(url: FileManager.default.temporaryDirectory
            .appendingPathComponent("orchestrator-alerts-\(UUID().uuidString).json"))
        let sched = Scheduler(clock: ManualClock(), runner: FakeAgenticRunner(output: ""), store: store)

        // Track the derived circle on every queue change (mirrors the app wiring).
        var derived = circle(alertCount: sched.alerts.count)
        sched.onAlertsChanged = { alerts in derived = circle(alertCount: alerts.count) }

        // 0) Baseline: no alerts → underlying category wins (done-unseen, count 1).
        check("baseline is done-unseen count 1",
              derived.category == .doneUnseen && derived.count == 1 && derived.alertCount == 0)

        // 1) Fire one alert → category flips to alert, count/alertCount = 1.
        sched.pushAlert("build finished")
        check("one alert → category alert, count 1",
              derived.category == .alert && derived.count == 1 && derived.alertCount == 1)
        check("alert text is queued",
              sched.alerts.first?.text == "build finished")

        // 2) Fire a second alert → count/alertCount = 2 (multiple queued).
        sched.pushAlert("PR review ready")
        check("two alerts → count 2",
              derived.category == .alert && derived.count == 2 && derived.alertCount == 2)

        // 3) Ack the first → still alert, count 1 (one-per-click ack).
        let firstId = sched.alerts.first!.id
        sched.ackAlert(id: firstId)
        check("ack one alert → still alert, count 1",
              derived.category == .alert && derived.count == 1 && sched.alerts.count == 1)
        check("acked alert removed from queue",
              !sched.alerts.contains { $0.id == firstId })

        // 4) Ack the last → queue empty → fall back per §4 precedence (done-unseen).
        sched.ackAlert(id: sched.alerts.first!.id)
        check("ack last alert → queue empty", sched.alerts.isEmpty)
        check("category falls back to done-unseen after last ack",
              derived.category == .doneUnseen && derived.count == 1 && derived.alertCount == 0)

        // 5) Placement (item 7): restore onto the saved display; fall back + clamp
        //    when that monitor is gone.
        pass = placementChecks(check) && pass
        return pass
    }

    /// Pure multi-monitor placement assertions (PLAN.md §3 / Phase 3 item 7).
    private static func placementChecks(_ check: (String, Bool) -> Void) -> Bool {
        let size = CGSize(width: 100, height: 100)
        // Built-in: 1440×925 of glass, of which the top 25 is the menu bar (split
        // around a notch spanning x 620…820) and the bottom 40 is the Dock — so
        // `frame` and `visibleFrame` differ on both edges.
        let notch = CGRect(x: 620, y: 900, width: 200, height: 25)
        let main = ScreenDesc(displayID: 1, name: "Built-in",
                              frame: CGRect(x: 0, y: 0, width: 1440, height: 925),
                              visibleFrame: CGRect(x: 0, y: 40, width: 1440, height: 860),
                              notch: notch)
        let external = ScreenDesc(displayID: 2, name: "External",
                                  visibleFrame: CGRect(x: 1440, y: 0, width: 1920, height: 1080))

        // Saved on the external display → restored there.
        let onExternal = CircleConfig(screen: "External", displayID: 2, x: 3000, y: 900)
        let a1 = PanelPlacement.resolveAnchor(
            config: onExternal, size: size, screens: [main, external], mainIndex: 0)
        check("restores onto saved external display",
              a1.x == 3000 && a1.y == 900)

        // External unplugged → fall back to main, clamped on-screen (top-right).
        let a2 = PanelPlacement.resolveAnchor(
            config: onExternal, size: size, screens: [main], mainIndex: 0)
        check("absent monitor → falls back to main top-right",
              a2.x == 1440 - PanelPlacement.margin && a2.y == 900 - PanelPlacement.margin)

        // Off-screen saved point on a present display → clamped fully on-screen.
        let offscreen = CircleConfig(screen: "Built-in", displayID: 1, x: 5000, y: 5000)
        let a3 = PanelPlacement.resolveAnchor(
            config: offscreen, size: size, screens: [main], mainIndex: 0)
        check("off-screen point clamped within visibleFrame",
              a3.x == 1440 && a3.y == 900)

        // Legacy config: name only, no displayID → resolves by name.
        let legacy = CircleConfig(screen: "External", displayID: nil, x: 3000, y: 900)
        let a4 = PanelPlacement.resolveAnchor(
            config: legacy, size: size, screens: [main, external], mainIndex: 0)
        check("legacy name-only config resolves by name", a4.x == 3000 && a4.y == 900)

        // 6) Corner-aware unfolding: panes go to the side with room; content folds
        //    up/down based on room. Screen 1440×900, circle box 72, max pane ≈ 720w.
        let vf = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let box: CGFloat = 72
        let maxC = CGSize(width: 720, height: 620)
        // Top-right corner → panes unfold LEFT, content grows DOWN.
        let tr = PanelPlacement.decideExpansion(
            circleCenter: CGPoint(x: 1440 - 60, y: 900 - 60), maxContent: maxC, circleBox: box, in: vf)
        check("top-right → panes left, content down", tr.panesLeft && tr.contentDown)
        // Bottom-left corner → panes unfold RIGHT, content grows UP.
        let bl = PanelPlacement.decideExpansion(
            circleCenter: CGPoint(x: 60, y: 60), maxContent: maxC, circleBox: box, in: vf)
        check("bottom-left → panes right, content up", !bl.panesLeft && !bl.contentDown)
        // Top-left corner → panes RIGHT, content DOWN.
        let tl = PanelPlacement.decideExpansion(
            circleCenter: CGPoint(x: 60, y: 900 - 60), maxContent: maxC, circleBox: box, in: vf)
        check("top-left → panes right, content down", !tl.panesLeft && tl.contentDown)
        // The disc stays on-screen when clamped from an off-screen center — the
        // drag limit, measured from the disc not the box.
        let disc: CGFloat = 45
        let limit = disc / 2 + PanelPlacement.edgeGap
        let cc = PanelPlacement.clampCenter(CGPoint(x: 5000, y: -100), discBox: disc, in: vf)
        check("circle center clamped on-screen", cc.x == 1440 - limit && cc.y == limit)

        // 7) The park region is the WHOLE display: both strips macOS reserves — the
        //    Dock's and the menu bar's — are parkable, since the panel floats above
        //    each. Only the notch is out of bounds, having no pixels behind it.
        let region = main.parkRegion
        check("park region is the whole display", region.bounds == main.frame)
        check("park region knows the notch", region.notch == notch)
        check("a display without a notch has none", external.parkRegion.notch == nil)

        // …so a drag pushed past a corner parks FLUSH: the disc's edges land exactly
        // on the screen's, leaving no dead band beside it for a corner-slammed
        // pointer to fall into. Bottom-left and top-right, i.e. across the Dock's
        // strip and the menu bar's.
        let low = PanelPlacement.clampCenter(
            CGPoint(x: -400, y: -400), discBox: disc, in: region)
        check("bottom-left park is flush with the screen edges",
              low.x - disc / 2 == main.frame.minX && low.y - disc / 2 == main.frame.minY)
        let high = PanelPlacement.clampCenter(
            CGPoint(x: 5000, y: 5000), discBox: disc, in: region)
        check("top-right park is flush with the screen edges",
              high.x + disc / 2 == main.frame.maxX && high.y + disc / 2 == main.frame.maxY)

        // Straight up the notch's column the circle stops just below the cutout,
        // whole, instead of being sliced by it — and it is back to the top edge one
        // disc-width to the side.
        let underNotch = PanelPlacement.clampCenter(
            CGPoint(x: notch.midX, y: 5000), discBox: disc, in: region)
        check("the circle dips below the notch", underNotch.y + disc / 2 == notch.minY)
        let besideNotch = PanelPlacement.clampCenter(
            CGPoint(x: notch.minX - disc, y: 5000), discBox: disc, in: region)
        check("beside the notch it is back at the top edge",
              besideNotch.y + disc / 2 == main.frame.maxY)

        // Saved positions in either reserved strip survive a restart (they used to
        // be clamped out of it, moving the circle the user parked).
        for (name, saved) in [("bottom", CGPoint(x: disc / 2, y: disc / 2)),
                              ("top", CGPoint(x: disc / 2, y: 925 - disc / 2))] {
            let config = CircleConfig(
                screen: "Built-in", displayID: 1, x: saved.x, y: saved.y)
            let restored = PanelPlacement.resolveCircleCenter(
                config: config, discBox: disc, screens: [main], mainIndex: 0)
            check("a circle parked at the \(name) edge is restored there", restored == saved)
        }

        return true
    }
}
