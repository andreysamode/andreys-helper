import { branchExists, realPath, remoteBranchExists, runGit } from "../git";
import { extractJson, runWt, WtListEntry, WtSwitchResult } from "../wt";

/** First non-empty trimmed line of a command's output, for error surfacing. */
function firstLine(s: string): string {
  return (
    (s || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0] ?? ""
  );
}

/** Path of an existing worktree for `branch`, or undefined. */
export async function findWorktreePath(
  repoRoot: string,
  branch: string
): Promise<string | undefined> {
  try {
    const listed = await runWt(["-C", repoRoot, "list", "--format", "json"]);
    const entries = extractJson<WtListEntry[]>(listed.stdout) ?? [];
    const hit = entries.find((e) => e.branch === branch);
    return hit ? realPath(hit.path) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the worktree for `branch`, creating it if needed (the lazy step that
 * happens the first time a marble is processed). Mirrors extension.ts#newWorktree
 * minus the interactive open UI. Returns the realpath'd worktree cwd.
 *
 * `copyIgnored` runs `wt step copy-ignored` after creating a brand-new worktree
 * (warm start with build caches / node_modules).
 */
export async function ensureWorktreeForBranch(
  repoRoot: string,
  branch: string,
  copyIgnored: boolean
): Promise<string> {
  const existing = await findWorktreePath(repoRoot, branch);
  if (existing) {
    return existing;
  }

  // Create a brand-new branch only when it exists neither locally nor remotely.
  const needCreate =
    !(await branchExists(repoRoot, branch)) &&
    !(await remoteBranchExists(repoRoot, branch));

  const switchArgs = [
    "-C",
    repoRoot,
    "switch",
    branch,
    "--no-cd",
    "--format",
    "json",
  ];
  if (needCreate) {
    switchArgs.splice(4, 0, "-c");
  }
  const sw = await runWt(switchArgs);
  if (sw.code !== 0) {
    throw new Error(
      firstLine(sw.stderr || sw.stdout) || `wt switch exited ${sw.code}`
    );
  }

  const parsed = extractJson<WtSwitchResult>(sw.stdout);
  const newPath = parsed?.path ?? (await findWorktreePath(repoRoot, branch));
  if (!newPath) {
    throw new Error("could not resolve the new worktree path");
  }

  if (copyIgnored) {
    // Non-fatal: the worktree exists even if the copy fails.
    await runWt(["-C", newPath, "step", "copy-ignored"]);
  }

  return realPath(newPath);
}

/** Remove a worktree (used by Archive). Throws with a readable reason. */
export async function removeWorktreePath(worktreeCwd: string): Promise<void> {
  const res = await runWt([
    "-C",
    worktreeCwd,
    "remove",
    "-y",
    "--format",
    "json",
  ]);
  if (res.code !== 0) {
    throw new Error(
      firstLine(res.stderr || res.stdout) || `wt remove exited ${res.code}`
    );
  }
}

/** True when the worktree has no uncommitted changes (git status --porcelain). */
export async function isWorktreeClean(worktreeCwd: string): Promise<boolean> {
  const res = await runGit(worktreeCwd, ["status", "--porcelain"]);
  return res.code === 0 && res.stdout.trim() === "";
}
