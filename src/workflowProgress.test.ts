import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import {
  PhaseState,
  WfProjection,
  WorkflowRun,
  applyProgressTick,
  derivePhaseStates,
  parsePlannedPhases,
  parseWfProjection,
  projectWorkflowRun,
  splitWorkflowProgress,
  workflowSignature,
} from "./workflowProgress";

/**
 * Unit tests for the dynamic-workflow derivation layer (WORKFLOW-PROGRESS.md §5.1),
 * driven off `src/fixtures/workflowRuns.json` — 17 REAL runs lifted verbatim off
 * disk (script prefix as the runtime hands it to us, plus the persisted progress
 * array). The corpus is the point: the parser and the derivation rules are only
 * worth anything if they hold on the scripts people actually wrote.
 *
 * Named risks below are the entries in the design's §4 risk register.
 *
 * The fixture is read with `fs` rather than imported, so `tsc --noEmit` needs no
 * `resolveJsonModule`; `__dirname` is `dist-test/` once esbuild has bundled this.
 */

interface Fixture {
  runId: string;
  workflowName: string;
  status: string;
  /** First 4096 chars of the script — exactly what arrives as `task_started.prompt`. */
  scriptPrefix: string;
  workflowProgress: unknown[];
}

const FIXTURES: Fixture[] = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "src", "fixtures", "workflowRuns.json"),
    "utf8"
  )
) as Fixture[];

/** Build the `WorkflowRun` a fixture's persisted state corresponds to. */
function runOf(f: Fixture): WorkflowRun {
  const split = splitWorkflowProgress(f.workflowProgress);
  return {
    taskId: f.runId,
    name: f.workflowName,
    status: f.status === "failed" ? "failed" : "completed",
    planned: parsePlannedPhases(f.scriptPrefix),
    phases: split.phases,
    agents: split.agents,
    updatedAt: 0,
  };
}

/** A minimal running run, for the hand-built cases. */
function blank(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    taskId: "t1",
    name: "wf",
    status: "running",
    planned: [],
    phases: [],
    agents: [],
    updatedAt: 0,
    ...over,
  };
}

test("fixture corpus is the expected 17 runs / 110 progress entries", () => {
  assert.equal(FIXTURES.length, 17);
  const entries = FIXTURES.reduce((n, f) => n + f.workflowProgress.length, 0);
  assert.equal(entries, 110);
});

// ---------------------------------------------------------------------------
// parsePlannedPhases
// ---------------------------------------------------------------------------

test("parsePlannedPhases: every fixture yields its announced phase titles", () => {
  for (const f of FIXTURES) {
    const planned = parsePlannedPhases(f.scriptPrefix);
    assert.ok(planned.length > 0, f.runId + " parsed no planned phases");
    // The runtime later announces each phase via `phase()`. Since all 17 scripts
    // declare a complete `meta.phases`, the parsed table of contents must equal the
    // titles the run actually emitted — a far stronger check than "non-empty".
    const announced = splitWorkflowProgress(f.workflowProgress).phases.map((p) => p.title);
    assert.deepEqual(planned, announced, f.runId);
  }
});

test("parsePlannedPhases: exact titles for a known script", () => {
  const timer = FIXTURES.find((f) => f.workflowName === "timer-20s");
  assert.ok(timer);
  assert.deepEqual(parsePlannedPhases(timer.scriptPrefix), ["Timer"]);
});

test("parsePlannedPhases: risk #6 — a `title:` after the meta block is not picked up", () => {
  // The prefix keeps whatever body follows `meta`, and real scripts declare further
  // object literals there. A loose global /title:/ regex would return four titles.
  const src = [
    "export const meta = {",
    "  name: 'toc-bounded',",
    "  phases: [",
    "    { title: 'Scan', detail: 'look around' },",
    "    { title: 'Fix' },",
    "  ],",
    "}",
    "",
    "const REPORT = { title: 'NOT A PHASE', properties: { title: 'ALSO NOT' } }",
    "await agent('go', { label: 'x', title: 'STILL NOT' })",
  ].join("\n");
  assert.deepEqual(parsePlannedPhases(src), ["Scan", "Fix"]);
});

test("parsePlannedPhases: quote flavours, escapes and brackets inside titles", () => {
  const src = [
    "export const meta = {",
    "  description: 'phases: [ { title: \"decoy\" } ]',",
    "  phases: [",
    "    { title: 'It\\'s fine', detail: 'a' },",
    '    { title: "double [bracketed]" },',
    "    { title: `backticked` },",
    "    { detail: 'no title here' },",
    "    { title: someVariable },",
    "  ],",
    "}",
  ].join("\n");
  // The decoy lives inside a string literal, so the scan never sees it; the
  // non-literal title is skipped rather than guessed at.
  assert.deepEqual(parsePlannedPhases(src), ["It's fine", "double [bracketed]", "backticked"]);
});

test("parsePlannedPhases: risk #5 — absent meta or absent phases yields []", () => {
  assert.deepEqual(parsePlannedPhases(""), []);
  assert.deepEqual(parsePlannedPhases("phase('Untabled')\nawait agent('x')"), []);
  assert.deepEqual(
    parsePlannedPhases("export const meta = { name: 'no-toc' }\nphase('A')\n"),
    []
  );
  // `subtitle:` must not be mistaken for `title:`.
  assert.deepEqual(
    parsePlannedPhases("export const meta = { phases: [ { subtitle: 'x' } ] }"),
    []
  );
});

test("parsePlannedPhases: a prefix truncated mid-meta still yields what it can", () => {
  const src = "export const meta = {\n  phases: [\n    { title: 'One' },\n    { title: 'Tw";
  assert.deepEqual(parsePlannedPhases(src), ["One"]);
});

// ---------------------------------------------------------------------------
// derivePhaseStates
// ---------------------------------------------------------------------------

test("derivePhaseStates: every fixture derives a sane, settled strip", () => {
  for (const f of FIXTURES) {
    const run = runOf(f);
    const states = derivePhaseStates(run);
    const observed = run.phases.reduce((m, p) => Math.max(m, p.index), 0);
    assert.equal(
      states.length,
      Math.max(run.planned.length, observed),
      f.runId + " strip length"
    );
    // Every one of these runs reached a terminal status, so nothing may still read
    // as in-flight. (Six runs declare a trailing phase whose work was attributed to
    // an earlier phase — those squares legitimately stay `pending`.)
    assert.ok(!states.includes("active"), f.runId + " has a stuck active phase");
    const errored = run.agents.some((a) => a.state === "error");
    assert.equal(states.includes("failed"), errored, f.runId + " failed-phase agreement");
  }
});

test("derivePhaseStates: every phase holding agents settles done or failed", () => {
  for (const f of FIXTURES) {
    const run = runOf(f);
    const states = derivePhaseStates(run);
    for (const a of run.agents) {
      const s = states[(a.phaseIndex ?? 0) - 1] as PhaseState;
      assert.ok(s === "done" || s === "failed", f.runId + " phase " + a.phaseIndex + " = " + s);
    }
  }
});

