/**
 * Shared wire contract for the AndreysOrchestrator ("The Circle").
 *
 * This file is the TypeScript half of the Phase-0 protocol freeze (PLAN.md §6).
 * Its Swift mirror is `orchestrator/Sources/AndreysOrchestrator/Model/Protocol.swift`; the two
 * MUST stay structurally identical — same message set, same field names, same
 * enum cases. Everything here is pure types plus a couple of const literals
 * (protocol version + verb names). No runtime dependencies.
 *
 * Transport: JSON over a localhost WebSocket. WS frames are message-delimited, so
 * no newline framing is used. Every message carries `"v": 1` (PLAN.md §6).
 */

import type { WorkflowRun } from "../workflowProgress";

/** Current protocol version, stamped on every message (PLAN.md §6). */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

// --- §6.1 Session & window addressing ---------------------------------------

/**
 * Stable per-connected-window id for the app's lifetime. The extension generates
 * a UUID at activation and re-announces it on reconnect (PLAN.md §6.1).
 */
export type WindowId = string;

/**
 * The persistent Claude session uuid — the durable, global key for
 * steer/stop/chain. May be absent briefly on a freshly-spawned tab, in which case
 * the tab is addressed by {@link TabId} until the handshake completes (PLAN.md §6.1).
 */
export type SessionId = string;

/**
 * The per-window panel id (`ClaudeTab.id`). Used to address a tab BEFORE its
 * `sessionId` exists; the extension emits a `sessionId` update once known
 * (temp-id → sessionId handshake) (PLAN.md §6.1).
 */
export type TabId = string;

/** Editor host that a window belongs to (PLAN.md §6.2 `hello`). */
export type Host = "cursor" | "vscode";

/**
 * Live status a session can be in, as emitted by the patched Claude bundle.
 * Mirrors `ClaudeTabStatus` in `src/claudeStatus.ts` exactly (PLAN.md §4).
 */
export type SessionStatus =
  | "working"
  | "question"
  | "plan"
  | "permission"
  | "done"
  | "idle";

// --- §6.2 WS message payloads (shared sub-shapes) ----------------------------

/** The window's repo identity, sent in `hello` (PLAN.md §6.2). */
export interface RepoRef {
  /** Display name of the repo (e.g. "core"). */
  name: string;
  /** Absolute path of the repo root opened in the window. */
  trunkPath: string;
}

/**
 * One worktree of the window's repo, as published in a `snapshot`. Mirrors the
 * surfaced subset of `WorktreeInfo` in `src/scmInfo.ts` (PLAN.md §6.2).
 */
export interface WorktreeRef {
  /** Absolute worktree path (realpath-normalized) — the match key. */
  path: string;
  /** Basename, for display. */
  name: string;
  /** Branch name, or "" when detached. */
  branch: string;
  /** Commits in this worktree not in trunk. */
  ahead: number;
  /** Commits in trunk not in this worktree. */
  behind: number;
  /** This worktree IS the window's trunk. */
  isTrunk: boolean;
  /**
   * The name the user gave this worktree's row in the Source Control+ pane.
   * ABSENT when they never renamed it, so the orchestrator falls back to the
   * branch exactly as that pane does. Optional keeps older decoders (and the
   * unrenamed common case) seeing today's shape, so no version bump.
   */
  displayName?: string;
}

/**
 * One live Claude session in a window, as published in a `snapshot`. Mirrors the
 * surfaced subset of `ClaudeTab` in `src/claudeStatus.ts` (PLAN.md §6.2).
 */
export interface SessionInfo {
  /** Per-window panel id; addresses the tab before its sessionId exists. */
  tabId: TabId;
  /** Persistent Claude session uuid, or null until the session exists. */
  sessionId: SessionId | null;
  /** Realpath-normalized worktree cwd the session runs in. */
  cwd: string;
  /** Current tab title. */
  title: string;
  /** Live status glyph source. */
  status: SessionStatus;
  /** Whether the completion has been revealed/seen (folds `done` → idle). */
  seen: boolean;
  /** Editor group column the panel is in. */
  col: number;
  /** Whether this panel is the active editor tab. */
  active: boolean;
  /**
   * The dynamic workflow this session is running, or most recently ran
   * (WORKFLOW-PROGRESS.md §3.3). ABSENT on every session that isn't running one,
   * and on all of them when Claude is unpatched — so a decoder that doesn't know
   * the key simply keeps seeing today's shape, which is why this could be added
   * without a protocol-version bump. The Swift mirror gains the matching struct
   * when the orchestrator renders workflow progress; until then it ignores the key.
   *
   * Type-only import: this file still has no runtime dependencies, and reusing
   * `WorkflowRun` keeps the wire names identical on both sides of the hop rather
   * than restating the shape here and letting the two drift.
   */
  wf?: WorkflowRun;
}

