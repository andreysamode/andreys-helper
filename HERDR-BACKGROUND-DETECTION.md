# How herdr detects "still working" (even when the LLM is silent) — and how to replicate it

Source studied: `github.com/ogulcancelik/herdr` (cloned, read directly — not the marketing docs).
Relevant files: `src/detect/mod.rs`, `src/detect/manifest.rs`, `src/detect/manifests/claude.toml`,
`src/pane/agent_detection.rs`, `src/integration/mod.rs`, `src/integration/assets/claude/herdr-agent-state.sh`,
`src/api/schema/common.rs` (`PaneAgentState`).

## 1. What herdr actually does (ground truth)

herdr is a terminal multiplexer — it **owns the PTY** for every pane. It fuses three signals, with a
strict authority hierarchy:

### (a) PTY process-tree detection — *which* agent, and *that it's alive*
`foreground_job(child_pid)` reads the OS process table to find the foreground process **group** under the
pane's shell PID, then `identify_agent()` matches the process name/argv to a known agent. This is how it
knows a `claude` is running in the pane, and — critically — it sees **child processes** (`npm test`,
`cargo build`, a backgrounded shell) that are alive under that group.

### (b) Screen manifest — the **authoritative state** for Claude (idle/working/blocked)
`detect_agent_with_osc(agent, screen_content, osc_title, osc_progress)` feeds three things into TOML rule
matching (`claude.toml`):
- **`osc_title`** — the terminal title Claude's CLI emits via an OSC escape sequence.
- **`osc_progress`** — the OSC `9;4` progress sequence.
- **`screen`** — a snapshot of the **bottom lines of the terminal buffer**.

The **highest-priority Claude rule** (`osc_title_working`, priority 1100) is:
```toml
region = "osc_title"
regex = ['^[\x{2800}-\x{28FF}] ']   # a braille spinner glyph ⠋⠙⠹… + space
state = "working"
```
**Claude's CLI animates a braille spinner in the terminal title the entire time it considers itself busy.**
That title update comes straight out of the CLI's render loop, independent of any discrete lifecycle event —
so it stays "working" through gaps that events miss. `osc_title_idle` (`✳ `) and `osc_progress 4;0` mean idle.
Lower-priority rules scrape the bottom buffer text for permission/blocked prompts (`do you want to proceed?`,
`esc to cancel`, `❯ 1. yes`, etc.).

### (c) Lifecycle hooks → Unix socket — **session identity only** for Claude
The installed hook (`herdr-agent-state.sh`, integration v7) fires on Claude's native hook events and sends a
JSON-RPC line to `HERDR_SOCKET_PATH` (a Unix domain socket) — but it calls **`pane.report_agent_session`**
(pane_id ↔ session_id ↔ transcript_path). It does **not** report working/idle. State for Claude comes from (b).

Only 6 agents get `full_lifecycle_hook_authority` (pi, omp, mastracode, opencode, kilo, kimi) — those ship a
real plugin that streams state. Claude is deliberately **not** one of them.

### (d) Debounce
`AgentDetectionPresence` (`src/pane/agent_detection.rs`) runs a small state machine with miss-confirmation
timers so a one-frame Working→Idle blip doesn't flip the pane. Manifests self-update from herdr.dev every 30 min.

## 2. The buried lesson (this is the important part)

herdr **tried the exact approach your extension currently uses and abandoned it.** The source still carries the
tombstones:

```rust
const CLAUDE/DEVIN/COPILOT/DROID _REMOVED_LIFECYCLE_HOOK_EVENTS = [
  ("UserPromptSubmit", "working"),
  ("PreToolUse",       "working"),
  ("PostToolUse",      "working"),
  ("Notification",     "blocked"),
  ("Stop",             "idle"),     // <-- this is the false "done"
];
```
And in the current hook script:
```python
# SubagentStop is a completion event. Older Herdr integrations mapped it to durable
# working, but Claude recap/away-summary can emit it after the main turn has already
# stopped. Never let it revive an idle pane.
```

Translation: **deriving state from Claude's lifecycle events (`Stop → idle`, subagent events, busy flags) is
fundamentally unreliable, because background work outlives the events that are supposed to bracket it.** herdr
hit exactly your bug, concluded events can't be the source of truth, and moved the source of truth to the
**terminal spinner + process tree**, keeping hooks only to *identify the session*.

## 3. Why your previous attempts hit a wall

Your status pipeline (`patchClaude.ts` + `claudeStatus.ts`) is built entirely on **webview / extension-host
lifecycle signals**: `busy`, `subagentTasks`, `permissionRequests`, and `update_session_state`
running/idle edges. Those are precisely the signals herdr classifies as *not authoritative*. Your own code
already admits the gap:

> `applyWebviewStatus`: "Detached background bash shells live in the Claude CLI subprocess and are not
> observable from the webview, so they can't be covered here."

And the herdr-equivalent authoritative signals are **unavailable in your architecture**: the Cursor Claude
integration is a **webview + extension host**, not a PTY. There is no terminal title to read, no OSC sequence,
no bottom buffer to scrape. That's the "block" — you were trying to make the abandoned-by-herdr signal
reliable, and the signal herdr replaced it with doesn't exist in a webview.

## 4. What actually replicates herdr in your environment

You can't copy (b) (no terminal). But you **can** copy herdr's mechanism (a) — **process-tree monitoring** —
which is the one signal that catches "background bash still running while the main loop is idle," i.e. the
exact failure you described. Two layers:

### Layer 1 (fast path, already have): webview signals
Keep `busy` / `subagentTasks` / `__wtBgTasks` as the instant, in-band "working" signal for Task subagents and
active turns. This is your equivalent of Claude's own spinner. Leave it as-is.

