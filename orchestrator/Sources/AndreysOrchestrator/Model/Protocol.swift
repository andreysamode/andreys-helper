// Shared wire contract for the AndreysOrchestrator ("The Circle").
//
// This file is the Swift half of the Phase-0 protocol freeze (PLAN.md §6). Its
// TypeScript mirror is `src/broker/protocol.ts`; the two MUST stay structurally
// identical — same message set, same field names, same enum cases. Everything
// here is `Codable`. This is the Swift side used by the broker (W3), UI (W2),
// and daemon (W4).
//
// Transport: JSON over a localhost WebSocket. WS frames are message-delimited,
// so no newline framing is used. Every message carries `"v": 1` (PLAN.md §6).
//
// Where a Swift name would differ from the JSON key, a `CodingKeys` enum pins
// the wire name so the two languages agree byte-for-byte.

import Foundation

/// Current protocol version, stamped on every message (PLAN.md §6).
public let protocolVersion = 1

// MARK: - §6.1 Session & window addressing

/// Stable per-connected-window id for the app's lifetime. The extension
/// generates a UUID at activation and re-announces it on reconnect (PLAN.md §6.1).
public typealias WindowId = String

/// The persistent Claude session uuid — the durable, global key for
/// steer/stop/chain. May be absent briefly on a freshly-spawned tab (PLAN.md §6.1).
public typealias SessionId = String

/// The per-window panel id (`ClaudeTab.id`). Used to address a tab BEFORE its
/// `sessionId` exists; a `sessionId` update follows once known (PLAN.md §6.1).
public typealias TabId = String

/// Editor host that a window belongs to (PLAN.md §6.2 `hello`).
public enum Host: String, Codable, Sendable {
    case cursor
    case vscode
}

/// Live status a session can be in, as emitted by the patched Claude bundle.
/// Mirrors `ClaudeTabStatus` in `src/claudeStatus.ts` exactly (PLAN.md §4).
public enum SessionStatus: String, Codable, Sendable {
    case working
    case question
    case plan
    case permission
    case done
    case idle
}

// MARK: - §6.2 WS message payloads (shared sub-shapes)

/// The window's repo identity, sent in `hello` (PLAN.md §6.2).
public struct RepoRef: Codable, Sendable {
    /// Display name of the repo (e.g. "core").
    public var name: String
    /// Absolute path of the repo root opened in the window.
    public var trunkPath: String

    public init(name: String, trunkPath: String) {
        self.name = name
        self.trunkPath = trunkPath
    }
}

/// One worktree of the window's repo, as published in a `snapshot`. Mirrors the
/// surfaced subset of `WorktreeInfo` in `src/scmInfo.ts` (PLAN.md §6.2).
public struct WorktreeRef: Codable, Sendable {
    /// Absolute worktree path (realpath-normalized) — the match key.
    public var path: String
    /// Basename, for display.
    public var name: String
    /// Branch name, or "" when detached.
    public var branch: String
    /// Commits in this worktree not in trunk.
    public var ahead: Int
    /// Commits in trunk not in this worktree.
    public var behind: Int
    /// This worktree IS the window's trunk.
    public var isTrunk: Bool
    /// The name the user gave this row in the Source Control+ pane. Absent when
    /// they never renamed it, so the pane here falls back to the branch exactly
    /// as Source+ does. Optional, so older extensions still decode.
    public var displayName: String?

    public init(
        path: String, name: String, branch: String,
        ahead: Int, behind: Int, isTrunk: Bool, displayName: String? = nil
    ) {
        self.path = path
        self.name = name
        self.branch = branch
        self.ahead = ahead
        self.behind = behind
        self.isTrunk = isTrunk
        self.displayName = displayName
    }
}

