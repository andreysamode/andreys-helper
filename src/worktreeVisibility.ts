/**
 * Which worktree rows the Source Control+ pane hides.
 *
 * Only one class of worktree is ever hidden: the throwaway checkouts release
 * scripts and agents cut with `git worktree add <tag>`, which land on a
 * detached HEAD and churn in and out as those scripts run. Nobody works on
 * them — Commit / Publish / PR can't apply — so their rows are noise.
 *
 * "Detached" alone is NOT that signal. A worktree people actively work in goes
 * detached whenever git parks it mid-operation: a rebase that stopped on a
 * conflict or an `edit`/`break` step, or a bisect. Hiding those rows removes
 * the branch exactly when the user most needs it — the pane's own REBASING chip
 * and rebase-recovery menu live on that row — and reads as a worktree
 * mysteriously vanishing while it is still on disk. So a detached worktree is
 * hidden only when all three hold:
 *
 *   1. it isn't the window's trunk (a detached trunk means bisect or a tag
 *      checkout, and hiding the row would empty the pane);
 *   2. no git operation is in progress there (rebase / bisect);
 *   3. this window has never seen it on a branch.
 *
 * Rule 3 is the general guard: any worktree that has shown a branch at least
 * once this session is one somebody works in, so every later transient detach
 * (a bare `git checkout <sha>`, a half-finished `wt` operation, a tool that
 * detaches to read a tree) keeps its row. A tag checkout never qualifies — it
 * is born detached and stays that way — so the original intent survives intact.
 */

/** The fields of a snapshot worktree this decision reads. */
export interface VisibilityWorktree {
  /** Absolute worktree path, realpath-normalized. */
  path: string;
  /** Branch name, or "" when detached. */
  branch: string;
  /** This worktree IS the window's trunk. */
  isTrunk: boolean;
}

/**
 * Record every worktree currently on a branch, so a later detach can be told
 * apart from a worktree that was never on one. Mutates and returns `seen`.
 */
export function rememberBranchedRoots(
  worktrees: readonly VisibilityWorktree[],
  seen: Set<string>
): Set<string> {
  for (const w of worktrees) {
    if (w.branch) {
      seen.add(w.path);
    }
  }
  return seen;
}

/**
 * The worktree roots whose rows should be hidden — see the module comment for
 * the rule. `midGitOperation` answers "is a rebase or bisect in progress in
 * this worktree", injected so the decision stays pure and testable.
 */
export function hiddenWorktreeRoots(
  worktrees: readonly VisibilityWorktree[],
  everBranched: ReadonlySet<string>,
  midGitOperation: (root: string) => boolean
): Set<string> {
  const hidden = new Set<string>();
  for (const w of worktrees) {
    if (w.branch || w.isTrunk || everBranched.has(w.path)) {
      continue;
    }
    if (midGitOperation(w.path)) {
      continue;
    }
    hidden.add(w.path);
  }
  return hidden;
}