test("derivePhaseStates: the four rules, in precedence order", () => {
  const run = blank({
    planned: ["A", "B", "C", "D"],
    phases: [
      { index: 1, title: "A" },
      { index: 2, title: "B" },
      { index: 3, title: "C" },
      { index: 4, title: "D" },
    ],
    agents: [
      // done — all terminal
      { index: 1, phaseIndex: 1, state: "done" },
      { index: 2, phaseIndex: 1, state: "done" },
      // failed — an error outranks the live sibling
      { index: 3, phaseIndex: 2, state: "error" },
      { index: 4, phaseIndex: 2, state: "progress" },
      // active — one non-terminal
      { index: 5, phaseIndex: 3, state: "done" },
      { index: 6, phaseIndex: 3, state: "start" },
      // phase 4: no agents at all
    ],
  });
  assert.deepEqual(derivePhaseStates(run), ["done", "failed", "active", "pending"]);
});

test("derivePhaseStates: risk #5 — no meta.phases still grows a strip from observed phases", () => {
  const run = blank({
    planned: parsePlannedPhases("export const meta = { name: 'dynamic' }"),
    phases: [
      { index: 1, title: "Discovered A" },
      { index: 2, title: "Discovered B" },
    ],
    agents: [
      { index: 1, phaseIndex: 1, state: "done" },
      { index: 2, phaseIndex: 2, state: "progress" },
    ],
  });
  assert.deepEqual(run.planned, []);
  assert.deepEqual(derivePhaseStates(run), ["done", "active"]);
});

test("derivePhaseStates: risk #8 — more phases than meta listed grows the strip", () => {
  const run = blank({
    planned: ["Scan", "Fix"],
    phases: [
      { index: 1, title: "Scan" },
      { index: 2, title: "Fix" },
      { index: 3, title: "Fix round 2" },
      { index: 4, title: "Fix round 3" },
    ],
    agents: [
      { index: 1, phaseIndex: 1, state: "done" },
      { index: 2, phaseIndex: 3, state: "done" },
      { index: 3, phaseIndex: 4, state: "progress" },
    ],
  });
  assert.deepEqual(derivePhaseStates(run), ["done", "pending", "done", "active"]);
});

test("derivePhaseStates: agents with no phaseIndex land in a synthetic trailing bucket", () => {
  const run = blank({
    planned: ["Only"],
    phases: [{ index: 1, title: "Only" }],
    agents: [
      { index: 1, phaseIndex: 1, state: "done" },
      { index: 2, state: "progress" },
      { index: 3, state: "done" },
    ],
  });
  // One square for the declared phase, one synthetic square holding both orphans —
  // work that ran is never silently dropped.
  assert.deepEqual(derivePhaseStates(run), ["done", "active"]);

  // A script that never calls phase() at all is nothing but the synthetic bucket.
  const noPhases = blank({ agents: [{ index: 1, state: "error" }] });
  assert.deepEqual(derivePhaseStates(noPhases), ["failed"]);
});

test("derivePhaseStates: risk #12 — a run that ended settles the phase its agents never closed", () => {
  // The shape a killed run leaves behind: `killWorkflowTask` marks the task terminal
  // BEFORE aborting the agent controllers, and every emit path then bails on
  // `status !== "running"` — so the last array we hold shows the in-flight agent at
  // `progress` forever, and `task_notification` is the only further signal.
  const stuck = blank({
    planned: ["Scan", "Fix"],
    phases: [
      { index: 1, title: "Scan" },
      { index: 2, title: "Fix" },
    ],
    agents: [
      { index: 1, phaseIndex: 1, state: "done" },
      { index: 2, phaseIndex: 2, state: "progress" },
    ],
  });
  // While it really is running, that phase really is active.
  assert.deepEqual(derivePhaseStates(stuck), ["done", "active"]);
  // Killed or interrupted: the abandoned phase reads failed, and the phase that did
  // finish keeps its verdict — a completed phase in a failed run is still completed.
  assert.deepEqual(derivePhaseStates({ ...stuck, status: "failed" }), ["done", "failed"]);
  // Completed with a loose end: nothing failed, so it settles rather than pulsing.
  assert.deepEqual(derivePhaseStates({ ...stuck, status: "completed" }), ["done", "done"]);
  // A phase holding no agents holds nothing to settle, whatever the run's status.
  const neverReached = blank({
    status: "failed",
    planned: ["A", "B"],
    phases: [{ index: 1, title: "A" }],
    agents: [{ index: 1, phaseIndex: 1, state: "error" }],
  });
  assert.deepEqual(derivePhaseStates(neverReached), ["failed", "pending"]);
});

test("derivePhaseStates: risk #7 — resumed `cached` agents derive as done", () => {
  // The CLI emits replayed agents as state:"done", cached:true the instant a run
  // resumes. They must count as complete (the UI mutes them separately).
  const run = blank({
    planned: ["Replayed", "Fresh"],
    phases: [
      { index: 1, title: "Replayed" },
      { index: 2, title: "Fresh" },
    ],
    agents: [
      { index: 1, phaseIndex: 1, state: "done", cached: true },
      { index: 2, phaseIndex: 2, state: "start" },
    ],
  });
  assert.deepEqual(derivePhaseStates(run), ["done", "active"]);

  // And the real thing: a corpus run that resumed carries cached agents verbatim.
  const resumed = FIXTURES.map(runOf).find((r) => r.agents.some((a) => a.cached));
  assert.ok(resumed, "no cached agent in the corpus");
  for (const a of resumed.agents.filter((x) => x.cached)) {
    assert.equal(a.state, "done");
    assert.equal(derivePhaseStates(resumed)[(a.phaseIndex ?? 0) - 1], "done");
  }
});

// ---------------------------------------------------------------------------
// splitWorkflowProgress / applyProgressTick
// ---------------------------------------------------------------------------

test("splitWorkflowProgress: real entries map onto the typed shapes", () => {
  const timer = FIXTURES.find((f) => f.workflowName === "timer-20s");
  assert.ok(timer);
  const { phases, agents } = splitWorkflowProgress(timer.workflowProgress);
  assert.deepEqual(phases, [{ index: 1, title: "Timer" }]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].index, 1);
  assert.equal(agents[0].phaseIndex, 1);
  assert.equal(agents[0].label, "timer:20s");
  assert.equal(agents[0].state, "done");
  assert.equal(agents[0].lastToolName, "Bash");
  assert.equal(agents[0].cached, undefined);
});

test("splitWorkflowProgress: unknown types and junk are dropped, unknown states are non-terminal", () => {
  const { phases, agents } = splitWorkflowProgress([
    { type: "workflow_log", index: 1, message: "chatty" },
    { type: "workflow_phase", index: 1, title: "A" },
    { type: "workflow_phase" }, // no index
    null,
    "garbage",
    { type: "workflow_agent", index: 1, phaseIndex: 1, state: "teleported" },
  ]);
  assert.deepEqual(phases, [{ index: 1, title: "A" }]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].state, "progress");
  // A vocabulary we don't recognize must never let a phase claim completion.
  assert.deepEqual(derivePhaseStates(blank({ phases, agents })), ["active"]);
});

