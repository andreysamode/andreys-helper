// Daemon — production wrapper around the Scheduler (Workstream W4, PLAN.md §5,
// §6.5). Owns a serial queue + repeating timer that drives `Scheduler.tick()`
// against the real `SystemClock`, and bridges the broker's completion-transition
// stream into `Scheduler.onCompletion`. All scheduler access is serialized on
// this queue so the scheduler itself stays lock-free.

import Foundation

public final class Daemon {
    private let queue = DispatchQueue(label: "orchestrator.daemon")
    private let scheduler: Scheduler
    private let store: JobStore
    private var timer: DispatchSourceTimer?

    /// Re-published on the daemon queue; the app marshals to main for the UI.
    public var onAlertsChanged: (([Alert]) -> Void)?
    public var onPendingChanged: (([Job]) -> Void)?
    public var onDispatch: ((CommandVerb, CommandArgs) -> Void)?

    public init(
        store: JobStore = JobStore(),
        runner: AgenticRunner = ProcessAgenticRunner(),
        tickInterval: TimeInterval = 1.0
    ) {
        self.store = store
        self.scheduler = Scheduler(clock: SystemClock(), runner: runner, store: store)
        self.tickInterval = tickInterval
        scheduler.onAlertsChanged = { [weak self] a in self?.onAlertsChanged?(a) }
        scheduler.onPendingChanged = { [weak self] p in self?.onPendingChanged?(p) }
        scheduler.onDispatch = { [weak self] v, args in self?.onDispatch?(v, args) }
    }

    private let tickInterval: TimeInterval

    public func start() {
        queue.async { self.scheduler.publishPending() }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + tickInterval, repeating: tickInterval)
        timer.setEventHandler { [weak self] in self?.scheduler.tick() }
        timer.resume()
        self.timer = timer
    }

    public func stop() {
        timer?.cancel()
        timer = nil
    }

    // MARK: Bridges

    /// Wire this to `Broker.onTransition`; forwards `working → done` completions.
    public func handleTransition(sessionId: SessionId, from: SessionStatus, to: SessionStatus) {
        guard from == .working, to == .done else { return }
        queue.async { self.scheduler.onCompletion(sessionId: sessionId) }
    }

    public func addJob(_ job: Job) { queue.async { self.scheduler.addJob(job) } }
    public func removeJob(id: String) { queue.async { self.scheduler.removeJob(id: id) } }
    public func pushAlert(_ text: String) { queue.async { self.scheduler.pushAlert(text) } }
    /// Synchronous snapshot of the current jobs (for the `ah schedule list` verb).
    public func jobsSnapshot() -> [Job] { queue.sync { self.scheduler.jobs } }
    public func ackAlert(id: String) { queue.async { self.scheduler.ackAlert(id: id) } }
    public func ackAllAlerts() { queue.async { self.scheduler.ackAllAlerts() } }
}
