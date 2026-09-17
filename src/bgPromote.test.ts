import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  AGENT_ACTIVITY_STALE_MS,
  BG_PROMOTE_WINDOW_MS,
  BgQuietLatch,
  BgSignals,
  stepBgPromotion,
} from "./bgPromote";
import {
  FileVerdict,
  newestUnfinishedWrite,
  projectSlug,
  tailIsFinished,
} from "./sessionActivity";

const T0 = 1_700_000_000_000;

interface Step extends Partial<BgSignals> {
  status: string;
  at: number;
}

/** Drive a sequence of polls, carrying the latch the way claudeStatus does. */
function run(steps: Step[]): string[] {
  let latch: BgQuietLatch | undefined;
  return steps.map(({ status, at, shellWorkStartedAt, unfinishedSubagentWriteAt }) => {
    const out = stepBgPromotion(
      status,
      { shellWorkStartedAt, unfinishedSubagentWriteAt },
      latch,
      at
    );
    latch = out.latch;
    return out.status;
  });
}

// ---------------------------------------------------------------------------
// The shell signal (process tree) — bounded, because a shell may never exit
// ---------------------------------------------------------------------------

test("stepBgPromotion: a live shell holds a quiet tab at working", () => {
  assert.deepEqual(
    run([
      { status: "working", shellWorkStartedAt: T0, at: T0 },
      { status: "done", shellWorkStartedAt: T0, at: T0 + 1500 },
      { status: "done", shellWorkStartedAt: T0, at: T0 + 60_000 },
    ]),
    ["working", "working", "working"]
  );
});

test("stepBgPromotion: the shell promotion lapses once the window is up", () => {
  // The wait-loop was launched mid-turn, so its window opens before the tab is quiet.
  const started = T0 - 1500;
  const at = started + BG_PROMOTE_WINDOW_MS;
  assert.deepEqual(
    run([
      { status: "working", shellWorkStartedAt: started, at: started },
      { status: "done", shellWorkStartedAt: started, at: T0 },
      // The abandoned `until … sleep 2` wait-loop is still alive, but the session
      // gave its final answer ten minutes ago — the check must land.
      { status: "done", shellWorkStartedAt: started, at: at - 1 },
      { status: "done", shellWorkStartedAt: started, at },
      { status: "done", shellWorkStartedAt: started, at: at + 3_600_000 },
    ]),
    ["working", "working", "working", "done", "done"]
  );
});

test("stepBgPromotion: a new turn does NOT restart a stale shell's window", () => {
  // The 2026-09-17 bug. Two dev servers left running in the worktree, the session
  // long done, and the user asking "are you still doing something?" — which ends the
  // turn on a fresh quiet edge. Measuring from that edge handed the servers another
  // ten minutes on every such question and the spinner could never clear. The shell's
  // own age doesn't reset, so the check lands the moment the turn is over.
  const late = T0 + BG_PROMOTE_WINDOW_MS + 60_000;
  assert.deepEqual(
    run([
      { status: "done", shellWorkStartedAt: T0, at: T0 },
      { status: "done", shellWorkStartedAt: T0, at: late }, // lapsed
      { status: "working", shellWorkStartedAt: T0, at: late + 1500 }, // new prompt
      { status: "done", shellWorkStartedAt: T0, at: late + 3000 },
      { status: "done", shellWorkStartedAt: T0, at: late + 4500 },
    ]),
    ["working", "done", "working", "done", "done"]
  );
});

test("stepBgPromotion: a shell the new turn launched promotes, stale neighbour or not", () => {
  // Same worktree, same ancient dev servers — but this turn backgrounded a test run.
  // The monitor reports the YOUNGEST shell, so the fresh job still holds the spinner:
  // ageing the shell must not cost the case the whole signal exists for.
  const late = T0 + BG_PROMOTE_WINDOW_MS + 60_000;
  assert.deepEqual(
    run([
      { status: "done", shellWorkStartedAt: T0, at: late },
      { status: "working", shellWorkStartedAt: late + 1500, at: late + 1500 },
      { status: "done", shellWorkStartedAt: late + 1500, at: late + 3000 },
      { status: "done", shellWorkStartedAt: late + 1500, at: late + 60_000 },
    ]),
    ["done", "working", "working", "working"]
  );
});