test("splitWorkflowProgress: a non-array (or missing) payload yields empties", () => {
  assert.deepEqual(splitWorkflowProgress(undefined), { phases: [], agents: [] });
  assert.deepEqual(splitWorkflowProgress({ nope: 1 }), { phases: [], agents: [] });
});

test("applyProgressTick: risk #1 — an absent workflow_progress leaves the array intact", () => {
  const prev = blank({
    activity: "Scan: probe",
    phases: [{ index: 1, title: "Scan" }],
    agents: [{ index: 1, phaseIndex: 1, state: "progress", label: "probe" }],
    updatedAt: 100,
  });
  // The throttled heartbeat: description only, `workflow_progress` ABSENT. The naive
  // read blanks the strip every ~10 s; absent must mean NO CHANGE.
  const next = applyProgressTick(prev, { description: "Scan: probe (still)" }, 200);
  assert.deepEqual(next.phases, prev.phases);
  assert.deepEqual(next.agents, prev.agents);
  assert.equal(next.activity, "Scan: probe (still)");
  assert.equal(next.updatedAt, 200);
  assert.deepEqual(derivePhaseStates(next), ["active"]);
  // The input is not mutated — callers hold the previous run for comparison.
  assert.equal(prev.activity, "Scan: probe");
  assert.equal(prev.updatedAt, 100);

  // An explicitly empty array is a different statement, and IS honored.
  const cleared = applyProgressTick(prev, { workflow_progress: [] }, 300);
  assert.deepEqual(cleared.phases, []);
  assert.deepEqual(cleared.agents, []);
  assert.equal(cleared.activity, "Scan: probe");

  // A present array replaces wholesale — the CLI already upserted it for us.
  const replaced = applyProgressTick(
    prev,
    {
      description: "Scan: probe",
      workflow_progress: [
        { type: "workflow_phase", index: 1, title: "Scan" },
        { type: "workflow_agent", index: 1, phaseIndex: 1, state: "done" },
      ],
    },
    400
  );
  assert.deepEqual(derivePhaseStates(replaced), ["done"]);
});

test("applyProgressTick: a throttled tick sequence never regresses the strip", () => {
  // A start transition, then three heartbeats, then the done transition — the shape
  // the emitter actually produces once `_n()` is true.
  let run = blank({ planned: ["Only"] });
  run = applyProgressTick(
    run,
    {
      description: "Only: worker",
      workflow_progress: [
        { type: "workflow_phase", index: 1, title: "Only" },
        { type: "workflow_agent", index: 1, phaseIndex: 1, state: "start" },
      ],
    },
    1
  );
  for (const t of [2, 3, 4]) {
    run = applyProgressTick(run, { description: "Only: worker tick " + t }, t);
    assert.deepEqual(derivePhaseStates(run), ["active"]);
  }
  run = applyProgressTick(
    run,
    {
      workflow_progress: [
        { type: "workflow_phase", index: 1, title: "Only" },
        { type: "workflow_agent", index: 1, phaseIndex: 1, state: "done" },
      ],
    },
    5
  );
  assert.deepEqual(derivePhaseStates(run), ["done"]);
  assert.equal(run.activity, "Only: worker tick 4");
});

// ---------------------------------------------------------------------------
// workflowSignature
// ---------------------------------------------------------------------------

test("workflowSignature: risk #2 — heartbeats are identical, transitions are not", () => {
  const base = blank({
    phases: [{ index: 1, title: "A" }],
    agents: [{ index: 1, phaseIndex: 1, state: "progress", lastToolName: "Read" }],
  });
  const heartbeat = applyProgressTick(
    base,
    {
      description: "A: worker",
      workflow_progress: [
        { type: "workflow_phase", index: 1, title: "A" },
        // Same agent, same state — only the tool and counters moved.
        { type: "workflow_agent", index: 1, phaseIndex: 1, state: "progress", lastToolName: "Edit" },
      ],
    },
    2
  );
  assert.equal(workflowSignature(heartbeat), workflowSignature(base));

  const transitioned = { ...base, agents: [{ ...base.agents[0], state: "done" as const }] };
  assert.notEqual(workflowSignature(transitioned), workflowSignature(base));

  const newPhase = { ...base, phases: [...base.phases, { index: 2, title: "B" }] };
  assert.notEqual(workflowSignature(newPhase), workflowSignature(base));

  const terminal = { ...base, status: "completed" as const };
  assert.notEqual(workflowSignature(terminal), workflowSignature(base));
});

// ---------------------------------------------------------------------------
// Compact wire projection
// ---------------------------------------------------------------------------

test("projectWorkflowRun: clips the long fields and drops the ones the UI never shows", () => {
  const run = blank({
    activity: "A: worker",
    planned: ["A"],
    phases: [{ index: 1, title: "A" }],
    agents: [
      {
        index: 1,
        phaseIndex: 1,
        state: "done",
        cached: true,
        label: "l".repeat(90),
        lastToolName: "t".repeat(90),
        resultPreview: "r".repeat(400),
        startedAt: 123,
        durationMs: 456,
      },
    ],
  });
  const p = projectWorkflowRun(run);
  assert.deepEqual(p.P, ["A"]);
  assert.deepEqual(p.p, [{ i: 1, T: "A" }]);
  assert.equal(p.d, "A: worker");
  assert.equal(p.a[0].l?.length, 40);
  assert.equal(p.a[0].tn?.length, 24);
  assert.equal(p.a[0].r?.length, 120);
  assert.ok(p.a[0].l?.endsWith("…"));
  assert.equal(p.a[0].c, true);
  // The two timings ride along — the accordion counts a live agent up from
  // startedAt and shows the runner's own durationMs for a finished one, neither of
  // which a UI seeing only terminal state can reconstruct (§3.4). promptPreview and
  // lastToolSummary are what actually made the raw array 10 KB, and stay out.
  assert.equal(p.a[0].sa, 123);
  assert.equal(p.a[0].dm, 456);
  assert.deepEqual(
    Object.keys(p.a[0]).sort(),
    ["c", "dm", "i", "l", "p", "r", "sa", "st", "tn"]
  );
});

// The webview-side projection in patchClaude.ts writes `c:1`, not `c:true`, to
// save bytes on a channel it shares with every rename. An identity check on the
// host would drop every cached marker — the one signal risk #7's muted styling is
// built on — and would do it silently, since a resumed run looks otherwise normal.
test("parseWfProjection: accepts the wire's `c:1` cached marker, not just `c:true`", () => {
  const wired = parseWfProjection(
    { t: "x", n: "wf", s: "running", a: [{ i: 1, st: "done", c: 1, sa: 10, dm: 20 }] },
    0
  );
  assert.ok(wired);
  assert.equal(wired.agents[0].cached, true);
  assert.equal(wired.agents[0].startedAt, 10);
  assert.equal(wired.agents[0].durationMs, 20);
  // Absent stays absent, so "no marker" can never be read as "reused".
  const plain = parseWfProjection({ t: "x", n: "wf", s: "running", a: [{ i: 1, st: "done" }] }, 0);
  assert.ok(plain);
  assert.equal(plain.agents[0].cached, undefined);
  assert.equal(plain.agents[0].startedAt, undefined);
});

