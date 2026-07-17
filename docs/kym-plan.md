# Keep Your Marbles (KYM) — Implementation Plan

A Kanban orchestration layer for running many Claude Code sessions at once, built
on top of the existing **Source Control+** pane and the Claude-status patch this
extension already ships.

Source: FigJam "Kanban AI Flow"
(https://www.figma.com/board/GUR87kzpy5L09sSQWzJ7Fp).

---

## 1. Decisions locked in (from interview)

| Question | Decision |
| --- | --- |
| Pathway | **VSCode & Extension** (not Swift+Terminal). Continue on this extension. |
| Board UI surface | **New full editor-tab webview** (horizontal Kanban). Source Control+ sidebar stays and links into it. |
| Marble ↔ worktree | Each marble has a **Branch input** that defines which worktree it lands in. Many marbles can share a worktree, or be 1:1. |
| Worktree lifecycle | **Lazy** — a marble does NOT create a worktree. A worktree is created only when a marble is **processed**. On archive, the worktree is removed **only if no other active/TODO marble** targets that branch. |
| Session engine | **Claude tabs in one window** — reuse `claudePanes` / `claudeTab` / `patchClaude`. Each processing marble = a Claude tab scoped to its worktree. Board lives in the same window. |
| Completion signal | Tap the **existing status patch** (`claudeStatus.ts` / `__wtClaude.getTabs()`), which already reports `plan` / `done` / `question` / `permission` / `working` / `idle` per session. |
| State store | **`.vscode/kym.json`** at the open folder root — board state, snippet library, and **repo-scoped settings**. Global-scoped settings live in VSCode extension settings (`andreysHelper.kym.*`). Repo overrides global. |
| Board scope | **Per window / per open folder.** Whatever folder the window has open owns its board (`.vscode/kym.json`). Open a worktree as its own window → that window has its own board; open at top level with worktrees as sub-branches → the board lives there. |
| Stage → command mapping | Plan = **Claude plan mode**, or **OpenSpec propose** if OpenSpec checked. Process = **apply the plan**, or **opsx:apply**. Done = **opsx archive** (runs on Verify→Done for OpenSpec marbles). |
| Transitions | Arrows in the FigJam = **automatic**; the stop-sign octagon = **manual stop**. Everything else = **manual drag**. |

---

## 2. Columns & transition rules

`Source Control+` → `TODO` → `Plan` → `Process` → `Verify` → `Done` → `Archive`

- **TODO** — marbles created via *Add Task*. No worktree, no session. *Add Section*
  makes a draggable divider for organization.
- **Plan** — has two drop targets:
  - **Plan & Pause** (octagon / stop): runs plan mode, stops when planning is
    complete (session status = `plan`, i.e. asking the user to review). Marble waits.
  - **Plan & Implement** (arrow): plans, then **auto-advances to Process** without
    user input.
- **Process** — implementation runs. If OpenSpec is checked, this is `opsx:apply`;
  otherwise "apply the plan". A worktree is created here if one doesn't exist for
  the marble's branch. **Rule: any time a marble is actively processing it lives in
  Process automatically** (including re-processing kicked off from Verify).
- **Verify** — reached automatically when the session reports `done`. Process is
  instructed to emit a **list of items to verify** in its normal output
  (**freeform** — no parsing); the marble in Verify links to its session so the user
  reads the list there. Clicking a marble here lets the user type extra instructions;
  on submit the marble **auto-moves back to Process** while it runs, then
  **auto-returns to Verify** when `done`.
- **Done** — manual drag. Finished but may still need action/comms. **Sessions are
  NOT auto-closed.** For OpenSpec marbles, the **Verify→Done** move runs `opsx archive`.
- **Archive** — manual drag. Fail-safe: verifies changes were committed; closes the
  session; removes the worktree **only if no other active/TODO marble targets that
  branch**. Refuses to archive with uncommitted changes.

**Automatic transitions (driven by session status):**
1. Plan-mode session hits `plan` status → *Plan & Pause* stays; *Plan & Implement*
   accepts and advances to Process.
2. Processing session hits `done` → advance to Verify.
3. Verify re-submission starts processing → back to Process; on `done` → Verify.

All other moves are manual drag.

---

## 3. Add Task form (create-marble modal)

Fields: **Title**, **Ticket(s)** (＋ adds fields; links to Linear/Jira with a
go-to icon, referenceable in the prompt), **Branch** (dropdown + autocomplete from
existing worktrees), **Copy Ignored** (hidden if an existing branch is selected —
worktree already set up), **OpenSpec** (independent checkbox), **Prompt**,
**Snippets** (see below), **Model**, **Color**, **Icon**, and **On [processed |
done]** actions: close session / remove worktree if none active / merge / process
another item(s).

### Snippets

Snippets are **draggable chips** shown near the prompt input; dragging a chip into
the prompt textarea **expands it to its body text** at the drop point. Each snippet
is `{ tag: string; body: string }` — a short title/tag plus a textarea body. A **＋
button** adds a new snippet (tag input + body textarea). Example: dragging `IMOGAA`
expands to "Interview me on gaps and ambiguities". `[code review]` /
`[security review]` are just seeded defaults. The snippet library is user-editable
and persisted alongside board state in `.vscode/kym.json`.

### Plan drop targets

- **Plan & Pause** (octagon / stop): plan, then wait for the user to review.
- **Plan & Implement** (arrow): **quick path, no user input** — planning runs and
  flows straight into implementation (→ Process) without stopping.

---

## 3a. Launching the board

The board is opened from a **title-bar button on the Source Control+ pane**,
positioned **all the way to the left** — before the list/tree toggle.

- Asset: `media/kanban.svg` (copied from `~/Desktop/kanban.svg` — a Bootstrap
  kanban glyph using `currentColor`, so it themes automatically).
- New command `andreysHelper.kym.openBoard` (title "Keep Your Marbles"), icon
  `media/kanban.svg`, contributed to `view/title` for `view == andreysHelper.scm`
  in `group: "navigation@0"`. The existing list/tree toggle is `navigation@1`,
  so `@0` places the kanban button to its left.
- The command opens (or reveals) the KYM board editor-tab webview.

### Board tab & layout

- The board is a **locked editor tab** (like a Claude session tab) so new files
  don't open into it.
- The window splits: **KYM board ≈ 2/3** (left), **Claude session tabs ≈ 1/3**
  (right).
- Clicking a marble **opens/reveals that marble's session tab in the right pane**
  (via `ClaudeStatusService.reveal(sessionId)`), rather than replacing the board.

## 3c. Settings

Opened from the **gear** in the Source Control+ title bar (existing
`andreysHelper.scm.openSettings`), rendered as a menu **styled like the branch
menus**. Two scopes:

- **Global** (extension settings, `andreysHelper.kym.*`) — the default
  per-stage extra instructions and defaults that apply across all repos.
- **Repo** (this repo, stored in `.vscode/kym.json`) — overrides/additions specific
  to the open folder. Repo overrides global.

**Per-stage additional instructions:** each stage (Plan / Process / Verify / …) has a
**textarea of extra instructions** appended to the message sent when a marble enters
that stage. These are the *only* default extra instructions the extension injects.
Example: the Process stage's default instructions include "output a list of items for
the user to verify" — which is what populates the Verify step (read freeform in the
session).

