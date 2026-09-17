import { WorkflowRun } from "./workflowProgress";

/**
 * Turning live Claude panels into the pane's session rows (grouping, and which one
 * reads as open).
 *
 * No `vscode` import and no I/O, so this is unit-testable under `node --test`
 * (claudeRows.test.ts) — including the collision that made it its own module.
 *
 * ONE LIST, ONE IDENTITY. The pane used to enumerate `vscode.window.tabGroups` for
 * existence and pair each editor tab to a Claude controller by (column, exact title)
 * to pick up its id, cwd and status. Titles are not identities: three tabs named
 * "Review pull request with…", two of them in the same editor group, made that
 * pairing a coin flip — a row could be filed under one worktree while wearing another
 * panel's id, so clicking it revealed the other session and the highlight sat on the
 * wrong box. No tie-breaker can fix that, because nothing in an editor tab tells one
 * same-named panel from another; the fix is to never pair the two lists. Rows are
 * built from the panel list itself, which is the list that supplies the id, so a row
 * cannot be about one panel and act on another.
 */

/** A live Claude panel, as `ClaudeStatusService.tabs()` reports it. */
export interface ClaudePanel {
  /** Stable per-panel id — what focus/rename are addressed by. */
  id: string;
  /** Realpath-normalized cwd of the session in this panel. */
  cwd?: string;
  title: string;
  status: string;
  /** Editor group the panel sits in. */
  col?: number;
  /** Whether the panel is FOCUSED. */
  active?: boolean;
  /** Whether the panel is the selected tab of its group. */
  visible?: boolean;
  wf?: WorkflowRun;
}

/** One session box in the pane. */
export interface ClaudeTabModel {
  /** The panel's stable id — the key for focus/rename. */
  sessionId: string;
  /** Current tab title (the editor tab's label). */
  title: string;
  /** "working" | "question" | "plan" | "permission" | "done" | "idle" | other. */
  status: string;
  /** True for the session the user currently has open (gets the highlight). */
  active?: boolean;
  /**
   * The dynamic workflow this tab is running, or most recently ran — the source
   * for the row's chevron, phase strip and accordion (WORKFLOW-PROGRESS.md §3.4).
   * OMITTED, not nulled, on the overwhelming majority of rows: a tab that isn't
   * running a workflow must cost this payload nothing and render exactly as it
   * does today. Absent as well whenever Claude is unpatched, per §2's
   * "degrade to nothing".
   */
  wf?: WorkflowRun;
}

/**
 * The worktree a panel belongs to: the longest root that contains its cwd, so a
 * worktree nested inside another repo's checkout wins over the outer one.
 */
export function ownerRoot(cwd: string, roots: string[], sep: string): string | undefined {
  return roots
    .filter((rt) => cwd === rt || cwd.startsWith(rt + sep))
    .sort((a, b) => b.length - a.length)[0];
}

/**
 * Whether this panel is the one the user has open: the selected tab of the group they
 * are in. `visible` alone would highlight one row per split, and `active` (focused)
 * alone would unhighlight everything the moment they click the pane itself — so it
 * takes both halves, the panel's own visibility and the group being the active one.
 *
 * A bundle patched before wtpatch-v28 doesn't report `visible`; there, `active` is
 * the honest answer available, and the highlight simply follows focus.
 */
export function isOpenPanel(panel: ClaudePanel, activeCol: number | undefined): boolean {
  if (panel.visible === undefined) {
    return panel.active === true;
  }
  return panel.visible && panel.col !== undefined && panel.col === activeCol;
}

/**
 * Group live panels into rows per worktree root. Panels with no cwd, or a cwd under
 * none of the roots, are dropped — there is no box to put them in.
 *
 * Order within a root follows the panel list (Claude's `allComms`, i.e. creation
 * order); the pane applies the user's own ordering on top.
 */
export function claudeRowsByRoot(
  panels: ClaudePanel[],
  roots: string[],
  activeCol: number | undefined,
  sep: string
): Map<string, ClaudeTabModel[]> {
  const out = new Map<string, ClaudeTabModel[]>();
  for (const panel of panels) {
    if (!panel.cwd) {
      continue;
    }
    const owner = ownerRoot(panel.cwd, roots, sep);
    if (!owner) {
      continue;
    }
    const row: ClaudeTabModel = {
      sessionId: panel.id,
      title: panel.title,
      status: panel.status,
      active: isOpenPanel(panel, activeCol),
    };
    // Carried through verbatim — ClaudeStatusService has already parsed and memoized
    // it, so this is a reference copy, and the key stays off rows without a workflow.
    if (panel.wf) {
      row.wf = panel.wf;
    }
    const list = out.get(owner);
    if (list) {
      list.push(row);
    } else {
      out.set(owner, [row]);
    }
  }
  return out;
}