test("projectWorkflowRun: caps a runaway fan-out", () => {
  const run = blank({
    planned: Array.from({ length: 100 }, (_, i) => "P" + i),
    phases: Array.from({ length: 100 }, (_, i) => ({ index: i + 1, title: "P" + i })),
    agents: Array.from({ length: 200 }, (_, i) => ({
      index: i + 1,
      phaseIndex: 1,
      state: "done" as const,
    })),
  });
  const p = projectWorkflowRun(run);
  assert.equal(p.P.length, 32);
  assert.equal(p.p.length, 32);
  assert.equal(p.a.length, 64);
});

test("projectWorkflowRun: every fixture round-trips and stays small on the wire", () => {
  let max = 0;
  for (const f of FIXTURES) {
    const run = runOf(f);
    const wire = JSON.stringify(projectWorkflowRun(run));
    max = Math.max(max, Buffer.byteLength(wire));
    const back = parseWfProjection(JSON.parse(wire), 7);
    assert.ok(back, f.runId + " failed to parse back");
    assert.equal(back.updatedAt, 7);
    assert.equal(back.taskId, run.taskId);
    assert.equal(back.name, run.name);
    assert.deepEqual(back.planned, run.planned);
    assert.deepEqual(back.phases, run.phases);
    // The projection is lossy by design, but never on anything the strip derives from.
    assert.deepEqual(derivePhaseStates(back), derivePhaseStates(run));
    assert.deepEqual(
      back.agents.map((a) => [a.index, a.phaseIndex, a.state, a.cached]),
      run.agents.map((a) => [a.index, a.phaseIndex, a.state, a.cached])
    );
  }
  // Measured at 1892 B on this corpus; the guard is against a regression that
  // reintroduces a dropped field, not a tight bound.
  assert.ok(max < 4096, "largest projection was " + max + " B");
});

/**
 * A phase number is an ARRAY INDEX and a growth target, and it crosses the patch
 * boundary verbatim (the injected projection copies `phaseIndex` straight out of
 * Claude's broadcast), so "finite number" is not a strong enough check. The fraction
 * is the one that hurt: `1.5` passed the old `>= 1` test, `buckets[0.5]` was
 * `undefined`, and reading `.agents` off it threw inside the pane's render — which
 * empties the WHOLE Source+ pane, not just the offending strip. A huge value is the
 * other: it grew the strip, and the open accordion, to that many DOM nodes.
 */
test("parseWfProjection: a phase number that cannot be an index is rejected, not passed on", () => {
  const wire = {
    t: "x",
    n: "wf",
    s: "running",
    P: ["A"],
    p: [{ i: 1, T: "A" }],
    a: [
      { i: 1, st: "done", p: 1.5 },
      { i: 2, st: "done", p: 20000 },
      { i: 3, st: "done", p: 0 },
      { i: 4, st: "done", p: -1 },
      { i: 5, st: "done", p: NaN },
      { i: 6, st: "done", p: Infinity },
      { i: 7, st: "done", p: "1" },
      { i: 8, st: "done", p: 32 },
      { i: 9, st: "done", p: 33 },
      { i: 10, st: "done", p: 1 },
    ],
  };
  const run = parseWfProjection(wire, 0);
  assert.ok(run);
  // Exactly the two usable ones keep a phaseIndex; the rest become orphans, which
  // keeps them visible in the trailing bucket instead of dropping work that ran.
  assert.deepEqual(
    run.agents.map((a) => a.phaseIndex),
    [
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      32,
      undefined,
      1,
    ]
  );
  // 32 usable phases + the orphan bucket, and no throw from indexing at 0.5.
  assert.equal(derivePhaseStates(run).length, 33);

  // The same rule on the phases array, whose indices are what the strip's LENGTH is
  // derived from: an unplaceable phase is dropped rather than used as a growth target.
  const grown = parseWfProjection(
    { t: "x", n: "wf", s: "running", p: [{ i: 1.5, T: "a" }, { i: 1e7, T: "b" }, { i: 2, T: "ok" }] },
    0
  );
  assert.ok(grown);
  assert.deepEqual(grown.phases, [{ index: 2, title: "ok" }]);
  assert.equal(derivePhaseStates(grown).length, 2);

  // planned is capped at the same 32 the projection ships, so a runaway meta TOC
  // cannot set the strip length either.
  const capped = parseWfProjection(
    { t: "x", n: "wf", s: "running", P: Array.from({ length: 100 }, (_, i) => "P" + i) },
    0
  );
  assert.ok(capped);
  assert.equal(capped.planned.length, 32);
  assert.equal(derivePhaseStates(capped).length, 32);
});

test("projectWorkflowRun: the run's own name and the titles are clipped like every other string", () => {
  const p = projectWorkflowRun(
    blank({
      name: "n".repeat(200),
      activity: "d".repeat(400),
      planned: ["p".repeat(200)],
      phases: [{ index: 1, title: "t".repeat(200) }],
    })
  );
  // `n` was the one string that rode the channel unbounded — `meta.name` is whatever
  // the script's author typed — which made the cap-bounded worst case ~20 KB rather
  // than the number risk #10 quotes. Titles and the activity line the same.
  assert.equal(p.n.length, 40);
  assert.equal(p.P[0].length, 40);
  assert.equal(p.p[0].T.length, 40);
  assert.equal(p.d?.length, 120);
  // Short values are untouched — no marker, no padding.
  const plain = projectWorkflowRun(blank({ name: "wf", planned: ["A"] }));
  assert.equal(plain.n, "wf");
  assert.deepEqual(plain.P, ["A"]);
});

test("parseWfProjection: junk and unknown statuses degrade to undefined, not a half-run", () => {
  assert.equal(parseWfProjection(undefined, 0), undefined);
  assert.equal(parseWfProjection("nope", 0), undefined);
  assert.equal(parseWfProjection({ n: "wf", s: "running" }, 0), undefined); // no taskId
  assert.equal(parseWfProjection({ t: "x", n: "wf", s: "sideways" }, 0), undefined);
  const minimal = parseWfProjection({ t: "x", n: "wf", s: "running" }, 5);
  assert.ok(minimal);
  assert.deepEqual(minimal, {
    taskId: "x",
    name: "wf",
    status: "running",
    planned: [],
    phases: [],
    agents: [],
    updatedAt: 5,
  });
});

// ---------------------------------------------------------------------------
// The claudeStatus.ts plumbing contract (§3.3)
// ---------------------------------------------------------------------------

/**
 * `ClaudeTab.wf` is produced by handing `getTabs()`'s raw `wf` field straight to
 * `parseWfProjection`. That field crosses the patch boundary, so the three inputs
 * below are the ones the host actually has to survive: an OLDER patched bundle
 * (no field at all), a bundle whose shape moved under us (garbage), and the happy
 * path. None may throw — `tabs()` sits on the repaint path for the whole pane.
 */
