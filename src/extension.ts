import * as vscode from "vscode";
import { registerClaudePanes } from "./claudePanes";
import { toast } from "./notify";
import { openWorktreeClaudeTab } from "./claudeTab";
import { registerClaudePatch } from "./patchClaude";
import {
  branchExists,
  getHostLabel,
  realPath,
  remoteBranchExists,
  resolveRepoRoot,
  validateBranchName,
} from "./git";
import {
  extractJson,
  runWt,
  WtListEntry,
  WtSwitchResult,
} from "./wt";

export function activate(context: vscode.ExtensionContext): void {
  registerClaudePanes(context);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "wt.worktreeMenu",
      (scm?: vscode.SourceControl) => worktreeMenu(scm)
    ),
    vscode.commands.registerCommand("wt.newWorktree", (scm?: vscode.SourceControl) =>
      newWorktree(scm)
    ),
    vscode.commands.registerCommand(
      "wt.removeWorktree",
      (scm?: vscode.SourceControl) => removeWorktree(scm)
    )
  );

  // First-launch nudge + the Settings-driven patch/unpatch action.
  registerClaudePatch(context);
}

export function deactivate(): void {
  /* nothing to clean up */
}

/**
 * Single SCM title-bar entry point (the tree icon, on every git repo row).
 * `scm/title` when-clauses are window-global so we can't vary the button per
 * row — instead we resolve the clicked row's worktree at invocation time:
 *   - main trunk (or unknown): act directly as New Worktree (one option, no menu)
 *   - any other worktree: show a dropdown with Open in <host> / New Worktree /
 *     Remove Worktree
 */
async function worktreeMenu(scm?: vscode.SourceControl): Promise<void> {
  const rootPath = scm?.rootUri?.fsPath;
  if (!rootPath) {
    return newWorktree(scm); // command palette / no row context
  }

  const entry = await findEntry(rootPath);
  if (!entry || entry.is_main) {
    return newWorktree(scm); // main trunk → single action, no dropdown
  }

  interface ActionItem extends vscode.QuickPickItem {
    action: "tab" | "open" | "new" | "remove";
  }
  const pick = await vscode.window.showQuickPick<ActionItem>(
    [
      {
        label: "$(add) New Claude Tab",
        description: entry.branch,
        action: "tab",
      },
      {
        label: `$(window) Open in ${getHostLabel()}`,
        description: entry.branch,
        action: "open",
      },
      { label: "$(git-branch) New Worktree", action: "new" },
      {
        label: "$(trash) Remove Worktree",
        description: entry.branch,
        action: "remove",
      },
    ],
    {
      title: `Worktrunk — ${entry.branch}`,
      placeHolder: "Choose a worktree action",
    }
  );
  if (!pick) {
    return; // dismissed
  }
  switch (pick.action) {
    case "tab":
      return openWorktreeClaudeTab(entry.path);
    case "open":
      return openWorktree(entry.path);
    case "new":
      return newWorktree(scm);
    case "remove":
      return removeWorktree(scm, entry);
  }
}

/** Open a worktree directory in a new editor window (host-aware: Cursor/VSCode). */
async function openWorktree(worktreePath: string): Promise<void> {
  await vscode.commands.executeCommand(
    "vscode.openFolder",
    vscode.Uri.file(worktreePath),
    { forceNewWindow: true }
  );
}

/**
 * New Worktree:
 *  1. wt -C <repoRoot> switch <branch> [-c] --no-cd --format json
 *  2. resolve the new worktree path from the JSON
 *  3. (Full only) wt -C <newPath> step copy-ignored
 *  4. vscode.openFolder(newPath, { forceNewWindow: true })  — host-aware
 */
