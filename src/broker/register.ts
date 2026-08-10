import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ClaudeStatusService } from "../claudeStatus";
import { ScmInfoService } from "../scmInfo";
import { openWorktreeClaudeTab } from "../claudeTab";
import {
  branchExists,
  getHostLabel,
  realPath,
  remoteBranchExists,
} from "../git";
import { RepoNameStore } from "../repoNames";
import { worktreeSubtree } from "../scmParse";
import { extractJson, runWt } from "../wt";
import { BrokerClient, BrokerConnection, SnapshotPayload } from "./client";
import { CommandDeps, createCommandDispatcher } from "./commands";
import { Host, RepoRef, SessionInfo, SessionStatus, WorktreeRef } from "./protocol";

/**
 * Wires the pure {@link BrokerClient} + command dispatcher (Workstream W1) to the
 * live editor: reads the broker config/token, builds `hello`/`snapshot` from
 * `ScmInfoService` + `ClaudeStatusService`, and maps commands to the existing
 * primitives. This is the only broker file that touches `vscode`, so the client
 * and dispatcher stay unit-testable without an editor host.
 *
 * Editor-safety (PLAN.md §9.4): every path here is guarded so a missing broker,
 * missing config, or a primitive throwing is a silent no-op — the broker being
 * down never disrupts the editor. The whole registration is wrapped in a
 * try/catch and the client only ever retries in the background.
 */

const CONFIG_DIR = path.join(os.homedir(), ".andreys-helper");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const TOKEN_PATH = path.join(CONFIG_DIR, "token");

/** Read broker port + token, or null when config/token isn't present yet. */
function readConnection(): BrokerConnection | null {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw) as { port?: unknown };
    const token = fs.readFileSync(TOKEN_PATH, "utf8").trim();
    if (typeof cfg.port !== "number" || !token) {
      return null;
    }
    return { port: cfg.port, token };
  } catch {
    // No config/token yet, or unreadable → treat as "broker offline".
    return null;
  }
}

/** This editor host, for the `hello` message (PLAN.md §6.2). */
function detectHost(): Host {
  return getHostLabel() === "Cursor" ? "cursor" : "vscode";
}

/** Coerce a live Claude status to the protocol enum (unknown → idle, §6.2). */
function coerceStatus(status: string): SessionStatus {
  switch (status) {
    case "working":
    case "question":
    case "plan":
    case "permission":
    case "done":
    case "idle":
      return status;
    default:
      return "idle";
  }
}

/**
 * Register the broker client for this window (PLAN.md §8 W1). Idempotent-safe to
 * call once from `activate()`; never throws.
 */
