// Daemon self-test (PLAN.md §8 W4 "prove via self-test using injected clock +
// fake runner + fake transitions"). Drives the Scheduler deterministically:
// a time job fires an alert, a completion job fires on a simulated transition,
// an agentic job posts its runner output as an alert, and the §9.5 rate floor is
// enforced. Invoked from the binary's `--selftest` path. Prints PASS/FAIL.

import Foundation

/// Deterministic runner: returns canned output synchronously (no `claude`).
final class FakeAgenticRunner: AgenticRunner {
    let output: String
    private(set) var runs = 0
    init(output: String) { self.output = output }
    func run(instruction: String, cwd: String, completion: @escaping (Result<String, Error>) -> Void) {
        runs += 1
        completion(.success(output))
    }
}

enum DaemonSelfTest {
    static func run() -> Bool {
        var pass = true
        func check(_ name: String, _ cond: Bool) {
            print("\(cond ? "PASS" : "FAIL")[daemon]: \(name)")
            if !cond { pass = false }
        }

        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime]
        func tempStore() -> JobStore {
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("orchestrator-selftest-\(UUID().uuidString).json")
            return JobStore(url: url)
        }

        // 1) Time job → alert.
        do {
            let clock = ManualClock()
            let runner = FakeAgenticRunner(output: "")
            let sched = Scheduler(clock: clock, runner: runner, store: tempStore())
            sched.addJob(Job(
                id: "t", kind: .static,
                trigger: JobTrigger(type: .time, at: iso.string(from: clock.now)),
                action: JobAction(type: .alert, text: "wake up"),
                label: "wake up", nextFireAt: iso.string(from: clock.now)))
            check("time job pending before fire", sched.pendingJobs().contains { $0.id == "t" })
            sched.tick()
            check("time job fires an alert", sched.alerts.count == 1 && sched.alerts.first?.text == "wake up")
            check("time job is one-shot (gone from pending)", !sched.pendingJobs().contains { $0.id == "t" })
        }

        // 2) Completion job → fires on simulated working→done transition.
        do {
            let clock = ManualClock()
            let sched = Scheduler(clock: clock, runner: FakeAgenticRunner(output: ""), store: tempStore())
            sched.addJob(Job(
                id: "c", kind: .static,
                trigger: JobTrigger(type: .completion, sessionId: "sess-42"),
                action: JobAction(type: .alert, text: "session done"),
                label: "watch sess-42", nextFireAt: ""))
            sched.onCompletion(sessionId: "other")  // wrong session: no fire
            check("completion job ignores unrelated session", sched.alerts.isEmpty)
            sched.onCompletion(sessionId: "sess-42")
            check("completion job fires on matching transition", sched.alerts.count == 1)
        }

        // 3) Agentic job → runs runner, posts output as alert.
        do {
            let clock = ManualClock()
            let runner = FakeAgenticRunner(output: "flagged 2 stuck sessions")
            let sched = Scheduler(clock: clock, runner: runner, store: tempStore())
            sched.addJob(Job(
                id: "a", kind: .agentic,
                trigger: JobTrigger(type: .time, at: iso.string(from: clock.now)),
                instruction: "scan sessions, flag stuck ones", onResult: "alert",
                label: "stuck scan", nextFireAt: iso.string(from: clock.now)))
            sched.tick()
            check("agentic job invoked runner once", runner.runs == 1)
            check("agentic result posted as alert", sched.alerts.first?.text == "flagged 2 stuck sessions")
        }

        // 4) §9.5 rate floor: interval job cannot fire faster than perJobFloor.
        do {
            let clock = ManualClock()
            let runner = FakeAgenticRunner(output: "x")
            let sched = Scheduler(clock: clock, runner: runner, store: tempStore(),
                                  perJobFloor: 60, globalFloor: 5)
            sched.addJob(Job(
                id: "i", kind: .static,
                trigger: JobTrigger(type: .interval, everyMs: 500),  // asks 0.5s
                action: JobAction(type: .alert, text: "tick"),
                label: "fast interval", nextFireAt: iso.string(from: clock.now)))
            sched.tick()                       // fires once
            let afterFirst = sched.alerts.count
            clock.advance(by: 1); sched.tick() // 1s later — floor blocks
            let afterSecond = sched.alerts.count
            clock.advance(by: 61); sched.tick() // >60s — fires again
            let afterThird = sched.alerts.count
            check("interval job fires first time", afterFirst == 1)
            check("rate floor blocks sub-floor re-fire", afterSecond == 1)
            check("interval job fires again past the floor", afterThird == 2)
        }

        return pass
    }
}
