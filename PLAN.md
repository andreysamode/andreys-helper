# PLAN — AndreysOrchestrator ("The Circle")

A floating macOS orchestrator for the **Andrey's Helper** Cursor/VS Code extension: a
single always-on-top circle that gives a global, cross-window overview of every
Claude session, plus an embedded orchestrator agent that dispatches work into the
right repo/window on command.

This document is the implementation contract. It is written so the work can be
split across **parallel subagents** — Section 8 defines independent workstreams,
each buildable against the shared contracts in Section 6 with the rest mocked.

---

## 1. Goal

One glanceable circle, pinned top-right, that answers "does anything need me right
now?" across **all** Cursor/VS Code windows at once — and, on demand, an embedded
Claude Code "orchestrator" that manages and dispatches work into those windows
without you having to switch into them and paste context.

The circle is a **minified aggregate** of what the Source+ panel shows per-window,
summed across every window.

---

## 2. Locked decisions

| Area | Decision |
|---|---|
| App platform | **Native macOS, SwiftUI + AppKit** (borderless `NSPanel`, always-on-top, draggable, ⌘Q). macOS-only. |
| Cross-window transport | **App-hosted local WebSocket broker.** Each window's extension is a client. |
| Circle state | **Priority icon + that category's count** (see §4). |
| Orchestrator | **Embedded Claude Code terminal(s)** (SwiftTerm running `claude`) in a neutral workspace. **Multiple tabs** — spin up a second orchestrator for a quick lookup/scan while another is busy. |
| Orchestrator role | **Dispatcher + light local work** — delegates real work; may do read-only lookups inline. Never edits code itself. |
| Orchestrator lifecycle | **Long-lived, resumable**; user clears it manually (`/clear`). Not a source of truth. |
| Orchestrator autonomy | **Fully autonomous**, but **asks when a singular target is ambiguous**. Bulk verbs act on all matches and report. |
| Manager tool interface | **A thin `ah` CLI** the orchestrator shells out to. Everything routes through the extension. |
| Repo universe | **Open windows (live) ∪ configured repo-scan dirs** (both, from config). |
| Cold repo (no window) | App launches `cursor <path>`, waits for that window's extension to connect, then dispatches through it. |
| Dashboard coverage | **Extension-equipped, patched windows only.** |
| "Stop" semantics | **Interrupt (Esc-equivalent), tab stays open** and resumable. |
| Summarize / fuzzy-find | **Live open sessions first, then all on-disk Claude transcripts, most-recent-first.** |
| Jobs | **Static + agentic**, persisted in the app daemon, triggered by time / interval / completion. |
| Alerts | Fired alerts → circle **`!`** (top priority) + bubble, **click to ack**. Pending jobs → **bottom strip** of the session pane. |
| Multi-window-per-repo | Not a real use case; if ambiguous, tell the user and act on the first. |
| Multiple orchestrator tabs | Run **fully independently** — no cross-tab awareness/coordination for now. Revisit if conflicts arise. |
| Click-to-focus | `cursor <worktreePath>` / deep link foregrounds the folder's window; extension reveals the tab. No AX API. |

---

## 3. UX / layout spec

The window is an always-on-top, borderless, non-activating `NSPanel` at
`.floating` level. It is **anchored to the circle** in the top-right; panes grow
**leftward** from it. Dragging the circle moves the whole thing. ⌘Q quits.

### Three states

```
STATE 1 — collapsed (default)
                                              ( ● )   ← circle, top-right
                                                        notifications live here

STATE 2 — hover the circle → session pane slides out left
        ┌───────────────────────────┐ ( ● )
        │ core                       │
        │  ▭ session   ▭ session     │
        │ samodeus-mac               │
      < │  ▭ session   ▭ session     │  ← "<" collapses back to state 1
        │ andreys-helper             │
        │  ▭ session   ▭ session     │
        ├───────────────────────────┤
        │ XYZ in 10 mins             │  ← pending-jobs strip (bottom)
        └───────────────────────────┘

STATE 3 — expand further (">" ) → orchestrator terminal opens further left
   ┌───────────────────────┐┌───────────────────────────┐ ( ● )
   │ [orch 1] [orch 2] [+]  ││ core                       │  ← orchestrator tab bar
   │  embedded Claude Code  ││  ▭ session   ▭ session     │
 > │  (orchestrator) TUI    ││ samodeus-mac               │
   │  drag screenshots in   ││  ▭ session   ▭ session     │
   │                        ││ andreys-helper             │
   │                        ││  ▭ ...                     │
   │                        │├───────────────────────────┤
   │                        ││ XYZ in 10 mins             │
   └───────────────────────┘└───────────────────────────┘
```

