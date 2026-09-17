/**
 * Is a worktree safe to remove without asking?
 *
 * No `vscode` import and no I/O — the git calls live in extension.ts and hand their
 * stdout here — so the rules are unit-testable (worktreeSafety.test.ts).
 *
 * `wt remove` deletes the worktree directory AND its branch, and nothing about that
 * is recoverable. The pane used to guard it with a modal confirmation on every
 * removal, which is the wrong shape twice over: it asks about the clean, boring case
 * (where there is nothing to lose and the click already said what the user wanted),
 * and a dialog is weak protection for the case that matters, where saying "Remove"
 * once destroys work. So the confirmation is replaced by a decision:
 *
 *   nothing to lose  → remove it, no dialog
 *   work would be lost → refuse, and say exactly what is in the way
 *
 * Two things count as work that would be lost. Uncommitted changes are the obvious
 * one. The other is commits that exist nowhere else: the branch is going away with
 * the directory, so a commit no other ref can reach is as gone as an unsaved file.
 * A branch whose commits are pushed, or merged into another branch, is not holding
 * anything and removes silently — which is the normal "PR merged, clean this up" case.
 */

/** What a worktree is still holding on to. Empty in both fields ⇒ safe to remove. */
export interface WorktreeHoldings {
  /** Paths with uncommitted changes: staged, unstaged or untracked. */
  changed: string[];
  /** One-line subjects of commits reachable from no other ref. */
  strandedCommits: string[];
}

/** How many names/subjects a refusal message spells out before it counts the rest. */
const NAMED = 3;

/**
 * Paths from `git status --porcelain` output.
 *
 * The status letters are fixed-width (XY, then a space), so the path is everything
 * from column 3 on. A rename arrives as `R  old -> new`; the new path is the one that
 * exists, so that is the one reported. Quoted paths (non-ASCII, spaces with
 * core.quotePath on) are handed through as git printed them — this is a message, and
 * the count is what the decision rests on.
 */
export function parseChangedPaths(porcelain: string): string[] {
  const out: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) {
      continue;
    }
    const rest = line.slice(3).trim();
    if (!rest) {
      continue;
    }
    const arrow = rest.lastIndexOf(" -> ");
    out.push(arrow === -1 ? rest : rest.slice(arrow + 4));
  }
  return out;
}

/** Subjects from `git log --format=%s` output (one per line, blanks dropped). */
export function parseCommitSubjects(log: string): string[] {
  return log
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * The reason this worktree must not be removed, or undefined when it is safe.
 *
 * The message is the whole user-facing explanation, so it names what is in the way
 * rather than saying "it has changes" — the point of refusing instead of prompting is
 * that the user learns what they would have destroyed.
 */
export function removalBlocker(
  label: string,
  holdings: WorktreeHoldings
): string | undefined {
  const parts: string[] = [];
  if (holdings.changed.length) {
    parts.push(`${count(holdings.changed.length, "uncommitted change")} (${list(holdings.changed)})`);
  }
  if (holdings.strandedCommits.length) {
    const n = holdings.strandedCommits.length;
    parts.push(
      `${count(n, "commit")} that ${n === 1 ? "exists" : "exist"} nowhere else ` +
        `(${list(holdings.strandedCommits)})`
    );
  }
  if (!parts.length) {
    return undefined;
  }
  return `Kept worktree "${label}": it has ${parts.join(" and ")}. Removing it would delete that for good.`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Up to {@link NAMED} items, then how many more there are. */
function list(items: string[]): string {
  const shown = items.slice(0, NAMED).join(", ");
  const rest = items.length - NAMED;
  return rest > 0 ? `${shown}, +${rest} more` : shown;
}
