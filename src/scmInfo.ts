import * as path from "path";
import * as vscode from "vscode";
import { getGitApi, realPath, runGit } from "./git";
import {
  attributeTabs,
  parseAheadBehind,
  parseWorktreePorcelain,
  PorcelainWorktree,
} from "./scmParse";

/**
 * Compute layer for the SCM branch-info augmentation. Produces, per worktree of
 * the window's repo, the facts we surface under each branch header:
 *   - ahead/behind vs. the TRUNK (the repo root opened in this window)
 *   - how many editor tabs currently point into that worktree
 *
 * Everything here is stable public API (git via runGit, tabs via
 * vscode.window.tabGroups). The pure helpers are unit-tested; the service is
 * event-driven (git state + tab changes + focus) with a cheap signature gate.
 * The service only computes and emits snapshots — transport (SSE) and
 * rendering (injected client) live elsewhere.
 */

export interface WorktreeInfo {
  /** Absolute worktree path (realpath-normalized) — the match key for the client. */
  path: string;
  /** Basename, for display and DOM-row matching when the path isn't exposed. */
  name: string;
  /** Branch name, or "" when detached. */
  branch: string;
  /** Commits in this worktree not in trunk. */
  ahead: number;
  /** Commits in trunk not in this worktree. */
  behind: number;
  /** This worktree IS the window's trunk. */
  isTrunk: boolean;
  /** Trunk commit SHA — the baseline for "what this branch introduces" diffs. */
  trunkHead: string;
  /** Open editor tabs whose resource lives under this worktree (deepest-match). */
  tabs: number;
}

export interface Snapshot {
  trunkPath: string;
  worktrees: WorktreeInfo[];
}

// --- open-tab collection ----------------------------------------------------

/** Resolve the on-disk resource of a tab input across the known input shapes. */
function tabResource(input: unknown): vscode.Uri | undefined {
  if (input instanceof vscode.TabInputText) {
    return input.uri;
  }
  if (input instanceof vscode.TabInputTextDiff) {
    return input.modified;
  }
  if (input instanceof vscode.TabInputCustom) {
    return input.uri;
  }
  if (input instanceof vscode.TabInputNotebook) {
    return input.uri;
  }
  return undefined;
}

/** All open tabs' file-scheme resource paths, realpath-normalized. */
function openTabPaths(): string[] {
  const paths: string[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const uri = tabResource(tab.input);
      if (uri && uri.scheme === "file") {
        paths.push(realPath(uri.fsPath));
      }
    }
  }
  return paths;
}

// --- the service ------------------------------------------------------------

export class ScmInfoService implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<Snapshot>();
  /** Fires whenever a freshly computed snapshot differs from the last. */
  readonly onDidChange = this._onDidChange.event;

  private snapshot: Snapshot = { trunkPath: "", worktrees: [] };
  private lastSerialized = "";
  private readonly disposables: vscode.Disposable[] = [];
  private readonly repoListeners = new Map<string, vscode.Disposable>();
  private gitApi: any | undefined;
  private computing = false;
  private queued = false;

  async start(): Promise<void> {
    this.gitApi = await getGitApi();
    for (const repo of this.gitApi?.repositories ?? []) {
      this.trackRepo(repo);
    }
    if (this.gitApi) {
      this.disposables.push(
        this.gitApi.onDidOpenRepository((r: any) => {
          this.trackRepo(r);
          void this.recompute();
        }),
        this.gitApi.onDidCloseRepository((r: any) => {
          this.untrackRepo(r);
          void this.recompute();
        })
      );
    }
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(() => void this.recompute()),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) {
          void this.recompute();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("andreysHelper.scmBranchInfo")) {
          void this.recompute();
        }
      })
    );
    await this.recompute();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    for (const d of this.repoListeners.values()) {
      d.dispose();
    }
    this.repoListeners.clear();
    this._onDidChange.dispose();
  }

  getSnapshot(): Snapshot {
    return this.snapshot;
  }

  private trackRepo(repo: any): void {
    const root = repo?.rootUri?.fsPath;
    if (!root || this.repoListeners.has(root)) {
      return;
    }
    this.repoListeners.set(
      root,
      repo.state.onDidChange(() => void this.recompute())
    );
  }

  private untrackRepo(repo: any): void {
    const root = repo?.rootUri?.fsPath;
    if (!root) {
      return;
    }
    this.repoListeners.get(root)?.dispose();
    this.repoListeners.delete(root);
  }

  /** The window's trunk: the git root of the first workspace folder. */
  private trunkRoot(): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      return undefined;
    }
    // Prefer the git repo whose root contains the folder; else the folder itself.
    const repos: any[] = this.gitApi?.repositories ?? [];
    const containing = repos
      .map((r) => r.rootUri.fsPath as string)
      .filter((root) => folder === root || folder.startsWith(root + path.sep))
      .sort((a, b) => b.length - a.length)[0];
    return containing ?? folder;
  }

  /** Recompute the snapshot; coalesces concurrent triggers into one pass. */
  private async recompute(): Promise<void> {
    if (this.computing) {
      this.queued = true;
      return;
    }
    this.computing = true;
    try {
      const next = await this.computeSnapshot();
      const serialized = JSON.stringify(next);
      if (serialized !== this.lastSerialized) {
        this.lastSerialized = serialized;
        this.snapshot = next;
        this._onDidChange.fire(next);
      }
    } catch {
      // Keep the previous snapshot; a later event retries.
    } finally {
      this.computing = false;
      if (this.queued) {
        this.queued = false;
        void this.recompute();
      }
    }
  }

  private async computeSnapshot(): Promise<Snapshot> {
    const cfg = vscode.workspace.getConfiguration("andreysHelper.scmBranchInfo");
    if (!cfg.get<boolean>("enabled", true)) {
      return { trunkPath: "", worktrees: [] };
    }
    const trunk = this.trunkRoot();
    if (!trunk) {
      return { trunkPath: "", worktrees: [] };
    }
    const trunkReal = realPath(trunk);

    const list = await runGit(trunk, ["worktree", "list", "--porcelain"]);
    if (list.code !== 0) {
      return { trunkPath: trunkReal, worktrees: [] };
    }
    const worktrees = parseWorktreePorcelain(list.stdout);

    // Identify the trunk record by realpath (the window's opened root).
    const trunkHead =
      worktrees.find((w) => realPath(w.path) === trunkReal)?.head ?? "";

    const tabCounts = attributeTabs(
      openTabPaths(),
      worktrees.map((w) => realPath(w.path))
    );

    const infos = await Promise.all(
      worktrees.map((w) => this.buildInfo(w, trunk, trunkReal, trunkHead, tabCounts))
    );
    return { trunkPath: trunkReal, worktrees: infos };
  }

  private async buildInfo(
    w: PorcelainWorktree,
    trunk: string,
    trunkReal: string,
    trunkHead: string,
    tabCounts: Map<string, number>
  ): Promise<WorktreeInfo> {
    const wtReal = realPath(w.path);
    const isTrunk = wtReal === trunkReal;
    const base: WorktreeInfo = {
      path: wtReal,
      name: path.basename(wtReal),
      branch: w.branch,
      ahead: 0,
      behind: 0,
      isTrunk,
      trunkHead,
      tabs: tabCounts.get(wtReal) ?? 0,
    };
    if (isTrunk || !w.head || !trunkHead) {
      return base;
    }

    const rl = await runGit(trunk, [
      "rev-list",
      "--left-right",
      "--count",
      `${trunkHead}...${w.head}`,
    ]);
    if (rl.code === 0) {
      Object.assign(base, parseAheadBehind(rl.stdout));
    }
    return base;
  }
}
