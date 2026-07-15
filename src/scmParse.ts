import * as path from "path";

/**
 * Pure, dependency-light parsers/attribution for the SCM branch-info compute
 * layer — no `vscode` import, so they're unit-testable under `node --test`
 * (same discipline as watchPatterns.ts). scmInfo.ts wires these to git/tabs.
 */

export interface PorcelainWorktree {
  path: string;
  head: string;
  branch: string; // "" when detached / bare
}

/**
 * Parse `git worktree list --porcelain`. Records are blank-line separated:
 *   worktree <abs path>
 *   HEAD <sha>
 *   branch refs/heads/<name>      (absent when detached; "bare"/"detached" line)
 */
export function parseWorktreePorcelain(stdout: string): PorcelainWorktree[] {
  const out: PorcelainWorktree[] = [];
  let cur: Partial<PorcelainWorktree> | undefined;
  const flush = () => {
    if (cur?.path) {
      out.push({ path: cur.path, head: cur.head ?? "", branch: cur.branch ?? "" });
    }
    cur = undefined;
  };
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? "" : line.slice(sp + 1);
    if (key === "worktree") {
      flush();
      cur = { path: val };
    } else if (cur && key === "HEAD") {
      cur.head = val;
    } else if (cur && key === "branch") {
      cur.branch = val.replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return out;
}

/** Parse "<behind>\t<ahead>" from `rev-list --left-right --count A...B`
 *  where A=trunk, B=worktree (left = trunk-only = behind, right = wt-only = ahead). */
export function parseAheadBehind(stdout: string): { ahead: number; behind: number } {
  const [left, right] = stdout.trim().split(/\s+/);
  const behind = Number.parseInt(left ?? "", 10);
  const ahead = Number.parseInt(right ?? "", 10);
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
}

/** Strip the two-column XY status prefix from `git status --porcelain` lines,
 *  returning repo-relative paths (rename "old -> new" yields new). */
export function parseStatusPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const raw of stdout.split("\n")) {
    if (raw.length < 4) {
      continue;
    }
    let p = raw.slice(3).trim();
    const arrow = p.indexOf(" -> ");
    if (arrow !== -1) {
      p = p.slice(arrow + 4);
    }
    if (p.startsWith('"') && p.endsWith('"')) {
      p = p.slice(1, -1);
    }
    if (p) {
      paths.push(p);
    }
  }
  return paths;
}

/**
 * Attribute each open tab (by fsPath) to the DEEPEST worktree it lives under,
 * so a tab inside a nested worktree counts once, for the nested worktree only.
 * Inputs are expected realpath-normalized. Count keyed by worktree path.
 */
export function attributeTabs(
  tabPaths: string[],
  worktreePaths: string[]
): Map<string, number> {
  const deepestFirst = [...worktreePaths].sort((a, b) => b.length - a.length);
  const counts = new Map<string, number>();
  for (const w of worktreePaths) {
    counts.set(w, 0);
  }
  for (const t of tabPaths) {
    const owner = deepestFirst.find((w) => t === w || t.startsWith(w + path.sep));
    if (owner) {
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
  }
  return counts;
}