/// One live Claude session in a window, as published in a `snapshot`. Mirrors
/// the surfaced subset of `ClaudeTab` in `src/claudeStatus.ts` (PLAN.md §6.2).
public struct SessionInfo: Codable, Sendable {
    /// Per-window panel id; addresses the tab before its sessionId exists.
    public var tabId: TabId
    /// Persistent Claude session uuid, or nil until the session exists.
    public var sessionId: SessionId?
    /// Realpath-normalized worktree cwd the session runs in.
    public var cwd: String
    /// Current tab title.
    public var title: String
    /// Live status glyph source.
    public var status: SessionStatus
    /// Whether the completion has been revealed/seen (folds `done` → idle).
    public var seen: Bool
    /// Editor group column the panel is in.
    public var col: Int
    /// Whether this panel is the active editor tab.
    public var active: Bool

    public init(
        tabId: TabId, sessionId: SessionId?, cwd: String, title: String,
        status: SessionStatus, seen: Bool, col: Int, active: Bool
    ) {
        self.tabId = tabId
        self.sessionId = sessionId
        self.cwd = cwd
        self.title = title
        self.status = status
        self.seen = seen
        self.col = col
        self.active = active
    }
}

// MARK: - §6.2 Message envelope

/// The `type` tag carried by every message envelope (PLAN.md §6.2).
public enum MessageType: String, Codable, Sendable {
    case hello
    case snapshot
    case result
    case command
}

// MARK: - §6.2 Extension → Broker messages

/// Sent by the extension on connect to register the window (PLAN.md §6.2).
public struct HelloMessage: Codable, Sendable {
    public var v: Int
    public var type: MessageType
    public var windowId: WindowId
    public var host: Host
    public var repo: RepoRef
    /// Shared secret from `~/.andreys-helper/token`; rejected if wrong
    /// (PLAN.md §6.4, §9.3).
    public var token: String

    public init(
        windowId: WindowId, host: Host, repo: RepoRef, token: String
    ) {
        self.v = protocolVersion
        self.type = .hello
        self.windowId = windowId
        self.host = host
        self.repo = repo
        self.token = token
    }
}

/// Live snapshot, debounced and sent whenever ScmInfo or ClaudeStatus changes
/// (PLAN.md §6.2).
public struct SnapshotMessage: Codable, Sendable {
    public var v: Int
    public var type: MessageType
    public var windowId: WindowId
    public var worktrees: [WorktreeRef]
    public var sessions: [SessionInfo]
    /// Whether this window is frontmost/focused (`vscode.window.state.focused`).
    /// Optional so an older extension that predates the field still decodes
    /// (treated as `false`); the broker picks the last window reporting `true`
    /// as the "upfront" window for session-pane styling (PLAN.md §3).
    public var focused: Bool?

    public init(
        windowId: WindowId, worktrees: [WorktreeRef], sessions: [SessionInfo],
        focused: Bool = false
    ) {
        self.v = protocolVersion
        self.type = .snapshot
        self.windowId = windowId
        self.worktrees = worktrees
        self.sessions = sessions
        self.focused = focused
    }
}

/// Ack/result of a command routed to the extension (PLAN.md §6.2).
///
/// `data` is verb-specific JSON, kept as a type-erased `AnyCodable` so the shared
/// contract need not enumerate every payload; null on failure. `error` is a
/// human-readable failure reason, or nil on success.
public struct ResultMessage: Codable, Sendable {
    public var v: Int
    public var type: MessageType
    public var cmdId: String
    public var ok: Bool
    public var data: AnyCodable?
    public var error: String?

    public init(
        cmdId: String, ok: Bool, data: AnyCodable? = nil, error: String? = nil
    ) {
        self.v = protocolVersion
        self.type = .result
        self.cmdId = cmdId
        self.ok = ok
        self.data = data
        self.error = error
    }
}

// MARK: - §6.2 Broker → Extension messages (commands)

/// The set of command verbs the extension MUST implement (PLAN.md §6.2).
public enum CommandVerb: String, Codable, Sendable, CaseIterable {
    case spawnSession
    case sendPrompt
    case interrupt
    case reveal
    case createWorktree
    case rename
    case listWorktrees
}

/// How a newly created worktree should be opened (PLAN.md §6.2 `createWorktree`).
public enum OpenTarget: String, Codable, Sendable {
    case tab
    case window
}

