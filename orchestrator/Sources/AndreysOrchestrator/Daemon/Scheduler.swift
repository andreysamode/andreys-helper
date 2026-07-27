// Scheduler — evaluates job triggers, runs actions, feeds the alert queue and
// the pending-jobs strip (PLAN.md §6.5, §8 W4, §9.5 rate floors).
//
// Pure and single-threaded by design: it reads time only from the injected
// `Clock` and runs agentic work only through the injected `AgenticRunner`, so
// the self-test drives it deterministically. The `Daemon` wraps it with a real
// timer + queue for production. Nothing here touches the wall clock.

import Foundation

/// A fired, unacked alert shown on the circle's `!` badge (PLAN.md §4).
public struct Alert: Identifiable, Sendable, Equatable {
    public let id: String
    public var text: String
    public var createdAt: Date
    public init(id: String = UUID().uuidString, text: String, createdAt: Date) {
        self.id = id
        self.text = text
        self.createdAt = createdAt
    }
}

public final class Scheduler {
    // MARK: Injected collaborators
    private let clock: Clock
    private let runner: AgenticRunner
    private let store: JobStore
    private let scratchDir: String

    /// §9.5 rate floors: a single job cannot fire more often than this, and no
    /// two fires globally can be closer than the global floor. Prevents a tight
    /// interval/completion loop from running away.
    private let perJobFloor: TimeInterval
    private let globalFloor: TimeInterval

    // MARK: Outputs (invoked synchronously; Daemon marshals to main)
    public var onAlertsChanged: (([Alert]) -> Void)?
    public var onPendingChanged: (([Job]) -> Void)?
    /// A `static` dispatch action asks the broker to route a command.
    public var onDispatch: ((CommandVerb, CommandArgs) -> Void)?

    // MARK: State
    private(set) public var alerts: [Alert] = []
    private var lastRunAt: [String: Date] = [:]
    private var lastGlobalRunAt: Date?

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    public init(
        clock: Clock,
        runner: AgenticRunner,
        store: JobStore,
        scratchDir: String = Bootstrap.baseDir.appendingPathComponent("scratch").path,
        perJobFloor: TimeInterval = 60,
        globalFloor: TimeInterval = 5
    ) {
        self.clock = clock
        self.runner = runner
        self.store = store
        self.scratchDir = scratchDir
        self.perJobFloor = perJobFloor
        self.globalFloor = globalFloor
    }

    // MARK: Public API

    public var jobs: [Job] { store.jobs }

    public func addJob(_ job: Job) {
        store.upsert(job)
        publishPending()
    }

    public func removeJob(id: String) {
        store.remove(id: id)
        publishPending()
    }

    /// Clear one fired alert (circle click-to-ack, PLAN.md §4).
    public func ackAlert(id: String) {
        alerts.removeAll { $0.id == id }
        onAlertsChanged?(alerts)
    }

    public func ackAllAlerts() {
        alerts.removeAll()
        onAlertsChanged?(alerts)
    }

    /// Push an ad-hoc alert (the `ah alert` verb / any producer).
    public func pushAlert(_ text: String) {
        enqueueAlert(text)
    }

    /// Emit the current pending-jobs list to the UI strip.
    public func publishPending() {
        onPendingChanged?(pendingJobs())
    }

    /// Jobs still scheduled to fire (time/interval with a future/next fire, plus
    /// all completion watchers). Shown in the state-2 bottom strip.
    public func pendingJobs() -> [Job] {
        store.jobs.filter { job in
            switch job.trigger.type {
            case .completion: return true
            case .time, .interval:
                guard let fire = Self.iso.date(from: job.nextFireAt) else { return true }
                return fire >= clock.now.addingTimeInterval(-1)
            }
        }
    }

    // MARK: Time-driven evaluation

    /// Evaluate all time/interval triggers against the injected clock. Called on
    /// every timer tick in production; called explicitly in tests.
    public func tick() {
        let now = clock.now
        for job in store.jobs {
            switch job.trigger.type {
            case .time, .interval:
                guard let fire = Self.iso.date(from: job.nextFireAt), fire <= now else { continue }
                attemptFire(job)
            case .completion:
                break  // driven by onCompletion, not the clock.
            }
        }
        publishPending()
    }

    // MARK: Completion-driven evaluation

    /// A session transitioned `working → done` (from the broker). Fire every
    /// completion job watching that session (PLAN.md §6.5 completion trigger).
    public func onCompletion(sessionId: SessionId) {
        for job in store.jobs where job.trigger.type == .completion
            && job.trigger.sessionId == sessionId {
            attemptFire(job)
        }
        publishPending()
    }

    // MARK: Firing + rate floors (§9.5)

    private func attemptFire(_ job: Job) {
        let now = clock.now
        // Per-job floor.
        if let last = lastRunAt[job.id], now.timeIntervalSince(last) < perJobFloor {
            deferJob(job, until: last.addingTimeInterval(perJobFloor))
            return
        }
        // Global floor.
        if let g = lastGlobalRunAt, now.timeIntervalSince(g) < globalFloor {
            deferJob(job, until: g.addingTimeInterval(globalFloor))
            return
        }

        lastRunAt[job.id] = now
        lastGlobalRunAt = now
        fire(job)
        reschedule(job, firedAt: now)
    }

    private func fire(_ job: Job) {
        switch job.kind {
        case .static:
            guard let action = job.action else { return }
            switch action.type {
            case .alert:
                enqueueAlert(action.text ?? job.label)
            case .dispatch:
                if let verb = action.verb {
                    onDispatch?(verb, action.args ?? CommandArgs())
                }
            }
        case .agentic:
            let instruction = job.instruction ?? ""
            let onResult = job.onResult
            runner.run(instruction: instruction, cwd: scratchDir) { [weak self] result in
                guard let self else { return }
                if onResult == "alert" {
                    let text: String
                    switch result {
                    case .success(let out): text = out.isEmpty ? "\(job.label): (no output)" : out
                    case .failure(let err): text = "\(job.label) failed: \(err)"
                    }
                    self.enqueueAlert(text)
                }
            }
        }
    }

    /// Advance a fired job: interval reschedules; time/completion are one-shot
    /// and are removed once fired.
    private func reschedule(_ job: Job, firedAt now: Date) {
        switch job.trigger.type {
        case .interval:
            guard let everyMs = job.trigger.everyMs else { store.remove(id: job.id); return }
            let period = max(TimeInterval(everyMs) / 1000.0, perJobFloor)
            var updated = job
            updated.nextFireAt = Self.iso.string(from: now.addingTimeInterval(period))
            store.upsert(updated)
        case .time, .completion:
            store.remove(id: job.id)
        }
    }

    /// Push a throttled job's next fire forward without running it.
    private func deferJob(_ job: Job, until date: Date) {
        guard job.trigger.type != .completion else { return }
        var updated = job
        updated.nextFireAt = Self.iso.string(from: date)
        store.upsert(updated)
    }

    private func enqueueAlert(_ text: String) {
        alerts.append(Alert(text: text, createdAt: clock.now))
        onAlertsChanged?(alerts)
    }
}
