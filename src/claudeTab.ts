import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { realPath, registerRepoWithGit } from "./git";
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

/**
 * Pre-create Claude's per-project session directory for a cwd.
 *
 * Renaming a Claude tab appends a custom-title line to
 * `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`; appendFile creates the
 * file but NOT the directory, and Claude only creates the directory when the
 * first query writes the session. So on a brand-new worktree, renaming a tab
 * before the first message fails silently (ENOENT). Creating the directory up
 * front makes rename work immediately.
 *
 * Mirrors Claude's slug rules (verified against bundle 2.1.204): cwd is
 * realpath'd + NFC-normalized, then non-alphanumerics become "-". Slugs over
 * 200 chars get a hash suffix we can't reproduce — skip those (rename just
 * stays as slow as today). Base dir honors CLAUDE_CONFIG_DIR like Claude does.
 */
function ensureClaudeProjectDir(cwd: string): void {
  try {
    const slug = realPath(cwd)
      .normalize("NFC")
      .replace(/[^a-zA-Z0-9]/g, "-");
    if (slug.length > 200) {
      return;
    }
    const base =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    fs.mkdirSync(path.join(base, "projects", slug), { recursive: true });
  } catch {
    // Best-effort: without it, rename simply keeps requiring a first message.
  }
}
const CLAUDE_OPEN_COMMAND = "claude-vscode.editor.open";
// Added by patch-claude.sh: opens a tab whose cwd is the given worktree.
const CLAUDE_OPEN_WORKTREE_COMMAND = "claude-vscode.editor.openWorktree";

/**
 * Open a Claude Code tab in the current window scoped to the given worktree.
 *
 * When `prompt` is given and the Claude bundle carries the prompt-injection
 * patch (see patchClaude.ts), the prompt is stashed on the shared extension-host
 * global; the patched bundle picks it up as the new session's controller is
 * created and submits it automatically. On an unpatched bundle the stash is
 * inert (nothing consumes it), so callers should keep their own fallback.
 *
 * When `resumeSessionId` is given (a persistent Claude session uuid), the tab
 * RESUMES that session with its full history instead of starting fresh — the
 * id is forwarded to Claude's own reopen-with-history path. A session that is
 * already open in some tab is revealed rather than duplicated.
 */
export async function openWorktreeClaudeTab(
  worktreePath: string,
  prompt?: string,
  resumeSessionId?: string
): Promise<void> {
  // The worktree folder never joins the workspace in tab mode, so nudge the git
  // extension now — otherwise the SCM view only lists it after a background
  // scan (30–60s). Fire-and-forget; the tab doesn't depend on it.
  void registerRepoWithGit(worktreePath);

  // Make tab rename work before the first message (see helper docstring).
  ensureClaudeProjectDir(worktreePath);

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
    // Stash the pending prompt for the patched bundle to submit into the new
    // session (see openWorktreeClaudeTab docstring). Set it right before opening
    // so the controller created by the command consumes it.
    const g = globalThis as unknown as {
      __wtClaude?: { pendingPrompt?: string | null };
    };
    g.__wtClaude = g.__wtClaude || {};
    g.__wtClaude.pendingPrompt = prompt && prompt.trim() ? prompt : null;

    // Patched bundle: opens a tab pinned to the worktree cwd, resuming the
    // given session (with history) when one is passed.
    await vscode.commands.executeCommand(
      CLAUDE_OPEN_WORKTREE_COMMAND,
      worktreePath,
      resumeSessionId
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