/// Per-verb argument payloads (PLAN.md §6.2 command table). All fields carried
/// in a single struct with the verb-relevant subset populated; encodes to the
/// `args` object. Optional fields are omitted when nil.
public struct CommandArgs: Codable, Sendable {
    // spawnSession
    public var worktreePath: String?
    public var prompt: String?
    public var attachments: [String]?
    // sendPrompt / rename / interrupt / reveal
    public var sessionId: SessionId?
    public var text: String?
    public var title: String?
    // createWorktree
    public var repoRoot: String?
    public var branch: String?
    public var full: Bool?
    public var open: OpenTarget?

    public init(
        worktreePath: String? = nil,
        prompt: String? = nil,
        attachments: [String]? = nil,
        sessionId: SessionId? = nil,
        text: String? = nil,
        title: String? = nil,
        repoRoot: String? = nil,
        branch: String? = nil,
        full: Bool? = nil,
        open: OpenTarget? = nil
    ) {
        self.worktreePath = worktreePath
        self.prompt = prompt
        self.attachments = attachments
        self.sessionId = sessionId
        self.text = text
        self.title = title
        self.repoRoot = repoRoot
        self.branch = branch
        self.full = full
        self.open = open
    }
}

/// A command dispatched from the broker to a window's extension. `verb` selects
/// which fields of `args` are meaningful (PLAN.md §6.2).
public struct CommandMessage: Codable, Sendable {
    public var v: Int
    public var type: MessageType
    /// Correlation id; echoed back in the matching `ResultMessage`.
    public var cmdId: String
    public var verb: CommandVerb
    public var args: CommandArgs

    public init(cmdId: String, verb: CommandVerb, args: CommandArgs) {
        self.v = protocolVersion
        self.type = .command
        self.cmdId = cmdId
        self.verb = verb
        self.args = args
    }
}

// MARK: - §4 Circle state

/// The circle's aggregate category, in precedence order (highest first):
/// alert > needs-input > done-unseen > working > idle (PLAN.md §4).
public enum CircleCategory: String, Codable, Sendable {
    case alert
    case needsInput = "needs-input"
    case doneUnseen = "done-unseen"
    case working
    case idle
}

/// Aggregated state the broker derives across all windows and hands to the UI
/// (PLAN.md §4, §6.2).
public struct CircleState: Codable, Sendable {
    /// The single highest-priority category currently in play.
    public var category: CircleCategory
    /// Size of the winning category. `working` renders a spinner with NO number;
    /// `alert` uses `alertCount`.
    public var count: Int
    /// Queued unacked alerts (drives the "!" badge), independent of `count`.
    public var alertCount: Int
    /// Number of sessions currently working (0…N), INDEPENDENT of `category` —
    /// drives the rotating rim dashes, which spin even while the center glyph
    /// shows an attention state (question/done). Rendered as 1…5 dashes (capped).
    public var workingCount: Int
    /// Sessions asking a question / awaiting plan/permission. Presence (not the
    /// number) drives a "?" glyph; shown side-by-side with "✓" when both apply.
    public var needsInputCount: Int
    /// Finished-but-unseen sessions. Presence drives a "✓" glyph.
    public var doneUnseenCount: Int

    public init(
        category: CircleCategory, count: Int, alertCount: Int,
        workingCount: Int = 0, needsInputCount: Int = 0, doneUnseenCount: Int = 0
    ) {
        self.category = category
        self.count = count
        self.alertCount = alertCount
        self.workingCount = workingCount
        self.needsInputCount = needsInputCount
        self.doneUnseenCount = doneUnseenCount
    }
}

// MARK: - §6.4 Config

/// Persisted circle window position (PLAN.md §6.4). Multi-monitor: the window
/// remembers its screen + position.
public struct CircleConfig: Codable, Sendable {
    /// Human-readable screen name (`NSScreen.localizedName`), for display/fallback.
    public var screen: String
    /// Robust screen identity: the `CGDirectDisplayID` of the screen the circle
    /// lives on. Survives display re-ordering better than a name or index; nil
    /// for legacy configs written before this field existed (PLAN.md §3, Phase 3).
    public var displayID: Int?
    public var x: Double
    public var y: Double

