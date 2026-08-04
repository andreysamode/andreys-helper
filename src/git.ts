import { spawn } from "child_process";
import * as fs from "fs";
import * as vscode from "vscode";

/**
 * Thin helpers over the built-in `vscode.git` extension API plus a couple of
 * direct git calls for facts the API doesn't expose cleanly (branch existence).
 */

const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

function augmentedPath(): string {
  const current = (process.env.PATH || "").split(":");
  const seen = new Set<string>();
  return [...EXTRA_PATH, ...current]
    .filter((p) => p && !seen.has(p) && (seen.add(p), true))
    .join(":");
}

/** Get the built-in Git extension's API (v1), activating it if needed. */
export async function getGitApi(): Promise<any | undefined> {
  const ext = vscode.extensions.getExtension("vscode.git");
  if (!ext) {
    return undefined;
  }
  if (!ext.isActive) {
    await ext.activate();
  }
  return ext.exports?.getAPI?.(1);
}

/**
 * Register a directory with the built-in git extension right away, so it shows
 * in the Source Control view immediately instead of waiting (30–60s) for the
 * git extension's background scan to discover it. Used after opening a
 * worktree as a tab, where the folder never joins the workspace and would
 * otherwise only appear on the next scan. Best-effort: failures are ignored.
 */
export async function registerRepoWithGit(path: string): Promise<void> {
  try {
    const api = await getGitApi();
    await api?.openRepository?.(vscode.Uri.file(path));
  } catch {
    // Non-fatal: the git extension will still discover it eventually.
  }
}

/**
 * Best-effort repo root: the SourceControl row's rootUri when invoked from
 * scm/title, else the first known git repository, else the first workspace
 * folder. Returns the fsPath or undefined.
 */
