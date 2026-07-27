/**
 * Local git scan for `ah resolve-branch` (PLAN.md §6.3).
 *
 * After the broker reports which currently-open windows hold the branch, the CLI
 * scans the configured `repoScanDirs` for repos that have the branch as a local
 * branch or a checked-out worktree. This is the only git logic in the CLI; the
 * broker/extension own everything else.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface BranchMatch {
  repo: string;
  path: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** Immediate git repos: each scan dir itself, plus its direct children. */
function discoverRepos(scanDirs: string[]): string[] {
  const repos = new Set<string>();
  for (const dir of scanDirs) {
    try {
      if (isGitRepo(dir)) repos.add(dir);
      for (const name of readdirSync(dir)) {
        const child = join(dir, name);
        try {
          if (statSync(child).isDirectory() && isGitRepo(child)) repos.add(child);
        } catch {
          /* skip */
        }
      }
    } catch {
      /* unreadable scan dir */
    }
  }
  return [...repos];
}

interface WorktreeRecord {
  path: string;
  branch: string;
}

function parseWorktrees(porcelain: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let cur: Partial<WorktreeRecord> = {};
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur.path) records.push({ path: cur.path, branch: cur.branch ?? "" });
      cur = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  if (cur.path) records.push({ path: cur.path, branch: cur.branch ?? "" });
  return records;
}

/**
 * Scan `scanDirs` for repos holding `branch`. A worktree checked out on the
 * branch matches at its worktree path; a bare local branch with no dedicated
 * worktree matches at the repo root.
 */
export function scanReposForBranch(
  scanDirs: string[],
  branch: string,
): BranchMatch[] {
  const matches: BranchMatch[] = [];
  for (const repo of discoverRepos(scanDirs)) {
    try {
      const worktrees = parseWorktrees(git(repo, ["worktree", "list", "--porcelain"]));
      const wtOnBranch = worktrees.filter((w) => w.branch === branch);
      for (const w of wtOnBranch) matches.push({ repo: basename(repo), path: w.path });
      if (wtOnBranch.length === 0) {
        const listed = git(repo, ["branch", "--list", branch]);
        if (listed) matches.push({ repo: basename(repo), path: repo });
      }
    } catch {
      /* not a usable git repo; skip */
    }
  }
  return matches;
}
