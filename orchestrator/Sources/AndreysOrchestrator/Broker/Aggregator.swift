// Snapshot aggregation — folds every connected window's sessions into a single
// `CircleState` (PLAN.md §4 precedence) and builds the merged
// window → worktree → session tree that feeds the UI panes (W2). Pure functions
// so W3's self-test can assert them without any networking.

import Foundation

// MARK: - Registry entry

/// One connected window's most-recent state, held by the broker registry.
/// Combines the `hello` identity with the latest `snapshot` payload (PLAN.md §6.2).
public struct RegisteredWindow: Sendable {
    public var windowId: WindowId
    public var host: Host
    public var repo: RepoRef
    public var worktrees: [WorktreeRef]
    public var sessions: [SessionInfo]
    /// Whether this window claimed `vscode.window.state.focused` in its latest
    /// snapshot. Live state, not a latch — see `Broker.upfrontWindowId`.
    public var focused: Bool

    public init(
        windowId: WindowId, host: Host, repo: RepoRef,
        worktrees: [WorktreeRef] = [], sessions: [SessionInfo] = [],
        focused: Bool = false
    ) {
        self.windowId = windowId
        self.host = host
        self.repo = repo
        self.worktrees = worktrees
        self.sessions = sessions
        self.focused = focused
    }
}

// MARK: - UI tree

/// Merged window → worktree → session tree handed to the UI panes (PLAN.md §3).
public struct SessionTree: Sendable, Equatable {
    public var windows: [WindowNode]
    public init(windows: [WindowNode] = []) { self.windows = windows }
}

public struct WindowNode: Sendable, Identifiable, Equatable {
    public var id: WindowId { windowId }
    public var windowId: WindowId
    public var repoName: String
    public var repoPath: String
    public var host: Host
    /// True for the single frontmost editor window (last to report focus). Its
    /// active tab gets the full "upfront" styling; other windows' active tabs
    /// get the lighter window-active styling (PLAN.md §3).
    public var isUpfront: Bool
    public var worktrees: [WorktreeNode]
}

public struct WorktreeNode: Sendable, Identifiable, Equatable {
    public var id: String { path }
    public var path: String
    public var name: String
    public var branch: String
    public var ahead: Int
    public var behind: Int
    public var isTrunk: Bool
    public var sessions: [SessionInfo]
}

// SessionInfo (from Protocol.swift) is the leaf; make it usable in SwiftUI lists.
extension SessionInfo: Identifiable {
    public var id: String { sessionId ?? tabId }
}
extension SessionInfo: Equatable {
    public static func == (lhs: SessionInfo, rhs: SessionInfo) -> Bool {
        lhs.tabId == rhs.tabId && lhs.sessionId == rhs.sessionId
            && lhs.cwd == rhs.cwd && lhs.title == rhs.title
            && lhs.status == rhs.status && lhs.seen == rhs.seen
            && lhs.col == rhs.col && lhs.active == rhs.active
    }
}

/// How a session box is drawn in the state-2 pane (PLAN.md §3). Lives here
/// rather than in the view so the reveal self-test asserts the same rule the
/// pane renders.
public enum SessionVisual: Sendable, Equatable {
    /// Not its window's active tab: muted outline, warm fill.
    case inactive
    /// Active tab of a window that ISN'T frontmost: terracotta outline only.
    case windowActive
    /// Active tab of the frontmost window: double terracotta border, cream fill.
    case upfront

    public static func of(_ session: SessionInfo, windowUpfront: Bool) -> SessionVisual {
        guard session.active else { return .inactive }
        return windowUpfront ? .upfront : .windowActive
    }
}

// MARK: - Aggregator

public enum Aggregator {

    /// Fold one session's live status into a circle category (PLAN.md §4 table).
    /// `done` that has been seen folds to `idle`.
    public static func fold(_ session: SessionInfo) -> CircleCategory {
        switch session.status {
        case .question, .plan, .permission:
            return .needsInput
        case .done:
            return session.seen ? .idle : .doneUnseen
        case .working:
            return .working
        case .idle:
            return .idle
        }
    }