## 4. Architecture

```
┌─────────────────────── Editor tab: KYM Board (webview) ──────────────────────┐
│  columns render marbles; drag/drop; Add Task modal; marble detail + chain     │
└───────────────▲───────────────────────────────────────────────▲──────────────┘
                │ postMessage                                     │
      ┌─────────┴──────────┐                          ┌───────────┴───────────┐
      │ KymController       │  owns board state,       │ ClaudeStatusService   │
      │ (extension host)    │  drives transitions      │ (existing)            │
      └─────────┬──────────┘                          └───────────────────────┘
                │ spawn/reveal tabs        reads getTabs() status per cwd
      ┌─────────┴──────────┐   create/remove worktrees (wt.ts / git.ts)
      │ claudePanes /       │
      │ claudeTab           │
      └────────────────────┘
                │
        KymStore (central JSON in main repo, e.g. .git/kym/board.json or
        globalStorage keyed by repo root) — marbles, stages, chains, links
```

Key modules to add:
- `src/kym/KymStore.ts` — persistence + typed board model (marbles, stages, chains).
- `src/kym/KymController.ts` — orchestration: reacts to `ClaudeStatusService.onDidChange`,
  applies auto-transition rules, spawns/reveals sessions, creates/removes worktrees.
- `src/kym/kymBoardView.ts` — the editor-tab webview (HTML/JS), messaging protocol.
- `src/kym/stageCommands.ts` — maps (stage, openSpec) → the Claude message / command
  to send into the session (plan mode vs opsx propose; apply vs opsx:apply; opsx archive).
