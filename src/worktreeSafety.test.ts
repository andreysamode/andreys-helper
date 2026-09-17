import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseChangedPaths, parseCommitSubjects, removalBlocker } from "./worktreeSafety";

test("parseChangedPaths: every flavor of uncommitted change", () => {
  const porcelain = [
    " M src/app.ts", // unstaged edit
    "M  src/staged.ts", // staged edit
    "MM src/both.ts", // staged and edited again
    "A  src/added.ts",
    " D src/gone.ts",
    "?? scratch/", // untracked dir, collapsed by git
    "R  src/old.ts -> src/new.ts", // the path that exists is the new one
    "UU src/conflict.ts",
    "", // trailing newline
  ].join("\n");
  assert.deepEqual(parseChangedPaths(porcelain), [
    "src/app.ts",
    "src/staged.ts",
    "src/both.ts",
    "src/added.ts",
    "src/gone.ts",
    "scratch/",
    "src/new.ts",
    "src/conflict.ts",
  ]);
});

test("parseChangedPaths: a clean tree has nothing to report", () => {
  assert.deepEqual(parseChangedPaths(""), []);
  assert.deepEqual(parseChangedPaths("\n\n"), []);
});

test("parseCommitSubjects: one subject per line", () => {
  assert.deepEqual(parseCommitSubjects("fix the thing\nwip\n"), ["fix the thing", "wip"]);
  assert.deepEqual(parseCommitSubjects(""), []);
});

test("removalBlocker: a worktree holding nothing is removed without a word", () => {
  assert.equal(removalBlocker("feat/x", { changed: [], strandedCommits: [] }), undefined);
});

test("removalBlocker: uncommitted changes are named, not just counted", () => {
  const msg = removalBlocker("feat/x", {
    changed: ["src/app.ts", "src/b.ts"],
    strandedCommits: [],
  });
  assert.equal(
    msg,
    'Kept worktree "feat/x": it has 2 uncommitted changes (src/app.ts, src/b.ts). ' +
      "Removing it would delete that for good."
  );
});

test("removalBlocker: singular reads as singular", () => {
  const msg = removalBlocker("feat/x", { changed: ["a.ts"], strandedCommits: [] });
  assert.match(msg!, /1 uncommitted change \(a\.ts\)/);
});

test("removalBlocker: commits reachable from nowhere else block too", () => {
  const many = removalBlocker("feat/x", { changed: [], strandedCommits: ["a", "b"] });
  assert.match(many!, /2 commits that exist nowhere else/);
  const msg = removalBlocker("feat/x", {
    changed: [],
    strandedCommits: ["wip: half a migration"],
  });
  assert.match(msg!, /1 commit that exists nowhere else \(wip: half a migration\)/);
});

test("removalBlocker: both reasons are reported together", () => {
  const msg = removalBlocker("feat/x", { changed: ["a.ts"], strandedCommits: ["wip"] });
  assert.match(msg!, /1 uncommitted change \(a\.ts\) and 1 commit that exists nowhere else \(wip\)/);
});

test("removalBlocker: long lists are trimmed to a readable few", () => {
  const msg = removalBlocker("feat/x", {
    changed: ["a", "b", "c", "d", "e"],
    strandedCommits: [],
  });
  assert.match(msg!, /5 uncommitted changes \(a, b, c, \+2 more\)/);
});