    /// Aggregate all windows' sessions into the single highest-priority
    /// `CircleState` (PLAN.md §4 precedence). `alertCount` is supplied by the
    /// daemon and, when > 0, wins over everything.
    public static func aggregate(
        windows: [RegisteredWindow], alertCount: Int
    ) -> CircleState {
        var needsInput = 0
        var doneUnseen = 0
        var working = 0
        for window in windows {
            for session in window.sessions {
                switch fold(session) {
                case .needsInput: needsInput += 1
                case .doneUnseen: doneUnseen += 1
                case .working: working += 1
                case .idle, .alert: break
                }
            }
        }

        // Precedence picks the CENTER glyph (alert → needs-input → done-unseen →
        // working → idle). `workingCount` rides on EVERY result, independent of the
        // winning category, so the rotating rim dashes keep spinning to show N
        // things are still working even while the center shows "?" or "✓".
        // Every result carries all four tallies so the circle can composite them:
        // rim dashes (working), and center glyphs "?" (needs-input) + "✓"
        // (done-unseen) shown together when both apply. `category` is still the
        // precedence winner, used only for tap/tint behavior.
        func state(_ category: CircleCategory, _ count: Int, alert: Int = 0) -> CircleState {
            CircleState(
                category: category, count: count, alertCount: alert,
                workingCount: working, needsInputCount: needsInput, doneUnseenCount: doneUnseen)
        }
        if alertCount > 0 { return state(.alert, alertCount, alert: alertCount) }
        if needsInput > 0 { return state(.needsInput, needsInput) }
        if doneUnseen > 0 { return state(.doneUnseen, doneUnseen) }
        if working > 0 { return state(.working, working) }
        return state(.idle, 0)
    }

    /// Build the merged window → worktree → session tree for the UI panes.
    /// Sessions are grouped under the worktree whose realpath matches their
    /// `cwd`; a session whose cwd matches no declared worktree gets a synthetic
    /// group so nothing is dropped (PLAN.md §3).
    public static func buildTree(
        windows: [RegisteredWindow], upfront: WindowId? = nil
    ) -> SessionTree {
        var nodes: [WindowNode] = []
        for window in windows {
            // Seed a worktree node per declared worktree, trunk first.
            var byPath: [String: WorktreeNode] = [:]
            var order: [String] = []
            for wt in window.worktrees {
                byPath[wt.path] = WorktreeNode(
                    path: wt.path, name: wt.name, branch: wt.branch,
                    ahead: wt.ahead, behind: wt.behind, isTrunk: wt.isTrunk,
                    sessions: [])
                order.append(wt.path)
            }
            // Attach sessions to their worktree by cwd; synthesize if unknown.
            for session in window.sessions {
                if byPath[session.cwd] != nil {
                    byPath[session.cwd]!.sessions.append(session)
                } else {
                    let name = (session.cwd as NSString).lastPathComponent
                    byPath[session.cwd] = WorktreeNode(
                        path: session.cwd, name: name.isEmpty ? session.cwd : name,
                        branch: "", ahead: 0, behind: 0, isTrunk: false,
                        sessions: [session])
                    order.append(session.cwd)
                }
            }
            // Every declared worktree is kept — even with no sessions — so the
            // pane mirrors the Source+ panel (branch headers for all open
            // worktrees). Trunk floats to the top; declared order is otherwise
            // preserved (stable partition, not an unstable sort).
            let all = order.compactMap { byPath[$0] }
            let sorted = all.filter { $0.isTrunk } + all.filter { !$0.isTrunk }
            nodes.append(
                WindowNode(
                    windowId: window.windowId,
                    repoName: window.repo.name,
                    repoPath: window.repo.trunkPath,
                    host: window.host,
                    isUpfront: window.windowId == upfront,
                    worktrees: sorted))
        }
        return SessionTree(windows: nodes)
    }
}
