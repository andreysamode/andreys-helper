import * as vscode from "vscode";
import { toast } from "./notify";

/**
 * Open a Claude Code session as an editor tab whose working directory is a
 * specific git worktree — in the current window, without adding the worktree to
 * the workspace.
 *
 * This relies on a small patch to the Claude Code extension (see
 * patch-claude.sh) that teaches one of its commands a new, optional argument:
 *   - claude-vscode.editor.openWorktree(cwd)
 *       opens a tab whose session cwd is `cwd` instead of the first workspace
 *       folder.
 *
 * On an UNPATCHED Claude build the command is absent: we fall back to the stock
 * open command (tab opens in the main workspace cwd) and say why it's degraded.
 */

const CLAUDE_EXTENSION_ID = "anthropic.claude-code";
const CLAUDE_OPEN_COMMAND = "claude-vscode.editor.open";
// Added by patch-claude.sh: opens a tab whose cwd is the given worktree.
const CLAUDE_OPEN_WORKTREE_COMMAND = "claude-vscode.editor.openWorktree";

/**
 * Open a Claude Code tab in the current window scoped to the given worktree.
 */
export async function openWorktreeClaudeTab(worktreePath: string): Promise<void> {
  const ext = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
  if (!ext) {
    toast("Worktrunk: Claude Code extension is not installed.", "warning");
    return;
  }
  if (!ext.isActive) {
    await ext.activate();
  }

  const all = await vscode.commands.getCommands(true);

  if (all.includes(CLAUDE_OPEN_WORKTREE_COMMAND)) {
    // Patched bundle: opens a tab pinned to the worktree cwd.
    await vscode.commands.executeCommand(
      CLAUDE_OPEN_WORKTREE_COMMAND,
      worktreePath
    );
  } else if (all.includes(CLAUDE_OPEN_COMMAND)) {
    // Unpatched bundle: fall back to a normal tab (main workspace cwd) so the
    // action still does something, and say why it's degraded.
    await vscode.commands.executeCommand(CLAUDE_OPEN_COMMAND);
    toast(
      "Worktrunk: Claude Code isn't patched (run patch-claude.sh), so the tab opened in the main folder instead of the worktree.",
      "warning"
    );
  } else {
    toast(
      `Worktrunk: Claude Code command "${CLAUDE_OPEN_COMMAND}" not found — the extension's API may have changed.`,
      "error"
    );
  }
}
