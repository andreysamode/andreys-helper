/**
 * Pure derivation layer for dynamic-workflow progress (WORKFLOW-PROGRESS.md §3.1).
 *
 * No `vscode` import and no I/O, so this is unit-testable under `node --test`
 * against the 17 real runs checked in at `src/fixtures/workflowRuns.json` — the
 * same discipline as scmParse.ts. Everything downstream (the patch's in-webview
 * tracker, claudeStatus.ts, the Source+ strip) is a consumer of these shapes.
 *
 * The data arrives as Claude's own `workflow_progress` array, broadcast on the
 * `task_progress` system message. The CLI has already upserted it by
 * `${type}:${index}` before broadcasting, so consumers REPLACE wholesale and never
 * merge — there is deliberately no merge logic here to get wrong.
 */

/** Agent lifecycle, in order. Terminal = `done` | `error`. */
export type WfState = "start" | "progress" | "done" | "error";

export interface WfPhase {
  /** 1-based, as emitted. */
  index: number;
  title: string;
}

export interface WfAgent {
  /** 1-based, as emitted. */
  index: number;
  /** 1-based phase this agent was attributed to; absent if the script never called `phase()`. */
  phaseIndex?: number;
  label?: string;
  state: WfState;
  lastToolName?: string;
  resultPreview?: string;
  /** Replayed from a prior run on resume — emitted `done` instantly (risk #7). */
  cached?: boolean;
  startedAt?: number;
  durationMs?: number;
}

export interface WorkflowRun {
  taskId: string;
  name: string;
  status: "running" | "completed" | "failed";
  /** `task_progress.description` — "PhaseTitle: label". A live activity line. */
  activity?: string;
  /** `meta.phases` titles from the script prefix. MAY BE EMPTY — phases is optional. */
  planned: string[];
  phases: WfPhase[];
  agents: WfAgent[];
  updatedAt: number;
}

export type PhaseState = "pending" | "active" | "done" | "failed";

/**
 * Projection caps (risk #10). A `pipeline()` over a discovered work-list can fan
 * out far past the 1–5 phases / 1–8 agents the corpus shows; the strip degrades to
 * a numeric count above 12 phases anyway, so anything past these bounds could only
 * bloat the `rename_tab` payload.
 */
const MAX_PROJECTED_PHASES = 32;
const MAX_PROJECTED_AGENTS = 64;
/** Per-field clips for the compact wire shape (§3.2). */
const MAX_LABEL = 40;
/**
 * Phase and planned-phase titles. Same 40 the injected projection applies
 * (`TR(it.title,40)`, and `__wtWfPlan`'s own cap on the TOC it parses) — kept as its
 * own constant because a title and an agent label are different things that happen
 * to share a width.
 */
const MAX_TITLE = 40;
const MAX_TOOL_NAME = 24;
const MAX_RESULT_PREVIEW = 120;
/**
 * The run's own name is capped too, at MAX_LABEL. It comes from the script's
 * `meta.name` (or the task description), so it is as unbounded as any label a
 * script writes; leaving it alone was what let the cap-bounded worst case reach
 * ~20 KB instead of the ~2 KB the caps are meant to guarantee. The chevron tooltip
 * is the only place it is displayed, so 40 chars loses nothing.
 */
const MAX_NAME = 40;

// ---------------------------------------------------------------------------
// meta.phases — the planned table of contents
// ---------------------------------------------------------------------------

/**
 * Extract the `meta.phases[].title` list from the first 4096 chars of a workflow
 * script (what the runtime hands us as `task_started.prompt`).
 *
 * The scan is BOUNDED — meta object, then the `phases:[…]` array, both walked with
 * a bracket counter — rather than a loose global `/title:/` regex. A loose regex
 * happens to give the right answer on all 17 corpus scripts, but the prefix keeps
 * whatever body follows `meta`, and several scripts declare further object literals
 * there; a stray `title:` in one of them would silently corrupt the table of
 * contents (risk #6). Bounding removes that class of bug outright.
 *
 * Returns `[]` when `meta` or `phases` is absent — `phases` is OPTIONAL in the
 * Workflow contract, so callers must never treat the length as a known total
 * (risk #5); `derivePhaseStates` grows the strip from observed phases instead.
 */