export async function resolveRepoRoot(
  scm?: vscode.SourceControl
): Promise<string | undefined> {
  if (scm?.rootUri) {
    return scm.rootUri.fsPath;
  }
  const api = await getGitApi();
  const repos: any[] = api?.repositories ?? [];
  if (repos.length > 0) {
    return repos[0].rootUri.fsPath;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Does a local branch already exist? Drives whether `wt switch` needs `-c`.
 * Uses `git show-ref --verify --quiet refs/heads/<branch>` (exit 0 = exists).
 */
export async function branchExists(
  repoRoot: string,
  branch: string
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(
      "git",
      ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { env: { ...process.env, PATH: augmentedPath() }, stdio: "ignore" }
    );
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** Spawn a command capturing stdout/stderr. Never rejects; resolves {code:-1}
 *  on spawn error or timeout so callers can degrade gracefully. */
function spawnCapture(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      // GIT_OPTIONAL_LOCKS=0 stops background reads (git status refreshing the
      // index) from taking index.lock — the same guard VS Code's git extension
      // uses. Without it, a slow/killed status can orphan a lock that then
      // blocks every commit (ours and the native SCM's). Harmless for non-git.
      // GH_NO_UPDATE_NOTIFIER / GH_PROMPT_DISABLED trim gh's per-call startup
      // latency and guarantee it never blocks on an interactive prompt (stdin is
      // ignored) — harmless for git.
      env: {
        ...process.env,
        PATH: augmentedPath(),
        GIT_OPTIONAL_LOCKS: "0",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_PROMPT_DISABLED: "1",
        // Last, so a caller can override any of the above — notably GIT_EDITOR,
        // which git prefers over core.editor, so `-c core.editor=…` alone can't
        // neutralize an interactive editor if one is set in the environment.
        ...opts.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (code: number) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill();
      done(-1);
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => done(-1));
    child.on("close", (code) => done(code ?? 0));
  });
}

/** Run a git command under repoRoot, capturing stdout. `env` merges over the
 *  defaults, for the rare command that needs to neutralize the user's git
 *  environment (see NON_INTERACTIVE_GIT). */
export function runGit(
  repoRoot: string,
  args: string[],
  timeoutMs = 8000,
  env?: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  return spawnCapture("git", ["-C", repoRoot, ...args], { timeoutMs, env });
}

/**
 * Environment for a git command that must never stop to ask a human anything.
 *
 * The hazard is a configured editor that blocks: `code --wait` / `cursor --wait`
 * are the usual `core.editor` values here, and a git step that wants a commit
 * message (a rebase `reword` or `squash`, `--continue` on one of those, a merge
 * commit) will sit on it forever. We spawn with stdin ignored and no terminal,
 * so there is no way for the user to answer and no way for us to notice — the
 * command just burns its whole timeout. `true` exits 0 immediately, which git
 * reads as "the message is fine as-is".
 *
 * All three names are needed: GIT_EDITOR wins over core.editor, and
 * GIT_SEQUENCE_EDITOR is a separate hook for the rebase todo list.
 * GIT_TERMINAL_PROMPT=0 covers credential prompts on the same principle.
 */
export const NON_INTERACTIVE_GIT: NodeJS.ProcessEnv = {
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_TERMINAL_PROMPT: "0",
};

/** Run a `gh` (GitHub CLI) command in repoRoot. Resolves {code:-1} when gh is
 *  missing/unauthenticated/offline, so PR lookups degrade to "no link". */
export function runGh(
  repoRoot: string,
  args: string[],
  timeoutMs = 8000
): Promise<{ code: number; stdout: string; stderr: string }> {
  return spawnCapture("gh", args, { cwd: repoRoot, timeoutMs });
}

/**
 * Does the branch exist on any remote? A user pasting the name of an existing
 * remote branch must NOT trigger `wt switch -c`, which would fork a divergent
 * local branch off base with no upstream (see the "Publish Branch" symptom).
 * Without -c, `wt switch <name>` creates a proper local tracking branch from
 * `origin/<name>` instead.
 *
 * Authoritative check via `git ls-remote` (network), so it works even when the
 * remote branch has never been fetched locally. Falls back to local
 * remote-tracking refs on network failure/timeout so we still avoid the
 * divergent-branch trap in the common (already-fetched) case while offline.
 */
export async function remoteBranchExists(
  repoRoot: string,
  branch: string
): Promise<boolean> {
  const remotesRes = await runGit(repoRoot, ["remote"]);
  const remotes = remotesRes.stdout
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
  if (remotes.length === 0) {
    return false;
  }
  // Query origin first (the usual case), then any other remotes.
  const ordered = [
    ...remotes.filter((r) => r === "origin"),
    ...remotes.filter((r) => r !== "origin"),
  ];
  for (const remote of ordered) {
    const res = await runGit(repoRoot, [
      "ls-remote",
      "--heads",
      remote,
      `refs/heads/${branch}`,
    ]);
    if (res.code === 0) {
      if (res.stdout.trim().length > 0) {
        return true;
      }
      continue; // reached the remote, branch absent — check the next one
    }
    // code === -1: network unavailable/timeout — fall back to the cached
    // remote-tracking ref for this remote.
    const cached = await runGit(repoRoot, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/${remote}/${branch}`,
    ]);
    if (cached.code === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Validate a branch name against git's ref-format rules (`git check-ref-format`).
 * Returns an error string for the input box, or undefined when the name is valid.
 * Mirrors the rules that would otherwise cause `wt switch` to fail at the git level.
 */
export function validateBranchName(raw: string): string | undefined {
  const name = raw.trim();
  if (name.length === 0) {
    return "Branch name is required";
  }
  if (/\s/.test(name)) {
    return "Branch names cannot contain spaces or whitespace";
  }
  // Control characters (0x00–0x1F) and DEL (0x7F).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) {
    return "Branch names cannot contain control characters";
  }
  const badChar = name.match(/[~^:?*[\\]/);
  if (badChar) {
    return `Branch names cannot contain "${badChar[0]}"`;
  }
  if (name.includes("..")) {
    return 'Branch names cannot contain ".."';
  }
  if (name.includes("@{")) {
    return 'Branch names cannot contain "@{"';
  }
  if (name === "@") {
    return 'Branch name cannot be "@"';
  }
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) {
    return "Branch names cannot start or end with, or contain consecutive, slashes";
  }
  if (name.startsWith(".") || name.endsWith(".") || name.includes("/.")) {
    return 'Branch names cannot begin or end a path segment with "."';
  }
  if (name.endsWith(".lock")) {
    return 'Branch names cannot end with ".lock"';
  }
  return undefined;
}

/** Resolve symlinks so two paths can be compared structurally. */
export function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Detect the host editor binary (Cursor vs VSCode). Provided for completeness;
 *  the folder-open path uses the host-aware vscode.openFolder API instead. */
export function getEditorBinary(): "cursor" | "code" {
  const scheme = vscode.env.uriScheme?.toLowerCase() ?? "";
  if (scheme.includes("cursor")) {
    return "cursor";
  }
  const appName = vscode.env.appName?.toLowerCase() ?? "";
  return appName.includes("cursor") ? "cursor" : "code";
}

/** Friendly host name for UI labels — "Cursor" or "VS Code". */
export function getHostLabel(): string {
  return getEditorBinary() === "cursor" ? "Cursor" : "VS Code";
}