test("parseWfProjection: the shapes a tab descriptor can actually carry", () => {
  // Missing field — an unpatched or pre-applyWfTracking bundle. The overwhelmingly
  // common case, and not an error condition.
  assert.equal(parseWfProjection(undefined, 1), undefined);

  // Garbage, in every flavour the boundary could hand over.
  for (const junk of [null, 0, "", "{}", true, [], [1, 2], { wf: {} }, { t: 7, s: "running" }]) {
    assert.equal(parseWfProjection(junk, 1), undefined, "parsed junk: " + JSON.stringify(junk));
  }
  // Partial garbage INSIDE a valid envelope is pruned, not fatal: the run survives
  // carrying only the entries that made sense.
  const partial = parseWfProjection(
    {
      t: "task-1",
      n: "wf",
      s: "running",
      P: ["Scan", 42, null],
      p: [{ i: 1, T: "Scan" }, "nope", { T: "no index" }],
      a: [{ i: 1, st: "done" }, null, { st: "done" }],
    },
    1
  );
  assert.ok(partial);
  assert.deepEqual(partial.planned, ["Scan"]);
  assert.deepEqual(partial.phases, [{ index: 1, title: "Scan" }]);
  assert.deepEqual(partial.agents, [{ index: 1, state: "done" }]);

  // Well-formed, end to end: a real run projected onto the wire, JSON'd exactly as
  // the rename_tab hop does it, and read back into something the strip can derive.
  const run = runOf(FIXTURES[0]);
  const wire = JSON.parse(JSON.stringify(projectWorkflowRun(run))) as unknown;
  const back = parseWfProjection(wire, 1234);
  assert.ok(back);
  assert.equal(back.taskId, run.taskId);
  assert.equal(back.name, run.name);
  assert.equal(back.status, run.status);
  assert.equal(back.updatedAt, 1234);
  assert.deepEqual(derivePhaseStates(back), derivePhaseStates(run));
});

/**
 * Why ClaudeStatusService memoizes the parse against the raw projection's JSON:
 * the ONLY thing that differs between two parses of identical bytes is the
 * `updatedAt` the caller supplies. `serialize()` stringifies the tab list to
 * decide whether to repaint, so re-stamping that field on every read would make
 * every 1.5 s poll a change for as long as a workflow runs. Same bytes must mean
 * same run.
 */
test("parseWfProjection: identical bytes parse identically but for the caller's clock", () => {
  const wire = JSON.parse(JSON.stringify(projectWorkflowRun(runOf(FIXTURES[0])))) as unknown;
  const first = parseWfProjection(wire, 1000);
  const second = parseWfProjection(wire, 1000);
  assert.deepEqual(first, second);
  const later = parseWfProjection(wire, 2000);
  assert.ok(first && later);
  assert.notDeepEqual(first, later);
  assert.deepEqual({ ...first, updatedAt: 0 }, { ...later, updatedAt: 0 });
});

// ---------------------------------------------------------------------------
// The injected twins in patchClaude.ts (§3.2)
// ---------------------------------------------------------------------------

/**
 * `WF_HELPERS` is the JS the patch injects into Claude's webview bundle, so the
 * functions in THIS file are only the reference for it — everything that actually
 * ships is that string. Nothing was checking the two against each other, and they
 * had drifted: the injected table-of-contents parse returned nothing for a prefix
 * cut mid-`phases`, let a decorative `phases:[{title:…}]` inside meta's own
 * `description` shadow the real array, and read `subtitle:` as a title (one phantom
 * pending square for a whole run). Each of those is a case the tests above pin the
 * reference on, failing the opposite way in production.
 *
 * So the string is evaluated here and held to the same corpus. patchClaude.ts can't
 * be imported — it pulls in `vscode`, which the test bundle has no way to resolve —
 * so the constant is lifted out of the source text. It is nothing but string
 * concatenation, which means the TS expression IS a JS expression: evaluating it
 * yields the exact bytes the patch writes. If the constant is ever reformatted past
 * what the match below understands, this fails loudly rather than silently passing.
 */
const WF_HELPERS: string = (() => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "patchClaude.ts"), "utf8");
  // WF_HELPERS is no longer self-contained: it concatenates sibling constants
  // (WF_PLAN_BODY, and any future split-out piece). Evaluating its expression text
  // alone therefore throws ReferenceError — which is exactly what happened when the
  // parser was factored out, and it took the whole file's tests down with it rather
  // than failing one assertion. So bind EVERY top-level `const WF_* = <string expr>`
  // in declaration order and evaluate WF_HELPERS with those in scope. A newly split
  // constant is picked up automatically instead of silently breaking the suite.
  const names: string[] = [];
  const bodies: string[] = [];
  const decl = /\nconst (WF_[A-Z0-9_]+) =([\s\S]*?);\n/g;
  for (let m = decl.exec(src); m; m = decl.exec(src)) {
    names.push(m[1]);
    bodies.push(m[2]);
  }
  assert.ok(names.includes("WF_HELPERS"), "WF_HELPERS not located in src/patchClaude.ts");
  const scope: Record<string, unknown> = {};
  for (let i = 0; i < names.length; i++) {
    // Each constant may reference the ones declared before it, so build up the scope
    // incrementally and pass it in as named parameters.
    const keys = Object.keys(scope);
    const fn = new Function(...keys, "return (\n" + bodies[i] + "\n)");
    try {
      scope[names[i]] = fn(...keys.map((k) => scope[k]));
    } catch {
      // A constant that isn't a pure string expression is not our concern; skip it so
      // one unrelated shape change can't take the suite down again.
      scope[names[i]] = undefined;
    }
  }
  const text = scope.WF_HELPERS;
  assert.equal(typeof text, "string", "WF_HELPERS did not evaluate to a string");
  return text as string;
})();

/** The webview-side map entry `applyWfTracking` maintains, keyed by task id. */
interface WfEntry {
  name: string;
  planned: string[];
  progress: unknown[];
  status: string;
  activity: string;
  ts: number;
}

interface Injected {
  __wtWfPlan(scriptPrefix: string): string[];
  __wtWfProj(map: Map<string, WfEntry>): { sig: string; wf: WfProjection | null };
}

/** A fresh install of the injected helpers, as `W` (the window) sees them. */
function injected(): Injected {
  const W = {} as Injected;
  new Function("W", WF_HELPERS)(W);
  return W;
}

/**
 * The injected side clips for the wire where the reference does not: planned titles
 * are hard-cut at 40 chars (no ellipsis — this one is a raw byte cap, not the
 * display clip `projectWorkflowRun` applies to labels and previews). Nothing in the
 * corpus is anywhere near it (longest title: 35 chars), so this only matters to keep
 * the comparison honest rather than to paper over a difference in behaviour.
 */
