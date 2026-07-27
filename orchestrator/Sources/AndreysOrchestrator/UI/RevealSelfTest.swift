// Click-to-reveal highlight self-test (`--selftest-reveal`).
//
// Replays the broker snapshot sequence a real cross-window click produces and
// asserts what the session pane would draw at each step. The bug this pins
// down: revealing a session in a BACKGROUND window is two ordered steps (raise
// the editor window ~1.3s, then switch its tab), so there is a stretch where the
// target window is already upfront while its OLD tab is still active — and
// `active && isUpfront` is the pane's full-accent state. The pane therefore lit
// up a box the user never clicked, then jumped to the one they did.
//
// Asserted here through `SessionVisual.of`, the same rule `SessionBox` renders,
// so the checks can't drift from the view. No GUI, no networking.

import Foundation

enum RevealSelfTest {
    // Two windows: w1 frontmost with session `a` active; w2 in the background
    // with `b` active and `c` idle. The user clicks `c`.
    private static func windows(
        upfrontW1: Bool, w2Active: String
    ) -> [RegisteredWindow] {
        func session(_ id: String, active: Bool) -> SessionInfo {
            SessionInfo(tabId: "t-\(id)", sessionId: id, cwd: "/tmp/repo", title: id,
                        status: .idle, seen: true, col: 1, active: active)
        }
        return [
            RegisteredWindow(
                windowId: "w1", host: .cursor,
                repo: RepoRef(name: "front", trunkPath: "/tmp/repo"),
                worktrees: [], sessions: [session("a", active: true)],
                focused: upfrontW1),
            RegisteredWindow(
                windowId: "w2", host: .cursor,
                repo: RepoRef(name: "back", trunkPath: "/tmp/repo2"),
                worktrees: [],
                sessions: [session("b", active: w2Active == "b"),
                           session("c", active: w2Active == "c")],
                focused: !upfrontW1),
        ]
    }

    static func run() -> Bool {
        var pass = true
        func check(_ name: String, _ cond: Bool) {
            print("\(cond ? "PASS" : "FAIL")[reveal]: \(name)")
            if !cond { pass = false }
        }

        let model = AppModel()
        model.revealTimeout = 0.4  // keep the timeout check quick

        /// What the pane would draw for a session id, from the model's tree.
        func visual(_ id: String) -> SessionVisual? {
            for window in model.tree.windows {
                for wt in window.worktrees {
                    if let s = wt.sessions.first(where: { $0.id == id }) {
                        return .of(s, windowUpfront: window.isUpfront)
                    }
                }
            }
            return nil
        }
        func snapshot(upfront: WindowId, upfrontW1: Bool, w2Active: String) {
            let ws = windows(upfrontW1: upfrontW1, w2Active: w2Active)
            model.applyBroker(tree: Aggregator.buildTree(windows: ws, upfront: upfront), windows: ws)
        }
        /// Drain the main queue for `seconds` so debounced work can fire.
        func settle(_ seconds: TimeInterval) {
            RunLoop.current.run(until: Date().addingTimeInterval(seconds))
        }
        func session(_ id: String) -> SessionInfo {
            model.tree.windows.flatMap { $0.worktrees }.flatMap { $0.sessions }
                .first { $0.id == id }!
        }

        // 1) Baseline: w1 frontmost, its tab `a` fully accented; w2's active tab
        //    `b` is outline-only; `c` is plain.
        snapshot(upfront: "w1", upfrontW1: true, w2Active: "b")
        check("baseline: frontmost window's active tab is upfront", visual("a") == .upfront)
        check("baseline: background window's active tab is window-active",
              visual("b") == .windowActive)
        check("baseline: clicked-to-be session is inactive", visual("c") == .inactive)

        // 2) The click. The accent must move to `c` in the same turn — no broker
        //    round-trip — and `a` must give it up at the same moment.
        model.reveal(session("c"))
        check("on click: clicked session takes the accent immediately",
              visual("c") == .upfront)
        check("on click: previously frontmost tab drops to window-active",
              visual("a") == .windowActive)
        check("on click: the target window's old tab does NOT light up",
              visual("b") == .inactive)
        check("on click: exactly one box carries the accent",
              ["a", "b", "c"].filter { visual($0) == .upfront } == ["c"])

        // 3) MID-FLIGHT — the regression. The window has come forward but the tab
        //    hasn't switched yet, so the broker reports w2 upfront with `b` still
        //    active. This is the snapshot that used to light up the wrong box.
        snapshot(upfront: "w2", upfrontW1: false, w2Active: "b")
        check("mid-flight: the un-clicked tab stays unlit", visual("b") != .upfront)
        check("mid-flight: the clicked session keeps the accent", visual("c") == .upfront)

        // 4) The reveal lands: the broker now agrees, and the overlay retires.
        snapshot(upfront: "w2", upfrontW1: false, w2Active: "c")
        check("confirmed: clicked session is upfront", visual("c") == .upfront)
        //    Retired, not stuck: a later in-editor tab switch must show through.
        snapshot(upfront: "w2", upfrontW1: false, w2Active: "b")
        check("after confirm: a later editor-side tab switch shows through",
              visual("b") == .upfront && visual("c") == .inactive)

        // 5) The reveal never lands (editor won't come forward). The optimistic
        //    accent must expire back to broker truth rather than pin forever.
        snapshot(upfront: "w1", upfrontW1: true, w2Active: "b")
        model.reveal(session("c"))
        check("failed reveal: accent starts on the clicked session",
              visual("c") == .upfront)
        snapshot(upfront: "w1", upfrontW1: true, w2Active: "b")  // stale: nothing moved
        check("failed reveal: overlay holds while the raise could still be in flight",
              visual("c") == .upfront)
        settle(model.revealTimeout + 0.3)
        check("failed reveal: reverts to broker truth after the timeout",
              visual("a") == .upfront && visual("c") == .inactive)

        // 6) The user goes somewhere else mid-flight (a third window comes
        //    forward). The overlay must yield immediately, not fight them.
        snapshot(upfront: "w1", upfrontW1: true, w2Active: "b")
        model.reveal(session("c"))
        let third = windows(upfrontW1: false, w2Active: "b") + [
            RegisteredWindow(
                windowId: "w3", host: .cursor,
                repo: RepoRef(name: "other", trunkPath: "/tmp/repo3"),
                worktrees: [],
                sessions: [SessionInfo(tabId: "t-d", sessionId: "d", cwd: "/tmp/repo3",
                                       title: "d", status: .idle, seen: true, col: 1,
                                       active: true)],
                focused: true),
        ]
        model.applyBroker(
            tree: Aggregator.buildTree(windows: third, upfront: "w3"), windows: third)
        check("user switches elsewhere: overlay yields to the window they chose",
              visual("d") == .upfront && visual("c") == .inactive)

        return pass
    }
}
