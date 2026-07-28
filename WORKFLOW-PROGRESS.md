# Dynamic-workflow progress in the Source Control+ session box

Detect that a session is running a **dynamic workflow** (the `Workflow` tool), and
show its progress in the session box: a chevron before the title, a strip of
phase squares that fill in as work completes, and an expandable accordion whose
completed phases collapse to one line.

Evidence base: 17 real runs on disk (`~/.claude/projects/*/<sessionId>/workflows/`)
plus their 17 scripts, and the decompiled CLI (`native-binary/claude`, 2.1.220).

---

## 1. Established facts

### 1.1 Real workflow size — the pane-flooding fear is unfounded

| | min | median | mean | max |
|---|---|---|---|---|
| Phases (`meta.phases`) | 1 | **3** | 2.9 | **5** |
| Agents | 1 | **4** | 3.6 | **8** |

Durations 0.5 → 192 min. A 3–5 square strip fits the collapsed row trivially.
Overflow is a guard case (`pipeline()` over a discovered work-list), not the common
path; this repo's session config caps workflows at ~15 agents.

### 1.2 Where the data lives

`workflowProgress` is held in an **in-memory task registry**, reaching disk only at
terminal state (`completeWorkflowTask` / `failWorkflowTask`). `/workflows` is
`type:"local-jsx"` — a React view rendered **inside the CLI process**, reading that
registry directly. That is why it has data no file holds.

**But the registry is broadcast out**, and the webview already receives it:

```js
function Wpr(e){ lv({ type:"system", subtype:"task_progress",
  task_id, tool_use_id, description, subagent_type,
  usage:{ total_tokens, tool_uses, duration_ms },
  last_tool_name, summary,
  workflow_progress: e.workflowProgress })}    // ← the full live array
```

`task_started` announces `task_type`, `workflow_name`, and `prompt`. For a workflow
task the registry is built as `{...script:t, scriptPath:r, prompt:t}` — so
**`task_started.prompt` is the full script source**, carrying the `meta.phases`
table of contents. The `Workflow` contract requires `meta` to be the first
statement and a pure literal.

The webview then **discards the workflow parts**:

```js
handleTaskStarted(e){ ... if(t.task_type!=="local_agent") return; ... }
handleTaskProgress(e){ ... let i=this.subagentTasks.value.get(t.task_id); if(!i) return; ... }
```

`task_started` bails for `local_workflow`, so the task is never registered, so
`handleTaskProgress` can't find it and drops `workflow_progress` on the floor.

### 1.3 Emission cadence — resolved

The workflow runner batches through `fj_`:

```js
o=(i)=>{ if(r=void 0, t.length===0) return;
  if(!i && !_n() && LR()){ /* dj_=250ms min interval */ }
  let s=t; t=[]; e.onBatch(s);
  if(!_n() && !LR()) return;          // gate on SDK emission
  e.onSdkEmit(s) };
onProgress:(i)=>{ t.push(i); if(!r) r=setTimeout(o, uj_ /*16ms*/) }
```

with `_n() = !Mt.isInteractive` (true in SDK/non-interactive mode) and
`LR() = Mt.replBridgeActive`. Cursor runs the CLI in SDK mode (`promptSource:"sdk"`,
`entrypoint:"claude-vscode"`), so `_n()` is true — the 250 ms throttle branch is
skipped and the `onSdkEmit` gate never returns early.

The emit site decides whether to attach the array:

```js
let q=B.findLast(Y=>Y.type==="workflow_agent"),
    z=B.every(Y=>Y.type==="workflow_agent" && Y.state==="progress"),
    K=!z || Date.now()-I >= pj_;      // pj_ = 10_000
Wpr({ ..., description: q ? (q.phaseTitle?`${q.phaseTitle}: ${q.label}`:q.label) : T.description,
      lastToolName:q?.label, workflowProgress: K ? j.workflowProgress.filter(pTd) : undefined })
```

**Consequences, all favourable:**

