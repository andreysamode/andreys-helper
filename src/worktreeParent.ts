import * as fs from "fs";
import * as path from "path";

/**
 * Persistence for "which worktree was this one cut from".
 *
 * Git tracks no relationship between a worktree and the worktree it was created
 * in — `git worktree list` is a flat set, and `wt list --format json` has no
 * base field either. The one place we can know it for certain is at creation
 * time, so "New Worktree…" records it here and the panes read it back.
 *
 * Storage is the worktree's own private admin directory
 * (`<main>/.git/worktrees/<name>/`), reached through the `gitdir:` pointer in
 * the linked worktree's `.git` file. That location is deliberate: `git worktree
 * remove` (and `prune`) delete the whole directory, so the record is garbage-
 * collected with the worktree it describes and can never outlive it and
 * mis-parent a later worktree that reuses the name.
 *
 * Worktrees created outside our UI have no record; scmInfo falls back to
 * inferring the parent from the commit graph.
 */

const RECORD = "andreys-helper-parent";

/**
 * Resolve a linked worktree's private admin directory from the `gitdir:`
 * pointer in its `.git` file. Returns undefined for the main worktree (where
 * `.git` is a directory) and for anything unreadable.
 */
function adminDir(worktreePath: string): string | undefined {
  try {
    const dotGit = path.join(worktreePath, ".git");
    if (!fs.statSync(dotGit).isFile()) {
      return undefined;
    }
    const pointer = fs.readFileSync(dotGit, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/m.exec(pointer);
    if (!match) {
      return undefined;
    }
    const dir = match[1].trim();
    return path.isAbsolute(dir) ? dir : path.resolve(worktreePath, dir);
  } catch {
    return undefined;
  }
}

/**
 * Record that `worktreePath` was created from `parentPath`. Best-effort: a
 * failure just means the parent gets inferred from the graph instead.
 */
export function recordWorktreeParent(worktreePath: string, parentPath: string): void {
  const dir = adminDir(worktreePath);
  if (!dir) {
    return;
  }
  try {
    fs.writeFileSync(path.join(dir, RECORD), parentPath + "\n", "utf8");
  } catch {
    // Non-fatal: inference covers it.
  }
}

/** The recorded parent path for a worktree, or undefined when none was written. */
export function readRecordedParent(worktreePath: string): string | undefined {
  const dir = adminDir(worktreePath);
  if (!dir) {
    return undefined;
  }
  try {
    return fs.readFileSync(path.join(dir, RECORD), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