function hard(v: string | undefined, max: number): string | undefined {
  if (v === undefined) {
    return undefined;
  }
  return v.length > max ? v.slice(0, max) : v;
}

function entry(over: Partial<WfEntry> = {}): WfEntry {
  return {
    name: "wf",
    planned: ["A"],
    progress: [{ type: "workflow_phase", index: 1, title: "A" }],
    status: "running",
    activity: "A: worker",
    ts: Date.now(),
    ...over,
  };
}

test("injected __wtWfPlan: agrees with parsePlannedPhases on all 17 corpus scripts", () => {
  const W = injected();
  for (const f of FIXTURES) {
    const want = parsePlannedPhases(f.scriptPrefix).map((t) => hard(t, 40));
    assert.deepEqual(W.__wtWfPlan(f.scriptPrefix), want, f.runId);
  }
});

test("injected __wtWfPlan: agrees with the reference on the cases it is pinned on", () => {
  const W = injected();
  const cases: string[] = [
    // A prefix cut mid-title by the 4096-char slice — the injected bracket walk used
    // to hit end-of-input and give up on the whole array.
    "export const meta = {\n  phases: [\n    { title: 'One' },\n    { title: 'Tw",
    // A decorative mention inside meta's own description must not shadow the real
    // array, and brackets/escapes inside a title must not unbalance the scan.
    [
      "export const meta = {",
      "  description: 'phases: [ { title: \"decoy\" } ]',",
      "  phases: [",
      "    { title: 'It\\'s fine', detail: 'a' },",
      '    { title: "double [bracketed]" },',
      "    { title: `backticked` },",
      "    { detail: 'no title here' },",
      "    { title: someVariable },",
      "  ],",
      "}",
    ].join("\n"),
    // Keys that merely END in `title` are not titles — the CLI's own validator
    // ignores unknown keys, so `subtitle` is legal and common.
    "export const meta = { phases: [ { title: 'Alpha', subtitle: 'Beta' } ] }",
    "export const meta = { phases: [ { subtitle: 'x' } ] }",
    // risk #6: object literals after the meta block carry their own `title:`.
    [
      "export const meta = {",
      "  name: 'toc-bounded',",
      "  phases: [",
      "    { title: 'Scan', detail: 'look around' },",
      "    { title: 'Fix' },",
      "  ],",
      "}",
      "",
      "const REPORT = { title: 'NOT A PHASE', properties: { title: 'ALSO NOT' } }",
      "await agent('go', { label: 'x', title: 'STILL NOT' })",
    ].join("\n"),
    // risk #5: `phases` is optional, and no meta at all is not an error.
    "",
    "phase('Untabled')\nawait agent('x')",
    "export const meta = { name: 'no-toc' }\nphase('A')\n",
  ];
  for (const src of cases) {
    const want = parsePlannedPhases(src).map((t) => hard(t, 40));
    assert.deepEqual(W.__wtWfPlan(src), want, JSON.stringify(src.slice(0, 60)));
  }
  // Stated outright as well, so this test says what the answers ARE and not only
  // that two implementations agree on them.
  assert.deepEqual(W.__wtWfPlan(cases[0]), ["One"]);
  assert.deepEqual(W.__wtWfPlan(cases[1]), [
    "It's fine",
    "double [bracketed]",
    "backticked",
  ]);
  assert.deepEqual(W.__wtWfPlan(cases[2]), ["Alpha"]);
  assert.deepEqual(W.__wtWfPlan(cases[3]), []);
  assert.deepEqual(W.__wtWfPlan(cases[4]), ["Scan", "Fix"]);
});

test("injected __wtWfProj: projects the corpus the way projectWorkflowRun does", () => {
  const W = injected();
  for (const f of FIXTURES) {
    const run = runOf(f);
    const mp = new Map<string, WfEntry>([
      [
        f.runId,
        entry({
          name: f.workflowName,
          planned: W.__wtWfPlan(f.scriptPrefix),
          progress: f.workflowProgress,
          status: run.status,
        }),
      ],
    ]);
    // Through JSON, as the rename_tab hop does it: the injected projection writes
    // absent fields as an explicit `undefined`, which stringify drops.
    const got = JSON.parse(JSON.stringify(W.__wtWfProj(mp).wf)) as WfProjection;
    const want = projectWorkflowRun(run);
    assert.equal(got.t, want.t, f.runId);
    assert.equal(got.n, want.n, f.runId);
    assert.equal(got.s, want.s, f.runId);
    assert.deepEqual(got.P, want.P, f.runId);
    // Everything a square, a glyph or a duration is derived from must be identical.
    // (`c` is `1` on the wire and `true` in the reference — see parseWfProjection.)
    assert.deepEqual(
      got.a.map((a) => [a.i, a.p, a.st, !!a.c, a.sa, a.dm]),
      want.a.map((a) => [a.i, a.p, a.st, !!a.c, a.sa, a.dm]),
      f.runId
    );
    // The display strings are clipped hard here and with an ellipsis in the
    // reference, so they are checked against the raw entries they came from.
    const raw = f.workflowProgress as Record<string, string | undefined>[];
    const rawPhases = raw.filter((e) => e && e.type === "workflow_phase");
    const rawAgents = raw.filter((e) => e && e.type === "workflow_agent");
    assert.deepEqual(
      got.p.map((p) => p.T),
      rawPhases.map((e) => hard(e.title, 40)),
      f.runId
    );
    assert.deepEqual(
      got.a.map((a) => [a.l, a.tn, a.r]),
      rawAgents.map((e) => [
        hard(e.label, 40),
        hard(e.lastToolName, 24),
        hard(e.resultPreview, 120),
      ]),
      f.runId
    );
  }
});

test("injected __wtWfProj: a terminal run is kept for the session, only a stuck one ages out", () => {
  const W = injected();
  const stale = Date.now() - 11 * 60 * 1000;

  // §2's history is "the most recent run", full stop. An age prune here deleted the
  // completed run's own strip on whatever unrelated tick came next — ten minutes
  // after it finished, mid-session, with no user action.
  const finished = new Map<string, WfEntry>([["t-done", entry({ status: "completed", ts: stale })]]);
  const kept = W.__wtWfProj(finished);
  assert.equal(finished.size, 1);
  assert.ok(kept.wf);
  assert.equal(kept.wf.t, "t-done");

  // A run still claiming `running` after ten quiet minutes has lost its emitter — it
  // heartbeats at least every 10s — and is the one case worth dropping.
  const stuck = new Map<string, WfEntry>([["t-stuck", entry({ ts: stale })]]);
  const gone = W.__wtWfProj(stuck);
  assert.equal(stuck.size, 0);
  assert.equal(gone.wf, null);
  assert.equal(gone.sig, "-");

  // Bounded by COUNT instead: only the freshest run is ever rendered, so a terminal
  // run behind it can never be seen again and goes. Anything still live is kept, no
  // matter how many runs are ahead of it (risk #11).
  const many = new Map<string, WfEntry>([
    ["older", entry({ status: "completed", ts: Date.now() - 2000 })],
    ["live", entry({ ts: Date.now() - 1000 })],
    ["newest", entry({ status: "failed", ts: Date.now() })],
  ]);
  const freshest = W.__wtWfProj(many);
  assert.ok(freshest.wf);
  assert.equal(freshest.wf.t, "newest");
  assert.deepEqual([...many.keys()], ["live", "newest"]);
});

