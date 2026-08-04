import * as fs from "fs";
import * as path from "path";

/**
 * Detect whether a worktree is sitting in an interrupted rebase, and read the
 * few facts needed to describe it.
 *
 * Deliberately synchronous and git-process-free: buildModel() runs on every
 * state push, so this has to be cheap enough to call per repo per render. Git
 * keeps the whole rebase state in a directory next to the index, so the check
 * is one existsSync in the common (no rebase) case.
 */

export interface RebaseState {
  /**
   * Which backend is mid-flight. "merge" is `rebase-merge` — the interactive /
   * merge backend that has been the default since git 2.26, and what a plain
   * `git rebase` uses. "apply" is the older `rebase-apply` (am) backend, still
   * reachable via `--apply` and by `git am`. They store the same facts under
   * different filenames, which is the only reason the distinction is kept.
   */
  kind: "merge" | "apply";
  /** Branch being rebased, short (e.g. "andrey/foo"); "" if unreadable. */
  branch: string;
  /**
   * Commit the branch is being replayed onto. Always a sha: git resolves the
   * ref the user typed and stores the object, so recovering a human-readable
   * name needs `git name-rev` (or our own memory of what was picked).
   */
  ontoSha: string;
  /** Where the branch pointed before the rebase — what `--abort` restores. */
  origHead: string;
  /** 1-based position in the todo list, and its length, for a "3/7" readout. */
  step: number;
  total: number;
}

/**
 * A worktree's own git dir. For the main checkout that's `<root>/.git`; for a
 * linked worktree `.git` is a *file* pointing at
 * `<main>/.git/worktrees/<name>`, and the rebase state lives there — not in the
 * shared main git dir. Getting this wrong would report the trunk's rebase on
 * every worktree, so the file indirection is followed explicitly.
 *
 * Cached per root: a worktree's git dir never moves for the life of the window,
 * and this is on the render path.
 */
const gitDirCache = new Map<string, string>();

function gitDirOf(root: string): string | undefined {
  const cached = gitDirCache.get(root);
  if (cached !== undefined) {
    return cached;
  }
  const dotGit = path.join(root, ".git");
  let resolved: string | undefined;
  try {
    if (fs.statSync(dotGit).isDirectory()) {
      resolved = dotGit;
    } else {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
      const p = m?.[1]?.trim();
      resolved = p ? (path.isAbsolute(p) ? p : path.resolve(root, p)) : undefined;
    }
  } catch {
    resolved = undefined; // not a repo, or unreadable — no rebase to report
  }
  if (resolved !== undefined) {
    gitDirCache.set(root, resolved);
  }
  return resolved;
}

/** The rebase in progress in `root`, or undefined when there isn't one. */
export function readRebaseState(root: string): RebaseState | undefined {
  const gitDir = gitDirOf(root);
  if (!gitDir) {
    return undefined;
  }
  const backends = [
    { kind: "merge", dir: "rebase-merge" },
    { kind: "apply", dir: "rebase-apply" },
  ] as const;
  for (const backend of backends) {
    const dir = path.join(gitDir, backend.dir);
    if (!fs.existsSync(dir)) {
      continue;
    }
    const read = (name: string): string => {
      try {
        return fs.readFileSync(path.join(dir, name), "utf8").trim();
      } catch {
        return "";
      }
    };
    // The two backends name the progress counters differently: rebase-merge
    // uses msgnum/end, rebase-apply uses next/last. Read both, take whichever
    // parsed, and fall back to 1/1 so the readout is never "0/0".
    const num = (...names: string[]): number => {
      for (const name of names) {
        const n = Number(read(name));
        if (Number.isFinite(n) && n > 0) {
          return n;
        }
      }
      return 1;
    };
    return {
      kind: backend.kind,
      branch: read("head-name").replace(/^refs\/heads\//, ""),
      ontoSha: read("onto"),
      origHead: read("orig-head") || read("abort-safety"),
      step: num("msgnum", "next"),
      total: num("end", "last"),
    };
  }
  return undefined;
}
