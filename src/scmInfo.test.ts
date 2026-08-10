import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  attributeTabs,
  bestRebaseBase,
  conventionalTrunk,
  parseAheadBehind,
  parseStatusPaths,
  parseWorktreePorcelain,
  pickWorktreeParent,
  worktreeSubtree,
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

test("bestRebaseBase: trunk wins over a sibling branch cut from HEAD", () => {
  // HEAD hasn't moved since both branches forked, so every candidate is ahead:0
  // and only the trunk rule separates the base (main) from the child branch.
  const best = bestRebaseBase(
    [
      { branch: "main", ahead: 0, behind: 14 },
      { branch: "spike", ahead: 0, behind: 3 },
      { branch: "origin/main", ahead: 0, behind: 14 },
    ],
    "main",
    ["origin"]
  );
  assert.equal(best, "main");
});

test("bestRebaseBase: nearer fork point beats the trunk (stacked branch)", () => {
  const best = bestRebaseBase(
    [
      { branch: "main", ahead: 4, behind: 5 },
      { branch: "stack-lower", ahead: 1, behind: 2 },
    ],
    "main",
    ["origin"]
  );
  assert.equal(best, "stack-lower");
});

test("bestRebaseBase: local beats remote on a dead heat, whatever the order", () => {
  const scored = [
    { branch: "origin/main", ahead: 3, behind: 0 },
    { branch: "main", ahead: 3, behind: 0 },
  ];
  assert.equal(bestRebaseBase(scored, "main", ["origin"]), "main");
  assert.equal(bestRebaseBase([...scored].reverse(), "main", ["origin"]), "main");
});

test("bestRebaseBase: no trunk known falls back to the branch that moved least", () => {
  const best = bestRebaseBase(
    [
      { branch: "far", ahead: 0, behind: 14 },
      { branch: "near", ahead: 0, behind: 3 },
    ],
    undefined,
    ["origin"]
  );
  assert.equal(best, "near");
});

test("bestRebaseBase: remote-only trunk still matches by short name", () => {
  const best = bestRebaseBase(
    [
      { branch: "spike", ahead: 0, behind: 3 },
      { branch: "origin/master", ahead: 0, behind: 14 },
    ],
    "master",
    ["origin"]
  );
  assert.equal(best, "origin/master");
});

test("bestRebaseBase: a stale branch parked inside HEAD's history is not a base", () => {
  // `wip` at HEAD~1 has the nearest fork point of all, but it's already contained
  // in HEAD, so rebasing onto it would replay nothing.
  const best = bestRebaseBase(
    [
      { branch: "main", ahead: 3, behind: 1 },
      { branch: "wip", ahead: 1, behind: 0 },
      { branch: "origin/main", ahead: 3, behind: 0 },
    ],
    "main",
    ["origin"]
  );
  assert.equal(best, "main");
});

test("bestRebaseBase: a trunk that hasn't moved still outranks an unrelated branch", () => {
  const best = bestRebaseBase(
    [
      { branch: "main", ahead: 3, behind: 0 },
      { branch: "someone-elses-feature", ahead: 3, behind: 20 },
    ],
    "main",
    ["origin"]
  );
  assert.equal(best, "main");
});

test("bestRebaseBase: every candidate a no-op falls back to the nearest fork point", () => {
  const best = bestRebaseBase(
    [
      { branch: "main", ahead: 5, behind: 0 },
      { branch: "stack-lower", ahead: 1, behind: 0 },
    ],
    "main",
    ["origin"]
  );
  assert.equal(best, "stack-lower");
});

test("bestRebaseBase: empty candidate list", () => {
  assert.equal(bestRebaseBase([], "main", []), undefined);
});

test("conventionalTrunk: prefers main, sees through remote prefixes", () => {
  assert.equal(conventionalTrunk(["feature", "develop", "origin/main"], ["origin"]), "main");
  assert.equal(conventionalTrunk(["feature", "upstream/develop"], ["origin", "upstream"]), "develop");
  assert.equal(conventionalTrunk(["feature", "spike"], ["origin"]), undefined);
  // Only a real remote prefix is stripped — "main" here is a directory-style name.
  assert.equal(conventionalTrunk(["andrey/main"], ["origin"]), undefined);
});

// --- pickWorktreeParent ----------------------------------------------------

test("pickWorktreeParent: the nearest fork point wins over the trunk", () => {
  // wt1a was cut from wt1 after wt1 had a commit of its own, so it shares more
  // history with wt1 than with main.
  const parent = pickWorktreeParent(
    [
      { path: "/main", ahead: 2, behind: 1 },
      { path: "/wt1", ahead: 1, behind: 0 },
    ],
    "/main"
  );
  assert.equal(parent, "/wt1");
});