// --- §6.2 Extension → Broker messages ----------------------------------------

/** Sent by the extension on connect to register the window (PLAN.md §6.2). */
export interface HelloMessage {
  v: ProtocolVersion;
  type: "hello";
  windowId: WindowId;
  host: Host;
  repo: RepoRef;
  /** Shared secret from `~/.andreys-helper/token`; rejected if wrong (PLAN.md §6.4, §9.3). */
  token: string;
}

/**
 * Live snapshot, debounced and sent whenever ScmInfo or ClaudeStatus changes
 * (PLAN.md §6.2).
 */
export interface SnapshotMessage {
  v: ProtocolVersion;
  type: "snapshot";
  windowId: WindowId;
  worktrees: WorktreeRef[];
  sessions: SessionInfo[];
  /**
   * Whether this window is the frontmost/focused editor window right now
   * (`vscode.window.state.focused`). The broker uses the last window to report
   * `true` as the "upfront" window; the orchestrator's session pane gives that
   * window's active tab its full active styling (PLAN.md §3).
   */
  focused: boolean;
}

/** Ack/result of a command routed to the extension (PLAN.md §6.2). */
export interface ResultMessage {
  v: ProtocolVersion;
  type: "result";
  cmdId: string;
  ok: boolean;
  /** Verb-specific result payload; null/absent on failure. */
  data: unknown | null;
  /** Human-readable failure reason, or null on success. */
  error: string | null;
}

/** Any message the extension sends to the broker. */
export type ExtensionMessage = HelloMessage | SnapshotMessage | ResultMessage;

// --- §6.2 Broker → Extension messages (commands) -----------------------------

/** The set of command verbs the extension MUST implement (PLAN.md §6.2). */
export const COMMAND_VERBS = [
  "spawnSession",
  "sendPrompt",
  "interrupt",
  "reveal",
  "createWorktree",
  "rename",
  "listWorktrees",
] as const;

/** Union of command verbs (PLAN.md §6.2 command table). */
export type CommandVerb = (typeof COMMAND_VERBS)[number];

/** How a newly created worktree should be opened (PLAN.md §6.2 `createWorktree`). */
export type OpenTarget = "tab" | "window";

/** Per-verb argument shapes (PLAN.md §6.2 command table). */
export interface CommandArgs {
  /** `openWorktreeClaudeTab` (+ `submitPrompt` once session ready). */
  spawnSession: {
    worktreePath: string;
    prompt?: string;
    attachments?: string[];
  };
  /** `submitPrompt`. */
  sendPrompt: {
    sessionId: SessionId;
    text: string;
    attachments?: string[];
  };
  /** Esc/`wtInterrupt` path (new exposed command). */
  interrupt: {
    sessionId: SessionId;
  };
  /** `reveal` (also foregrounds window). */
  reveal: {
    sessionId: SessionId;
  };
  /** `wt switch` flow (from `extension.ts#newWorktree`). */
  createWorktree: {
    repoRoot: string;
    branch: string;
    full?: boolean;
    open: OpenTarget;
  };
  /** `rename`. */
  rename: {
    sessionId: SessionId;
    title: string;
  };
  /** `wt list`. */
  listWorktrees: Record<string, never>;
}

/**
 * A command dispatched from the broker to a window's extension. `verb` selects
 * the entry in {@link CommandArgs} that `args` must match (PLAN.md §6.2).
 */
export interface CommandMessage<V extends CommandVerb = CommandVerb> {
  v: ProtocolVersion;
  type: "command";
  /** Correlation id; echoed back in the matching {@link ResultMessage}. */
  cmdId: string;
  verb: V;
  args: CommandArgs[V];
}

/** Any message the broker sends to the extension. */
export type BrokerMessage = CommandMessage;

/** Any protocol message on the wire, in either direction. */
export type WireMessage = ExtensionMessage | BrokerMessage;

// --- §4 Circle state ---------------------------------------------------------

/**
 * The circle's aggregate category, in precedence order (highest first):
 * alert > needs-input > done-unseen > working > idle (PLAN.md §4).
 */
export type CircleCategory =
  | "alert"
  | "needs-input"
  | "done-unseen"
  | "working"
  | "idle";

