import * as path from "path";
import * as vscode from "vscode";
import { getGitApi, realPath, runGit } from "./git";
import { readRecordedParent } from "./worktreeParent";
import {
  attributeTabs,
  ParentCandidate,
  parseAheadBehind,
  parseWorktreePorcelain,
  pickWorktreeParent,
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
  /**
   * The worktree this one was cut from (realpath), "" for the repo's main
   * worktree. Git records no such link, so this is the parent we wrote at
   * creation time, else the nearest fork point inferred from the commit graph,
   * else the main worktree. See `readRecordedParent` / `inferParents`.
   */
  parent: string;
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
  /** `<candidateHead>:<childHead>` → fork-point counts (see forkDistance). */
  private readonly forkCache = new Map<string, { ahead: number; behind: number }>();

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

    // `git worktree list` always prints the repo's main worktree first — the
    // root every parent chain terminates at.
    const mainReal = worktrees.length > 0 ? realPath(worktrees[0].path) : trunkReal;
    const parents = await this.resolveParents(trunk, worktrees, mainReal);

    const infos = await Promise.all(
      worktrees.map((w) =>
        this.buildInfo(w, trunk, trunkReal, trunkHead, tabCounts, parents, mainReal)
      )
    );
    return { trunkPath: trunkReal, worktrees: infos };
  }

  /**
   * Parent worktree (realpath) for every worktree, keyed by realpath. The main
   * worktree maps to "". A recorded parent (written when we created the
   * worktree) wins; otherwise the parent is inferred from the commit graph.
   *
   * Inference reuses the rebase-base ranker: every OTHER worktree is scored
   * against this one by fork-point distance, and the nearest wins, with the
   * main worktree breaking ties. That's the right answer whenever the parent
   * had commits of its own at the moment the child was cut; when it didn't, the
   * two fork points coincide and the tiebreak hands the child to main — which
   * is where a worktree cut from an unmodified worktree effectively came from
   * anyway.
   */
  private async resolveParents(
    trunk: string,
    worktrees: PorcelainWorktree[],
    mainReal: string
  ): Promise<Map<string, string>> {
    const parents = new Map<string, string>();
    const known = new Set(worktrees.map((w) => realPath(w.path)));
    const needInference: PorcelainWorktree[] = [];

    for (const w of worktrees) {
      const wtReal = realPath(w.path);
      if (wtReal === mainReal) {
        parents.set(wtReal, "");
        continue;
      }
      const recorded = readRecordedParent(w.path);
      const recordedReal = recorded ? realPath(recorded) : undefined;
      // A recorded parent that is no longer a worktree (it was removed) is
      // stale; fall through to inference rather than pointing at nothing.
      if (recordedReal && recordedReal !== wtReal && known.has(recordedReal)) {
        parents.set(wtReal, recordedReal);
      } else {
        needInference.push(w);
      }
    }

    for (const w of needInference) {
      parents.set(realPath(w.path), await this.inferParent(trunk, w, worktrees, mainReal));
    }

    // Every chain must terminate at the main worktree, so the window opened
    // there keeps seeing every worktree in the repo. Two worktrees parked on
    // the same commit can each infer the other as its parent, and a stale
    // recorded parent can point into a cycle; either way both would drop out of
    // main's view. Reparent anything that doesn't reach main.
    for (const wtReal of parents.keys()) {
      const seen = new Set<string>([wtReal]);
      let cursor = parents.get(wtReal) ?? "";
      while (cursor && cursor !== mainReal && !seen.has(cursor)) {
        seen.add(cursor);
        cursor = parents.get(cursor) ?? "";
      }
      if (cursor !== mainReal && wtReal !== mainReal) {
        parents.set(wtReal, mainReal);
      }
    }
    return parents;
  }

  /** Nearest-fork-point parent for one worktree; main when nothing separates them. */
  private async inferParent(
    trunk: string,
    child: PorcelainWorktree,
    worktrees: PorcelainWorktree[],
    mainReal: string
  ): Promise<string> {
    const childReal = realPath(child.path);
    // Candidates deliberately include worktrees parked on the SAME commit as
    // this one: a fresh worktree sits exactly on its parent's HEAD, so skipping
    // equal heads would drop the real parent from the pool and hand the child
    // to whichever unrelated worktree scored least badly.
    const candidates = worktrees.filter(
      (w) => realPath(w.path) !== childReal && w.head
    );
    if (candidates.length === 0 || !child.head) {
      return childReal === mainReal ? "" : mainReal;
    }
    const scored = await Promise.all(
      candidates.map(async (w): Promise<ParentCandidate> => ({
        path: realPath(w.path),
        ...(await this.forkDistance(trunk, w.head, child.head)),
      }))
    );
    return pickWorktreeParent(scored, mainReal) ?? mainReal;
  }

  /**
   * `<candidate>...<child>` counts, memoized on the sha pair: HEADs move rarely
   * compared to how often snapshots recompute (every tab change and focus), so
   * the O(worktrees²) git calls are paid once per commit, not once per render.
   */
  private async forkDistance(
    trunk: string,
    candidateHead: string,
    childHead: string
  ): Promise<{ ahead: number; behind: number }> {
    const key = `${candidateHead}:${childHead}`;
    const hit = this.forkCache.get(key);
    if (hit) {
      return hit;
    }
    const rl = await runGit(trunk, [
      "rev-list",
      "--left-right",
      "--count",
      `${candidateHead}...${childHead}`,
    ]);
    // left = commits only the candidate has (how far it moved on) = behind;
    // right = commits only the child has = the fork-point distance = ahead.
    const counts = rl.code === 0 ? parseAheadBehind(rl.stdout) : { ahead: 0, behind: 0 };
    if (this.forkCache.size > 500) {
      this.forkCache.clear();
    }
    this.forkCache.set(key, counts);
    return counts;
  }

  private async buildInfo(
    w: PorcelainWorktree,
    trunk: string,
    trunkReal: string,
    trunkHead: string,
    tabCounts: Map<string, number>,
    parents: Map<string, string>,
    mainReal: string
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
      parent: parents.get(wtReal) ?? (wtReal === mainReal ? "" : mainReal),
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
