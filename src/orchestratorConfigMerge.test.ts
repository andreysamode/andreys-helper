import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mergeMoonMode } from "./orchestratorConfigMerge";

test("mergeMoonMode: no config yet — writes a file with just the one key", () => {
  assert.deepEqual(mergeMoonMode(undefined, true), { moonMode: true });
});

test("mergeMoonMode: keeps every key the app owns", () => {
  const existing = JSON.stringify({
    port: 47615,
    repoScanDirs: ["/Users/andrey/dev"],
    circle: { screen: "Built-in", displayID: 1, x: 100, y: 200 },
    orchestrator: { workspace: "~/.andreys-helper/orchestrator", hideByDefault: true },
    launchAtLogin: true,
  });
  assert.deepEqual(mergeMoonMode(existing, true), {
    port: 47615,
    repoScanDirs: ["/Users/andrey/dev"],
    circle: { screen: "Built-in", displayID: 1, x: 100, y: 200 },
    orchestrator: { workspace: "~/.andreys-helper/orchestrator", hideByDefault: true },
    launchAtLogin: true,
    moonMode: true,
  });
});

test("mergeMoonMode: already correct — no write", () => {
  assert.equal(mergeMoonMode(JSON.stringify({ port: 1, moonMode: true }), true), undefined);
  assert.equal(mergeMoonMode(JSON.stringify({ port: 1, moonMode: false }), false), undefined);
});

test("mergeMoonMode: turning it off writes false rather than dropping the key", () => {
  assert.deepEqual(mergeMoonMode(JSON.stringify({ moonMode: true }), false), {
    moonMode: false,
  });
});

test("mergeMoonMode: an empty file is treated as no config", () => {
  assert.deepEqual(mergeMoonMode("", true), { moonMode: true });
  assert.deepEqual(mergeMoonMode("  \n", true), { moonMode: true });
});

test("mergeMoonMode: refuses to touch contents that aren't a JSON object", () => {
  // The caller turns these into "leave the file alone" — every other key in it
  // belongs to the app, so replacing it would be data loss.
  assert.throws(() => mergeMoonMode("[1,2,3]", true));
  assert.throws(() => mergeMoonMode("null", true));
  assert.throws(() => mergeMoonMode("not json at all", true));
});