- Reuse: `claudeStatus.ts`, `claudePanes.ts`, `claudeTab.ts`, `wt.ts`, `git.ts`,
  `scmInfo.ts`.

**Marble ↔ session binding:** a marble stores its target `branch`; when processed we
resolve/create the worktree for that branch, spawn a Claude tab scoped to that `cwd`,
and remember the session id. `getTabs()` entries are matched to marbles by
`cwd` + session id so status changes drive the right marble.

---

## 5. Data model (sketch)

```ts
type Stage = "todo" | "plan" | "process" | "verify" | "done" | "archive";

interface Marble {
  id: string;
  title: string;
  stage: Stage;
  branch: string;              // defines the worktree it lands in
  tickets: { label: string; url?: string }[];
  prompt: string;
  snippets: ("code-review" | "security-review" | "imogaa")[];
  model?: string;
  openSpec: boolean;
  copyIgnored: boolean;
  color?: string; icon?: string;
  planMode?: "pause" | "implement";   // which Plan drop target
  onProcessed?: PostAction[];
  onDone?: PostAction[];
  chain?: ChainStep[];         // multi-select follow-ups
  sessionId?: string;          // bound Claude tab, once processing
  worktreeCwd?: string;        // resolved lazily
  verifyChecklist?: string[];
}
```

---

## 6. Milestones

### MVP (first target, per interview)
1. **Board shell** — editor-tab webview with all columns (`Source Control+`* /
   `TODO` / `Plan` / `Process` / `Verify` / `Done` / `Archive`). *(Source Control+
   column can start as a link into the existing pane.)*
2. **Create a marble** via Add Task — persisted in `KymStore`, rendered in TODO.
   **No worktree created.**
3. **Drag TODO → Plan or → Process** — on entering Process, lazily create the
   worktree for the marble's branch and spawn a scoped Claude tab with the composed
   prompt/command.
4. **Auto-advance to Verify** when the bound session reports `done`.
5. **Archive** — remove the worktree only if no other active/TODO marble targets that
   branch; block on uncommitted changes.

### M2 — full automation
- Plan & Pause vs Plan & Implement drop targets + auto-accept.
- Verify re-submission → Process → Verify loop; Process emits verify checklist.
- OpenSpec path (propose / opsx:apply / opsx archive).
- Marble detail: attention symbol on `question`/`permission`, active highlight,
  click-to-open session, chain arrows.

### M3 — orchestration polish
- Chaining (plan-no-ask / plan-ask / plan+process / process; "process another item").
- On-processed / on-done post-actions (close session, merge, remove worktree).
- Source Control+ integration: in-flight counts (3/5), safe rebase, migration alerts.

