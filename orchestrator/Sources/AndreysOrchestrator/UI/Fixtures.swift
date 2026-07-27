// Fixtures / preview mode (PLAN.md §8 W2 "feed it canned CircleState + tree +
// fake pending jobs"). Lets the UI be verified standalone with `--fixtures`,
// without a broker or daemon running.

import Foundation

public enum Fixtures {
    /// A canned window → worktree → session tree spanning several statuses so §4
    /// precedence is exercised (a `question` session makes the circle show "?").
    public static func windows() -> [RegisteredWindow] {
        [
            RegisteredWindow(
                windowId: "win-core",
                host: .cursor,
                repo: RepoRef(name: "core", trunkPath: "/Users/andrey/dev/core"),
                worktrees: [
                    WorktreeRef(path: "/Users/andrey/dev/core", name: "core", branch: "main", ahead: 0, behind: 0, isTrunk: true),
                    WorktreeRef(path: "/Users/andrey/dev/core-feat", name: "core-feat", branch: "feat/api", ahead: 3, behind: 1, isTrunk: false),
                ],
                sessions: [
                    SessionInfo(tabId: "t1", sessionId: "s1", cwd: "/Users/andrey/dev/core", title: "refactor auth", status: .working, seen: false, col: 1, active: true),
                    SessionInfo(tabId: "t2", sessionId: "s2", cwd: "/Users/andrey/dev/core-feat", title: "add endpoint", status: .question, seen: false, col: 1, active: false),
                ]),
            RegisteredWindow(
                windowId: "win-ah",
                host: .cursor,
                repo: RepoRef(name: "andreys-helper", trunkPath: "/Users/andrey/dev/andreys-helper"),
                worktrees: [
                    WorktreeRef(path: "/Users/andrey/dev/andreys-helper", name: "andreys-helper", branch: "main", ahead: 0, behind: 0, isTrunk: true),
                ],
                sessions: [
                    SessionInfo(tabId: "t3", sessionId: "s3", cwd: "/Users/andrey/dev/andreys-helper", title: "orchestrator app", status: .done, seen: false, col: 1, active: true),
                    SessionInfo(tabId: "t4", sessionId: "s4", cwd: "/Users/andrey/dev/andreys-helper", title: "idle scratch", status: .idle, seen: false, col: 2, active: false),
                ]),
        ]
    }

    /// Canned usage windows for the header bars — one of each kind, including a
    /// scoped window whose label comes from the model name.
    public static func quota(now: Date = Date()) -> QuotaSnapshot {
        QuotaSnapshot(
            bars: [
                QuotaBar(id: "session", label: "cur", title: "Current session",
                         percent: 45, resetsAt: now.addingTimeInterval(2 * 3600)),
                QuotaBar(id: "weekly_all", label: "all", title: "Current week (all models)",
                         percent: 50, resetsAt: now.addingTimeInterval(3 * 86400)),
                QuotaBar(id: "weekly_scoped:Fable", label: "fab", title: "Current week (Fable only)",
                         percent: 10, resetsAt: now.addingTimeInterval(3 * 86400)),
            ],
            fetchedAt: now)
    }

    /// Fake pending scheduled jobs for the bottom strip.
    public static func pendingJobs(now: Date = Date()) -> [Job] {
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime]
        return [
            Job(id: "j1", kind: .static,
                trigger: JobTrigger(type: .time, at: iso.string(from: now.addingTimeInterval(600))),
                action: JobAction(type: .alert, text: "Standup"),
                label: "Standup", nextFireAt: iso.string(from: now.addingTimeInterval(600))),
            Job(id: "j2", kind: .agentic,
                trigger: JobTrigger(type: .interval, everyMs: 3_600_000),
                instruction: "scan sessions, flag stuck ones", onResult: "alert",
                label: "Stuck-session scan", nextFireAt: iso.string(from: now.addingTimeInterval(1800))),
        ]
    }
}