### Rules
- **Session pane sections** = one per **window** (labeled by repo/folder name),
  matching the Source+ grouping: window → worktree/branch → session boxes.
  (Minus SCM/changed-files.)
- **Session box** shows: title, live status glyph (`⟳ ? ✓` etc.), and is
  **clickable** → focuses that window and reveals that tab (marks it seen).
- **Bottom strip** lists upcoming/pending scheduled jobs with a countdown
  ("XYZ in 10 mins"). This is distinct from a *fired* alert.
- **Orchestrator (state 3) is hidden by default.** Reachable via the `>` expander.
  **If any orchestrator tab is running, state 3 stays open/visible** so you can see
  it is running.
- **Multiple orchestrator tabs.** A tab bar across the top of the orchestrator
  panel with a `+` to add a new orchestrator (a fresh `claude` session in the same
  neutral workspace) — e.g. start a second orchestrator for a quick scan/stats
  lookup while the first is mid-task. Tabs are independently closable; closing the
  last one collapses state 3 back to the session pane. Each tab is its own PTY /
  `claude` process with its own conversation.
- Multi-monitor: window remembers its screen + position.

---

## 4. Circle state model

Aggregate across **all** connected windows' sessions, then render the single
highest-priority category and its count.

### Status folding (per session)
Extension emits `working | question | plan | permission | done | idle`
(`ClaudeTabStatus`). Fold to circle categories:

| Circle category | From session statuses |
|---|---|
| needs-input | `question`, `plan`, `permission` |
| done-unseen | `done` **and** not yet revealed/seen |
| working | `working` |
| idle | `idle`, or `done` already seen |

### Precedence (highest wins)
```
1. alert       →  "!" + count   (fired jobs/reminders awaiting ack)  [click to ack]
2. needs-input →  "?" + count
3. done-unseen →  "✓" + count
4. working     →  spinner around rim, NO number
5. idle        →  blank circle
```
- Count = size of the winning category (except `working` = spinner only, and
  `alert` count = queued unacked alerts).
- "Seen" is set when a session is revealed (existing `reveal` marks completion
  seen). Alerts are cleared on click-ack.

---

## 5. Architecture

```
┌──────────────────────── macOS AndreysOrchestrator (always running) ─────────────────────────┐
│                                                                                        │
│  UI Shell (SwiftUI/AppKit)   Broker (WS server)   Daemon (scheduler)   Orch host       │
│   - circle + 3 panes          - localhost :port    - job store          - SwiftTerm     │
│   - state derivation          - token auth         - time/interval/     - N `claude`    │
│   - alert bubbles             - window registry      completion triggers   PTY tabs      │
│   - pending-jobs strip        - snapshot aggregate - headless job runner - neutral cwd   │
│                               - command router     - alert queue        - tab bar + `+` │
│                               - cold-start launch                        - show/hide     │
└───────▲───────────────────────────────▲──────────────────────────────────▲────────────┘
        │ WS (snapshots ▲ / commands ▼)  │                                   │ shells out
        │                                │                                   │
┌───────┴────────┐   ┌───────┴────────┐  │                          ┌────────┴─────────┐
│ Cursor window  │   │ Cursor window  │  … each = broker client     │  `ah` CLI        │
│  extension     │   │  extension     │     (this repo's extension) │  (thin client)   │
│  - publishes   │   │  - publishes   │                             │  - resolve-branch│
│    snapshot    │   │  - executes    │                             │  - list/spawn/   │
│  - executes    │   │    commands    │                             │    steer/stop/…  │
│    commands    │   └────────────────┘                             │  - talks to WS   │
└────────────────┘                                                  └──────────────────┘
```

**Component roles**
- **UI Shell** — the circle + panes; subscribes to broker's aggregated state.
- **Broker** — localhost WS server; holds the window registry, aggregates
  snapshots into circle state, routes commands to the right window, performs
  cold-start window launches.
- **Daemon** — persistent job store + scheduler; watches session transitions for
  completion triggers; runs headless agentic jobs; feeds the alert queue.
- **Orchestrator host** — tabbed embedded terminals, each running its own `claude`
  process in the neutral workspace; tab bar + `+` to add more; show/hide rules.