- Any **state transition** (`start`/`done`/`error`, or a new `phase()`) makes `z`
  false → the **full array ships immediately**. Squares change the moment work does.
- Batches of pure `"progress"` heartbeats ship the array at most every **10 s**, but
  still carry `description` = `"PhaseTitle: label"` — a live activity line.
- **`workflow_progress` is `undefined` when throttled.** Not empty — absent.
- `pTd(e){return e.type!=="workflow_log"}` — logs are **always excluded**, so the
  payload is bounded by phases + agents.

### 1.4 Shapes, vocabulary, invariants

Streamed and persisted shapes are identical:

```
workflow_phase  { index, title }
workflow_agent  { index, phaseIndex, phaseTitle, label, state, model, agentType,
                  isolation, tokens, toolCalls, lastToolName, lastToolSummary,
                  promptPreview, resultPreview, startedAt, queuedAt, durationMs,
                  attempt, lastAttemptReason, cached }
```

- **States** (from the emission sites): `start` → `progress` → `done` | `error`.
  Terminal = `done` | `error`.
- **`cached: true`** is emitted with `state:"done"` immediately on resume, for
  agents replayed from a prior run. (This explains the historical run whose first
  four agents' files predate its start by ~1.6 days.)
- **Indices are 1-based**; across all 110 corpus entries `phaseIndex` was always
  present and ≥ 1.
- The CLI upserts by `${type}:${index}` before broadcasting, so the array arrives
  **already merged** — consumers replace, never merge.

### 1.5 Verified against the corpus

| Check | Result |
|---|---|
| All 5 patch anchors unique in `webview/index.js` | **1 occurrence each** |
| `meta.phases` present within first 4096 B of script | **17 / 17** |
| `workflow_log` in persisted progress | **0** (49 phase + 61 agent entries only) |
| Compact projection size | median **1044 B**, max **2072 B** on the wire (host reference: 1055 / 2100; raw: median 4939 B, max 9727 B) |

> The projection measured 952 / 1892 B when this table was first written. The
> difference is entirely the per-agent `startedAt`/`durationMs` (~32 B each), which
> §3.4's elapsed-time counter needs and which nothing else can reconstruct; no field
> was added for any other reason.

### 1.6 Correction to a standing assumption

The `__wtBgTasks` mirror ([patchClaude.ts:941](src/patchClaude.ts#L941)) is injected
*after* the `task_type!=="local_agent"` gate, so **it has never tracked workflows**.
The running-workflow spinner comes from [backgroundWork.ts](src/backgroundWork.ts):
workflow subagents are nested `native-binary/claude` processes matching
`WORK_SIGNATURES`. The capability is real; the mechanism is not the assumed one.

### 1.7 Rejected alternatives

- **Poll the run directory.** `agent-<id>.meta.json` mtime matches `startedAt` to
  0.0 s and `agent-<id>.jsonl` matches finish to ~0.1 s — spawn/finish *are* live on
  disk, but nothing on disk carries phase or label until the run ends. Coarse.
- **`listTasks` in `extension.js`.** MCP-SDK boilerplate (`tasks/list`), unrelated to
  Claude's task registry. Red herring.
- **Read `workflows/<runId>.json`.** Terminal-only, and unsafe as a done-signal:
  resume reuses the same `runId` (observed: `wf_ff40066f-2a9` launched twice), so a
  stale JSON sits beside an in-flight run.

---

## 2. Decisions

| | |
|---|---|
| Squares | **One per phase**, agents revealed on expand |
| Scope | **Workflows only** — plain background `Task` subagents keep today's spinner |
| History | **Current / most recent run only** |
| Collapsed summary | **Result summary text** (`resultPreview`) |
| Anchor breakage | **Degrade to nothing** — no chevron, same best-effort discipline as the rest of `patchClaude` |

Consequence of patch-only, stated plainly: after a window reload **mid-run**, state
repopulates on the next transition or within 10 s (the stream sends the whole array,
not deltas). After a reload following a **completed** run, the strip is gone.
Accepted.

---

## 3. Design

### 3.1 Data model — `src/workflowProgress.ts` (new, no `vscode` import)

```ts
export type WfState = "start" | "progress" | "done" | "error";
export interface WfPhase { index: number; title: string }
export interface WfAgent {
  index: number; phaseIndex?: number; label?: string; state: WfState;
  lastToolName?: string; resultPreview?: string; cached?: boolean;
  startedAt?: number; durationMs?: number;
}
export interface WorkflowRun {
  taskId: string; name: string;
  status: "running" | "completed" | "failed";
  activity?: string;        // task_progress.description — "Phase: label"
  planned: string[];        // meta.phases titles (may be empty)
  phases: WfPhase[]; agents: WfAgent[];
  updatedAt: number;
}
export type PhaseState = "pending" | "active" | "done" | "failed";
```

Pure functions, unit-tested against the 17 real `wf_*.json` files:

- `parsePlannedPhases(scriptPrefix): string[]` — locate `export const meta`, then the
  `phases:[` array, and walk it with a **bracket counter** to its matching `]`
  before extracting `title:` values. A loose global regex over the whole prefix
  happens to give the right answer on all 17 scripts, but would misfire on any
  `title:` appearing later in the file; bounding the scan removes that class of bug.
- `derivePhaseStates(run): PhaseState[]` —
  - `failed` — any agent in the phase has `state === "error"`
  - `done` — ≥ 1 agent, all terminal
  - `active` — ≥ 1 non-terminal agent
  - `pending` — no agents yet
  - strip length = `max(planned.length, max(phase.index))`; grows if a dynamic
    script declares more phases than `meta` listed.
  - agents with no `phaseIndex` (a script that never calls `phase()`) collect into a
    synthetic trailing bucket rather than being dropped.

### 3.2 Capture — `src/patchClaude.ts`

**One new anchor** (verified unique), hooking the dispatch *before* the
`local_agent` filter:

```js
else if(e.type==="system"&&e.subtype==="task_progress")this.handleTaskProgress(e)
```

`applyWfTracking` maintains `this.__wtWf` — a Map `taskId → {name, planned, progress, status, activity}`,
mirroring the `__wtBgTasks` idiom:

- `task_started` && `task_type==="local_workflow"` → create the entry; keep
  `workflow_name` and the **first 4096 chars of `prompt`** (the script prefix).
- `task_progress` → set `activity = description`; **replace `progress` only when
  `workflow_progress` is present.** When absent (throttled), keep the previous array.
- `task_notification` → mark terminal, stop the pulse.

**Three extensions to already-patched functions** (not new anchors):

- `applyWebviewStatus` — `__wtSend` passes a compact projection as a new `wtWf`
  argument; `renameTab` forwards it on the `rename_tab` request beside the existing
  `wtStatus`/`wtSeen`/`wtInterrupt`/`wtBg`.
- `applyStatusStash` — host side stashes `this.__wtWf = e.request.wtWf`, exactly as
  it already does for `__wtWeb` at [patchClaude.ts:395](src/patchClaude.ts#L395).
- `applyTabCommands` — include `__c.__wtWf` in the tab descriptor.

Each injection guards on `split(anchor).length - 1 === 1` and returns
`{changed:false, note}` otherwise, like every existing patch function.

**Payload and poke discipline** — the two things that keep this cheap:

- Ship a projection, not the raw array:
  `{t,n,s,d,P:[titles],p:[{i,T}],a:[{i,p,l,st,tn,c,r,sa,dm}]}`. **Every string is
  clipped** — `name` ≤ 40, phase/planned `title` ≤ 40, `label` ≤ 40,
  `lastToolName` ≤ 24, `resultPreview` and the `activity` line ≤ 120 — which is what
  makes the caps below an actual bound rather than a bound on the array lengths only.
  Measured on the corpus: **median 1044 B, max 2072 B** (vs. 4939 / 9727 B raw); the
  cap-bounded worst case (32 phases, 64 agents, every field at its limit) is
  **~20 KB**. `sa`/`dm` are `startedAt`/`durationMs`: §3.4's elapsed counter cannot
  derive them, and they are the whole of the difference from the 952 / 1892 B first
  measured in §1.5.
- Compute a signature (`agents.map(a=>a.index+a.state).join()` + phase count +
  status) and **omit `wtWf` when unchanged**.
- **Do not poke `__wtSend()` on every batch.** Batches coalesce at 16 ms; poking
  that fast would flood the `rename_tab` channel. Poke only when the signature
  changes — i.e. on state transitions, a few times per run — with a 500 ms floor.
  Pure heartbeats ride along on the next natural tick.
- **The poke gate may not depend only on state its consumer advances.** `__wtWfSig`
  is written by `__wtSend`, which can decline to publish at all (the run is on a
  session that is not `activeSession`, or a stale bundle's `__wtSend` predates the
  `wtWf` argument). The hook therefore also latches the signature it last poked FOR
  (`self.__wtWfPoked`), so an unpublishable projection costs one poke instead of one
  per tick. The floor is kept, and the latch is set inside it, so a poke the floor
  suppressed is still owed.

### 3.3 Plumbing

- [claudeStatus.ts](src/claudeStatus.ts) — parse `wtWf` into `WorkflowRun`, expose as
  `ClaudeTab.wf?`. Reuse the existing 1.5 s poll; no new watcher, no new timer.
- Phase NUMBERS are untrusted input, not just numbers: `parseWfProjection` accepts a
  phase index only when it is an **integer in 1..32**, because that value is used as
  an array index and as a growth target. A fraction indexed `buckets[0.5]` and threw
  inside the pane's render path — which blanks the entire Source+ pane, not one strip
  — and a huge value grew the strip (and the open accordion) to that many nodes.
  Anything else buckets as an orphan, so the agent stays visible.
- [broker/protocol.ts](src/broker/protocol.ts) — add the optional field to the tab
  shape if descriptors cross the broker.

### 3.4 UI — [scmMirrorView.ts](src/scmMirrorView.ts)

**Collapsed row** (`renderClaudeTabs`, [scmMirrorView.ts:2137](src/scmMirrorView.ts#L2137)):

```
▸ editor-qa-round3   ■■▣□□   ◴
```

Chevron in a fixed 16 px slot at row start. `.ctab` has no chevron today, and
PLAN.md's `<`/`>` expanders live on the worktree container, so there is no
collision. Squares sit between title and status indicator. Rows without a workflow
render exactly as today — no reserved slot, no reflow.

**Expanded accordion:**

```
▾ editor-qa-round3                        ■■▣□□
  ■ Scan      2 agents · 4m   found 6 nesting violations…      ✓
  ■ Triage    1 agent  · 2m   grouped into 3 root causes…      ✓
  ▣ Fix                                              ← active
      fix:round1   Edit Replace.swift        3m
      fix:round2   running…                  1m
  □ Verify
  □ Report
```

- Completed phases collapse to one line: agent count, duration, and the last agent's
  `resultPreview`, truncated.
- Active phase auto-expands, listing agents with `label`, `lastToolName`, and
  client-side elapsed time from `startedAt`.
- Auto-collapse on completion **unless** manually toggled — per-phase override set,
  cleared when a new run starts.
- Pending phases: dim one-liners from `planned[]`.
- **Cached agents** (`cached:true`, replayed on resume) render muted with a distinct
  glyph, so a resumed run that lights up instantly reads as "reused", not "ran".

**Styling** — reuse existing tokens rather than inventing a palette (and satisfy the
companion/`.ctab` pixel-parity rule):

| state | style |
|---|---|
| done | `#22C55E` (matches `.ccheck`) |
| active | `#D97757` + existing `ah-pulse` animation |
| pending | transparent, `inset 0 0 0 1px var(--vscode-descriptionForeground)` (matches `.cdot.hollow`) |
| error | `#EF4444` |
| cached | done colour at 45 % opacity |

Squares 6×6 px, 2 px gap, 1 px radius. **Overflow guard:** above 12 phases the strip
renders `■■▣ 3/17` — squares plus a count.

**Interaction:** the chevron must `stopPropagation` on `mousedown`/`click` so it
neither focuses the tab nor starts a drag — `makeReorderable` uses the whole row as
its handle, the same hazard `beginRenameTab` already works around.

---

## 4. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | `workflow_progress` absent on throttled ticks; naive code clears the strip every 10 s | **High** — silent, intermittent | Treat `undefined` as "no change": update `activity`/elapsed only. Covered by a unit test feeding a throttled tick. |
| 2 | Poking `__wtSend()` per 16 ms batch floods `rename_tab` | **High** — perf | Poke only on signature change, 500 ms floor. Heartbeats ride the existing tick. The gate compares against the hook's OWN last-poked signature as well as the published one — gating on the published signature alone (which only `__wtSend` advances) meant a projection `__wtSend` could not publish, e.g. a workflow on a non-active session, re-opened the gate on every tick and flooded at ~2 msg/s for the whole run. |
| 3 | `_n()`/`LR()` are runtime flags; if both were false no `task_progress` reaches us | Medium | SDK mode is near-certain (`promptSource:"sdk"`; the webview already consumes `task_progress` for `local_agent`). Confirm empirically in build step 2 before any UI work — a one-line log of the first arriving payload settles it. |
| 4 | Patch anchors break on a Claude update | Medium — expected | All 5 unique today; every injection guards on uniqueness and no-ops with a note. Degrades to no chevron. Accepted. |
| 5 | `meta.phases` is optional in the contract | Medium | 17/17 present, but never assume a total: fall back to progressive squares that appear as `phase()` is called. |
| 6 | Loose `title:` regex picks up non-meta matches | Medium — wrong TOC | Bracket-counted scan bounded to the `phases:[…]` array (§3.1). |
| 7 | Resumed runs emit `state:"done", cached:true` instantly — looks like it finished in a second | Medium — misleading | Distinct muted styling + treat as complete-but-not-run. |
| 8 | Dynamic scripts declare more phases than `meta` lists, or repeat titles | Low | Merge by index; let the strip grow; `max(planned, observed)`. |
| 9 | Nested `workflow()` children share the parent's counters and could collide on index | Low | The CLI upserts by `${type}:${index}` before broadcasting; we replace wholesale, so we render exactly what it rendered. No independent merge logic to get wrong. |
| 10 | Large `pipeline()` fan-out inflates payload | Low | Logs already excluded (`pTd`); caps of 32 phases / 64 agents **and a clip on every string** (§3.2), which together bound the payload at ~20 KB measured; numeric fallback above 12 phases. A count cap alone left `name` unbounded and the titles unclipped on the reference side. |
| 11 | Concurrent workflows in one session | Low | Keyed by `taskId`; show most recently updated. |
| 12 | No final `task_progress` after completion leaves an agent mid-pulse | Low | `task_notification` marks terminal and stops the pulse regardless of last agent state. |
| 13 | Chevron click steals focus / starts a drag | Low | `stopPropagation`, mirroring `beginRenameTab`. |

---

## 5. Build order

1. **`src/workflowProgress.ts` + unit tests** against the 17 real `wf_*.json`
   fixtures and 17 real scripts. Fully offline — no patch, no UI. Locks the
   derivation layer, and covers risks 1, 5, 6, 8.
2. **`applyWfTracking` + the three channel extensions.** Log the first arriving
   payload to settle risk 3 before building anything on top.
3. **`claudeStatus.ts` plumbing.**
4. **Collapsed row:** chevron + phase strip.
5. **Expanded accordion** + auto-collapse + cached styling.
6. **E2E:** run a real 3-phase workflow and watch the strip fill and phases
   collapse; then resume it to exercise the cached path. (Per the global rule,
   reproduce as a user would. Screenshots are blocked in this environment — drive
   and inspect via CGEvent + AX.)
