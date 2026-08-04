import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parsePsInstances } from "./psInstances";

const NAME = "AndreysOrchestrator";

test("parsePsInstances: finds the app whatever bundle it runs from", () => {
  const out = [
    "  1234 /Users/a/Library/Application Support/andreys-helper/AndreysOrchestrator.app/Contents/MacOS/AndreysOrchestrator",
    "  5678 /Users/a/dev/andreys-helper/orchestrator/.build/release/AndreysOrchestrator",
    "    12 /usr/libexec/logd",
  ].join("\n");
  assert.deepEqual(parsePsInstances(out, NAME), [
    {
      pid: 1234,
      exePath:
        "/Users/a/Library/Application Support/andreys-helper/AndreysOrchestrator.app/Contents/MacOS/AndreysOrchestrator",
    },
    {
      pid: 5678,
      exePath: "/Users/a/dev/andreys-helper/orchestrator/.build/release/AndreysOrchestrator",
    },
  ]);
});

test("parsePsInstances: no instances in a normal process list", () => {
  const out = [
    "     1 /sbin/launchd",
    "   400 /System/Library/CoreServices/Dock.app/Contents/MacOS/Dock",
    "  8123 /Applications/Cursor.app/Contents/MacOS/Cursor",
  ].join("\n");
  assert.deepEqual(parsePsInstances(out, NAME), []);
});

test("parsePsInstances: a mention in the arguments is not a match", () => {
  // The whole reason we match on `comm` and not `pgrep -f`: these three all
  // contain the name, and none of them IS the app.
  const out = [
    "  2001 /bin/bash /Users/a/dev/andreys-helper/orchestrator/scripts/build-app.sh",
    "  2002 /usr/bin/open /Users/a/x/AndreysOrchestrator.app",
    "  2003 /usr/local/bin/node --title AndreysOrchestrator",
  ].join("\n");
  assert.deepEqual(parsePsInstances(out, NAME), []);
});

test("parsePsInstances: a longer name that merely starts the same is not a match", () => {
  const out = "  3001 /x/AndreysOrchestratorHelper";
  assert.deepEqual(parsePsInstances(out, NAME), []);
});

test("parsePsInstances: tolerates blank lines, trailing newline and CRLF", () => {
  const out = "\r\n  9 /x/AndreysOrchestrator\r\n\n";
  assert.deepEqual(parsePsInstances(out, NAME), [
    { pid: 9, exePath: "/x/AndreysOrchestrator" },
  ]);
});

test("parsePsInstances: ignores kernel threads and anything without a path", () => {
  const out = ["     0 kernel_task", "    99 (idle)", "  1010 launchd"].join("\n");
  assert.deepEqual(parsePsInstances(out, "kernel_task"), []);
});