- **Extension (this repo)** — new broker-client module; publishes
  `ScmInfoService` + `ClaudeStatusService` snapshots and executes dispatched
  commands via existing primitives.
- **`ah` CLI** — thin broker client the orchestrator uses; no git logic of its own.

---

## 6. Contracts (Phase 0 — build these FIRST, they unblock everything)

All contracts are versioned (`"v": 1`). JSON over WebSocket. Newline framing not
needed (WS frames are message-delimited).

### 6.1 Session & window addressing
- `windowId`: stable per connected window for the app's lifetime (extension
  generates a UUID at activation, re-announced on reconnect).
- `sessionId`: the **persistent Claude session uuid** — the durable, global key
  for steer/stop/chain. May be absent briefly on a freshly-spawned tab.
- `tabId`: the per-window panel id (`ClaudeTab.id`) — used to address a tab
  **before** its `sessionId` exists; the extension emits a `sessionId` update once
  known (temp-id → sessionId handshake).

### 6.2 WS messages

**Extension → Broker**
```jsonc
// on connect
{ "v":1, "type":"hello", "windowId":"…", "host":"cursor|vscode",
  "repo":{ "name":"core", "trunkPath":"/…/core" }, "token":"…" }

// live snapshot (debounced; whenever ScmInfo or ClaudeStatus changes)
{ "v":1, "type":"snapshot", "windowId":"…",
  "worktrees":[ { "path":"…", "name":"…", "branch":"…", "ahead":0, "behind":0,
                  "isTrunk":true } ],
  "sessions":[ { "tabId":"…", "sessionId":"…|null", "cwd":"…", "title":"…",
                 "status":"working|question|plan|permission|done|idle",
                 "seen":false, "col":1, "active":true } ] }

// ack/result of a command
{ "v":1, "type":"result", "cmdId":"…", "ok":true, "data":{…}, "error":null }
```

**Broker → Extension (commands)**
```jsonc
{ "v":1, "type":"command", "cmdId":"…", "verb":"…", "args":{…} }
```
Command verbs the extension MUST implement (each maps to existing primitives):
| verb | args | maps to |
|---|---|---|
| `spawnSession` | `{ worktreePath, prompt?, attachments? }` | `openWorktreeClaudeTab` (+ `submitPrompt` once session ready) |
| `sendPrompt` | `{ sessionId, text, attachments? }` | `submitPrompt` |
| `interrupt` | `{ sessionId }` | Esc/`wtInterrupt` path (new exposed command) |
| `reveal` | `{ sessionId }` | `reveal` (also foregrounds window) |
| `createWorktree` | `{ repoRoot, branch, full?, open:"tab"|"window" }` | `wt switch` flow (from `extension.ts#newWorktree`) |
| `rename` | `{ sessionId, title }` | `rename` |
| `listWorktrees` | `{}` | `wt list` |

**Broker → UI** (internal, may be direct Swift, not WS): aggregated
`CircleState { category, count, alertCount }` + full tree for the panes.

### 6.3 `ah` CLI (thin client → broker over WS/loopback)

Reads config for broker port + token. All output is JSON on stdout for the model.
```
ah windows                          # list connected windows + repos
ah sessions [--repo R] [--status S] # list live sessions across windows
ah resolve-branch <branch>          # scan open windows' repos, then config repo dirs;
                                    #   → { matches:[{repo,path}], ambiguous:bool }
ah find-session <query>             # live sessions first, then transcripts (recent-first)
ah summarize <sessionId|transcriptPath>
ah open-window <repoPath>           # cold-start; returns once extension connects (timeout)
ah create-worktree <repoRoot> <branch> [--full] [--open tab|window]
ah spawn <windowId|repo> <worktreePath> --prompt <text> [--attach <path>…]
ah send <sessionId> --text <text> [--attach <path>…]
ah interrupt <sessionId | --repo R | --all>
ah reveal <sessionId>
ah schedule <spec>                  # see 6.5; create/list/cancel jobs
ah alert <text>                     # push an alert to the circle
```
`resolve-branch` order: (1) branches present in currently-open windows' repos,
(2) configured repo-scan dirs. Ambiguous → orchestrator asks the user.

### 6.4 Config — `~/.andreys-helper/config.json`
```jsonc
{
  "port": 47615,
  "repoScanDirs": ["/Users/andrey/dev"],
  "circle": { "screen": "…", "x": 0, "y": 0 },
  "orchestrator": { "workspace": "~/.andreys-helper/orchestrator", "hideByDefault": true }
}
```
Token: `~/.andreys-helper/token` (0600), generated on first run; shared by app,
extension, and `ah`.

