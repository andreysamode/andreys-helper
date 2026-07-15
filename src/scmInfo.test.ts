import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  attributeTabs,
  parseAheadBehind,
  parseStatusPaths,
  parseWorktreePorcelain,
} from "./scmParse";

test("parseWorktreePorcelain: multiple records with branch and detached", () => {
  const out = [
    "worktree /repo/main",
    "HEAD aaaa",
    "branch refs/heads/main",
    "",
    "worktree /repo/wt/feature",
    "HEAD bbbb",
    "branch refs/heads/feature-x",
    "",
    "worktree /repo/wt/detached",
    "HEAD cccc",
    "detached",
    "",
  ].join("\n");
  assert.deepEqual(parseWorktreePorcelain(out), [
    { path: "/repo/main", head: "aaaa", branch: "main" },
    { path: "/repo/wt/feature", head: "bbbb", branch: "feature-x" },
    { path: "/repo/wt/detached", head: "cccc", branch: "" },
  ]);
});

test("parseWorktreePorcelain: trailing record without blank line", () => {
  const out = "worktree /r\nHEAD dead\nbranch refs/heads/z";
  assert.deepEqual(parseWorktreePorcelain(out), [
    { path: "/r", head: "dead", branch: "z" },
  ]);
});

test("parseAheadBehind: left=behind, right=ahead", () => {
  assert.deepEqual(parseAheadBehind("3\t5"), { behind: 3, ahead: 5 });
  assert.deepEqual(parseAheadBehind("0\t0\n"), { behind: 0, ahead: 0 });
  assert.deepEqual(parseAheadBehind("garbage"), { behind: 0, ahead: 0 });
});

test("parseStatusPaths: strips XY prefix and handles renames", () => {
  const out = [
    " M src/a.ts",
    "?? new/file.py",
    "A  added.txt",
    "R  old/name.ts -> new/name.ts",
  ].join("\n");
  assert.deepEqual(parseStatusPaths(out), [
    "src/a.ts",
    "new/file.py",
    "added.txt",
    "new/name.ts",
  ]);
});

test("attributeTabs: deepest worktree wins for nested paths", () => {
  const worktrees = ["/repo/main", "/repo/main/nested"];
  const tabs = [
    "/repo/main/src/a.ts", // → /repo/main
    "/repo/main/nested/b.ts", // → /repo/main/nested (deeper)
    "/repo/main/nested/deep/c.ts", // → /repo/main/nested
    "/elsewhere/x.ts", // → none
  ];
  const counts = attributeTabs(tabs, worktrees);
  assert.equal(counts.get("/repo/main"), 1);
  assert.equal(counts.get("/repo/main/nested"), 2);
});

test("attributeTabs: no worktrees, no matches", () => {
  assert.equal(attributeTabs(["/a/b.ts"], []).size, 0);
});