/**
 * Aggregated state the broker derives across all windows and hands to the UI.
 * Delivered internally (may be direct Swift, not WS) (PLAN.md §4, §6.2).
 */
export interface CircleState {
  /** The single highest-priority category currently in play. */
  category: CircleCategory;
  /**
   * Size of the winning category. `working` renders a spinner with NO number
   * (count is not shown); `alert` uses {@link CircleState.alertCount}.
   */
  count: number;
  /** Queued unacked alerts (drives the "!" badge), independent of `count`. */
  alertCount: number;
  /**
   * Number of sessions currently working (0…N), INDEPENDENT of `category` —
   * drives the rotating rim dashes (rendered 1…5, capped) which keep spinning
   * even while the center glyph shows an attention state.
   */
  workingCount: number;
  /**
   * Sessions asking a question / awaiting plan/permission. Presence (not the
   * number) drives a "?" glyph, shown beside "✓" when both apply.
   */
  needsInputCount: number;
  /** Finished-but-unseen sessions. Presence drives a "✓" glyph. */
  doneUnseenCount: number;
}

// --- §6.4 Config -------------------------------------------------------------

/**
 * Persisted circle window position (PLAN.md §6.4). Multi-monitor: the window
 * remembers its screen + position.
 */
export interface CircleConfig {
  /** Identifier of the screen the circle lives on. */
  screen: string;
  x: number;
  y: number;
}

/** Orchestrator settings (PLAN.md §6.4). */
export interface OrchestratorConfig {
  /** Neutral workspace cwd for orchestrator `claude` sessions. */
  workspace: string;
  /** Whether state-3 (orchestrator) is hidden by default. */
  hideByDefault: boolean;
}

/**
 * Shape of `~/.andreys-helper/config.json` (PLAN.md §6.4). Shared by the app,
 * the extension, and the `ah` CLI. The token lives separately in
 * `~/.andreys-helper/token` (0600), generated on first run.
 */
export interface Config {
  /** Broker WS port. */
  port: number;
  /** Dirs scanned for cold repos (windowless) in addition to open windows. */
  repoScanDirs: string[];
  /** Remembered circle window placement. */
  circle: CircleConfig;
  orchestrator: OrchestratorConfig;
}

/** The §6.4 defaults written on first run. */
export const DEFAULT_CONFIG: Config = {
  port: 47615,
  repoScanDirs: ["/Users/andrey/dev"],
  circle: { screen: "", x: 0, y: 0 },
  orchestrator: {
    workspace: "~/.andreys-helper/orchestrator",
    hideByDefault: true,
  },
};

// --- §6.5 Job model ----------------------------------------------------------

/** Whether a job runs a fixed action or a headless agentic instruction (PLAN.md §6.5). */
export type JobKind = "static" | "agentic";

/** Fire at an absolute time. */
export interface TimeTrigger {
  type: "time";
  /** ISO-8601 timestamp. */
  at: string;
}

/** Fire on a repeating interval. */
export interface IntervalTrigger {
  type: "interval";
  everyMs: number;
}

/** Fire when a session's run completes (working → done). */
export interface CompletionTrigger {
  type: "completion";
  sessionId: SessionId;
}

/** When a job fires (PLAN.md §6.5). */
export type JobTrigger = TimeTrigger | IntervalTrigger | CompletionTrigger;

/** Push an alert to the circle. */
export interface AlertAction {
  type: "alert";
  text: string;
}

/** Dispatch a command through the broker. */
export interface DispatchAction {
  type: "dispatch";
  verb: CommandVerb;
  args: CommandArgs[CommandVerb];
}

/** What a `static` job does when it fires (PLAN.md §6.5). */
export type JobAction = AlertAction | DispatchAction;

/**
 * A scheduled job, persisted in `~/.andreys-helper/jobs.json` (PLAN.md §6.5).
 * `static` jobs carry `action`; `agentic` jobs carry `instruction` + `onResult`.
 */
export interface Job {
  id: string;
  kind: JobKind;
  trigger: JobTrigger;
  /** Present for `static` jobs. */
  action?: JobAction;
  /** Present for `agentic` jobs — headless `claude -p <instruction>`. */
  instruction?: string;
  /** Present for `agentic` jobs — e.g. "alert": result → circle alert. */
  onResult?: string;
  /** Shown in the pending-jobs strip. */
  label: string;
  /** ISO-8601 next scheduled fire time. */
  nextFireAt: string;
}