test("stepBgPromotion: a shell the monitor could not date never promotes", () => {
  // startedAt 0 is backgroundWork's "it was already there on my first poll" — a dev
  // server that survived a window reload. Unknown age reads as old, never as fresh.
  assert.deepEqual(
    run([
      { status: "working", shellWorkStartedAt: 0, at: T0 - 1500 },
      { status: "done", shellWorkStartedAt: 0, at: T0 },
      { status: "done", shellWorkStartedAt: 0, at: T0 + 1500 },
    ]),
    ["working", "done", "done"]
  );
});

// ---------------------------------------------------------------------------
// The subagent signal (transcript writes) — unbounded while the writes keep coming
// ---------------------------------------------------------------------------

test("stepBgPromotion: background agents hold the spinner past the shell window", () => {
  // The regression this exists to prevent: four background reviewers dispatched, the
  // main loop quiet for twenty minutes, their transcripts still open the whole time.
  // No completion check may appear while that is true.
  const quiet = T0;
  const steps: Step[] = [{ status: "working", at: quiet - 1500 }];
  for (let m = 0; m <= 20; m++) {
    steps.push({
      status: "done",
      at: quiet + m * 60_000,
      // A reviewer mid-run: its file is open and was written a few seconds ago.
      unfinishedSubagentWriteAt: quiet + m * 60_000 - 5_000,
    });
  }
  assert.deepEqual(new Set(run(steps).slice(1)), new Set(["working"]));
});

test("stepBgPromotion: a five-minute silence mid-run does not flap", () => {
  // Measured worst case inside a working reviewer was 5.4 minutes between writes, and
  // the file stays open across it — so the promotion must not depend on recency alone.
  const wrote = T0 + 10_000;
  assert.deepEqual(
    run([
      { status: "working", at: T0 - 1500 },
      { status: "done", unfinishedSubagentWriteAt: wrote, at: wrote + 1500 },
      { status: "done", unfinishedSubagentWriteAt: wrote, at: wrote + 324_000 },
    ]),
    ["working", "working", "working"]
  );
});

test("stepBgPromotion: finished subagents don't promote, so the check lands at once", () => {
  // A session whose last turn used subagents: every transcript closed out, so the
  // probe reports nothing and the tab reads exactly what the session says.
  assert.deepEqual(
    run([
      { status: "working", at: T0 - 1500 },
      { status: "done", at: T0 },
      { status: "done", at: T0 + 1500 },
    ]),
    ["working", "done", "done"]
  );
});

test("stepBgPromotion: an abandoned subagent's open transcript goes stale", () => {
  // Killed mid-run, so its closing message will never be written: the file stays
  // open forever and only the staleness backstop retires it.
  const wrote = T0 + 10_000;
  assert.deepEqual(
    run([
      { status: "working", at: T0 - 1500 },
      { status: "done", unfinishedSubagentWriteAt: wrote, at: wrote + 1500 },
      { status: "done", unfinishedSubagentWriteAt: wrote, at: wrote + AGENT_ACTIVITY_STALE_MS - 1 },
      { status: "done", unfinishedSubagentWriteAt: wrote, at: wrote + AGENT_ACTIVITY_STALE_MS },
    ]),
    ["working", "working", "working", "done"]
  );
});

test("stepBgPromotion: agent work needs no quiet-edge history, unlike the shell rule", () => {
  // First poll ever for this tab (no latch): a shell gets its window from the edge we
  // just observed, and an open subagent transcript stands on its own.
  const fresh = stepBgPromotion("done", { unfinishedSubagentWriteAt: T0 }, undefined, T0 + 1500);
  assert.equal(fresh.status, "working");
});

// ---------------------------------------------------------------------------
// Shared rules
// ---------------------------------------------------------------------------

test("stepBgPromotion: no signal at all leaves the status alone", () => {
  assert.deepEqual(
    run([
      { status: "done", at: T0 },
      { status: "idle", at: T0 + 1500 },
    ]),
    ["done", "idle"]
  );
});

test("stepBgPromotion: never touches working or attention states", () => {
  for (const status of ["working", "question", "plan", "permission", "something-new"]) {
    const out = stepBgPromotion(
      status,
      {
        shellWorkStartedAt: T0 + BG_PROMOTE_WINDOW_MS * 2,
        unfinishedSubagentWriteAt: T0 + 1_000_000,
      },
      { since: T0 },
      T0 + BG_PROMOTE_WINDOW_MS * 2
    );
    assert.equal(out.status, status);
    // The stretch is over, so the next quiet edge must start a fresh window.
    assert.equal(out.latch, undefined);
  }
});