async function newWorktree(scm?: vscode.SourceControl): Promise<void> {
  const repoRoot = await resolveRepoRoot(scm);
  if (!repoRoot) {
    toast("Worktrunk: no git repository found to base the new worktree on.", "error");
    return;
  }

  const branch = await vscode.window.showInputBox({
    title: "New Worktree",
    prompt: "Branch name for the new worktree",
    placeHolder: "e.g. andrey/feature-x or PRO-1234-thing",
    ignoreFocusOut: true,
    validateInput: validateBranchName,
  });
  if (!branch) {
    return; // cancelled
  }
  const branchName = branch.trim();

  const mode = await vscode.window.showQuickPick(
    [
      {
        label: "Basic",
        description: "Create the worktree and open it",
        detail: "wt switch — fast, nothing copied",
      },
      {
        label: "Full",
        description: "Also copy gitignored files (build caches / deps)",
        detail: "wt switch + wt step copy-ignored — warm start, slower",
      },
    ],
    { title: "New Worktree", placeHolder: "Choose worktree setup" }
  );
  if (!mode) {
    return; // cancelled
  }
  const full = mode.label === "Full";

  interface OpenItem extends vscode.QuickPickItem {
    how: "tab" | "window";
  }
  const openPick = await vscode.window.showQuickPick<OpenItem>(
    [
      {
        label: "$(add) Open Tab",
        detail: "Open a Claude tab in this window, scoped to the new worktree",
        how: "tab",
      },
      {
        label: `$(window) Open in ${getHostLabel()}`,
        detail: `Open the worktree in a new ${getHostLabel()} window`,
        how: "window",
      },
    ],
    { title: "New Worktree", placeHolder: "How should the new worktree open?" }
  );
  if (!openPick) {
    return; // cancelled
  }
  const openHow = openPick.how;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Worktrunk: creating worktree "${branchName}"`,
      cancellable: false,
    },
    async (progress) => {
      try {
        // Create a brand-new branch ONLY when it exists neither locally nor on
        // a remote. If a local branch exists, wt switches to it; if only a
        // remote branch exists, `wt switch` (no -c) creates a local tracking
        // branch from origin/<name>. Passing -c in that case would fork a
        // divergent branch off base with no upstream.
        progress.report({ message: "resolving branch…" });
        const needCreate =
          !(await branchExists(repoRoot, branchName)) &&
          !(await remoteBranchExists(repoRoot, branchName));

        // 1. switch (create the worktree)
        progress.report({ message: "switching…" });
        const switchArgs = [
          "-C",
          repoRoot,
          "switch",
          branchName,
          "--no-cd",
          "--format",
          "json",
        ];
        if (needCreate) {
          switchArgs.splice(4, 0, "-c"); // after the branch name
        }
        const sw = await runWt(switchArgs);
        if (sw.code !== 0) {
          throw new Error(firstLine(sw.stderr || sw.stdout) || `wt switch exited ${sw.code}`);
        }

        // 2. resolve the new path
        const parsed = extractJson<WtSwitchResult>(sw.stdout);
        const newPath = parsed?.path ?? (await resolvePathFromList(repoRoot, branchName));
        if (!newPath) {
          throw new Error("could not resolve the new worktree path");
        }

        // 3. Full → copy gitignored files
        if (full) {
          progress.report({ message: "copying gitignored files…" });
          const copy = await runWt(["-C", newPath, "step", "copy-ignored"]);
          if (copy.code !== 0) {
            // Non-fatal: the worktree exists; warn but still open it.
            toast(
              `Worktrunk: copy-ignored failed (${firstLine(copy.stderr) || "unknown"}). Opening worktree anyway.`,
              "warning"
            );
          }
        }

        // 4. open the new worktree — as a Claude tab in this window, or in a
        //    new host window, per the earlier choice.
        progress.report({ message: "opening…" });
        if (openHow === "tab") {
          await openWorktreeClaudeTab(newPath);
        } else {
          await openWorktree(newPath);
        }
      } catch (err) {
        toast(`Worktrunk: failed to create worktree — ${errMessage(err)}`, "error");
      }
    }
  );
}

/**
 * Remove Worktree: invoked from a repo row in the SCM view. The row's rootUri
 * is the worktree directory. Guards against the primary worktree, confirms,
 * then runs `wt -C <path> remove -y --format json`.
 */
async function removeWorktree(
  scm?: vscode.SourceControl,
  preEntry?: WtListEntry
): Promise<void> {
  const rootPath = scm?.rootUri?.fsPath;
  if (!rootPath) {
    toast("Worktrunk: run Remove Worktree from a worktree row in the Source Control view.");
    return;
  }

  // Look up this worktree in `wt list` to find its branch and guard against main.
  const entry = preEntry ?? (await findEntry(rootPath));

  if (entry?.is_main) {
    toast(`Worktrunk: "${entry.branch}" is the primary worktree and cannot be removed.`);
    return;
  }

  const label = entry?.branch ?? rootPath;
  const confirm = await vscode.window.showWarningMessage(
    `Remove worktree "${label}"?`,
    { modal: true, detail: "This deletes the worktree directory (and its branch). This cannot be undone." },
    "Remove"
  );
  if (confirm !== "Remove") {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Worktrunk: removing worktree "${label}"`,
      cancellable: false,
    },
    async () => {
      try {
        const res = await runWt(["-C", rootPath, "remove", "-y", "--format", "json"]);
        if (res.code !== 0) {
          throw new Error(firstLine(res.stderr || res.stdout) || `wt remove exited ${res.code}`);
        }
        toast(`Worktrunk: removed worktree "${label}".`);
      } catch (err) {
        toast(`Worktrunk: failed to remove worktree — ${errMessage(err)}`, "error");
      }
    }
  );
}

/**
 * Find the `wt list` entry for a worktree directory. Matches by resolved path
 * (handles symlinks), falling back to the entry wt marks as current under
 * `-C <path>`. Returns undefined only if the list call fails entirely.
 */
async function findEntry(rootPath: string): Promise<WtListEntry | undefined> {
  try {
    const listed = await runWt(["-C", rootPath, "list", "--format", "json"]);
    const entries = extractJson<WtListEntry[]>(listed.stdout) ?? [];
    const target = realPath(rootPath);
    return (
      entries.find((e) => realPath(e.path) === target) ??
      entries.find((e) => e.is_current)
    );
  } catch {
    return undefined;
  }
}

/** Fallback path resolution: find the branch in `wt list --format json`. */
async function resolvePathFromList(
  repoRoot: string,
  branch: string
): Promise<string | undefined> {
  try {
    const listed = await runWt(["-C", repoRoot, "list", "--format", "json"]);
    const entries = extractJson<WtListEntry[]>(listed.stdout) ?? [];
    return entries.find((e) => e.branch === branch)?.path;
  } catch {
    return undefined;
  }
}

function firstLine(s: string): string {
  return (s || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[0] ?? "";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