export function registerBrokerClient(
  context: vscode.ExtensionContext,
  scmInfo: ScmInfoService,
  claudeStatus: ClaudeStatusService,
  repoNames: RepoNameStore
): void {
  try {
    // The window's trunk path (repo root), from the latest SCM snapshot, falling
    // back to the first workspace folder before the first snapshot is computed.
    const trunkPath = (): string => {
      const t = scmInfo.getSnapshot().trunkPath;
      if (t) {
        return t;
      }
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      return folder ? realPath(folder) : "";
    };

    const getRepo = (): RepoRef => {
      const trunk = trunkPath();
      return { name: trunk ? path.basename(trunk) : "", trunkPath: trunk };
    };

    const buildSnapshot = (): SnapshotPayload => {
      const snap = scmInfo.getSnapshot();
      // Scope this window to its own worktree subtree. `git worktree list` is
      // flat and repo-wide, so without this a window opened ON a worktree
      // publishes every sibling worktree of the repo and the orchestrator draws
      // the whole repo under that one worktree's heading. A window on the main
      // worktree is unaffected: every chain terminates there, so it still sees
      // everything. The pane's own snapshot stays complete — it keys per-row
      // ahead/behind off it for whatever repos the editor has registered.
      const subtree = worktreeSubtree(snap.worktrees, trunkPath() || snap.trunkPath);
      // Empty means the root isn't in the list yet (a snapshot can land before
      // git has listed the window's own worktree) — publish everything rather
      // than an empty group.
      const visible = new Set(subtree.length > 0 ? subtree : snap.worktrees.map((w) => w.path));
      const worktrees: WorktreeRef[] = snap.worktrees
        .filter((w) => visible.has(w.path))
        .map((w) => {
          const displayName = repoNames.get(w.path);
          return {
            path: w.path,
            name: w.name,
            branch: w.branch,
            ahead: w.ahead,
            behind: w.behind,
            isTrunk: w.isTrunk,
            // Spread so an unrenamed worktree contributes no key at all.
            ...(displayName ? { displayName } : {}),
          };
        });
      const sessions: SessionInfo[] = claudeStatus.tabs().map((t) => ({
        tabId: t.id,
        sessionId: t.sessionId ?? null,
        cwd: t.cwd,
        title: t.title,
        status: coerceStatus(t.status),
        // getTabs() clears the completion latch on reveal, so a tab still reporting
        // "done" is by construction unseen; once seen it reports "idle".
        seen: false,
        col: t.col ?? 1,
        active: t.active ?? false,
        // Spread rather than `wf: t.wf`, so a session with no workflow (the common
        // case) contributes no key at all to the snapshot JSON. ClaudeStatusService
        // memoizes the run, so a live workflow only redirties this snapshot when the
        // run itself moves — not on every read (see its `wfByTab`).
        ...(t.wf ? { wf: t.wf } : {}),
      }));
      return { worktrees, sessions, focused: vscode.window.state.focused };
    };

    // Client is created first so the command deps can trigger a snapshot via it.
    let client: BrokerClient | undefined;

    const deps: CommandDeps = {
      openWorktreeClaudeTab: (worktreePath, prompt) =>
        openWorktreeClaudeTab(worktreePath, prompt),
      tabs: () => claudeStatus.tabs(),
      submitPrompt: (tabId, text) => claudeStatus.submitPrompt(tabId, text),
      interrupt: (tabId) => claudeStatus.interrupt(tabId),
      reveal: (tabId) => claudeStatus.reveal(tabId).then(() => undefined),
      rename: (tabId, title) => claudeStatus.rename(tabId, title),
      runWt: (args) => runWt(args),
      extractJson: (out) => extractJson(out),
      branchExists: (repoRoot, branch) => branchExists(repoRoot, branch),
      remoteBranchExists: (repoRoot, branch) =>
        remoteBranchExists(repoRoot, branch),
      openFolderWindow: async (worktreePath) => {
        await vscode.commands.executeCommand(
          "vscode.openFolder",
          vscode.Uri.file(worktreePath),
          { forceNewWindow: true }
        );
      },
      trunkPath,
      realPath,
      requestSnapshot: () => client?.notifyChange(),
    };

    client = new BrokerClient({
      connection: readConnection,
      host: detectHost(),
      getRepo,
      buildSnapshot,
      dispatch: createCommandDispatcher(deps),
      // Diagnostics only; broker being down is normal and stays silent otherwise.
      log: (message, error) => {
        if (process.env.AH_BROKER_DEBUG) {
          console.error(`[ah broker] ${message}`, error ?? "");
        }
      },
    });

    // Publish a fresh (debounced) snapshot whenever git state or Claude tab status
    // changes (PLAN.md §6.2). The full snapshot is also re-sent on every connect.
    context.subscriptions.push(
      scmInfo.onDidChange(() => client?.notifyChange()),
      claudeStatus.onDidChange(() => client?.notifyChange()),
      // A rename in the Source+ pane changes the label the orchestrator shows
      // for the row and, when it's the trunk row, for the window's heading.
      repoNames.onDidChange(() => client?.notifyChange()),
      // Focus changes flip this window's `focused` flag, which drives the
      // orchestrator's "upfront" window styling (PLAN.md §3) — publish immediately
      // so the broker learns which window just came to the front. These fire
      // once per window switch, so there is nothing to coalesce, and deferring
      // them behind the snapshot debounce is what let a busy window's focus
      // gain get swallowed while another repo's window kept the styling.
      vscode.window.onDidChangeWindowState(() =>
        client?.notifyChange({ immediate: true })
      ),
      // Which tab is active decides which session box is highlighted inside
      // this window. Claude's notify() hook doesn't cover webview view-state
      // changes, so without this a tab switch is only noticed by the 1.5s
      // status poll. Debounced rather than immediate: `WebviewPanel.active` is
      // updated from the same tab-model change, and the debounce keeps the read
      // safely behind it.
      vscode.window.tabGroups.onDidChangeTabs(() => client?.notifyChange()),
      vscode.window.tabGroups.onDidChangeTabGroups(() =>
        client?.notifyChange()
      ),
      { dispose: () => client?.dispose() }
    );

    client.start();
  } catch (err) {
    // Absolute guarantee: broker wiring never disrupts activation (PLAN.md §9.4).
    if (process.env.AH_BROKER_DEBUG) {
      console.error("[ah broker] registration failed", err);
    }
  }
}