export function parsePlannedPhases(scriptPrefix: string): string[] {
  const metaAt = scriptPrefix.indexOf("export const meta");
  if (metaAt === -1) {
    return [];
  }
  const braceAt = scriptPrefix.indexOf("{", metaAt);
  if (braceAt === -1) {
    return [];
  }
  // A 4096-char prefix can cut the object off mid-literal, so an unmatched bracket
  // means "scan to the end of what we were given" rather than "give up".
  const metaBody = sliceBracketed(scriptPrefix, braceAt);
  const arrayAt = findArrayValue(metaBody, "phases");
  if (arrayAt === -1) {
    return [];
  }
  return extractTitles(sliceBracketed(metaBody, arrayAt));
}

/** Interior of the bracket pair opening at `open`, to its match or to end-of-input. */
function sliceBracketed(src: string, open: number): string {
  const close = matchBracket(src, open);
  return src.slice(open + 1, close === -1 ? src.length : close);
}

/**
 * Index of the bracket closing the pair that opens at `open`, or -1 if unmatched.
 * Only the one pair is counted — a `}` can never close a `[` in a valid literal —
 * and string literals are skipped so a bracket inside a title can't throw the count.
 */
function matchBracket(src: string, open: number): number {
  const openCh = src[open];
  const closeCh = openCh === "[" ? "]" : "}";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i) - 1;
    } else if (ch === openCh) {
      depth++;
    } else if (ch === closeCh && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** Index just past the string literal whose opening quote is at `i` (escapes honored). */
function skipString(src: string, i: number): number {
  const quote = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
    } else if (src[j] === quote) {
      return j + 1;
    }
  }
  return src.length; // unterminated — the prefix was truncated mid-literal
}

/** Index of the first non-whitespace char at or after `i`. */
function nextNonSpace(src: string, i: number): number {
  while (i < src.length && /\s/.test(src[i])) {
    i++;
  }
  return i;
}

/** Whether `key` sits at `i` as a bare object key (not the tail of a longer identifier). */
function isKeyAt(src: string, i: number, key: string): boolean {
  if (!src.startsWith(key, i)) {
    return false;
  }
  return i === 0 || !/[A-Za-z0-9_$]/.test(src[i - 1]);
}

/** Index of the `[` opening `<key>: [ … ]`, skipping string literals; -1 if absent. */
function findArrayValue(src: string, key: string): number {
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i) - 1;
      continue;
    }
    if (ch !== key[0] || !isKeyAt(src, i, key)) {
      continue;
    }
    const colon = nextNonSpace(src, i + key.length);
    if (src[colon] !== ":") {
      continue;
    }
    const bracket = nextNonSpace(src, colon + 1);
    if (src[bracket] === "[") {
      return bracket;
    }
  }
  return -1;
}

/**
 * Pull every `title: <string literal>` out of an already-bounded array body.
 * Non-literal titles (a variable, a template with substitutions) are skipped
 * rather than guessed at — we render what we can prove.
 */
function extractTitles(body: string): string[] {
  const titles: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(body, i) - 1;
      continue;
    }
    if (ch !== "t" || !isKeyAt(body, i, "title")) {
      continue;
    }
    const colon = nextNonSpace(body, i + "title".length);
    if (body[colon] !== ":") {
      continue;
    }
    const open = nextNonSpace(body, colon + 1);
    const quote = body[open];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      i = colon;
      continue;
    }
    const end = skipString(body, open);
    if (body[end - 1] !== quote) {
      break; // truncated mid-title; nothing usable follows
    }
    titles.push(unescapeLiteral(body.slice(open + 1, end - 1)));
    i = end - 1;
  }
  return titles;
}

/** Resolve the backslash escapes a quoted title can legally carry. */
function unescapeLiteral(raw: string): string {
  return raw.replace(/\\(.)/g, (_m, c: string) =>
    c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c
  );
}

