import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fuzzyScore,
  listTranscriptFiles,
  searchTranscripts,
  summarizeTranscript,
  findTranscriptBySessionId,
} from "./transcripts";

/** Write a JSONL transcript and stamp its mtime (seconds). */
function writeTranscript(
  dir: string,
  sessionId: string,
  lines: object[],
  mtimeSec: number,
): string {
  const p = join(dir, `${sessionId}.jsonl`);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

function makeFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ah-transcripts-"));
  const base = 1_700_000_000; // arbitrary epoch seconds
  writeTranscript(
    dir,
    "sess-1",
    [
      { type: "summary", summary: "Broker reconnect backoff" },
      {
        type: "user",
        sessionId: "sess-1",
        cwd: "/dev/core",
        message: { role: "user", content: "start a new session about broker reconnect" },
      },
      {
        type: "assistant",
        sessionId: "sess-1",
        message: { role: "assistant", content: [{ type: "text", text: "Done: exponential backoff." }] },
      },
    ],
    base - 3000, // oldest
  );
  writeTranscript(
    dir,
    "sess-2",
    [
      {
        type: "user",
        sessionId: "sess-2",
        cwd: "/dev/app",
        message: { role: "user", content: "another session on the kanban board" },
      },
    ],
    base - 2000, // middle
  );
  writeTranscript(
    dir,
    "sess-3",
    [
      {
        type: "user",
        sessionId: "sess-3",
        cwd: "/dev/lab",
        message: { role: "user", content: "marble session physics simulation" },
      },
    ],
    base - 1000, // newest
  );
  return dir;
}

test("listTranscriptFiles: sorted most-recent-first", () => {
  const dir = makeFixtureDir();
  const files = listTranscriptFiles(dir);
  assert.equal(files.length, 3);
  assert.deepEqual(
    files.map((f) => f.path.endsWith("sess-3.jsonl") ? 3 : f.path.endsWith("sess-2.jsonl") ? 2 : 1),
    [3, 2, 1],
  );
});

test("searchTranscripts: fuzzy match narrows to matching transcripts", () => {
  const dir = makeFixtureDir();
  const broker = searchTranscripts(dir, "broker");
  assert.equal(broker.length, 1);
  assert.equal(broker[0].sessionId, "sess-1");

  const kanban = searchTranscripts(dir, "kanban");
  assert.equal(kanban.length, 1);
  assert.equal(kanban[0].sessionId, "sess-2");
});

test("searchTranscripts: ranks recent-first among matches", () => {
  const dir = makeFixtureDir();
  // "session" appears in all three; recent-first ⇒ sess-3, sess-2, sess-1.
  const hits = searchTranscripts(dir, "session");
  assert.deepEqual(
    hits.map((h) => h.sessionId),
    ["sess-3", "sess-2", "sess-1"],
  );
});

test("fuzzyScore: substring > subsequence > no-match", () => {
  const substr = fuzzyScore("broker", "fix the broker reconnect");
  const subseq = fuzzyScore("bkr", "fix the broker reconnect");
  const none = fuzzyScore("zzzq", "fix the broker reconnect");
  assert.ok(substr > 2, `substring score ${substr}`);
  assert.ok(subseq > 0 && subseq < 2, `subsequence score ${subseq}`);
  assert.equal(none, 0);
});

test("summarizeTranscript: extracts title, first/last message, count, sessionId", () => {
  const dir = makeFixtureDir();
  const file = listTranscriptFiles(dir).find((f) => f.path.endsWith("sess-1.jsonl"))!;
  const s = summarizeTranscript(file);
  assert.equal(s.sessionId, "sess-1");
  assert.equal(s.title, "Broker reconnect backoff");
  assert.match(s.firstUserMessage, /start a new session about broker/);
  assert.match(s.lastMessage, /exponential backoff/);
  assert.equal(s.messageCount, 2); // 1 user + 1 assistant
  assert.equal(s.cwd, "/dev/core");
});

test("findTranscriptBySessionId: locates by filename", () => {
  const dir = makeFixtureDir();
  const found = findTranscriptBySessionId(dir, "sess-2");
  assert.ok(found);
  assert.ok(found!.path.endsWith("sess-2.jsonl"));
  assert.equal(findTranscriptBySessionId(dir, "nope"), null);
});
