import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { BG_PROMOTE_WINDOW_MS, stepBgPromotion } from "./bgPromote";
import {
  applyTranscriptLine,
  MONITOR_DEFAULT_TIMEOUT_MS,
  MONITOR_MAX_TIMEOUT_MS,
  MonitorLedger,
} from "./monitorLedger";

const T0 = Date.parse("2026-11-17T23:20:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** Shapes copied from a real transcript (claude-code 2.1.325). */
function monitorUse(id: string, at: number, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: iso(at),
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Monitor", input: { description: "gate", command: "tail -f x", ...input } }],
    },
  });
}
function terminalNotice(id: string, at: number): string {
  return JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    timestamp: iso(at),
    content: `<task-notification>\n<task-id>b46ep5xl0</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/tmp/x.output</output-file>\n<status>completed</status>\n<summary>Monitor "gate" stream ended</summary>\n</task-notification>`,
  });
}
function eventNotice(at: number): string {
  return JSON.stringify({
    type: "queue-operation",
    timestamp: iso(at),
    content: `<task-notification>\n<task-id>b46ep5xl0</task-id>\n<summary>Monitor event: "gate"</summary>\n<event>EXIT=0</event>\n</task-notification>`,
  });
}

test("Monitor tool_use opens with its declared (capped) deadline", () => {
  const open = new Map<string, number>();
  applyTranscriptLine(monitorUse("toolu_a", T0, { timeout_ms: 1_800_000 }), open);
  applyTranscriptLine(monitorUse("toolu_b", T0, {}), open);
  applyTranscriptLine(monitorUse("toolu_c", T0, { timeout_ms: 3_600_000 }), open);
  applyTranscriptLine(monitorUse("toolu_p", T0, { persistent: true }), open);
  assert.equal(open.get("toolu_a"), T0 + 1_800_000);
  assert.equal(open.get("toolu_b"), T0 + MONITOR_DEFAULT_TIMEOUT_MS);
  assert.equal(open.get("toolu_c"), T0 + MONITOR_MAX_TIMEOUT_MS);
  assert.equal(open.has("toolu_p"), false, "persistent watchers never hold a spinner");
});

test("per-event notices keep it open; the terminal notice closes it", () => {
  const open = new Map<string, number>();
  applyTranscriptLine(monitorUse("toolu_a", T0, { timeout_ms: 1_800_000 }), open);
  applyTranscriptLine(eventNotice(T0 + 1000), open);
  assert.equal(open.has("toolu_a"), true);
  applyTranscriptLine(terminalNotice("toolu_a", T0 + 2000), open);
  assert.equal(open.has("toolu_a"), false);
});

test("ledger reads incrementally, including a line split across appends", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monledger-"));
  const file = path.join(dir, "s.jsonl");
  fs.writeFileSync(file, '{"type":"user"}\n');
  const ledger = new MonitorLedger(file);
  assert.equal(ledger.openDeadline(T0), undefined);

  const use = monitorUse("toolu_a", T0, { timeout_ms: 1_800_000 }) + "\n";
  fs.appendFileSync(file, use.slice(0, 40));
  assert.equal(ledger.openDeadline(T0), undefined);
  fs.appendFileSync(file, use.slice(40));
  assert.equal(ledger.openDeadline(T0 + 1000), T0 + 1_800_000);

  assert.equal(ledger.openDeadline(T0 + 1_800_000), undefined, "expired at its deadline");

  fs.appendFileSync(file, monitorUse("toolu_b", T0, { timeout_ms: 900_000 }) + "\n");
  assert.equal(ledger.openDeadline(T0 + 1000), T0 + 900_000);
  fs.appendFileSync(file, terminalNotice("toolu_b", T0 + 5000) + "\n");
  assert.equal(ledger.openDeadline(T0 + 6000), undefined);
  fs.rmSync(dir, { recursive: true });
});

test("regression 2026-11-17: armed 30-min Monitor holds the spinner past the 10-min shell ceiling", () => {
  const shellAt = T0;
  const latch = { since: T0 };
  const at = T0 + BG_PROMOTE_WINDOW_MS + 60_000; // 11 min in, gate still running
  // Without the Monitor signal this is the reported bug: a completion check.
  assert.equal(stepBgPromotion("done", { shellWorkStartedAt: shellAt }, latch, at).status, "done");
  assert.equal(
    stepBgPromotion("done", { shellWorkStartedAt: shellAt, monitorDeadline: T0 + 1_800_000 }, latch, at).status,
    "working"
  );
});

test("Monitor signal needs a live shell and an unexpired deadline", () => {
  const latch = { since: T0 };
  const at = T0 + BG_PROMOTE_WINDOW_MS + 60_000;
  assert.equal(stepBgPromotion("done", { monitorDeadline: T0 + 1_800_000 }, latch, at).status, "done");
  assert.equal(
    stepBgPromotion("done", { shellWorkStartedAt: T0, monitorDeadline: at }, latch, at).status,
    "done"
  );
});
