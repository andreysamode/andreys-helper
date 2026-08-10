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

/** One possible parent worktree, scored against the child by `rev-list --left-right`. */
export interface ParentCandidate {
  /** The candidate worktree's path — what gets returned as the parent. */
  path: string;
  /** Commits the child has that the candidate doesn't: the fork-point distance. */
  ahead: number;
  /** Commits the candidate has that the child doesn't: how far it moved on after. */
  behind: number;
}

/**
 * Which worktree a worktree was most likely cut from, given every other
 * worktree scored against it. Git records nothing, so this reads the graph:
 * the parent is whichever worktree shares the most history, i.e. the NEAREST
 * fork point (fewest `ahead`), because a child inherits its parent's history up
 * to the moment it was created and diverges only after.
 *
 * This is deliberately NOT {@link bestRebaseBase}, which answers a different
 * question. That ranker demotes candidates already contained in HEAD, since
 * rebasing onto one provably replays nothing — but a parent that hasn't
 * committed since the child was cut looks exactly like that, so borrowing it
 * here picks the grandparent and, worse, lets a child outrank its own parent.
 *
 * Ordering, most significant first:
 *   1. drop descendants — a candidate strictly ahead of the child (`ahead: 0`
 *      with commits of its own) sits in the child's future, so it cannot be
 *      where the child came from. Without this a parent picks its own child and
 *      the two point at each other. `ahead: 0, behind: 0` is NOT dropped: that's
 *      a freshly created worktree still sitting on its parent's HEAD;
 *   2. nearest fork point — the whole rule;
 *   3. the main worktree, which is where anything ambiguous belongs;
 *   4. fewest `behind`, then path, so the result is deterministic.
 */
export function pickWorktreeParent(
  candidates: ParentCandidate[],
  mainPath: string
): string | undefined {
  const pool = candidates.filter((c) => !(c.ahead === 0 && c.behind > 0));
  const ranked = [...pool].sort(
    (a, b) =>
      a.ahead - b.ahead ||
      Number(b.path === mainPath) - Number(a.path === mainPath) ||
      a.behind - b.behind ||
      a.path.localeCompare(b.path)
  );
  return ranked[0]?.path;
}

/**
 * The worktrees a window opened at `root` should surface: `root` itself plus
 * every worktree that descends from it, transitively. Git records no link
 * between a worktree and the one it was cut from, so `parent` is supplied by
 * the caller (recorded at creation, else inferred — see scmInfo).
 *
 * A window on the main worktree therefore still sees everything, since every
 * chain terminates there; a window on a linked worktree sees only its own
 * subtree instead of the whole repo's worktree list.
 *
 * Cycles can't arise from a correct parent map, but a corrupt recorded parent
 * could produce one; walking *down* from root with a visited set means a cycle
 * elsewhere in the map costs nothing, and one through root just stops.
 */
export function worktreeSubtree(
  worktrees: { path: string; parent: string }[],
  root: string
): string[] {
  const children = new Map<string, string[]>();
  for (const w of worktrees) {
    if (w.parent && w.parent !== w.path) {
      children.set(w.parent, [...(children.get(w.parent) ?? []), w.path]);
    }
  }
  const seen = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  // Emit in the caller's order, not discovery order, so the pane keeps the
  // declared worktree ordering it already sorts trunk-first.
  return worktrees.filter((w) => seen.has(w.path)).map((w) => w.path);
}

/** Trunk names to look for when git itself can't name the default branch. */
const CONVENTIONAL_TRUNKS = ["main", "master", "develop", "trunk"];

/** Drop a leading `<remote>/` from a branch name, so `origin/main` → `main`. */
export function stripRemote(branch: string, remotes: string[]): string {
  const r = remotes.find((name) => branch.startsWith(name + "/"));
  return r ? branch.slice(r.length + 1) : branch;
}

/**
 * The conventional trunk among `branches` (local or `<remote>/<name>`), used
 * only when `<remote>/HEAD` isn't set and git therefore can't name the default
 * branch itself. Returns the short name ("main"), not the ref.
 */
export function conventionalTrunk(branches: string[], remotes: string[]): string | undefined {
  const present = new Set(branches.map((b) => stripRemote(b, remotes)));
  return CONVENTIONAL_TRUNKS.find((n) => present.has(n));
}

/** One rebase-base candidate, scored against HEAD by `rev-list --left-right`. */
export interface BaseCandidate {
  /** Branch name as `for-each-ref --format=%(refname:short)` prints it. */
  branch: string;
  /** Commits on HEAD the candidate doesn't have — the fork-point distance. */
  ahead: number;
  /** Commits the candidate has that HEAD doesn't — how far it has moved on. */
  behind: number;
}

/**
 * Pick the branch HEAD is based on out of scored candidates. Ordering, most
 * significant first:
 *   1. non-no-op first — `behind: 0` means the candidate is already contained in
 *      HEAD, so rebasing onto it provably replays nothing. Stale branches parked
 *      at HEAD~n look like perfect bases by rule 2 and are useless as targets.
 *      Two carve-outs keep this from firing where it shouldn't: it goes quiet
 *      when *nothing* here has moved (no better target exists, so fork-point
 *      order should decide), and the trunk is exempt, so an unrelated diverged
 *      branch can't outrank a trunk that simply hasn't moved yet;
 *   2. fewest `ahead` — the nearest fork point, so a stacked branch prefers the
 *      branch below it over the trunk;
 *   3. the trunk — candidates forking at the same point can't be told apart by
 *      graph shape (a branch cut *from* HEAD looks exactly like the branch HEAD
 *      was cut from), and the trunk is the answer in nearly every real repo;
 *   4. local over remote — `main` over `origin/main`, same commit either way;
 *   5. fewest `behind`, so a dead heat still resolves deterministically.
 *
 * Without rule 3, a sibling branch cut from HEAD wins on rule 5 whenever HEAD
 * hasn't moved since (`ahead` 0 for every candidate), which preselects a child
 * branch as the base.
 */
export function bestRebaseBase(
  candidates: BaseCandidate[],
  trunk: string | undefined,
  remotes: string[]
): string | undefined {
  const isTrunk = (b: string) => !!trunk && stripRemote(b, remotes) === trunk;
  const isRemote = (b: string) => remotes.some((name) => b.startsWith(name + "/"));
  const anyActionable = candidates.some((c) => c.behind > 0);
  const noop = (c: BaseCandidate) =>
    Number(anyActionable && c.behind === 0 && !isTrunk(c.branch));
  const ranked = [...candidates].sort(
    (a, b) =>
      noop(a) - noop(b) ||
      a.ahead - b.ahead ||
      Number(isTrunk(b.branch)) - Number(isTrunk(a.branch)) ||
      Number(isRemote(a.branch)) - Number(isRemote(b.branch)) ||
      a.behind - b.behind
  );
  return ranked[0]?.branch;
}