### Layer 2 (the missing authoritative signal): watch the Claude CLI process tree
The extension host is a Node process on the same machine as the agent. Add a poller that:
1. Resolves the PID that hosts each session's tools (the `claude` CLI / agent subprocess — the process that
   Bash tools are spawned under).
2. Enumerates **live descendant processes** of that PID (`ps -o pid,ppid,stat,command` walk, or
   `pidtree`-style). A backgrounded `npm test` / `cargo build` / `run_in_background` shell shows up here even
   though the webview cleared `subagentTasks` on the turn `result`.
3. If any non-transient descendant is alive → force the tab to **"working"** (feeds the same
   `__wtBg`-style flag the getTabs resolver already honors, ranked above `done`).
4. Debounce the busy→idle edge (herdr's `AgentDetectionPresence`): require N consecutive "no live children"
   polls before releasing to "done", so a fork/exec gap doesn't flap.

This mirrors herdr's authority order: process tree can *promote* to working, but "done" only latches once the
tree is genuinely quiet AND the webview signals agree.

### Layer 3 (optional, cheap, herdr-parity): a session-identity hook
Install a Claude Code hook (like herdr's `herdr-agent-state.sh`) that reports `session_id` + `transcript_path`
+ pid to your broker socket. Not for state — for **robust pid resolution** in Layer 2 and clean session↔tab
keying (you already do attribution; this hardens it). Do **not** use `Stop`/`SubagentStop` to set "idle" —
that's the trap herdr removed.

## 5. Verification (done — the method is viable)

Empirically confirmed on Cursor 2.1.204 / macOS:

```
extension-host (19858, = our process.pid)
  ├─ native-binary/claude (82836)          ← this window's tab agents (one per tab)
  │   ├─ /bin/bash -c source …/shell-snapshots/snapshot-…   (Bash tool — fg OR bg)
  │   │   └─ sleep 300                       ← a run_in_background shell
  │   └─ node …/context-mode/start.mjs       (persistent plugin server)
  ├─ native-binary/claude (20482)          ← quiet tab (only child = plugin server)
  └─ native-binary/claude (21074)          ← quiet tab
```

- A **real `run_in_background` shell stays a child of its `claude` process** (`sleep 300 && echo done` →
  snapshot-bash → claude). It does **not** reparent to init. (An earlier test that reparented was an artifact
  of manual `disown`/`setsid`, which Claude does not use.)
- Our extension **runs in the same extension host** that is claude's parent, so `process.pid` roots the tree
  and a ppid walk finds everything.
- **Idle tabs read `quiet`**: their only child is the persistent context-mode/MCP server, which does *not*
  carry the `shell-snapshots/snapshot-` signature → no false positives.
- Claude procs from **other Cursor windows** have different ppids → filtering by `ppid === process.pid`
  scopes correctly to this window's tabs.
- `lsof -a -p <pid> -d cwd -Fn` returns each agent's cwd → the tab key.

## 6. What shipped — herdr-level per-tab precision (env-tag + process tree)

herdr's per-pane precision comes from *owning* the process it watches. We get the same unambiguous tab→process
mapping with a one-property bundle patch: stamp each agent's environment with its owning tab id, which — by
env inheritance — flows to every descendant, including detached background shells.

**Patch (`src/patchClaude.ts`, `applyEnvTag`, PATCH_VERSION wtpatch-v19).** `resolveClaudeBinary()` on the
comms controller builds the agent subprocess env via `Id(...)`; the patch injects
`try{if(this.__wtId&&t&&typeof t==="object")t.WT_TAB_ID=String(this.__wtId)}catch{}` right after it. `this` is
the controller (already carrying `__wtId` from `applyPanelId`), and a tab's `ClaudeTab.id` **is** that
`__wtId`. Anchored on the stable `resolveClaudeBinary(){…resolveShellPath(this.output)…}` shape (verified:
matches uniquely; the patched 2 MB bundle still passes `node --check`). Best-effort like the other
sub-patches, and folded into the version stamp / self-heal / partial-apply reporting.

**Monitor (`src/backgroundWork.ts`).** Every 1.5s: snapshot the process table, find `claude` agents whose
parent is our extension host, and for each whose descendant tree contains a work-shell
(`shell-snapshots/snapshot-` signature — which idle MCP/plugin servers lack), resolve its owning tab by
reading `WT_TAB_ID` from the agent's env (macOS `ps -Ewww`; Linux `/proc/<pid>/environ`; cached per
long-lived agent). A 3s release grace (herdr's miss-confirmation debounce) bridges the gap between sequential
background commands. `WT_TAB_ID` is per-host-unique, and we only consider agents parented by our host, so
this window's tabs are cleanly scoped.

**Consumer (`src/claudeStatus.ts`).** `tabs()` upgrades a tab from `done`/`idle` → `working` when
`hasBackgroundWork(tab.id)`. **Upgrade only** — never a downgrade — so an active turn's own foreground tool
shell (already "working" per the webview) is unaffected; the signal bites only when the webview has gone quiet
but a shell is still alive.

**Precision:** exact per tab. Two (or ten) sessions in the **same worktree** are told apart, because
attribution is by the env-stamped tab id, not by cwd. Verified end-to-end except the final apply+reload:
`WT_TAB_ID` is read back correctly from a background shell that inherited it. An unpatched/older agent (no
`WT_TAB_ID`) simply reports no signal — nothing is ever mis-attributed.

### Superseded first cut (cwd mapping)
The initial version mapped agents to tabs by cwd (`lsof -d cwd`), with no bundle patch. That over-reported
across same-worktree tabs (any one working → all read working). Since same-worktree sessions are common here,
it was replaced by the env-tag approach above.