test("pickWorktreeParent: a worktree strictly ahead is a descendant, never the parent", () => {
  // The mirror of the case above, scored from wt1: wt1a holds every commit wt1
  // has plus one. Without the drop, wt1 and wt1a each name the other.
  const parent = pickWorktreeParent(
    [
      { path: "/main", ahead: 1, behind: 1 },
      { path: "/wt1a", ahead: 0, behind: 1 },
    ],
    "/main"
  );
  assert.equal(parent, "/main");
});

test("pickWorktreeParent: a worktree still sitting on its parent's HEAD", () => {
  // Freshly created: nothing separates it from main yet (ahead 0, behind 0),
  // which must NOT read as "descendant" the way ahead 0 with commits does.
  const parent = pickWorktreeParent(
    [
      { path: "/main", ahead: 0, behind: 0 },
      { path: "/wt2", ahead: 3, behind: 4 },
    ],
    "/main"
  );
  assert.equal(parent, "/main");
});

test("pickWorktreeParent: an equal fork point goes to main", () => {
  // Two worktrees cut from the same commit of main can't be told apart by the
  // graph — both forked where the child did.
  const parent = pickWorktreeParent(
    [
      { path: "/sibling", ahead: 2, behind: 5 },
      { path: "/main", ahead: 2, behind: 5 },
    ],
    "/main"
  );
  assert.equal(parent, "/main");
});

test("pickWorktreeParent: ties below main resolve deterministically", () => {
  const cands = [
    { path: "/b", ahead: 2, behind: 1 },
    { path: "/a", ahead: 2, behind: 1 },
  ];
  assert.equal(pickWorktreeParent(cands, "/main"), "/a");
  assert.equal(pickWorktreeParent([...cands].reverse(), "/main"), "/a");
});

test("pickWorktreeParent: nothing eligible", () => {
  assert.equal(pickWorktreeParent([], "/main"), undefined);
  // Every candidate lives in the child's future.
  assert.equal(pickWorktreeParent([{ path: "/x", ahead: 0, behind: 2 }], "/main"), undefined);
});

// --- worktreeSubtree --------------------------------------------------------

// main ← wt1 ← wt1a, and main ← wt2. The shape the panes are scoped against.
const TREE = [
  { path: "/main", parent: "" },
  { path: "/wt1", parent: "/main" },
  { path: "/wt1a", parent: "/wt1" },
  { path: "/wt2", parent: "/main" },
];

test("worktreeSubtree: the main worktree still sees every worktree", () => {
  assert.deepEqual(worktreeSubtree(TREE, "/main"), ["/main", "/wt1", "/wt1a", "/wt2"]);
});

test("worktreeSubtree: a worktree window sees itself and its descendants only", () => {
  assert.deepEqual(worktreeSubtree(TREE, "/wt1"), ["/wt1", "/wt1a"]);
});

test("worktreeSubtree: a leaf worktree window sees only itself", () => {
  assert.deepEqual(worktreeSubtree(TREE, "/wt2"), ["/wt2"]);
  assert.deepEqual(worktreeSubtree(TREE, "/wt1a"), ["/wt1a"]);
});

test("worktreeSubtree: declared order is preserved, not discovery order", () => {
  const shuffled = [TREE[2], TREE[3], TREE[0], TREE[1]];
  assert.deepEqual(worktreeSubtree(shuffled, "/main"), ["/wt1a", "/wt2", "/main", "/wt1"]);
});

test("worktreeSubtree: an unknown root yields nothing to filter against", () => {
  // Callers treat empty as "don't filter" — a snapshot can land before git has
  // listed the window's own worktree, and publishing nothing would blank the pane.
  assert.deepEqual(worktreeSubtree(TREE, "/elsewhere"), []);
});

test("worktreeSubtree: a corrupt parent cycle terminates", () => {
  const cyclic = [
    { path: "/main", parent: "" },
    { path: "/a", parent: "/b" },
    { path: "/b", parent: "/a" },
  ];
  assert.deepEqual(worktreeSubtree(cyclic, "/main"), ["/main"]);
  assert.deepEqual(worktreeSubtree(cyclic, "/a"), ["/a", "/b"]);
});

test("worktreeSubtree: a worktree parented to itself doesn't loop", () => {
  const selfish = [{ path: "/main", parent: "" }, { path: "/x", parent: "/x" }];
  assert.deepEqual(worktreeSubtree(selfish, "/x"), ["/x"]);
});