test("injected __wtWfProj: risk #2 — the signature moves on transitions, not on heartbeats", () => {
  const W = injected();
  const phase = { type: "workflow_phase", index: 1, title: "A" };
  const at = (state: string, tool: string) => [
    phase,
    { type: "workflow_agent", index: 1, phaseIndex: 1, state, lastToolName: tool },
  ];
  const sigOf = (progress: unknown[], over: Partial<WfEntry> = {}) =>
    W.__wtWfProj(new Map([["t1", entry({ progress, ...over })]])).sig;

  const base = at("progress", "Read");
  assert.equal(sigOf(at("progress", "Edit")), sigOf(base));
  assert.notEqual(sigOf(at("done", "Read")), sigOf(base));
  assert.notEqual(sigOf([...base, { type: "workflow_phase", index: 2, title: "B" }]), sigOf(base));
  assert.notEqual(sigOf(base, { status: "completed" }), sigOf(base));

  // The other half of the same discipline (§3.2): a heartbeat's CONTENT does move,
  // which is what earns it a ride on the next natural __wtSend tick even though the
  // signature is pinned. Gating the payload on the signature alone left the tool
  // name and the activity line frozen for an agent's entire life.
  const body = (progress: unknown[]) =>
    JSON.stringify(W.__wtWfProj(new Map([["t1", entry({ progress })]])).wf);
  assert.notEqual(body(at("progress", "Edit")), body(base));
});

/**
 * The pane has a twin too: `wfBuckets` / `wfPhaseState` / `wfEnded` in
 * scmMirrorView.ts, which exist because the accordion needs the agents themselves
 * and not just the per-phase verdict. Same conformance problem, same treatment —
 * they live inside a template literal, so they are lifted out by their own function
 * boundaries and evaluated here. That slice is pure (it touches no DOM), and if it
 * ever stops being pure or the boundaries move, this fails loudly.
 */
interface PaneBucket {
  title: string;
  /** `derivePhaseStates`'s vocabulary plus the pane's own `cached`. */
  state: PhaseState | "cached";
  agents: unknown[];
  orphan: boolean;
}
const PANE_WF = (() => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "scmMirrorView.ts"), "utf8");
  // From the section's first constant, so the slice carries wfPhaseNo and the caps
  // it reads — the guard is part of the behaviour being conformance-checked.
  const from = src.indexOf("const WF_MAX_SQUARES");
  const to = src.indexOf("// Wall-clock span of a phase");
  assert.ok(from >= 0 && to > from, "wfBuckets not located in src/scmMirrorView.ts");
  const built: unknown = new Function(src.slice(from, to) + ";return {wfBuckets:wfBuckets};")();
  return built as { wfBuckets(run: WorkflowRun): PaneBucket[] };
})();

test("pane wfBuckets: derives the same strip as derivePhaseStates over the corpus", () => {
  let sawCached = false;
  for (const f of FIXTURES) {
    const run = runOf(f);
    const buckets = PANE_WF.wfBuckets(run);
    // The pane's one deliberate refinement: a phase whose every agent was replayed
    // on resume reads 'cached' where the reference says 'done' (risk #7).
    const states = buckets.map((b) => {
      if (b.state === "cached") {
        sawCached = true;
        return "done";
      }
      return b.state;
    });
    assert.deepEqual(states, derivePhaseStates(run), f.runId);
    // A square always has something to label itself with — the announced title,
    // then meta's table of contents, then the ordinal.
    for (const b of buckets) {
      assert.ok(b.title.length > 0, f.runId + " untitled bucket");
    }
  }
  assert.ok(sawCached, "no resumed run in the corpus — the cached path went untested");
});

test("pane wfBuckets: risk #12 — the run's status settles an unclosed phase, in both layers", () => {
  const stuck = blank({
    planned: ["Scan", "Fix"],
    phases: [
      { index: 1, title: "Scan" },
      { index: 2, title: "Fix" },
    ],
    agents: [
      { index: 1, phaseIndex: 1, state: "done" },
      { index: 2, phaseIndex: 2, state: "progress", startedAt: 1 },
    ],
  });
  for (const status of ["running", "completed", "failed"] as const) {
    const run = { ...stuck, status };
    assert.deepEqual(
      PANE_WF.wfBuckets(run).map((b) => b.state),
      derivePhaseStates(run),
      status
    );
  }
  // And a projection from an older patched bundle, with no status at all, must read
  // as still running rather than as ended.
  const noStatus: Omit<WorkflowRun, "status"> = { ...stuck, status: undefined } as Omit<
    WorkflowRun,
    "status"
  >;
  assert.deepEqual(
    PANE_WF.wfBuckets(noStatus as WorkflowRun).map((b) => b.state),
    ["done", "active"]
  );
});

/**
 * The pane's twin has to be total on the same inputs, and for a much harsher reason:
 * a throw in here does not lose a strip, it loses the PANE. `renderClaudeTabs` runs
 * after `renderBody()` has already emptied `rootEl` and nothing above it catches, so
 * one bad projection blanked every worktree box, commit box and file list until some
 * later post happened to succeed. (Measured before the fix: `phaseIndex: 1.5` threw
 * `TypeError: Cannot read properties of undefined (reading 'agents')` with 0 rows
 * rendered; `phaseIndex: 20000` built 20 000 squares and 20 000 accordion rows.)
 */
test("pane wfBuckets: an impossible phaseIndex is bucketed, never indexed — in both layers", () => {
  const cases: [string, WorkflowRun][] = [
    [
      "fraction",
      blank({
        planned: ["A"],
        phases: [{ index: 1, title: "A" }],
        agents: [{ index: 1, phaseIndex: 1.5, state: "done" }],
      }),
    ],
    [
      "past the cap",
      blank({
        planned: ["A"],
        phases: [{ index: 1, title: "A" }],
        agents: [{ index: 1, phaseIndex: 20000, state: "done" }],
      }),
    ],
    [
      "not a number at all",
      blank({
        phases: [{ index: 1, title: "A" }],
        agents: [{ index: 1, phaseIndex: NaN, state: "done" }],
      }),
    ],
    [
      "phase index itself unusable",
      blank({
        phases: [
          { index: 1e7, title: "huge" },
          { index: 2.5, title: "frac" },
          { index: 2, title: "ok" },
        ],
        agents: [{ index: 1, phaseIndex: 2, state: "progress", startedAt: 1 }],
      }),
    ],
    [
      "runaway planned TOC",
      blank({ planned: Array.from({ length: 500 }, (_, i) => "P" + i) }),
    ],
  ];
  for (const [name, run] of cases) {
    const buckets = PANE_WF.wfBuckets(run);
    // Bounded: 32 phases plus at most one synthetic orphan bucket, whatever arrived.
    assert.ok(buckets.length <= 33, name + " grew to " + buckets.length + " buckets");
    // Every square still has a title and a state, so the strip stays renderable.
    for (const b of buckets) {
      assert.ok(b.title.length > 0, name + " untitled bucket");
      assert.ok(typeof b.state === "string", name + " stateless bucket");
    }
    // And the pane still agrees with the reference, which is the invariant that keeps
    // the two copies from drifting while one of them is hardened.
    assert.deepEqual(
      buckets.map((b) => (b.state === "cached" ? "done" : b.state)),
      derivePhaseStates(run),
      name
    );
  }
  // An agent nobody can place is still shown: the orphan bucket, not the void.
  const orphaned = PANE_WF.wfBuckets(
    blank({
      planned: ["A"],
      phases: [{ index: 1, title: "A" }],
      agents: [{ index: 1, phaseIndex: 1.5, state: "done" }],
    })
  );
  assert.equal(orphaned.length, 2);
  assert.equal(orphaned[1].orphan, true);
  assert.equal(orphaned[1].agents.length, 1);
});

