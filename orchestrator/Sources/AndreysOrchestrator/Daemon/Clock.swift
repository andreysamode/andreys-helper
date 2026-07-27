// Injectable clock for the scheduler (PLAN.md §8 W4 "injectable clock").
//
// The scheduler never reads the wall clock directly — it reads `Clock.now`, so
// tests can drive time deterministically with `ManualClock` while production
// uses `SystemClock`.

import Foundation

public protocol Clock: AnyObject {
    var now: Date { get }
}

/// Real wall-clock time.
public final class SystemClock: Clock {
    public init() {}
    public var now: Date { Date() }
}

/// Deterministic clock for tests. Time only moves when `advance`/`set` is called.
public final class ManualClock: Clock {
    private var current: Date
    public init(_ start: Date = Date(timeIntervalSince1970: 1_700_000_000)) {
        self.current = start
    }
    public var now: Date { current }
    public func advance(by seconds: TimeInterval) { current = current.addingTimeInterval(seconds) }
    public func set(_ date: Date) { current = date }
}