    public init(screen: String = "", displayID: Int? = nil, x: Double = 0, y: Double = 0) {
        self.screen = screen
        self.displayID = displayID
        self.x = x
        self.y = y
    }
}

/// Orchestrator settings (PLAN.md §6.4).
public struct OrchestratorConfig: Codable, Sendable {
    /// Neutral workspace cwd for orchestrator `claude` sessions.
    public var workspace: String
    /// Whether state-3 (orchestrator) is hidden by default.
    public var hideByDefault: Bool

    public init(
        workspace: String = "~/.andreys-helper/orchestrator",
        hideByDefault: Bool = true
    ) {
        self.workspace = workspace
        self.hideByDefault = hideByDefault
    }
}

/// Shape of `~/.andreys-helper/config.json` (PLAN.md §6.4). Shared by the app,
/// the extension, and the `ah` CLI. The token lives separately in
/// `~/.andreys-helper/token` (0600), generated on first run.
public struct Config: Codable, Sendable {
    /// Broker WS port.
    public var port: Int
    /// Dirs scanned for cold repos (windowless) in addition to open windows.
    public var repoScanDirs: [String]
    /// Remembered circle window placement.
    public var circle: CircleConfig
    public var orchestrator: OrchestratorConfig
    /// User preference: register the app as a macOS login item (PLAN.md Phase 3).
    /// The authoritative state is `SMAppService.mainApp.status`; this mirrors the
    /// user's last choice so the app can reconcile on launch. Optional for
    /// backward compatibility with configs written before this field existed.
    public var launchAtLogin: Bool?
    /// "Moon mode": the circle renders as a cartoon moon with stars on its rim
    /// instead of the frosted disc. Owned by the EXTENSION setting
    /// `andreysHelper.orchestrator.moonMode`, which patches this key in place;
    /// the app watches the file and re-skins live (`ConfigWatcher`). nil ⇒ off.
    public var moonMode: Bool?

    public init(
        port: Int = 47615,
        repoScanDirs: [String] = ["/Users/andrey/dev"],
        circle: CircleConfig = CircleConfig(),
        orchestrator: OrchestratorConfig = OrchestratorConfig(),
        launchAtLogin: Bool? = nil,
        moonMode: Bool? = nil
    ) {
        self.port = port
        self.repoScanDirs = repoScanDirs
        self.circle = circle
        self.orchestrator = orchestrator
        self.launchAtLogin = launchAtLogin
        self.moonMode = moonMode
    }

    /// Every key falls back to its default when absent, rather than failing the
    /// whole decode.
    ///
    /// Two things depend on this. A config written before a field existed still
    /// loads (synthesised decoding would throw on the missing key, and
    /// `Bootstrap.loadConfig` would silently hand back defaults — losing the
    /// remembered circle position on every upgrade that adds a field). And the
    /// extension can create the file with nothing but `{"moonMode": true}` when
    /// the app has never run, instead of having to invent a whole config.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Config.defaults
        port = try c.decodeIfPresent(Int.self, forKey: .port) ?? d.port
        repoScanDirs = try c.decodeIfPresent([String].self, forKey: .repoScanDirs) ?? d.repoScanDirs
        circle = try c.decodeIfPresent(CircleConfig.self, forKey: .circle) ?? d.circle
        orchestrator =
            try c.decodeIfPresent(OrchestratorConfig.self, forKey: .orchestrator) ?? d.orchestrator
        launchAtLogin = try c.decodeIfPresent(Bool.self, forKey: .launchAtLogin)
        moonMode = try c.decodeIfPresent(Bool.self, forKey: .moonMode)
    }

    /// The §6.4 defaults written on first run.
    ///
    /// Built by the memberwise initialiser, never by decoding, so `init(from:)`
    /// reading it back is not a cycle.
    public static let defaults = Config()
}

// MARK: - §6.5 Job model

/// Whether a job runs a fixed action or a headless agentic instruction
/// (PLAN.md §6.5).
public enum JobKind: String, Codable, Sendable {
    case `static`
    case agentic
}