/**
 * The active square is an animated node in a list `renderBody()` throws away and
 * rebuilds several times a minute, so it has to resume its keyframes where the old
 * node left off — a fresh node starts `ah-pulse` at 0% (full opacity), which reads as
 * a stutter rather than a pulse. `phaseDelay()` only works if the period it is given
 * IS the CSS animation-duration, and the two live 900 lines apart, so the coupling is
 * pinned here rather than trusted.
 */
test("pane wfSquare: the active square's pulse is phase-locked, at the CSS period", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "scmMirrorView.ts"), "utf8");
  const css = /\.wsq\.active\s*\{[^}]*animation:\s*ah-pulse\s+([\d.]+)s/.exec(src);
  assert.ok(css, ".wsq.active no longer declares an ah-pulse animation");
  const periodMs = Math.round(parseFloat(css[1]) * 1000);
  const from = src.indexOf("function wfSquare(b){");
  const to = src.indexOf("// The collapsed row's strip", from);
  assert.ok(from >= 0 && to > from, "wfSquare not located in src/scmMirrorView.ts");
  const delay = /animationDelay\s*=\s*phaseDelay\((\d+)\)/.exec(src.slice(from, to));
  assert.ok(delay, "wfSquare does not phase-lock the active square");
  assert.equal(Number(delay[1]), periodMs, "phaseDelay period must equal the CSS duration");
});

/**
 * The accordion's per-phase open/closed decision (§3.4) is the other pure slice of
 * the pane worth pinning: it is the only place where an automatic layout and a
 * manual instruction meet, and it changes state underneath the user (a phase goes
 * active, then done, then maybe failed) while the manual instruction has to keep
 * meaning what it meant. Lifted the same way as `wfBuckets` above, with the two
 * module-level names it closes over stubbed: the override store, and `render`.
 */
const PANE_OV = (() => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "scmMirrorView.ts"), "utf8");
  const from = src.indexOf("function wfPhaseIsOpen(sid, wf, i, state){");
  const to = src.indexOf("// wf is the run the agent belongs to");
  assert.ok(from >= 0 && to > from, "wfPhaseIsOpen not located in src/scmMirrorView.ts");
  const built: unknown = new Function(
    "const wfPhaseOv={};function render(){}\n" +
      src.slice(from, to) +
      ";return {isOpen:wfPhaseIsOpen,toggle:wfTogglePhase," +
      "reset:()=>{for(const k of Object.keys(wfPhaseOv)) delete wfPhaseOv[k];}};"
  )();
  return built as {
    isOpen(sid: string, wf: { taskId: string }, i: number, state: string): boolean;
    toggle(sid: string, wf: { taskId: string }, i: number, open: boolean): void;
    reset(): void;
  };
})();

test("pane wfPhaseIsOpen: the automatic layout expands what you need to watch", () => {
  PANE_OV.reset();
  const wf = { taskId: "t1" };
  assert.equal(PANE_OV.isOpen("s", wf, 0, "active"), true);
  // A failure is the one thing you want the agents for, so it stays expanded even
  // though the phase has ended.
  assert.equal(PANE_OV.isOpen("s", wf, 0, "failed"), true);
  for (const state of ["pending", "done", "cached"]) {
    assert.equal(PANE_OV.isOpen("s", wf, 0, state), false, state);
  }
});

test("pane wfPhaseIsOpen: a manual toggle pins the phase and survives its state moving", () => {
  PANE_OV.reset();
  const wf = { taskId: "t1" };
  // Closing the phase you are not interested in has to STAY closed when the run
  // finishes. An override that merely inverted the automatic state re-expanded it,
  // because 'active' -> 'done' flips the automatic bit under the override.
  assert.equal(PANE_OV.isOpen("s", wf, 1, "active"), true);
  PANE_OV.toggle("s", wf, 1, true);
  assert.equal(PANE_OV.isOpen("s", wf, 1, "active"), false);
  assert.equal(PANE_OV.isOpen("s", wf, 1, "done"), false);
  // …and it stays closed if that phase fails instead. That is the user's own
  // instruction, not the layout hiding a failure behind a truncated preview.
  assert.equal(PANE_OV.isOpen("s", wf, 1, "failed"), false);

  // The mirror image: a finished phase the user opened must not slam shut the
  // moment the phase's state changes to one the layout would have opened anyway.
  PANE_OV.reset();
  assert.equal(PANE_OV.isOpen("s", wf, 0, "done"), false);
  PANE_OV.toggle("s", wf, 0, false);
  assert.equal(PANE_OV.isOpen("s", wf, 0, "done"), true);
  assert.equal(PANE_OV.isOpen("s", wf, 0, "active"), true);
  assert.equal(PANE_OV.isOpen("s", wf, 0, "failed"), true);
  // Toggling back is still one click, and lands on the state asked for.
  PANE_OV.toggle("s", wf, 0, true);
  assert.equal(PANE_OV.isOpen("s", wf, 0, "done"), false);
});

test("pane wfPhaseIsOpen: overrides are scoped to one run and one session box", () => {
  PANE_OV.reset();
  PANE_OV.toggle("s", { taskId: "t1" }, 0, false);
  assert.equal(PANE_OV.isOpen("s", { taskId: "t1" }, 0, "done"), true);
  // A new run in the same box starts from the automatic layout…
  assert.equal(PANE_OV.isOpen("s", { taskId: "t2" }, 0, "done"), false);
  // …and a different box was never spoken for at all.
  assert.equal(PANE_OV.isOpen("other", { taskId: "t1" }, 0, "done"), false);
  // The new run's first toggle also discards the old run's entry rather than
  // accumulating on top of it.
  PANE_OV.toggle("s", { taskId: "t2" }, 1, false);
  assert.equal(PANE_OV.isOpen("s", { taskId: "t2" }, 0, "done"), false);
  assert.equal(PANE_OV.isOpen("s", { taskId: "t2" }, 1, "done"), true);
});
