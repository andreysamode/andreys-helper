import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ClaudePanel, claudeRowsByRoot, isOpenPanel, ownerRoot } from "./claudeRows";

const SEP = "/";
const CORE = "/Users/andrey/dev/aligned/core";
const W = "/Users/andrey/worktrees/core";
const ROOTS = [CORE, `${W}/andrey-pro-2610`, `${W}/feat-pro-2527`, `${W}/iraklis-review`];

function panel(p: Partial<ClaudePanel> & { id: string; cwd: string }): ClaudePanel {
  return { title: "Review pull request with…", status: "idle", ...p };
}

/** The layout from the reported bug: three same-titled panels, two sharing a group. */
const REPORTED: ClaudePanel[] = [
  panel({ id: "wt3", cwd: CORE, title: "Improve codebase archite…", col: 1 }),
  panel({ id: "wt4", cwd: CORE, title: "Clarify member pending s…", col: 1, visible: true }),
  panel({ id: "wt7", cwd: `${W}/andrey-pro-2610`, col: 1 }),
  panel({ id: "wt9", cwd: `${W}/feat-pro-2527`, col: 2, visible: true, active: true, status: "working" }),
  panel({ id: "wt11", cwd: `${W}/iraklis-review`, col: 2 }),
];

test("claudeRowsByRoot: same-titled panels keep their own worktree and id", () => {
  const rows = claudeRowsByRoot(REPORTED, ROOTS, 2, SEP);
  // The bug: the feat-pro-2527 box carried the iraklis panel's id (and vice versa),
  // so clicking either revealed the other session.
  assert.deepEqual(
    rows.get(`${W}/feat-pro-2527`)?.map((r) => [r.sessionId, r.status]),
    [["wt9", "working"]]
  );
  assert.deepEqual(
    rows.get(`${W}/iraklis-review`)?.map((r) => [r.sessionId, r.status]),
    [["wt11", "idle"]]
  );
  // ...and the highlight followed the same mismatch.
  assert.equal(rows.get(`${W}/feat-pro-2527`)?.[0].active, true);
  assert.equal(rows.get(`${W}/iraklis-review`)?.[0].active, false);
});

test("claudeRowsByRoot: several rows under one root, in panel order", () => {
  const rows = claudeRowsByRoot(REPORTED, ROOTS, 2, SEP);
  assert.deepEqual(
    rows.get(CORE)?.map((r) => r.sessionId),
    ["wt3", "wt4"]
  );
  // The repo the user is NOT in has no highlighted row, even though one of its
  // panels is the selected tab of its own group.
  assert.deepEqual(
    rows.get(CORE)?.map((r) => r.active),
    [false, false]
  );
});

test("claudeRowsByRoot: panels with no home are dropped", () => {
  const rows = claudeRowsByRoot(
    [
      panel({ id: "wt1", cwd: "/Users/andrey/dev/somewhere-else" }),
      { id: "wt2", title: "unhydrated", status: "idle" },
      panel({ id: "wt3", cwd: CORE }),
    ],
    ROOTS,
    1,
    SEP
  );
  assert.deepEqual([...rows.keys()], [CORE]);
  assert.deepEqual(
    rows.get(CORE)?.map((r) => r.sessionId),
    ["wt3"]
  );
});

test("claudeRowsByRoot: a workflow is carried by reference, and only when present", () => {
  const wf = { taskId: "t1", name: "review", status: "running" } as never;
  const rows = claudeRowsByRoot(
    [panel({ id: "wt1", cwd: CORE, wf }), panel({ id: "wt2", cwd: CORE })],
    ROOTS,
    1,
    SEP
  );
  const [withWf, without] = rows.get(CORE)!;
  assert.equal(withWf.wf, wf);
  assert.equal("wf" in without, false);
});

test("ownerRoot: the longest containing root wins", () => {
  const roots = ["/repo", "/repo/nested"];
  assert.equal(ownerRoot("/repo/nested/app", roots, SEP), "/repo/nested");
  assert.equal(ownerRoot("/repo/app", roots, SEP), "/repo");
  // A sibling path that merely shares a prefix is not inside the root.
  assert.equal(ownerRoot("/repo-other/app", roots, SEP), undefined);
  assert.equal(ownerRoot("/repo", roots, SEP), "/repo");
});

test("isOpenPanel: the selected tab of the group the user is in", () => {
  assert.equal(isOpenPanel({ id: "a", title: "", status: "", col: 2, visible: true }, 2), true);
  // Selected in its own group, but the user is in the other one.
  assert.equal(isOpenPanel({ id: "a", title: "", status: "", col: 1, visible: true }, 2), false);
  // Open group, but a different tab of it is selected.
  assert.equal(isOpenPanel({ id: "a", title: "", status: "", col: 2, visible: false }, 2), false);
});

test("isOpenPanel: falls back to focus on a bundle that doesn't report visibility", () => {
  assert.equal(isOpenPanel({ id: "a", title: "", status: "", col: 2, active: true }, 2), true);
  assert.equal(isOpenPanel({ id: "a", title: "", status: "", col: 2, active: false }, 2), false);
  // No visibility and no column either: focus is all there is to go on.
  assert.equal(isOpenPanel({ id: "a", title: "", status: "", active: true }, undefined), true);
});

test("isOpenPanel: no active group means nothing reads as open", () => {
  assert.equal(isOpenPanel({ id: "a", title: "", status: "", col: 2, visible: true }, undefined), false);
});
