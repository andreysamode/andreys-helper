import * as vscode from "vscode";

type ToastKind = "info" | "warning" | "error";

// A single shared output channel where full error detail is logged, so an
// otherwise-transient toast always leaves a durable, copyable trail the user
// can open from the "Show Details" button.
let output: vscode.OutputChannel | undefined;
function channel(): vscode.OutputChannel {
  if (!output) {
    output = vscode.window.createOutputChannel("Andrey's Helper");
  }
  return output;
}

/**
 * Flatten whatever an operation threw into a descriptive, multi-line blob of
 * debug info. The VS Code Git extension API rejects with a `GitError` whose
 * `.message` is usually a stock one-liner ("Failed to execute git") — the
 * actionable part (auth failure, rejected push, hook output) lives in
 * `.stderr`/`.stdout`, and the classification in `.gitErrorCode`/`.exitCode`.
 * Plain `err.message` throws all of that away, which is why a GitHub sync
 * failure shows up as a generic, useless toast. Pull every field we can find.
 */
export function formatGitError(err: unknown): string {
  if (err == null) {
    return "Unknown error (no detail provided).";
  }
  const e = err as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

  const stderr = str(e.stderr);
  const stdout = str(e.stdout);
  const message = str(e.message);

  const parts: string[] = [];
  // stderr is the richest signal; fall back to the message only if it adds info.
  if (stderr) {
    parts.push(stderr);
  }
  if (message && message !== stderr && !stderr.includes(message)) {
    parts.push(message);
  }
  if (stdout && stdout !== stderr) {
    parts.push(stdout);
  }

  const meta: string[] = [];
  if (e.gitErrorCode) {
    meta.push(`gitErrorCode: ${String(e.gitErrorCode)}`);
  }
  if (typeof e.exitCode === "number") {
    meta.push(`exit: ${e.exitCode}`);
  }
  if (Array.isArray(e.gitArgs) && e.gitArgs.length) {
    meta.push(`git ${(e.gitArgs as unknown[]).join(" ")}`);
  } else if (e.gitCommand) {
    meta.push(`git ${String(e.gitCommand)}`);
  }
  if (meta.length) {
    parts.push(meta.join("  ·  "));
  }

  const out = parts.filter(Boolean).join("\n\n");
  return out || String(err);
}

/**
 * Format a raw `runGit`/`runGh` result (from git.ts) into descriptive detail.
 * When we shell out directly rather than through the Git extension API, the
 * failure signal is the process's `stderr`/`stdout` plus its exit code — not a
 * `GitError` object — so `formatGitError` can't see it. Without this, a failed
 * `git add`/`reset`/`checkout` collapses to a bare "stage failed" toast with no
 * clue as to why (e.g. "fatal: pathspec … did not match", a lock file, a
 * pre-commit hook rejection). Surface the command, its output, and exit code.
 */
export function formatGitResult(
  res: { code: number; stdout: string; stderr: string },
  args?: string[]
): string {
  const stderr = res.stderr?.trim() ?? "";
  const stdout = res.stdout?.trim() ?? "";
  const parts: string[] = [];
  if (stderr) {
    parts.push(stderr);
  }
  if (stdout && stdout !== stderr) {
    parts.push(stdout);
  }
  const meta: string[] = [];
  if (args?.length) {
    meta.push(`git ${args.join(" ")}`);
  }
  // spawnCapture resolves code -1 for a timeout or spawn failure, where there is
  // usually no stderr — say so explicitly rather than showing a bare "exit: -1".
  meta.push(res.code === -1 ? "exit: timed out or could not run git" : `exit: ${res.code}`);
  parts.push(meta.join("  ·  "));
  return parts.filter(Boolean).join("\n\n");
}

// VS Code auto-hides info/warning toasts but keeps error toasts (and any toast
// with buttons) on screen until dismissed. To make every status message behave
// like a transient toast, we render it as a self-closing progress notification.
//
// For errors, an optional `detail` string carries descriptive debug info: it is
// logged to the output channel and offered behind a "Show Details" button, and
// (because the notification collapses multi-line messages behind an expand
// chevron) folded into the message itself so it can be expanded inline.
export function toast(message: string, kind: ToastKind = "info", ms = 2000, detail?: string): void {
  // Errors persist until dismissed — they usually need action, and the native
  // error notification carries its own icon/severity styling.
  if (kind === "error") {
    const trimmed = detail?.trim();
    if (trimmed) {
      const chan = channel();
      chan.appendLine(`[${new Date().toISOString()}] ${message}`);
      chan.appendLine(trimmed);
      chan.appendLine("");
      // Multi-line message → the notification shows an expand chevron so the
      // detail is available inline; the button is the reliable fallback.
      void vscode.window
        .showErrorMessage(`${message}\n\n${trimmed}`, "Show Details")
        .then((choice) => {
          if (choice === "Show Details") {
            chan.show(true);
          }
        });
      return;
    }
    void vscode.window.showErrorMessage(message);
    return;
  }
  // Info/warning stay transient. A ProgressLocation.Notification title is a
  // plain label — it does NOT parse `$(codicon)` syntax (that only renders in
  // showInformationMessage & friends), so use a plain glyph, not "$(warning)".
  const icon = kind === "warning" ? "⚠ " : "";
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: icon + message },
    () => new Promise<void>((resolve) => setTimeout(resolve, ms))
  );
}