/// The `type` tag of a job trigger (PLAN.md §6.5).
public enum JobTriggerType: String, Codable, Sendable {
    case time
    case interval
    case completion
}

/// When a job fires (PLAN.md §6.5). One struct carrying the union; the relevant
/// fields are populated per `type`.
public struct JobTrigger: Codable, Sendable {
    public var type: JobTriggerType
    /// `time`: ISO-8601 timestamp.
    public var at: String?
    /// `interval`: period in milliseconds.
    public var everyMs: Int?
    /// `completion`: the session whose completion fires this job.
    public var sessionId: SessionId?

    public init(
        type: JobTriggerType,
        at: String? = nil,
        everyMs: Int? = nil,
        sessionId: SessionId? = nil
    ) {
        self.type = type
        self.at = at
        self.everyMs = everyMs
        self.sessionId = sessionId
    }
}

/// The `type` tag of a static job action (PLAN.md §6.5).
public enum JobActionType: String, Codable, Sendable {
    case alert
    case dispatch
}

/// What a `static` job does when it fires (PLAN.md §6.5). One struct carrying
/// the union; the relevant fields are populated per `type`.
public struct JobAction: Codable, Sendable {
    public var type: JobActionType
    /// `alert`: the alert text.
    public var text: String?
    /// `dispatch`: the command verb.
    public var verb: CommandVerb?
    /// `dispatch`: the command args.
    public var args: CommandArgs?

    public init(
        type: JobActionType,
        text: String? = nil,
        verb: CommandVerb? = nil,
        args: CommandArgs? = nil
    ) {
        self.type = type
        self.text = text
        self.verb = verb
        self.args = args
    }
}

/// A scheduled job, persisted in `~/.andreys-helper/jobs.json` (PLAN.md §6.5).
/// `static` jobs carry `action`; `agentic` jobs carry `instruction` + `onResult`.
public struct Job: Codable, Sendable {
    public var id: String
    public var kind: JobKind
    public var trigger: JobTrigger
    /// Present for `static` jobs.
    public var action: JobAction?
    /// Present for `agentic` jobs — headless `claude -p <instruction>`.
    public var instruction: String?
    /// Present for `agentic` jobs — e.g. "alert": result → circle alert.
    public var onResult: String?
    /// Shown in the pending-jobs strip.
    public var label: String
    /// ISO-8601 next scheduled fire time.
    public var nextFireAt: String

    public init(
        id: String,
        kind: JobKind,
        trigger: JobTrigger,
        action: JobAction? = nil,
        instruction: String? = nil,
        onResult: String? = nil,
        label: String,
        nextFireAt: String
    ) {
        self.id = id
        self.kind = kind
        self.trigger = trigger
        self.action = action
        self.instruction = instruction
        self.onResult = onResult
        self.label = label
        self.nextFireAt = nextFireAt
    }
}

// MARK: - AnyCodable

/// Minimal type-erased Codable value, used for verb-specific `result.data`
/// payloads that the shared contract intentionally leaves open. Supports the
/// JSON scalar/array/object shapes.
public struct AnyCodable: Codable, Sendable {
    public let value: Sendable

    public init(_ value: Sendable) {
        self.value = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self.value = Optional<Int>.none as Sendable
        } else if let b = try? container.decode(Bool.self) {
            self.value = b
        } else if let i = try? container.decode(Int.self) {
            self.value = i
        } else if let d = try? container.decode(Double.self) {
            self.value = d
        } else if let s = try? container.decode(String.self) {
            self.value = s
        } else if let arr = try? container.decode([AnyCodable].self) {
            self.value = arr.map { $0.value }
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            self.value = dict.mapValues { $0.value }
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported AnyCodable value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let b as Bool: try container.encode(b)
        case let i as Int: try container.encode(i)
        case let d as Double: try container.encode(d)
        case let s as String: try container.encode(s)
        case let arr as [Sendable]: try container.encode(arr.map { AnyCodable($0) })
        case let dict as [String: Sendable]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default: try container.encodeNil()
        }
    }
}