// ---------------------------------------------------------------------------
// The live progress array
// ---------------------------------------------------------------------------

/**
 * Split a raw `workflow_progress` array into typed phases and agents.
 *
 * Tolerant by construction: the array crosses a patched-bundle boundary we do not
 * own, so an unrecognized `type` (`workflow_log` is already stripped upstream by
 * the CLI's `pTd` filter, but nothing guarantees that forever) is dropped, and an
 * unknown `state` is read as non-terminal so a phase can never be declared done on
 * a vocabulary change we did not anticipate.
 */
export function splitWorkflowProgress(entries: unknown): {
  phases: WfPhase[];
  agents: WfAgent[];
} {
  const phases: WfPhase[] = [];
  const agents: WfAgent[] = [];
  if (!Array.isArray(entries)) {
    return { phases, agents };
  }
  for (const raw of entries) {
    const e = rec(raw);
    if (!e) {
      continue;
    }
    const index = num(e.index);
    if (index === undefined) {
      continue;
    }
    if (e.type === "workflow_phase") {
      phases.push({ index, title: str(e.title) ?? "" });
    } else if (e.type === "workflow_agent") {
      const agent: WfAgent = { index, state: state(e.state) };
      assign(agent, "phaseIndex", num(e.phaseIndex));
      assign(agent, "label", str(e.label));
      assign(agent, "lastToolName", str(e.lastToolName));
      assign(agent, "resultPreview", str(e.resultPreview));
      assign(agent, "startedAt", num(e.startedAt));
      assign(agent, "durationMs", num(e.durationMs));
      if (e.cached === true) {
        agent.cached = true;
      }
      agents.push(agent);
    }
  }
  return { phases, agents };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * A phase NUMBER, or `undefined` for anything that cannot be one. Distinct from
 * {@link num} because this value is used as an array index and as a growth target,
 * and it arrives across the patch boundary — the injected projection copies
 * `phaseIndex` verbatim out of Claude's broadcast, so "finite number" is not enough:
 *
 *  - a fraction (1.5) is not an index. It passed the old `>= 1` check, then
 *    `buckets[0.5]` was `undefined` and reading `.agents` off it threw — inside the
 *    pane's render path, which blanks the WHOLE Source+ pane rather than one strip.
 *  - a huge value (20000) is not a phase either: the projection can carry at most
 *    MAX_PROJECTED_PHASES, so anything past that was never announced by a `phase()`
 *    call we could render, and using it as a growth target builds that many buckets
 *    (and, with the accordion open, that many DOM rows) on every repaint.
 *
 * Rejecting to `undefined` rather than clamping is deliberate: an agent with no
 * usable phase lands in the orphan bucket, which is honest and keeps the rule that
 * work which ran is visible somewhere. Clamping to 32 would file it under a phase it
 * has nothing to do with.
 */
function phaseNo(v: unknown): number | undefined {
  return typeof v === "number" &&
    Number.isInteger(v) &&
    v >= 1 &&
    v <= MAX_PROJECTED_PHASES
    ? v
    : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function state(v: unknown): WfState {
  return v === "start" || v === "done" || v === "error" ? v : "progress";
}

/**
 * Set an optional field only when it has a value, so absent stays absent — an
 * explicit `undefined` would survive into `JSON.stringify` as nothing but still
 * defeat any `"key" in obj` check downstream, and clutters the object we project.
 */
function assign<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

/** Narrow an unknown array element to a plain record. */
function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/**
 * The wire message we get on `task_progress`. Field names are the SDK's own, so
 * `workflow_progress` keeps its snake_case: renaming it here would hide the one
 * property that matters about this payload.
 */
export interface WfProgressTick {
  /** "PhaseTitle: label" — present on EVERY tick, including throttled ones. */
  description?: string;
  /**
   * The full array — or ABSENT (not empty) when the emitter throttled it, which it
   * does for any batch of pure `progress` heartbeats inside a 10 s window.
   */
  workflow_progress?: unknown;
}

/**
 * Fold one `task_progress` tick into the run.
 *
 * This function exists to own risk #1, the single highest-severity trap in the
 * design: `workflow_progress` is `undefined` on a throttled tick, so the obvious
 * `run.agents = split(msg.workflow_progress).agents` blanks the strip every ~10 s,
 * intermittently and silently. ABSENT MEANS NO CHANGE — only `activity` (and the
 * timestamp the UI derives elapsed time from) move. An explicitly empty array is a
 * different statement and IS honored.
 *
 * `applyWfTracking` in patchClaude.ts re-states this rule in injected JS because it
 * runs inside Claude's bundle and cannot import from here; this is the reference
 * definition the injected mirror must keep matching.
 */
export function applyProgressTick(
  prev: WorkflowRun,
  tick: WfProgressTick,
  now: number
): WorkflowRun {
  const next: WorkflowRun = { ...prev, updatedAt: now };
  const activity = str(tick.description);
  if (activity !== undefined) {
    next.activity = activity;
  }
  if (tick.workflow_progress !== undefined && tick.workflow_progress !== null) {
    const split = splitWorkflowProgress(tick.workflow_progress);
    next.phases = split.phases;
    next.agents = split.agents;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

function isTerminal(a: WfAgent): boolean {
  return a.state === "done" || a.state === "error";
}

/**
 * One `PhaseState` per square in the strip, in 1-based phase order (§3.1).
 *
 * Strip length is `max(planned.length, max(phase.index))`, so a dynamic script that
 * calls `phase()` more times than `meta` advertised grows the strip instead of
 * clipping it (risk #8), and a script with no `meta.phases` at all still produces a
 * strip that appears progressively (risk #5).
 *
 * Agents carrying no `phaseIndex` — a script that never calls `phase()` — collect
 * into a synthetic trailing bucket rather than vanishing. Work that ran must always
 * be visible somewhere.
 *
 * The run's own `status` is read too, and it is what settles risk #12: a killed or
 * interrupted run's LAST word is `task_notification`, not a final progress array
 * (the CLI marks the task terminal before aborting its agents, after which the
 * batcher's own `status !== "running"` guards drop everything), so the newest array
 * we will ever hold still shows the aborted agent as `start`/`progress`. Once the
 * run has ended, work still shown as unfinished was ABANDONED, and reads as the
 * run's verdict rather than as in-flight. Phases that did finish keep theirs — a
 * completed phase inside a failed run is still a completed phase.
 */
export function derivePhaseStates(run: WorkflowRun): PhaseState[] {
  // Every phase number is re-checked here even though parseWfProjection already
  // rejected the unusable ones: a `WorkflowRun` can also be built by hand (the
  // tests do) and this function must be total for any of them, because it is the
  // reference the pane's twin is held to. See phaseNo() for what "unusable" means.
  let observed = 0;
  for (const p of run.phases) {
    const i = phaseNo(p.index);
    if (i !== undefined && i > observed) {
      observed = i;
    }
  }
  const buckets: WfAgent[][] = [];
  for (let i = 0; i < Math.max(Math.min(run.planned.length, MAX_PROJECTED_PHASES), observed); i++) {
    buckets.push([]);
  }
  const orphans: WfAgent[] = [];
  for (const a of run.agents) {
    const pi = phaseNo(a.phaseIndex);
    if (pi === undefined) {
      orphans.push(a);
      continue;
    }
    // An agent can in principle cite a phase whose announcement we never saw; grow
    // rather than drop it, for the same reason orphans get their own bucket. Bounded
    // by phaseNo's ceiling, so growth is at most MAX_PROJECTED_PHASES buckets.
    while (buckets.length < pi) {
      buckets.push([]);
    }
    buckets[pi - 1].push(a);
  }
  if (orphans.length > 0) {
    buckets.push(orphans);
  }
  return buckets.map((b) => bucketState(b, run.status));
}

/** Rule order matters: a phase holding both an errored and a live agent reads failed. */
function bucketState(agents: WfAgent[], status: WorkflowRun["status"]): PhaseState {
  if (agents.length === 0) {
    return "pending";
  }
  if (agents.some((a) => a.state === "error")) {
    return "failed";
  }
  if (agents.every(isTerminal)) {
    return "done";
  }
  // Non-terminal agents in a run that has ended were abandoned, not running.
  return status === "running" ? "active" : status === "completed" ? "done" : "failed";
}

/**
 * Change key over everything the strip can render: agent index+state, phase count,
 * run status. Ticks whose signature is unchanged carry nothing a square could show,
 * so the capture side omits `wtWf` and skips the `__wtSend()` poke entirely —
 * batches coalesce at 16 ms and poking that fast would flood `rename_tab` (risk #2).
 */
export function workflowSignature(run: WorkflowRun): string {
  return (
    run.status +
    "|" +
    run.phases.length +
    "|" +
    run.agents.map((a) => a.index + a.state).join(",")
  );
}

// ---------------------------------------------------------------------------
// Compact wire projection (§3.2)
// ---------------------------------------------------------------------------

/** `{i,T}` — phase index and title. */
export interface WfProjectedPhase {
  i: number;
  T: string;
}

/**
 * `{i,p,l,st,tn,c,r,sa,dm}` — index, phaseIndex, label, state, lastToolName,
 * cached, resultPreview, startedAt, durationMs.
 *
 * The two timings are the only numeric fields the strip's accordion cannot derive
 * for itself: elapsed time for a live agent has to count up from `startedAt`
 * client-side (§3.4), and a finished agent's `durationMs` is the runner's own
 * measurement, not something a UI that only sees terminal state could reconstruct.
 * They cost ~32 B per agent, and that is the ENTIRE difference between the design's
 * original figures (median 952 B / max 1892 B, quoted before §3.4's elapsed-time
 * requirement existed) and what ships today (median 1055 B / max 2100 B) — unlike
 * `promptPreview` and `lastToolSummary`, which are what made the raw array 10 KB
 * and stay out.
 *
 * `c` is `true` from {@link projectWorkflowRun} but `1` from the injected
 * webview-side projection in patchClaude.ts, which optimizes for bytes on a channel
 * it shares with every rename; {@link parseWfProjection} accepts either.
 */
export interface WfProjectedAgent {
  i: number;
  p?: number;
  l?: string;
  st: WfState;
  tn?: string;
  c?: true | 1;
  r?: string;
  sa?: number;
  dm?: number;
}

/**
 * `{t,n,s,d,P,p,a}` — taskId, name, status, activity, planned, phases, agents.
 * Every string here is capped: `n` at MAX_NAME, `d` at MAX_RESULT_PREVIEW, the
 * arrays at MAX_PROJECTED_*. That is what makes the worst case a stated number
 * rather than "whatever the script wrote".
 */
export interface WfProjection {
  t: string;
  n: string;
  s: WorkflowRun["status"];
  d?: string;
  P: string[];
  p: WfProjectedPhase[];
  a: WfProjectedAgent[];
}

/**
 * Squeeze a run into the shape that rides on `rename_tab`. The raw array reaches
 * 10 126 B on the corpus, almost all of it `promptPreview`/`lastToolSummary` the UI
 * never shows; dropping those and clipping the rest brings the median to 1055 B and
 * the max to 2100 B, which is what makes shipping this on an existing channel cheap.
 * (§1.5's 952/1892 predate `sa`/`dm`; see WfProjectedAgent.) With every string on
 * the shape clipped, the caps bound the absolute worst case — 32 phases, 64 agents,
 * each field at its limit — at ~20 KB measured (21 733 B here, 19 632 B from the
 * injected twin, which spends fewer bytes on ellipses and writes `c:1`). Only a
 * 64-agent fan-out gets near it, and the strip renders that as a count.
 */
export function projectWorkflowRun(run: WorkflowRun): WfProjection {
  const out: WfProjection = {
    t: run.taskId,
    n: clip(run.name, MAX_NAME) ?? "",
    s: run.status,
    // Titles are clipped as well as counted. The injected twin already did this
    // (__wtWfPlan caps each TOC entry at 40 and the projection wraps every title in
    // TR); leaving them unbounded here made this reference — the thing §3.2's numbers
    // are quoted from — the loosest of the two, and the one place where "the caps
    // bound the channel" was not actually true.
    P: run.planned.slice(0, MAX_PROJECTED_PHASES).map((t) => clip(t, MAX_TITLE) ?? ""),
    p: run.phases
      .slice(0, MAX_PROJECTED_PHASES)
      .map((ph) => ({ i: ph.index, T: clip(ph.title, MAX_TITLE) ?? "" })),
    a: run.agents.slice(0, MAX_PROJECTED_AGENTS).map((ag) => {
      const a: WfProjectedAgent = { i: ag.index, st: ag.state };
      assign(a, "p", ag.phaseIndex);
      assign(a, "l", clip(ag.label, MAX_LABEL));
      assign(a, "tn", clip(ag.lastToolName, MAX_TOOL_NAME));
      assign(a, "r", clip(ag.resultPreview, MAX_RESULT_PREVIEW));
      assign(a, "sa", ag.startedAt);
      assign(a, "dm", ag.durationMs);
      if (ag.cached) {
        a.c = true;
      }
      return a;
    }),
  };
  // The activity line is a whole `PhaseTitle: label` string straight off the wire and
  // is redrawn as a tooltip, so it gets the same 120 the injected side gives it.
  assign(out, "d", clip(run.activity, MAX_RESULT_PREVIEW));
  return out;
}

/** Clip to `max` chars inclusive, marking the cut so the UI doesn't imply completeness. */
function clip(v: string | undefined, max: number): string | undefined {
  if (v === undefined) {
    return undefined;
  }
  return v.length <= max ? v : v.slice(0, max - 1) + "…";
}

/**
 * Parse the entry the EXTENSION-SIDE stream capture builds (WF_STREAM_FN in
 * patchClaude.ts): `{taskId,name,planned,progress,status,activity,ts}`, where
 * `progress` is Claude's raw `workflow_progress` array, verbatim.
 *
 * This is the primary path. It exists as its own function because that entry is a
 * DIFFERENT shape from the webview's compact wire projection — it is built in the
 * extension host, so there is no channel to squeeze it through and nothing is
 * abbreviated or truncated. Feeding it to `parseWfProjection` yields `undefined`
 * (it looks for `t`/`a`, not `taskId`/`progress`), which renders as "no workflow"
 * and is exactly the silent seam this function closes.
 *
 * `updatedAt` is passed in rather than read from the clock, so this stays pure.
 * Anything that isn't a well-formed entry returns `undefined` — the value crosses
 * a patch boundary, so degrade to "no workflow", never to a half-built run.
 */
export function parseWfStreamEntry(raw: unknown, updatedAt: number): WorkflowRun | undefined {
  const o = rec(raw);
  if (!o) {
    return undefined;
  }
  const taskId = str(o.taskId);
  if (!taskId) {
    return undefined;
  }
  const status = o.status;
  const { phases, agents } = splitWorkflowProgress(o.progress);
  const planned = Array.isArray(o.planned)
    ? o.planned
        .filter((t): t is string => typeof t === "string")
        .slice(0, MAX_PROJECTED_PHASES)
        .map((t) => clip(t, MAX_TITLE) as string)
    : [];
  return {
    taskId,
    name: clip(str(o.name) ?? taskId, MAX_NAME) as string,
    status: status === "completed" || status === "failed" ? status : "running",
    activity: str(o.activity) ? clip(str(o.activity)!, MAX_RESULT_PREVIEW) : undefined,
    planned,
    phases: phases.slice(0, MAX_PROJECTED_PHASES),
    agents: agents.slice(0, MAX_PROJECTED_AGENTS),
    updatedAt,
  };
}

/**
 * Inverse of `projectWorkflowRun`, for the host side (claudeStatus.ts) reading a
 * tab descriptor. `updatedAt` is passed in rather than read from the clock so this
 * stays pure and testable; the caller knows when it sampled the descriptor.
 * Returns `undefined` for anything that isn't a projection — an unpatched or
 * stale bundle must degrade to "no workflow", never to a half-built run.
 */
export function parseWfProjection(raw: unknown, updatedAt: number): WorkflowRun | undefined {
  const o = rec(raw);
  if (!o) {
    return undefined;
  }
  const taskId = str(o.t);
  const status = o.s;
  if (
    taskId === undefined ||
    (status !== "running" && status !== "completed" && status !== "failed")
  ) {
    return undefined;
  }
  const run: WorkflowRun = {
    taskId,
    name: str(o.n) ?? "",
    status,
    planned: Array.isArray(o.P)
      ? o.P.filter((t): t is string => typeof t === "string").slice(0, MAX_PROJECTED_PHASES)
      : [],
    phases: [],
    agents: [],
    updatedAt,
  };
  assign(run, "activity", str(o.d));
  if (Array.isArray(o.p)) {
    for (const entry of o.p) {
      const ph = rec(entry);
      // phaseNo, not num: a phase we cannot place is a phase we cannot render, and
      // its index is what the strip's LENGTH is derived from (see phaseNo).
      const i = ph === undefined ? undefined : phaseNo(ph.i);
      if (ph !== undefined && i !== undefined) {
        run.phases.push({ index: i, title: str(ph.T) ?? "" });
      }
    }
  }
  if (Array.isArray(o.a)) {
    for (const entry of o.a) {
      const ag = rec(entry);
      const i = ag === undefined ? undefined : num(ag.i);
      if (ag === undefined || i === undefined) {
        continue;
      }
      const agent: WfAgent = { index: i, state: state(ag.st) };
      // Unusable phase numbers become absent, which buckets the agent as an orphan
      // instead of throwing on `out[0.5]` or growing the strip to 20 000 squares.
      assign(agent, "phaseIndex", phaseNo(ag.p));
      assign(agent, "label", str(ag.l));
      assign(agent, "lastToolName", str(ag.tn));
      assign(agent, "resultPreview", str(ag.r));
      assign(agent, "startedAt", num(ag.sa));
      assign(agent, "durationMs", num(ag.dm));
      // Truthy, not `=== true`: the injected projection sends `c:1` to save bytes.
      // An identity check here silently dropped every cached marker on the wire,
      // which is exactly the signal risk #7's muted styling is built on.
      if (ag.c) {
        agent.cached = true;
      }
      run.agents.push(agent);
    }
  }
  return run;
}

// ---------------------------------------------------------------------------
// Status precedence
// ---------------------------------------------------------------------------

/**
 * Attention states: something is waiting on the USER. A workflow cannot clear one
 * (the run is blocked precisely because the prompt is unanswered), so they outrank
 * everything below.
 */
const ATTENTION = new Set(["plan", "question", "permission"]);

/**
 * "No checkmarks mid-process — spinner all the way until the workflow is done."
 *
 * A dynamic workflow OUTLIVES THE MAIN LOOP: the turn that launched it returns, the
 * session goes idle, and the completion latch stamps a green check while several
 * agents are still working — then flaps between check and spinner as the process-tree
 * background signal drops and re-arms between agents. So a tab whose run is still
 * `running` resolves to "working" regardless of what the completion machinery thinks.
 *
 * Precedence, and each rank is deliberate:
 *   1. attention states (plan / question / permission) — the user is being asked
 *      something; a spinner would hide it.
 *   2. a LIVE run → "working" — outranks "done"/"idle" and the whole done latch.
 *   3. anything else, unchanged — a TERMINAL run (completed/failed) is transparent
 *      here, so normal done/idle behaviour resumes the instant the run finishes. This
 *      reads the run's own status, never a timer, so there is nothing to expire.
 *
 * The patched bundle's own getTabs() resolver applies the same rule (see
 * applyTabCommands), which is what makes the fix independent of the webview channel;
 * this host-side copy is what keeps it true on an older patched bundle, and it is the
 * unit-testable statement of the precedence.
 */
export function resolveWorkflowTabStatus(
  status: string,
  run: WorkflowRun | undefined
): string {
  if (ATTENTION.has(status)) {
    return status;
  }
  return run !== undefined && run.status === "running" ? "working" : status;
}