### Later (open board Qs — parked)
- Workflows as first-class; run/stop `pnpm dev` environments; multi-marble "Publish
  Feature X"; dropping a marble onto a specific flow.

---

## 6a. Prompt injection (implemented)

The Claude patch now injects the composed prompt into a marble's new session — no
more clipboard paste. Flow:

1. On Process, `openWorktreeClaudeTab(cwd, prompt)` stashes the prompt on the shared
   extension-host global (`globalThis.__wtClaude.pendingPrompt`) right before running
   the `openWorktree` command.
2. **extension.js patch** — when the new session's comms controller is created, it
   consumes `pendingPrompt` and repeatedly `send()`s a nonce'd `wt_submit_prompt`
   request to that controller's webview (retry-until-mounted; ~12×450ms).
3. **webview/index.js patch** — the composer's imperative handle gains `wtSubmit(text)`
   (sets the editor content and calls the existing submit fn); a `window.__wtSubmit`
   shim is registered where the composer ref is in scope; the host→webview dispatcher
   handles `wt_submit_prompt`, deduped by nonce so it submits exactly once.

All three webview edits and the extension.js edit are best-effort sub-patches with
unique anchors, consistent with the existing patch architecture; the clipboard copy
remains as a backup for unpatched bundles. Verified: anchors are unique on both the
pristine and already-patched 2.1.204 bundle, and the patched output parses.

## 6b. Agent path & pass-around execution

A TODO marble can carry an ordered **path** through the Plan/Process agents
(`Marble.pathAgentIds`), authored via the chevron editor (Phase 1). Dropping such
a marble on the field runs it through the agents automatically.

**Authoring (done, Phase 1):** hover a marble → chevron circle on its right edge →
click to edit → click agents in order (click again toggles off) → Verify pane /
Enter commits, Esc cancels. Hover shows a committed path; ends clamp perpendicular
to the TODO / Verify pane edges.

**Animation (Phase 2):** on drop the marble rolls from the drop point to the first
agent, circles it (isometric ellipse) while that hop runs, rolls to the next agent
when the hop completes, and after the last agent rolls off the right edge and drops
into Verify as the #1 card (pushing the rest down).

**Execution (Phase 3):**
- Drop on field → create/open the session in the marble's worktree.
- **Prompt sequence:** the marble's own initial prompt is sent **only at the first
  agent**, combined with that agent's prompt; agents 2+ receive only their own
  prompt (they infer the task from the shared session). One session for the whole
  run.
- **Advance on idle:** a hop is complete when the session returns from working to
  idle/waiting — fire the next agent's prompt. Mostly hands-off automation.
- **Attention:** if the session enters question / permission / plan (needs the
  user), the marble stops circling and **bounces** to get attention and shows that
  type's icon (same glyphs as Source Control+) in the marble.
- **Session stopped (not closed):** marble goes still with a **pause** button;
  clicking the marble focuses the session so the user can type "continue", which
  resumes the hop and the journey.
- **Session closed mid-run:** marble pops back to TODO into a locked **Failed**
  section pinned at the bottom, shown only while it holds marbles; moving a marble
  out hides it again.

## 7. Remaining open questions

1. **Board window identity** — is the board always the main/core window, or can it
   run from any window and reach into others? (Session engine is "tabs in one
   window," so I'm assuming the board + all session tabs live in one window.)
*(All prior open questions resolved.)*

*Resolved:* store = `.vscode/kym.json` (board + repo settings; global settings in
`andreysHelper.kym.*`); board scope = per window / per open folder; board = locked
editor tab, 2/3 board + 1/3 session split, marble click reveals its session on the
right; Plan & Implement = no-input quick path; snippets = draggable editable tag+body
chips with ＋; Verify checklist = **freeform**, read in the session; per-stage extra
instructions = textareas in settings (global default + repo override); **Model field =
fixed dropdown of current models + a "custom…" free-text escape hatch.**