test("stepBgPromotion: work appearing mid-quiet promotes within the window", () => {
  // A background shell spawned a poll or two after the tab went quiet is the same
  // stretch, so it still promotes.
  assert.deepEqual(
    run([
      { status: "done", at: T0 },
      { status: "done", shellWorkStartedAt: T0 + 1500, at: T0 + 1500 },
    ]),
    ["done", "working"]
  );
});

test("projectSlug: Claude's project-dir name for a worktree path", () => {
  assert.equal(
    projectSlug("/Users/andrey/worktrees/core/pro-2522-throw-data-message"),
    "-Users-andrey-worktrees-core-pro-2522-throw-data-message"
  );
  assert.equal(projectSlug("/Users/andrey/dev/aligned/core"), "-Users-andrey-dev-aligned-core");
});

// ---------------------------------------------------------------------------
// Reading a subagent transcript's tail
// ---------------------------------------------------------------------------

/** One transcript line, shaped like the real thing but trimmed to what we read. */
function entry(type: string, stop?: string | null): string {
  return JSON.stringify({ type, isSidechain: true, message: { stop_reason: stop } });
}

test("tailIsFinished: a closed-out subagent ends with end_turn", () => {
  // Every complete entry is newline-terminated on disk, which is exactly what tells a
  // finished write from one still in flight.
  const tail = [entry("user"), entry("assistant", null), entry("assistant", "end_turn"), ""].join("\n");
  assert.equal(tailIsFinished(tail), true);
});

test("tailIsFinished: mid-run tails are unfinished", () => {
  // Awaiting a tool result, and streaming a tool call: the two shapes a live
  // subagent's file ends with.
  assert.equal(
    tailIsFinished([entry("assistant", "tool_use"), entry("user")].join("\n")),
    false
  );
  assert.equal(
    tailIsFinished([entry("user"), entry("assistant", "tool_use")].join("\n")),
    false
  );
});

test("tailIsFinished: a partial last line never counts as finished", () => {
  const complete = entry("assistant", "end_turn");
  // A write in flight: the closing entry is only half on disk.
  assert.equal(tailIsFinished(entry("user") + "\n" + complete.slice(0, 20)), false);
  // A closing entry with no newline yet is a write in flight, not a finished agent.
  assert.equal(tailIsFinished(entry("user") + "\n" + complete), false);
  // The read started mid-entry (fixed-size tail), and the last complete line closes.
  assert.equal(tailIsFinished('sionId":"x"}\n' + complete + "\n"), true);
});

test("tailIsFinished: unreadable or empty tails are unfinished", () => {
  assert.equal(tailIsFinished(""), false);
  assert.equal(tailIsFinished("not json at all"), false);
  assert.equal(tailIsFinished("{oops\n{also not json}"), false);
});

// ---------------------------------------------------------------------------
// Scanning a real subagents directory
// ---------------------------------------------------------------------------

test("newestUnfinishedWrite: reports the open transcript, ignores the closed ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-subagents-"));
  const closed = `${entry("assistant", "end_turn")}\n`;
  const open = `${entry("assistant", "tool_use")}\n`;
  fs.writeFileSync(path.join(dir, "agent-aaa.jsonl"), closed);
  fs.writeFileSync(path.join(dir, "agent-bbb.jsonl"), open);
  fs.writeFileSync(path.join(dir, "notes.txt"), open); // not a transcript
  // Make the closed one the NEWEST file: an open transcript must still win, or a
  // session whose last subagent finished first would read as done mid-run.
  const t = Date.now();
  fs.utimesSync(path.join(dir, "agent-bbb.jsonl"), t / 1000 - 60, t / 1000 - 60);
  fs.utimesSync(path.join(dir, "agent-aaa.jsonl"), t / 1000, t / 1000);

  const verdicts = new Map<string, FileVerdict>();
  const openAt = fs.statSync(path.join(dir, "agent-bbb.jsonl")).mtimeMs;
  assert.equal(newestUnfinishedWrite(dir, verdicts), openAt);
  assert.equal(verdicts.size, 2); // both transcripts classified, notes.txt skipped

  // The memo is keyed to the bytes: a re-scan is a no-op, and closing the open
  // transcript flips the answer.
  assert.equal(newestUnfinishedWrite(dir, verdicts), openAt);
  fs.appendFileSync(path.join(dir, "agent-bbb.jsonl"), closed);
  assert.equal(newestUnfinishedWrite(dir, verdicts), undefined);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("newestUnfinishedWrite: an unreadable directory reports nothing", () => {
  assert.equal(
    newestUnfinishedWrite(path.join(os.tmpdir(), "ah-does-not-exist-1234"), new Map()),
    undefined
  );
});
