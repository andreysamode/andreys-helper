import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  hiddenWorktreeRoots,
  rememberBranchedRoots,
  VisibilityWorktree,
} from "./worktreeVisibility";

const wt = (path: string, branch: string, isTrunk = false): VisibilityWorktree => ({
  path,
  branch,
  isTrunk,
});

const noOps = () => false;

test("a tag checkout — born detached, never branched — is hidden", () => {
  const worktrees = [wt("/repo", "main", true), wt("/wt/v2.23.1", "")];
  const seen = rememberBranchedRoots(worktrees, new Set());
  assert.deepEqual([...hiddenWorktreeRoots(worktrees, seen, noOps)], ["/wt/v2.23.1"]);
});

test("worktrees on a branch are never hidden", () => {
  const worktrees = [wt("/repo", "main", true), wt("/wt/feat", "feat")];
  const seen = rememberBranchedRoots(worktrees, new Set());
  assert.deepEqual([...hiddenWorktreeRoots(worktrees, seen, noOps)], []);
});

test("a stopped rebase detaches the worktree but keeps its row", () => {
  // The pane's REBASING chip and rebase-recovery menu live on this row, so
  // hiding it would strip the only in-UI way out of a half-finished rebase.
  const worktrees = [wt("/repo", "main", true), wt("/wt/feat", "")];
  const midOp = (root: string) => root === "/wt/feat";
  // Fresh window: no history of this worktree ever being on a branch.
  assert.deepEqual([...hiddenWorktreeRoots(worktrees, new Set(), midOp)], []);
});

test("a worktree seen on a branch keeps its row through a later detach", () => {
  const seen = rememberBranchedRoots([wt("/wt/feat", "feat")], new Set());
  // Same worktree, now detached by a bare `git checkout <sha>` — no rebase dir,
  // so the operation probe says nothing; only the history keeps the row.
  const detached = [wt("/repo", "main", true), wt("/wt/feat", "")];
  assert.deepEqual([...hiddenWorktreeRoots(detached, seen, noOps)], []);
});

test("a detached trunk always stays — hiding it would empty the pane", () => {
  const worktrees = [wt("/repo", "", true)];
  assert.deepEqual([...hiddenWorktreeRoots(worktrees, new Set(), noOps)], []);
});

test("rememberBranchedRoots accumulates across renders and ignores detached", () => {
  const seen = new Set<string>();
  rememberBranchedRoots([wt("/wt/a", "a"), wt("/wt/b", "")], seen);
  rememberBranchedRoots([wt("/wt/c", "c")], seen);
  assert.deepEqual([...seen].sort(), ["/wt/a", "/wt/c"]);
});

test("hiding is decided per worktree, not all-or-nothing", () => {
  const worktrees = [
    wt("/repo", "main", true),
    wt("/wt/feat", ""), // mid-rebase → stays
    wt("/wt/v1.0.0", ""), // tag checkout → hidden
    wt("/wt/old", ""), // branched earlier this session → stays
  ];
  const seen = new Set(["/wt/old"]);
  const midOp = (root: string) => root === "/wt/feat";
  assert.deepEqual([...hiddenWorktreeRoots(worktrees, seen, midOp)], ["/wt/v1.0.0"]);
});