### 6.5 Job model — `~/.andreys-helper/jobs.json`
```jsonc
{
  "id": "…",
  "kind": "static" | "agentic",
  "trigger": { "type":"time", "at":"2026-07-25T02:00:00Z" }
           | { "type":"interval", "everyMs":3600000 }
           | { "type":"completion", "sessionId":"…" },
  // static:
  "action": { "type":"alert", "text":"XYZ" }
          | { "type":"dispatch", "verb":"…", "args":{…} },
  // agentic:
  "instruction": "scan sessions, flag stuck ones",   // headless `claude -p …`
  "onResult": "alert",                                // result → circle alert
  "label": "XYZ",                                     // shown in pending strip
  "nextFireAt": "…"
}
```

---

## 7. Repo / project layout

```
andreys-helper/                 (this repo — extension + ah CLI live here)
  src/…                         existing extension
  src/broker/client.ts          NEW: WS broker client (Workstream W1)
  src/broker/commands.ts        NEW: command → primitive dispatch
  cli/ah.ts                     NEW: `ah` CLI (Workstream W6), bundled via esbuild
orchestrator/                      NEW Swift app (Workstreams W2–W5)
  Package.swift                 (SwiftPM; SwiftTerm dependency)
  Sources/AndreysOrchestrator/
    App.swift                   entry, NSPanel setup
    UI/…                        circle + panes (W2)
    Broker/…                    WS server, registry, router, cold-start (W3)
    Daemon/…                    scheduler, job runner, alert queue (W4)
    Orchestrator/…              SwiftTerm host + show/hide (W5)
    Model/…                     shared types matching §6 contracts
  orchestrator-workspace/
    CLAUDE.md                   orchestrator operating manual (W7)
```

---

## 8. Parallel work breakdown (for subagents)

**Phase 0 is a hard barrier.** One agent produces the contracts/scaffolding; all
Phase-1 tracks then run in parallel against them with counterparties mocked. Each
track ships with a stub/mock of its dependencies + a smoke test so it is
independently verifiable.

### Phase 0 — Contracts & scaffolding  *(single agent, blocking)*
- Freeze §6 as shared type definitions in BOTH languages:
  `src/broker/protocol.ts` and `orchestrator/Sources/AndreysOrchestrator/Model/Protocol.swift`.
- Scaffold `orchestrator/` SwiftPM app that launches a borderless always-on-top
  `NSPanel` with a placeholder circle (proves window chrome + ⌘Q).
- Create config + token bootstrap (§6.4).
- **Done when:** both type files compile; empty app shows a draggable circle;
  token/config files are created on first run.

### Phase 1 — parallel tracks (against Phase-0 contracts)

**W1 — Extension broker client** *(agent, in this repo)*
- WS client: connect, `hello`, reconnect w/ backoff, publish `snapshot` from
  `ScmInfoService` + `ClaudeStatusService` (debounced), execute `command`s via the
  §6.2 mapping. Add the missing primitives: `interrupt` (expose the Esc/wtInterrupt
  path), and `spawnSession` with the temp-id→sessionId handshake.
- Mock: a tiny local WS echo/mock broker to test against.
- Done when: snapshots stream on tab/status/git changes; every verb executes and
  acks; survives broker restart.

**W2 — UI shell & panes** *(agent, Swift)*
- Circle (all 5 states + spinner + `!` bubble + click-ack), state-2 session pane
  (window→worktree→session boxes, `<` chevron, bottom pending-jobs strip),
  state-3 orchestrator container (`>` chevron, show/hide + keep-open-if-running),
  hover/pin behavior, click-a-session → emit reveal intent.
- Mock: feed it canned `CircleState` + tree fixtures + fake pending jobs.
- Done when: all three states render per §3 from fixtures; precedence/counts per §4
  are correct; clicking a box fires a (stubbed) reveal.

**W3 — Broker server & router** *(agent, Swift)*
- `NWListener` WS server (Network.framework `NWProtocolWebSocket`, no 3rd-party
  dep), token auth, window registry, snapshot aggregation → `CircleState` + tree,
  command routing by `windowId`/repo, **cold-start**: launch `cursor <path>` and
  await the new window's `hello` (timeout + surfaced error).
- Mock: a fake extension client (reuse W1's mock harness) + assert aggregation.
- Done when: N mock clients connect; aggregated state matches §4; commands route to
  the correct client; cold-start opens a window and resolves on connect.

**W4 — Daemon / scheduler** *(agent, Swift)*
- Persistent job store (§6.5), time/interval/completion triggers, completion-watch
  off session `working→done` transitions from the broker, headless agentic runner
  (`claude -p <instruction>` in a scratch cwd, capture result), alert queue → UI,
  pending-jobs list → UI strip.
- Mock: injectable clock + fake transition stream + fake `claude -p`.
- Done when: a time job fires an alert; a completion job fires on a simulated
  transition; an agentic job runs and posts its result as an alert.

**W6 — `ah` CLI + transcript search** *(agent, this repo)*
- Implement §6.3 verbs as a WS client to the broker. `resolve-branch` (open windows
  then config dirs). `find-session`/`summarize`: live sessions first, then scan
  `~/.claude/projects/**/*.jsonl` most-recent-first (mtime), match query, extract
  summary. JSON stdout.
- Mock: point at W3's server or its mock; fixture transcript dir.
- Done when: each verb returns correct JSON against the mock broker; transcript
  search ranks recent-first and matches fuzzy queries.

### Phase 2 — integration & the agent (sequential-ish)

**W5 — Orchestrator host** *(after W2, W3)*
- Embed SwiftTerm running `claude` in the neutral workspace; screenshot drag-in;
  show/hide + keep-open-while-running; wire the `>` expander.
- **Multi-tab**: a tab bar with `+` to add orchestrators; each tab is an
  independent PTY/`claude` process with its own conversation; independently
  closable; state 3 stays open while **any** tab is running and collapses when the
  last tab is closed. Track per-tab running/idle so the "keep-open-if-running" rule
  reflects all tabs.

**W7 — Orchestrator operating manual** *(after W6)*
- `orchestrator-workspace/CLAUDE.md`: role (dispatcher + light local work; never
  edits code), the `ah` verb surface, autonomy policy (autonomous; ask only when a
  singular target is ambiguous; bulk verbs act-all-and-report), and canonical
  playbooks (PR review, info lookup, stop-all, schedule a reminder).

**W8 — End-to-end wiring** *(after W1, W3)*
- Real extension ↔ real broker ↔ real UI. Live snapshots drive the circle; clicking
  a box focuses the window + reveals the tab.

### Phase 3 — polish
- Alert bubble interactions & ack; pending-strip countdowns; login-item / launch-at-
  login; `.app` packaging + code signing; `ah` install-to-PATH from the app; onboarding
  (first-run config for `repoScanDirs`); multi-monitor position persistence.

### Dependency graph
```
Phase0 ──▶ W1 ─┐
        ├▶ W2 ─┼─▶ W5 ─┐
        ├▶ W3 ─┼─▶ W8 ─┴─▶ Phase3
        ├▶ W4 ─┘
        └▶ W6 ─────▶ W7
```

---

## 9. Open risks & mitigations

1. **Click-to-focus a specific window.** Mechanism: `cursor <worktreePath>` /
   `cursor://` deep link foregrounds the folder's window, then extension reveals the
   tab. Multi-window-per-repo isn't a real use case; if ambiguous, notify and act on
   the first. *(Accepted.)*
2. **Addressing a just-spawned tab.** New tab has no `sessionId` yet — address by
   `tabId` until the extension emits the `sessionId` update (handshake in W1).
3. **Broker auth.** Localhost WS reachable by any local process → token file (0600)
   required on `hello`; reject otherwise.
4. **Extension gains outbound networking** (net-new): add `ws` dependency; guard so a
   missing/closed broker is a silent no-op with reconnect backoff (never disrupts the
   editor).
5. **Headless agentic-job cost.** Agentic jobs invoke `claude -p`; add per-job and
   global rate/interval floors so a tight loop can't run away.
6. **Patched-bundle dependency.** Only patched+equipped windows report/dispatch; the
   dashboard shows nothing for others (by design).

---

## 10. Out of scope (for now)
- Windows/Linux.
- Non-Claude / un-equipped windows in the dashboard.
- System notifications (alerts live on the circle only).
- Full Linear/PR API integrations (context comes from screenshots/paste + `ah`).
- Answering *permission* prompts programmatically (human handles; orchestrator sends
  text/prompts and interrupts only).
```
