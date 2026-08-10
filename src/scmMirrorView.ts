import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { getGitApi, realPath, runGit, runGh, NON_INTERACTIVE_GIT } from "./git";
import { toast, formatGitError, formatGitResult } from "./notify";
import { openWorktreeClaudeTab } from "./claudeTab";
import { readRebaseState, RebaseState } from "./rebaseState";
import { ClaudeStatusService } from "./claudeStatus";
import { ScmInfoService } from "./scmInfo";
import { PHOSPHOR_JSON } from "./phosphorIcons";
import { codiconBase64, initSetiIcons, resolveFileIcon, setiWoffBase64 } from "./setiIcons";
import { WorkflowRun } from "./workflowProgress";
import { BaseCandidate, bestRebaseBase, conventionalTrunk } from "./scmParse";
import { RepoNameStore } from "./repoNames";

/**
 * A custom Source Control pane (WebviewView) built for visual parity with the
 * built-in SCM view, plus this extension's worktree extras. It DRIVES real git
 * and SHOWS real state — no workbench patching. VS Code exposes no API to embed
 * its own SCM widgets, so we re-render from the git extension API (+
 * ScmInfoService for the trunk-relative migration flag), matching Cursor's git
 * extension behavior verbatim:
 *   - primary button morphs Commit → Commit & Push/Sync (git.postCommitCommand),
 *     or Sync Changes (upstream ahead/behind), or Publish Branch (no upstream);
 *   - a "…" overflow menu holds the rest (push/pull/fetch/stage-all/undo/PR/
 *     graph/worktree/view-mode);
 *   - files render in a compacted folder tree with git-decoration colors;
 *   - clicking a file selects it (double-click opens the diff), staging via the
 *     inline +/− or the group header.
 * Repositories are ordered trunk-first (SCM's default "discovery time").
 */

const STATUS_LETTER: Record<number, string> = {
  0: "M", 1: "A", 2: "D", 3: "R", 5: "M", 6: "D", 7: "U", 9: "A",
};
const UNTRACKED = 7;

interface FileModel {
  uri: string;
  rel: string;
  staged: boolean;
  untracked: boolean;
  letter: string;
  ic: string; // Seti glyph char ("" when theme missing)
  icColor: string;
}
/** A file changed by the commits on one side of a sync — the combined diff of
 *  either the outgoing (push) or incoming (pull) commits. No stage/untracked
 *  state: these are committed. */
interface SyncFileModel {
  uri: string;
  rel: string;
  letter: string; // A/M/D/R/C from `git diff --name-status`
  ic: string;
  icColor: string;
}
interface ClaudeTabModel {
  /** Claude session id — the stable, unique key for focus/rename. */
  sessionId: string;
  /** Current tab title (the editor tab's label). */
  title: string;
  /** "working" | "question" | "plan" | "permission" | "done" | "idle" | other. */
  status: string;
  /** True when this is the active editor tab (gets a gold highlight). */
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
 * An interrupted rebase in this worktree. OMITTED (not nulled) on the
 * overwhelming majority of rows — the state is rare and every row that isn't in
 * it must render exactly as it does today.
 */
interface RebaseModel {
  /** Position in the rebase todo list, for a "3/7" readout. */
  step: number;
  total: number;
  /** Files with unmerged paths right now; 0 once they're resolved and staged. */
  conflicts: number;
}
interface RepoModel {
  root: string;
  name: string;
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  canPublish: boolean;
  /** URL of the open GitHub pull request for this branch, or "" when there is
   *  no PR (or no GitHub remote / gh unavailable). Gates the "Copy PR Link" item. */
  prUrl: string;
  /** True while a PR lookup is applicable (branch pushed to a GitHub remote) but
   *  hasn't resolved yet — the menu shows a disabled spinner in place of the link
   *  until it does. Distinct from a resolved "no PR" (both leave prUrl ""). */
  prPending: boolean;
  isTrunk: boolean;
  trunkHead: string;
  tabs: number;
  /** Open Claude tabs whose session cwd is this worktree, with live status.
   *  Empty when Claude is unpatched (no status published) — the list stays hidden. */
  claudeTabs: ClaudeTabModel[];
  commitLabel: string;
  primary: "commit" | "sync" | "publish";
  primaryLabel: string;
  files: FileModel[];
  /** Combined changed files of the outgoing commits (what a Sync/Push will send). */
  outgoingFiles: SyncFileModel[];
  /** Combined changed files of the incoming commits (what a Sync/Pull will bring in).
   *  Both empty when there's nothing to sync, while the diff loads (see syncPending),
   *  or when the commits to sync touch no files (e.g. an empty commit). */
  incomingFiles: SyncFileModel[];
  /** True while the sync diff for the current tip is still being computed in the
   *  background. Distinguishes "still loading" from "loaded, but no file changes"
   *  so the modal doesn't sit on "Computing changes…" forever for empty commits. */
  syncPending: boolean;
  /** Present only while this worktree sits in an interrupted rebase — drives the
   *  header's REBASING chip and reroutes the menu's rebase entry to recovery. */
  rebase?: RebaseModel;
}

/**
 * Split pathspecs into batches that comfortably fit one argv. A "Discard All"
 * over a big generated tree can list thousands of files, and spawn() fails
 * outright (E2BIG) past the OS limit — the built-in git extension chunks its
 * own pathspecs at the same 30k budget for exactly this reason.
 */
function chunkArgs(rels: string[], maxChars = 30000): string[][] {
  const out: string[][] = [];
  let batch: string[] = [];
  let len = 0;
  for (const rel of rels) {
    if (batch.length && len + rel.length + 1 > maxChars) {
      out.push(batch);
      batch = [];
      len = 0;
    }
    batch.push(rel);
    len += rel.length + 1;
  }
  if (batch.length) {
    out.push(batch);
  }
  return out;
}

/**
 * The rules both rebase prompts share.
 *
 * The `GIT_EDITOR=true` prefix is not a nicety. A `reword`/`squash` step (or a
 * --continue on one) opens an editor for the commit message, and an agent shell
 * has no terminal to answer it — the command just hangs. It has to be the env
 * var rather than `-c core.editor=…`, because git prefers GIT_EDITOR over the
 * config, so the config form is silently defeated whenever one is set.
 *
 * Everything else is a guardrail: an agent that force-pushes or aborts on the
 * user's behalf turns a recoverable rebase into lost work.
 */
const REBASE_CONFLICT_RULES = [
  "Resolving a conflict:",
  "  a. Inspect it (`git status`, `git diff --diff-filter=U`) and read enough of the",
  "     surrounding code to understand BOTH sides before editing anything.",
  "  b. Resolve each conflicted file so the result keeps the intent of the upstream",
  "     change AND of this branch's change. Remove every conflict marker.",
  "  c. `git add` each resolved file, then run exactly:",
  "         GIT_EDITOR=true git rebase --continue",
  "     Keep the `GIT_EDITOR=true` — some steps open an editor for the commit",
  "     message, which you have no way to answer, and the command will hang.",
  "     Use the env var, not `-c core.editor=true`: git prefers GIT_EDITOR, so the",
  "     config form does nothing if one is already set.",
  "  d. Later commits can stop with their own conflicts. Repeat until `git status`",
  "     no longer reports a rebase in progress.",
  "",
  "Rules:",
  "  - Do NOT push, force-push, or amend commits that aren't part of this rebase.",
  "  - Do NOT run `git rebase --abort` — if you can't finish, leave the rebase as it",
  "    is and explain, so the user still has the choice.",
  "  - If a conflict is genuinely ambiguous, stop and describe both sides instead of",
  "    guessing at which one wins.",
].join("\n");

/** Prompt for finishing the rebase that is already stopped in this worktree. */
function resolveRebasePrompt(
  root: string,
  branch: string,
  onto: string,
  state: RebaseState,
  conflicts: string[]
): string {
  return [
    "Finish the git rebase that is currently in progress in this worktree.",
    "",
    `Worktree:      ${root}`,
    `Branch:        ${branch}`,
    `Rebasing onto: ${onto}`,
    `Stopped at:    step ${state.step} of ${state.total}`,
    `Conflicted (${conflicts.length}):`,
    ...conflicts.map((f) => `  - ${f}`),
    "",
    REBASE_CONFLICT_RULES,
  ].join("\n");
}

/** Prompt for running a rebase from the start (nothing in progress). */
function rebaseFromScratchPrompt(
  root: string,
  branch: string,
  onto: string,
  blockedBy?: string
): string {
  return [
    `Rebase this branch onto ${onto} in the worktree at ${root}.`,
    "",
    `Worktree: ${root}`,
    `Branch:   ${branch || "(the branch checked out here)"}`,
    `Onto:     ${onto}`,
    ...(blockedBy
      ? ["", "A previous attempt from the editor failed to start. git said:", ...blockedBy.split("\n").map((l) => `  ${l}`)]
      : []),
    "",
    "Do this:",
    `  1. Check the tree with \`git status\`. If something blocks the rebase (unstaged`,
    "     changes, a leftover rebase, an index.lock), deal with it first and say exactly",
    "     what you did — never discard the user's work to unblock yourself.",
    `  2. Run \`git rebase ${onto}\`.`,
    "  3. If it stops with conflicts, resolve them as described below.",
    "",
    REBASE_CONFLICT_RULES,
  ].join("\n");
}

/**
 * Extract "owner/repo" from a github.com remote URL, or undefined for non-GitHub
 * remotes. Handles SSH (git@github.com:owner/repo.git), HTTPS
 * (https://github.com/owner/repo(.git)), and ssh:// forms, with an optional
 * trailing ".git" and slash.
 */
function parseGithubSlug(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

class ScmWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private gitApi: any | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly repoListeners = new Map<string, vscode.Disposable>();

  constructor(
    private readonly info: ScmInfoService,
    private readonly status: ClaudeStatusService,
    private readonly repoNames: RepoNameStore
  ) {}

  private isLight(): boolean {
    const k = vscode.window.activeColorTheme.kind;
    return k === vscode.ColorThemeKind.Light || k === vscode.ColorThemeKind.HighContrastLight;
  }

  async start(): Promise<void> {
    initSetiIcons();
    this.gitApi = await getGitApi();
    this.disposables.push(this.info.onDidChange(() => this.post()));
    // Claude publishes tab status/title changes out-of-band from git/tab events,
    // so repaint when it signals (working→done, a new question, a rename).
    this.disposables.push(this.status.onDidChange(() => this.post()));
    this.disposables.push(vscode.window.onDidChangeActiveColorTheme(() => this.post()));
    // Opening/closing an editor tab changes the live Claude-tab list but need not
    // touch git or session status, so repaint directly on tab-group changes — else
    // a quickly-closed tab lingers as a dead row until some other event fires.
    this.disposables.push(vscode.window.tabGroups.onDidChangeTabs(() => this.post()));
    // Also repaint when the active group changes, so the gold active-tab highlight
    // follows focus even when switching between editor groups.
    this.disposables.push(vscode.window.tabGroups.onDidChangeTabGroups(() => this.post()));
    for (const repo of this.gitApi?.repositories ?? []) {
      this.trackRepo(repo);
    }
    if (this.gitApi) {
      this.disposables.push(
        this.gitApi.onDidOpenRepository((r: any) => {
          this.trackRepo(r);
          this.post();
        }),
        this.gitApi.onDidCloseRepository((r: any) => {
          this.untrackRepo(r);
          this.post();
        })
      );
    }
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("git.postCommitCommand")) {
          this.post();
        }
      })
    );
    // A PR is usually created/merged outside the editor, so re-check PR links
    // when the window regains focus. Throttled so rapid focus toggles don't spam
    // `gh`; clearing the cache makes the next render re-query each repo.
    this.disposables.push(
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused && Date.now() - this.lastPrFocusCheck > 15000) {
          this.lastPrFocusCheck = Date.now();
          this.prCache.clear();
          this.post();
        }
      })
    );
    this.post();
  }

  private lastPrFocusCheck = 0;

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    for (const d of this.repoListeners.values()) {
      d.dispose();
    }
    this.repoListeners.clear();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m), undefined, this.disposables);
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.post();
      }
    });
    this.post();
  }

  refresh(): void {
    this.post();
  }

  /** Set the file view mode ("tree" | "list") from the title-bar toggle button.
   *  The mode lives in the webview (it persists it), so we forward the request;
   *  the webview echoes back its new mode via a "viewMode" message, which drives
   *  the `andreysHelper.scmViewMode` context key that swaps the toggle button's
   *  icon/tooltip between List and Tree. */
  setViewMode(mode: "tree" | "list"): void {
    this.view?.webview.postMessage({ type: "setViewMode", mode });
  }

  private trackRepo(repo: any): void {
    const root = repo?.rootUri?.fsPath;
    if (!root || this.repoListeners.has(root)) {
      return;
    }
    this.repoListeners.set(root, repo.state.onDidChange(() => this.post()));
  }

  private untrackRepo(repo: any): void {
    const root = repo?.rootUri?.fsPath;
    if (root) {
      this.repoListeners.get(root)?.dispose();
      this.repoListeners.delete(root);
    }
  }

  private repo(root: string): any | undefined {
    return (this.gitApi?.repositories ?? []).find((r: any) => r.rootUri.fsPath === root);
  }

  // PR-link cache: root → { branch, url }. url:"" is a cached *negative* (no PR
  // for that branch) so repos without a PR don't re-run `gh` on every render.
  // Invalidated on branch change (implicitly — the key mismatches), on window
  // focus, and after we push/publish (when a PR may have just appeared).
  private readonly prCache = new Map<string, { branch: string; url: string }>();
  private readonly prInFlight = new Set<string>();

  // Sync-files cache: root → { key, outgoing, incoming }. `key` is HEAD +
  // ahead/behind counts, so it self-invalidates whenever the local tip moves or
  // upstream advances (no explicit clearing needed). Mirrors the prCache pattern:
  // a synchronous read for buildModel that kicks off a background diff on a miss.
  private readonly syncCache = new Map<
    string,
    { key: string; outgoing: SyncFileModel[]; incoming: SyncFileModel[] }
  >();
  private readonly syncInFlight = new Set<string>();

  // Last rebase target picked in this session, per root. git persists only the
  // resolved sha of the target (rebase-merge/onto), so once a rebase is under
  // way this map holds the only human-readable name of what it's replaying onto.
  // A miss just degrades the label to `git name-rev` / a short sha.
  private readonly rebaseTarget = new Map<string, string>();

  // In-session undo/redo history for commits, per repo root. Each undo
  // soft-resets HEAD~1 and pushes the undone commit here; redo pops and restores
  // it via an exact `reset --soft <sha>`. The commit-message box tracks the top
  // entry, so undo/redo walk the message history exactly like the native SCM
  // pane's "Undo Last Commit" repopulates its input box. Cleared on a successful
  // commit (history advanced) and dropped when a redo finds it stale (HEAD is no
  // longer the entry's parent — a new commit/checkout/rebase moved on).
  private readonly undone = new Map<string, { sha: string; message: string }[]>();

  private undoneStack(root: string): { sha: string; message: string }[] {
    let s = this.undone.get(root);
    if (!s) {
      s = [];
      this.undone.set(root, s);
    }
    return s;
  }

  /** Push the commit message of the top undo-history entry into the webview's
   *  commit box (an empty string clears it once the history is exhausted), so
   *  both undo and redo leave the box showing the message that would next be
   *  re-committed. `force` lets it clear the box, unlike a generate-message set. */
  private setMessageFromTop(root: string): void {
    const s = this.undone.get(root);
    const message = s && s.length ? s[s.length - 1].message : "";
    this.view?.webview.postMessage({ type: "setmsg", root, message, force: true });
  }

  /**
   * Ask `gh` for the pull request URL of the branch currently checked out in
   * `root`. Returns undefined (→ no link) when a PR lookup can't apply: detached
   * HEAD, no upstream (unpushed branch), a non-GitHub remote, or gh is missing/
   * unauthenticated/offline. Runs only when the cheap local gates pass, so gh is
   * never spawned for repos where a PR is impossible.
   */
  private async fetchPrUrl(root: string): Promise<string | undefined> {
    const head = this.repo(root)?.state?.HEAD;
    if (!head?.name || !head?.upstream) {
      return undefined; // detached or unpushed → no PR possible
    }
    const remotes: any[] = this.repo(root)?.state?.remotes ?? [];
    const remote =
      remotes.find((r) => r.name === head.upstream.remote) ??
      remotes.find((r) => r.name === "origin") ??
      remotes[0];
    if (!parseGithubSlug(remote?.fetchUrl ?? remote?.pushUrl)) {
      return undefined; // not a github.com remote
    }
    // gh is slow to start in the extension host (several seconds per call, slower
    // still when cold right after a reload — keychain access, config load), so the
    // default 8s timeout was intermittently killing a working lookup and dropping
    // the link. Give it a generous budget; the menu shows a spinner meanwhile.
    const res = await runGh(root, ["pr", "view", "--json", "url", "--jq", ".url"], 25000);
    if (res.code !== 0) {
      return undefined; // "no pull requests found" (exit 1) or gh unavailable
    }
    const url = res.stdout.trim();
    return url.startsWith("http") ? url : undefined;
  }

  /** Populate the PR cache for `root`@`branch` in the background (deduped), then
   *  re-render. Skips work when the cache already knows this branch (positive or
   *  negative), so reaching the body is always a pending→resolved transition —
   *  which flips prPending and must re-post even when the URL is unchanged (a
   *  resolved "no PR"), so an open menu's pending spinner clears. */
  private schedulePrRefresh(root: string, branch: string): void {
    const cached = this.prCache.get(root);
    if ((cached && cached.branch === branch) || this.prInFlight.has(root)) {
      return;
    }
    this.prInFlight.add(root);
    void this.fetchPrUrl(root)
      .then((url) => {
        this.prCache.set(root, { branch, url: url ?? "" });
        this.post();
      })
      .finally(() => this.prInFlight.delete(root));
  }

  /** Synchronous cache read for buildModel; on a miss it kicks off a background
   *  refresh (which re-posts when done) and returns "" for now. */
  private prUrlFromCache(root: string, branch?: string): string {
    if (!branch) {
      return "";
    }
    const cached = this.prCache.get(root);
    if (cached && cached.branch === branch) {
      return cached.url;
    }
    this.schedulePrRefresh(root, branch);
    return "";
  }

  /** Cheap synchronous test of whether a PR could exist for `root`'s current
   *  branch — the same local gates fetchPrUrl applies before spawning gh (branch
   *  name, upstream, GitHub remote). Used to decide whether to show the pending
   *  spinner, so repos where a PR is impossible never show one. */
  private prPossible(root: string): boolean {
    const head = this.repo(root)?.state?.HEAD;
    if (!head?.name || !head?.upstream) {
      return false;
    }
    const remotes: any[] = this.repo(root)?.state?.remotes ?? [];
    const remote =
      remotes.find((r) => r.name === head.upstream.remote) ??
      remotes.find((r) => r.name === "origin") ??
      remotes[0];
    return !!parseGithubSlug(remote?.fetchUrl ?? remote?.pushUrl);
  }

  /** True when a PR lookup is applicable but the cache hasn't resolved this branch
   *  yet — drives the menu's pending spinner. prUrlFromCache (called alongside)
   *  kicks off the background refresh, so this only reports the state. */
  private prPending(root: string, branch?: string): boolean {
    if (!branch) {
      return false;
    }
    const cached = this.prCache.get(root);
    const resolved = !!(cached && cached.branch === branch);
    return !resolved && this.prPossible(root);
  }

  /**
   * Re-check the PR when the worktree menu is opened. A cached *negative* ("no PR
   * for this branch") otherwise sticks until the branch changes or the window
   * regains focus, so a PR opened in the meantime — the common case right after
   * publishing a worktree's branch — stayed invisible in the menu until a window
   * reload. Dropping the negative makes the following render re-query gh: the row
   * shows its pending spinner and live-swaps to the link when it resolves, with
   * the menu still open. Positive entries are left as they are (revalidated on
   * window focus), so opening the menu never costs a `gh` call once a PR is known.
   */
  private recheckPr(root: string): void {
    const branch = this.repo(root)?.state?.HEAD?.name;
    const cached = this.prCache.get(root);
    if (!branch || !cached || cached.branch !== branch || cached.url) {
      return;
    }
    this.prCache.delete(root);
    this.post();
  }

  /** PR URL for the current branch, cache-first, falling back to a live lookup —
   *  used on click so Copy/Open always act on an up-to-date link. */
  private async prUrlNow(root: string): Promise<string | undefined> {
    const branch = this.repo(root)?.state?.HEAD?.name;
    const cached = this.prCache.get(root);
    if (branch && cached && cached.branch === branch) {
      return cached.url || undefined;
    }
    return this.fetchPrUrl(root);
  }

  // --- outgoing (sync) files ----------------------------------------------

  /** Parse `git diff --name-status -M <range>` into file models. Renames/copies
   *  ("R100\t<old>\t<new>") key off the new path. Returns [] on git error. */
  private async diffFiles(root: string, range: string): Promise<SyncFileModel[]> {
    const res = await runGit(root, ["diff", "--name-status", "-M", range]);
    if (res.code !== 0) {
      return [];
    }
    const light = this.isLight();
    const out: SyncFileModel[] = [];
    for (const line of res.stdout.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const parts = line.split("\t");
      const code = parts[0];
      const rel = parts.length >= 3 ? parts[parts.length - 1] : parts[1];
      if (!rel) {
        continue;
      }
      const icon = resolveFileIcon(path.basename(rel), light);
      out.push({
        uri: vscode.Uri.file(path.join(root, ...rel.split("/"))).toString(),
        rel,
        letter: code[0] === "C" ? "A" : code[0], // copy reads as an add
        ic: icon?.char ?? "",
        icColor: icon?.color ?? "inherit",
      });
    }
    out.sort((a, b) => a.rel.localeCompare(b.rel));
    return out;
  }

  /**
   * Files changed by each side of a sync, via three-dot diffs from the merge-base
   * so each reflects only *that* side's own commits: outgoing = `@{u}...HEAD`
   * (what a push sends), incoming = `HEAD...@{u}` (what a pull brings in).
   */
  private async fetchSyncFiles(
    root: string
  ): Promise<{ outgoing: SyncFileModel[]; incoming: SyncFileModel[] }> {
    const [outgoing, incoming] = await Promise.all([
      this.diffFiles(root, "@{u}...HEAD"),
      this.diffFiles(root, "HEAD...@{u}"),
    ]);
    return { outgoing, incoming };
  }

  /** Populate the sync-files cache for `root`@`key` in the background (deduped),
   *  then re-render if either file set changed. */
  private scheduleSyncRefresh(root: string, key: string): void {
    const cached = this.syncCache.get(root);
    if ((cached && cached.key === key) || this.syncInFlight.has(root)) {
      return;
    }
    this.syncInFlight.add(root);
    void this.fetchSyncFiles(root)
      .then(({ outgoing, incoming }) => {
        const prev = this.syncCache.get(root);
        this.syncCache.set(root, { key, outgoing, incoming });
        const changed =
          !prev ||
          prev.key !== key ||
          prev.outgoing.length !== outgoing.length ||
          prev.incoming.length !== incoming.length;
        if (changed) {
          this.post();
        }
      })
      .finally(() => this.syncInFlight.delete(root));
  }

  /** Synchronous cache read for buildModel; on a miss it kicks off a background
   *  diff (which re-posts when done) and returns empty sets for now. */
  private syncFilesFromCache(
    root: string,
    key: string
  ): { outgoing: SyncFileModel[]; incoming: SyncFileModel[]; pending: boolean } {
    const cached = this.syncCache.get(root);
    if (cached && cached.key === key) {
      return { outgoing: cached.outgoing, incoming: cached.incoming, pending: false };
    }
    this.scheduleSyncRefresh(root, key);
    return { outgoing: [], incoming: [], pending: true };
  }

  /**
   * Open a diff for one file involved in a sync: its content at the merge-base
   * (the common ancestor) vs. at the side's tip — HEAD for outgoing (what a push
   * sends), the upstream tip for incoming (what a pull will make your tree look
   * like). This shows the combined effect of that side's commits on the file;
   * added files show an empty left, deleted an empty right.
   */
  private async openSyncDiff(root: string, uriStr: string, dir: string): Promise<void> {
    const uri = vscode.Uri.parse(uriStr);
    const name = path.basename(uri.fsPath);
    const toGitUri = this.gitApi?.toGitUri?.bind(this.gitApi);
    const base = (await runGit(root, ["merge-base", "@{u}", "HEAD"])).stdout.trim();
    const target = (await runGit(root, ["rev-parse", dir === "in" ? "@{u}" : "HEAD"])).stdout.trim();
    if (!toGitUri || !base || !target) {
      await vscode.window.showTextDocument(uri, { preview: true });
      return;
    }
    await vscode.commands.executeCommand(
      "vscode.diff",
      toGitUri(uri, base),
      toGitUri(uri, target),
      `${name} (${dir === "in" ? "incoming" : "outgoing"})`
    );
  }

  // --- Claude tabs --------------------------------------------------------

  /**
   * Build one row per LIVE Claude editor tab (from vscode.window.tabGroups — the
   * authoritative open-tab set, so no strays and no duplicates), enriched by
   * matching to a live controller from `getTabs()` (Claude's own allComms). The
   * match is by editor group column, disambiguated by title; the controller
   * supplies the authoritative cwd (→ worktree) and status. A controller is used
   * at most once, so two identical tabs still produce exactly two rows.
   */
  private claudeTabsByRoot(): Map<string, ClaudeTabModel[]> {
    const out = new Map<string, ClaudeTabModel[]>();
    const controllers = this.status.tabs();
    if (!controllers.length) {
      return out;
    }
    const roots = (this.gitApi?.repositories ?? []).map((r: any) => realPath(r.rootUri.fsPath as string));
    const byCol = new Map<number, typeof controllers>();
    for (const c of controllers) {
      const k = c.col ?? -1;
      const arr = byCol.get(k) ?? [];
      arr.push(c);
      byCol.set(k, arr);
    }
    const used = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (!(input instanceof vscode.TabInputWebview) || !/claude/i.test(input.viewType)) {
          continue;
        }
        const pool = (byCol.get(group.viewColumn) ?? []).filter((c) => !used.has(c.id));
        // Match strictly by (column, exact title), then by exact title in any
        // column (a controller's viewColumn can lag after a split/move). There is
        // deliberately NO positional fallback: a restored-but-not-yet-hydrated
        // Claude tab has NO controller in allComms (Claude recreates the controller
        // only when the tab is first focused), so grabbing an arbitrary same-column
        // controller (the old `pool[0]`) mis-attributed a *different* live tab's
        // status/active/cwd onto it and dropped the real tab's row. Skipping an
        // unmatched tab (it appears the moment it's focused and hydrates) is far
        // better than showing it wearing another session's identity.
        const pick =
          pool.find((c) => c.title === tab.label) ??
          controllers.find((c) => !used.has(c.id) && c.title === tab.label);
        if (!pick?.cwd) {
          continue;
        }
        used.add(pick.id);
        const cwd = realPath(pick.cwd);
        const owner = roots
          .filter((rt: string) => cwd === rt || cwd.startsWith(rt + path.sep))
          .sort((a: string, b: string) => b.length - a.length)[0];
        if (!owner) {
          continue;
        }
        const list = out.get(owner) ?? [];
        // The active-tab highlight is the tab that is BOTH its group's active tab
        // AND in the active group — pure boolean reads off the live Tab/TabGroup, no
        // reference-identity comparison and independent of Claude's per-panel flag.
        const active = tab.isActive && group.isActive;
        const row: ClaudeTabModel = {
          sessionId: pick.id,
          title: tab.label,
          status: pick.status,
          active,
        };
        // Carried through verbatim — ClaudeStatusService has already parsed and
        // memoized it, so this is a reference copy, and the key stays off rows
        // without a workflow.
        if (pick.wf) {
          row.wf = pick.wf;
        }
        list.push(row);
        out.set(owner, list);
      }
    }
    return out;
  }

  /** Reveal/focus a Claude tab by its session id (via the patched command). The
   *  reveal also clears the tab's completion check — clicking the box in the pane
   *  is a deliberate interaction, so it counts as having looked at the tab. */
  private async focusClaudeTab(sessionId: string): Promise<void> {
    await this.status.reveal(sessionId);
  }

  /**
   * Rename a Claude tab externally by session id (via the patched command). The
   * new title comes from the pane's inline editor. Persists across reloads because
   * the patch uses Claude's own `renameSession(..., onlyIfNoCustomTitle=false)`,
   * which writes the custom title to Claude's session store — not just the live
   * panel title.
   */
  private async renameClaudeTab(sessionId: string, title: string, newTitle: string): Promise<void> {
    const next = (newTitle ?? "").trim();
    if (!next || next === title) {
      return;
    }
    if (!(await this.status.isPatched())) {
      return void toast(
        "Andrey's Helper: renaming needs the Claude Code patch — enable it under Settings → Andrey's Helper → “Claude Code Patch”.",
        "warning"
      );
    }
    const ok = await this.status.rename(sessionId, next);
    if (!ok) {
      toast("Andrey's Helper: couldn't rename that Claude tab.", "warning");
    }
    // The patch fires notify() on the resulting title change, which repaints; a
    // fallback post() covers the case where the summary reactor lags.
    this.post();
  }

  // --- model → webview ----------------------------------------------------

  private buildModel(): RepoModel[] {
    const snapshot = this.info.getSnapshot();
    const pcc = vscode.workspace.getConfiguration("git").get<string>("postCommitCommand", "none");
    const commitLabel = pcc === "push" ? "Commit & Push" : pcc === "sync" ? "Commit & Sync" : "Commit";
    const claudeByRoot = this.claudeTabsByRoot();

    const repos = (this.gitApi?.repositories ?? []).map((repo: any): RepoModel => {
      const root = repo.rootUri.fsPath as string;
      const head = repo.state?.HEAD;
      const branch = head?.name ?? (head?.commit ? head.commit.slice(0, 7) : "detached");
      const wt = snapshot.worktrees.find((w) => w.path === realPath(root));

      const light = this.isLight();
      const files: FileModel[] = [];
      const add = (changes: any[], staged: boolean) => {
        for (const c of [...(changes ?? [])].sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath))) {
          const icon = resolveFileIcon(path.basename(c.uri.fsPath), light);
          files.push({
            uri: c.uri.toString(),
            rel: path.relative(root, c.uri.fsPath).split(path.sep).join("/"),
            staged,
            untracked: c.status === UNTRACKED,
            letter: STATUS_LETTER[c.status] ?? "?",
            ic: icon?.char ?? "",
            icColor: icon?.color ?? "inherit",
          });
        }
      };
      add(repo.state.mergeChanges, false);
      add(repo.state.indexChanges, true);
      add(repo.state.workingTreeChanges, false);

      const dirty = files.length > 0;
      const ahead = head?.ahead ?? 0;
      const behind = head?.behind ?? 0;
      const hasUpstream = !!head?.upstream;
      const canPublish = !hasUpstream && (repo.state.remotes?.length ?? 0) > 0 && !!head?.name;

      // A rebase that stopped (conflicts, or an `edit`/`break` step) leaves the
      // worktree in a state where Commit/Sync are meaningless and a second
      // `git rebase` just errors. Surfacing it costs one existsSync per render;
      // the conflict count comes free from the git extension's merge group, so
      // no git process runs on the hot path.
      const rebaseState = readRebaseState(root);
      const rebase: RebaseModel | undefined = rebaseState && {
        step: rebaseState.step,
        total: rebaseState.total,
        conflicts: repo.state.mergeChanges?.length ?? 0,
      };

      let primary: RepoModel["primary"] = "commit";
      let primaryLabel = commitLabel;
      if (!dirty) {
        if (hasUpstream && (ahead || behind)) {
          primary = "sync";
          primaryLabel = "Sync Changes";
        } else if (canPublish) {
          primary = "publish";
          primaryLabel = "Publish Branch";
        }
      }

      return {
        root,
        name: path.basename(root),
        branch,
        dirty,
        ahead,
        behind,
        hasUpstream,
        canPublish,
        prUrl: this.prUrlFromCache(root, head?.name),
        prPending: this.prPending(root, head?.name),
        isTrunk: !!wt?.isTrunk,
        trunkHead: wt?.trunkHead ?? "",
        tabs: wt?.tabs ?? 0,
        claudeTabs: claudeByRoot.get(realPath(root)) ?? [],
        commitLabel,
        primary,
        primaryLabel,
        files,
        // Compute sync files only when there's an upstream and something to sync
        // (ahead or behind). Keyed by tip + ahead/behind so it recomputes when
        // either side moves. `_sync` is destructured into the two fields below.
        ...(() => {
          const s =
            hasUpstream && (ahead > 0 || behind > 0)
              ? this.syncFilesFromCache(root, `${head?.commit ?? ""}:${ahead}:${behind}`)
              : { outgoing: [], incoming: [], pending: false };
          return { outgoingFiles: s.outgoing, incomingFiles: s.incoming, syncPending: s.pending };
        })(),
        ...(rebase ? { rebase } : {}),
      };
    });

    // Trunk (workspace root) first, then the rest alphabetically by branch —
    // matching the built-in SCM view's ordering.
    const trunk = realPath(snapshot.trunkPath || "");
    repos.sort((a: RepoModel, b: RepoModel) => {
      const at = realPath(a.root) === trunk ? 0 : 1;
      const bt = realPath(b.root) === trunk ? 0 : 1;
      if (at !== bt) {
        return at - bt;
      }
      return a.branch.localeCompare(b.branch);
    });
    return repos;
  }

  private post(): void {
    this.view?.webview.postMessage({
      type: "state",
      repos: this.buildModel(),
      names: this.repoNames.all(),
    });
  }

  // --- webview → actions --------------------------------------------------

  private async onMessage(m: any): Promise<void> {
    switch (m?.type) {
      case "primary":
        return this.primary(m.root, m.action, m.message);
      case "commit":
        return this.commit(m.root, m.message, m.then);
      case "genmsg":
        return this.generateMessage(m.root);
      case "op":
        return this.op(m.root, m.op);
      case "file":
        return this.fileAction(m.root, m.uris ?? [m.uri], m.untracked, m.action);
      case "syncDiff":
        return this.openSyncDiff(m.root, m.uri, m.dir);
      case "focusTab":
        return this.focusClaudeTab(m.sessionId);
      case "renameTab":
        return this.renameClaudeTab(m.sessionId, m.title, m.newTitle);
      case "prCheck":
        return this.recheckPr(m.root);
      case "refresh":
        return this.post();
      case "setRepoName":
        this.repoNames.set(m.root, m.name || undefined);
        return;
      case "seedRepoNames":
        this.repoNames.seed(m.names ?? {});
        return;
      case "viewMode":
        void vscode.commands.executeCommand("setContext", "andreysHelper.scmViewMode", m.mode);
        return;
    }
  }

  private async primary(root: string, action: string, message: string): Promise<void> {
    if (action === "sync") {
      return this.op(root, "sync");
    }
    if (action === "publish") {
      return this.op(root, "publish");
    }
    // "default" → let native apply its own git.postCommitCommand config, exactly
    // like the native SCM main Commit button.
    return this.commit(root, message, "default");
  }

  /**
   * Busy signalling — mirrors the native SCM panel, which disables the commit
   * action button (and shows a spinning `$(sync~spin)`) while an operation is in
   * flight, tracked via the git extension's `repository.operations`. That state
   * isn't in the public git API, so instead we bracket every long-running
   * operation we drive: post `busy` with a label when it starts and clear it
   * (label:null) in a finally when it settles. The webview disables the primary
   * button + caret and spins the glyph while a label is present.
   */
  private postBusy(root: string, label: string | null): void {
    this.view?.webview.postMessage({ type: "busy", root, label });
  }

  private async withBusy<T>(root: string, label: string, fn: () => PromiseLike<T>): Promise<T> {
    this.postBusy(root, label);
    try {
      return await fn();
    } finally {
      this.postBusy(root, null);
    }
  }

  /**
   * Force the git extension to re-read a repo after a raw `runGit` mutation.
   * runGit spawns git directly, bypassing the git API, so `repo.state` (and the
   * ahead/behind info that rides on `repo.state.onDidChange`) stays stale until
   * the extension's own autorefresh happens to catch up — which is why a force
   * push wasn't reflected until an unrelated git command nudged it. `status()`
   * re-reads immediately and fires onDidChange, cascading to both our `post()`
   * and the info service's recompute(). Best-effort; `post()` covers the rest.
   */
  private async refreshRepo(root: string): Promise<void> {
    try {
      await this.repo(root)?.status?.();
    } catch {
      // Ignore — the fallback post() below still re-renders known state.
    }
    this.post();
  }

  /**
   * Commit by delegating to the built-in git extension's own `git.commit`
   * command, so behaviour is identical to the native Source Control view:
   * smart-commit staging, empty-message prompt, the post-commit push/sync, and
   * — crucially — the native error notification with "Open Git Log / Show
   * Command Output" instead of a custom toast. The command reads the message
   * from the repo's SCM input box (so we seed it first) and resolves the target
   * repository from the root Uri we pass, keeping multi-worktree commits correct.
   *
   * `then`: "default" uses the repo's git.postCommitCommand config; "none"
   * forces commit-only; "push"/"sync" force that post-commit action.
   */
  private async commit(root: string, message: string, then: string): Promise<void> {
    const repo = this.repo(root);
    if (!repo?.inputBox) {
      this.postBusy(root, null); // clear any optimistic spinner the webview set
      return void toast("Andrey's Helper: repository not found.", "error");
    }
    repo.inputBox.value = message ?? "";
    // git.commit's 2nd arg is the postCommitCommand *string* itself, not an
    // options object: "git.push"/"git.sync" force that post-commit action, null
    // forces commit-only, and undefined lets the extension read the repo's
    // git.postCommitCommand config. The extension runs it via
    // `executeCommand(arg.toString())`, so passing an object here produced
    // `executeCommand("[object Object]")` → the native "Git: command
    // '[object Object]' not found" error (the commit still landed; only the
    // post-commit step threw).
    const postCommitCommand =
      then === "push" ? "git.push"
      : then === "sync" ? "git.sync"
      : then === "none" ? null
      : undefined; // "default": native reads git.postCommitCommand
    await this.withBusy(root, "Committing…", () =>
      vscode.commands.executeCommand("git.commit", repo.rootUri, postCommitCommand)
    );
    // Native clears the input on success and leaves the message on failure — so
    // only clear our textarea when it actually committed.
    if (!repo.inputBox.value) {
      // A fresh commit advances HEAD, so any prior undo/redo history no longer
      // sits on top of it — drop it so a later redo can't restore a stale commit.
      this.undone.delete(root);
      this.view?.webview.postMessage({ type: "committed", root });
    }
  }

  /**
   * Drive Cursor's own "Generate Commit Message" (the sparkle button in the
   * native SCM input) headlessly: the command writes the generated text into
   * the repo's SCM input box, which the git API exposes as inputBox.value, so
   * we run it, read the result back, and push it into our webview textarea.
   */
  private async generateMessage(root: string): Promise<void> {
    const repo = this.repo(root);
    const done = (message?: string) =>
      this.view?.webview.postMessage({ type: "setmsg", root, message });
    if (!repo) {
      return void done();
    }
    try {
      await vscode.commands.executeCommand("cursor.generateGitCommitMessage", repo.rootUri);
    } catch {
      toast("Andrey's Helper: couldn't generate a commit message (Cursor only).", "error");
      return void done();
    }
    done(repo.inputBox?.value ?? "");
  }

  private async op(root: string, op: string): Promise<void> {
    if (op === "createPR") {
      // pr.create resolves its target from the argument: with none, the GitHub
      // extension either asks which repository to create in or lands on whichever
      // one it considers active — usually the wrong worktree in a window that has
      // several. {repoPath, compareBranch} pins it to this worktree and its branch
      // (it matches repoPath against its review managers' rootUri).
      const branch = this.repo(root)?.state?.HEAD?.name;
      return void vscode.commands.executeCommand("pr.create", {
        repoPath: root,
        compareBranch: branch,
      });
    }
    if (op === "gitGraph") {
      return void vscode.commands.executeCommand("git-graph.view");
    }
    if (op === "wtNewTab" || op === "wtNewWindow" || op === "wtNew" || op === "wtRemove") {
      const cmd = { wtNewTab: "wt.newTab", wtNewWindow: "wt.newWindow", wtNew: "wt.newWorktree", wtRemove: "wt.removeWorktree" }[op];
      return void vscode.commands.executeCommand(cmd, { rootUri: vscode.Uri.file(root) });
    }
    if (op === "openTerminal") {
      return this.openTerminal(root);
    }
    if (op === "copyPath") {
      await vscode.env.clipboard.writeText(root);
      return void toast("Andrey's Helper: copied worktree path.");
    }
    if (op === "copyBranch") {
      const b = this.repo(root)?.state?.HEAD?.name ?? "";
      await vscode.env.clipboard.writeText(b);
      return void toast(`Andrey's Helper: copied branch name "${b}".`);
    }
    if (op === "copyPr" || op === "openPr") {
      const url = await this.prUrlNow(root);
      if (!url) {
        return void toast("Andrey's Helper: no open pull request for this branch.", "warning");
      }
      if (op === "openPr") {
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
      await vscode.env.clipboard.writeText(url);
      return void toast("Andrey's Helper: copied PR link.");
    }
    if (op === "rebase") {
      return this.rebase(root);
    }
    if (op === "rebaseRecover") {
      return this.rebaseRecovery(root);
    }
    if (op === "forcePush") {
      return this.forcePush(root);
    }
    if (op === "undo") {
      return this.undo(root);
    }
    if (op === "redo") {
      return this.redo(root);
    }
    if (op === "stageAll" || op === "unstageAll") {
      const args = op === "stageAll" ? ["add", "-A"] : ["reset", "-q", "HEAD"];
      const res = await runGit(root, args);
      if (res.code !== 0) {
        toast(`Andrey's Helper: ${op} failed.`, "error", 2000, formatGitResult(res, args));
      }
      await this.refreshRepo(root);
      return;
    }
    const repo = this.repo(root);
    if (!repo) {
      this.postBusy(root, null); // clear any optimistic spinner the webview set
      return void toast("Andrey's Helper: repository not found.", "error");
    }
    const label = { sync: "Syncing", push: "Pushing", pull: "Pulling", fetch: "Fetching", publish: "Publishing" }[op] ?? op;
    await this.withBusy(root, `${label}…`, () =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: `${label} ${path.basename(root)}…` },
        async () => {
          try {
            if (op === "sync") {
              await repo.pull();
              await repo.push();
            } else if (op === "push") {
              await repo.push();
            } else if (op === "pull") {
              await repo.pull();
            } else if (op === "fetch") {
              await repo.fetch();
            } else if (op === "publish") {
              // Native `git.publish` rather than repo.push(remote, branch, true):
              // publishing through the API object does push the branch, but only
              // the git extension's own publish path fires its onDidPublish event
              // — and that event is what makes the GitHub extension offer "Would
              // you like to create a Pull Request for branch 'x'?". Pushing
              // directly published the branch silently, so the prompt never came
              // up for a worktree published from this panel. The command resolves
              // its repository from the argument (registered {repository:true}),
              // so rootUri pins it to this exact worktree; it picks the remote
              // itself, asking only when there's more than one.
              await vscode.commands.executeCommand("git.publish", repo.rootUri);
            }
          } catch (err) {
            toast(`Andrey's Helper: ${op} failed.`, "error", 2000, formatGitError(err));
          }
        }
      )
    );
    // A PR commonly appears right after we push/publish (not least via the publish
    // prompt above), and the cached "no PR" for this branch would otherwise hide it
    // until a branch change or window focus. Drop it so the next render re-queries.
    if (op === "publish" || op === "push" || op === "sync") {
      this.prCache.delete(root);
      this.post();
    }
  }

  /**
   * Rebase Branch… — mirrors the native SCM command: pick a branch, then rebase
   * the current branch onto it. Runs in this exact worktree (git -C) so it's
   * always the right one.
   *
   * Unlike the native command, a rebase that doesn't complete is not left as a
   * fading error toast: a conflict (or any other non-zero exit) hands off to the
   * recovery picker, which is the only in-UI way out of a half-finished rebase.
   */
  private async rebase(root: string): Promise<void> {
    // A worktree already mid-rebase can't start another one — `git rebase` would
    // fail with "there is already a rebase-merge directory" — so skip straight to
    // recovery rather than asking for a branch we couldn't use. Also covers the
    // race where a rebase started (in a terminal, say) after this row rendered.
    if (readRebaseState(root)) {
      return this.rebaseRecovery(root);
    }
    const onto = await this.pickRebaseTarget(root);
    if (!onto) {
      return;
    }
    await this.runRebase(root, onto);
  }

  /**
   * The branch picker shared by Rebase Branch… and the recovery picker's
   * "Abort & Rebase with Claude…". Returns undefined when dismissed.
   */
  private async pickRebaseTarget(root: string): Promise<string | undefined> {
    const current = this.repo(root)?.state?.HEAD?.name;
    const listed = await runGit(root, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
      "refs/remotes",
    ]);
    const branches = listed.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((b) => b !== current && !b.endsWith("/HEAD"));
    if (branches.length === 0) {
      toast("Andrey's Helper: no other branch to rebase onto.", "warning");
      return undefined;
    }
    // Pre-select the branch we're currently based on: it's the overwhelmingly
    // common rebase target (pull the base forward again), so it goes first —
    // VS Code makes the first item active, so Enter alone picks it.
    const base = await this.currentBase(root, current, branches);
    const items: vscode.QuickPickItem[] = (
      base ? [base, ...branches.filter((b) => b !== base)] : branches
    ).map((b) => (b === base ? { label: b, description: "current base" } : { label: b }));
    const picked = await vscode.window.showQuickPick(items, {
      title: `Rebase "${current ?? path.basename(root)}" onto…`,
      placeHolder: "Select a branch to rebase the current branch onto",
    });
    return picked?.label;
  }

  /** Run the rebase itself, then route a non-zero exit into recovery. */
  private async runRebase(root: string, onto: string): Promise<void> {
    const current = this.repo(root)?.state?.HEAD?.name;
    // Remember what was picked: git only persists the *resolved sha* of the
    // target, so this is the one place the human-readable name exists.
    this.rebaseTarget.set(root, onto);
    let failure = "";
    await this.withBusy(root, "Rebasing…", () =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: `Rebasing onto ${onto}…` },
        async () => {
          // Non-interactive env for the same reason as continueRebase: nothing
          // here should be able to block on an editor we can't reach.
          const res = await runGit(root, ["rebase", onto], 120000, NON_INTERACTIVE_GIT);
          if (res.code !== 0) {
            failure = `${res.stderr}\n${res.stdout}`.trim() || "git error";
          } else {
            toast(`Andrey's Helper: rebased "${current ?? path.basename(root)}" onto ${onto}.`);
          }
        }
      )
    );
    await this.refreshRepo(root);
    if (failure) {
      await this.rebaseFailed(root, onto, failure);
    }
  }

  /**
   * A rebase exited non-zero. Two very different situations hide behind that:
   *   - it started and stopped (conflicts, or an `edit` step) — the worktree is
   *     now mid-rebase and everything in the recovery picker applies;
   *   - it never started (dirty tree, unknown ref, index.lock) — there is
   *     nothing to continue or abort, so offering those would be a lie.
   * Which one it is comes from the on-disk state, not from parsing git's text.
   */
  private async rebaseFailed(root: string, onto: string, error: string): Promise<void> {
    if (readRebaseState(root)) {
      return this.rebaseRecovery(root, error);
    }
    const summary = error.split("\n").filter(Boolean).slice(-2).join(" — ");
    type Item = vscode.QuickPickItem & { id: "claude" | "terminal" };
    const picked = await vscode.window.showQuickPick<Item>(
      [
        {
          id: "claude",
          label: "$(sparkle) Rebase with Claude…",
          detail: `Opens a Claude tab in this worktree to sort out whatever blocked the rebase, then rebase onto ${onto}.`,
        },
        { id: "terminal", label: "$(terminal) Open Terminal Here", detail: root },
      ],
      {
        title: `Rebase onto ${onto} could not start`,
        placeHolder: summary || "git error",
        ignoreFocusOut: true,
      }
    );
    if (picked?.id === "claude") {
      await this.handOffToClaude(root, rebaseFromScratchPrompt(root, this.repo(root)?.state?.HEAD?.name ?? "", onto, error));
    } else if (picked?.id === "terminal") {
      this.openTerminal(root);
    }
  }

  /**
   * The way out of a half-finished rebase.
   *
   * A QuickPick rather than a native modal dialog: there are five actions and
   * each needs a sentence of explanation, which a macOS dialog (three readable
   * buttons, truncated detail) cannot carry. `ignoreFocusOut` keeps it up —
   * this is a recovery prompt, and silently dismissing it on a click elsewhere
   * would drop the user right back into the stuck state they opened it from.
   *
   * Every item is gated on freshly-read state, not on the render model, since
   * the user may have resolved conflicts in the editor since the last push.
   */
  private async rebaseRecovery(root: string, error?: string): Promise<void> {
    const state = readRebaseState(root);
    if (!state) {
      // Finished or aborted underneath us (a terminal, the native SCM view).
      await this.refreshRepo(root);
      return void toast("Andrey's Helper: no rebase in progress.", "warning");
    }
    const conflicts = await this.unmergedPaths(root);
    const onto = await this.ontoLabel(root, state);
    const branch = state.branch || path.basename(root);
    const n = conflicts.length;

    type Item = vscode.QuickPickItem & {
      id: "continue" | "claudeResolve" | "abort" | "claudeRestart" | "terminal";
    };
    const items: Item[] = [];
    if (n === 0) {
      // Nothing unmerged: either the user resolved everything, or the rebase
      // stopped on an `edit`/`break` step. Either way --continue is the move.
      items.push({
        id: "continue",
        label: "$(debug-continue) Continue Rebase",
        detail:
          state.step < state.total
            ? `Nothing left unmerged — finish step ${state.step} and replay the remaining ${state.total - state.step}.`
            : "Nothing left unmerged — finish the rebase.",
      });
    } else {
      items.push({
        id: "claudeResolve",
        label: "$(sparkle) Resolve Conflicts with Claude",
        detail: `Opens a Claude tab in this worktree to resolve ${n} file${n === 1 ? "" : "s"} and run rebase --continue. Keeps this rebase — no branch to pick.`,
      });
    }
    items.push({
      id: "abort",
      label: "$(discard) Abort Rebase",
      detail: `Puts "${branch}" back to ${state.origHead.slice(0, 7) || "where it started"}. Any conflict resolutions made so far are discarded.`,
    });
    items.push({
      id: "claudeRestart",
      label: "$(sparkle) Abort & Rebase with Claude…",
      detail: "Aborts first, then asks which branch to rebase onto and hands the whole rebase to a Claude tab.",
    });
    items.push({ id: "terminal", label: "$(terminal) Open Terminal Here", detail: root });

    const picked = await vscode.window.showQuickPick<Item>(items, {
      title: n
        ? `Rebase stopped — ${n} conflicted file${n === 1 ? "" : "s"} (step ${state.step}/${state.total})`
        : `Rebase in progress — step ${state.step}/${state.total}`,
      placeHolder: error
        ? error.split("\n").filter(Boolean).slice(-1)[0]
        : `Rebasing "${branch}" onto ${onto}${n ? ` — ${conflicts.slice(0, 3).map((f) => path.basename(f)).join(", ")}${n > 3 ? `, +${n - 3} more` : ""}` : ""}`,
      ignoreFocusOut: true,
    });
    if (!picked) {
      return;
    }
    if (picked.id === "continue") {
      return this.continueRebase(root);
    }
    if (picked.id === "abort") {
      await this.abortRebase(root, branch);
      return;
    }
    if (picked.id === "terminal") {
      return this.openTerminal(root);
    }
    if (picked.id === "claudeResolve") {
      return this.handOffToClaude(root, resolveRebasePrompt(root, branch, onto, state, conflicts));
    }
    // claudeRestart: abort BEFORE picking the branch, so a dismissed picker
    // still leaves a clean worktree rather than a stuck one. Aborting is what
    // this item promises up front, so it's not a surprise.
    if (!(await this.abortRebase(root, branch, { quiet: true }))) {
      return;
    }
    const onward = await this.pickRebaseTarget(root);
    if (!onward) {
      return void toast(`Andrey's Helper: rebase aborted — "${branch}" is back where it started.`);
    }
    this.rebaseTarget.set(root, onward);
    await this.handOffToClaude(root, rebaseFromScratchPrompt(root, branch, onward));
  }

  /**
   * `git rebase --continue`, then straight back into the picker if the rebase
   * stopped again on a later commit — a rebase with conflicts in three commits
   * takes three continues, and re-opening keeps that a single flow.
   *
   * NON_INTERACTIVE_GIT is load-bearing. A plain `pick` reuses its message and
   * needs no editor, but a `reword`/`squash` step does — and the user's rebase
   * may well be an interactive one they started in a terminal. With a `--wait`
   * editor configured (the norm here) that step blocks on a window we never
   * opened, and the command burns its full 120s timeout instead of failing.
   * The trade is that a message git would have offered to edit is accepted
   * as-is, which is the right call for a recovery action.
   */
  private async continueRebase(root: string): Promise<void> {
    let failure = "";
    await this.withBusy(root, "Continuing…", () =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: "Continuing rebase…" },
        async () => {
          const args = ["rebase", "--continue"];
          const res = await runGit(root, args, 120000, NON_INTERACTIVE_GIT);
          if (res.code !== 0) {
            failure = `${res.stderr}\n${res.stdout}`.trim() || "git error";
          }
        }
      )
    );
    await this.refreshRepo(root);
    if (!readRebaseState(root)) {
      // No rebase left on disk → it finished, whatever the exit code said.
      return void toast("Andrey's Helper: rebase completed.");
    }
    return this.rebaseRecovery(root, failure || undefined);
  }

  /** `git rebase --abort`. Returns whether it worked, for the restart flow. */
  private async abortRebase(
    root: string,
    branch: string,
    opts: { quiet?: boolean } = {}
  ): Promise<boolean> {
    let ok = false;
    await this.withBusy(root, "Aborting…", () =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: "Aborting rebase…" },
        async () => {
          const args = ["rebase", "--abort"];
          const res = await runGit(root, args, 120000);
          ok = res.code === 0;
          if (!ok) {
            toast("Andrey's Helper: rebase --abort failed.", "error", 2000, formatGitResult(res, args));
          } else if (!opts.quiet) {
            toast(`Andrey's Helper: rebase aborted — "${branch}" is back where it started.`);
          }
        }
      )
    );
    await this.refreshRepo(root);
    return ok;
  }

  /** Paths git currently reports as unmerged — the authoritative conflict list. */
  private async unmergedPaths(root: string): Promise<string[]> {
    const res = await runGit(root, ["diff", "--name-only", "--diff-filter=U"]);
    return res.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * A human-readable name for what the branch is being replayed onto. git only
   * stores the resolved sha, so prefer the target this session picked; failing
   * that ask `name-rev`, and failing that show the short sha.
   */
  private async ontoLabel(root: string, state: RebaseState): Promise<string> {
    // Only trust the remembered name if it still points at the sha this rebase is
    // actually replaying onto — otherwise it's left over from an earlier rebase
    // (or the branch has since moved) and would confidently name the wrong base.
    const remembered = this.rebaseTarget.get(root);
    if (remembered && state.ontoSha) {
      const res = await runGit(root, ["rev-parse", "--verify", "--quiet", `${remembered}^{commit}`]);
      if (res.stdout.trim() === state.ontoSha) {
        return remembered;
      }
    }
    if (!state.ontoSha) {
      return "its new base";
    }
    const res = await runGit(root, [
      "name-rev",
      "--name-only",
      "--refs=refs/heads/*",
      "--refs=refs/remotes/*",
      state.ontoSha,
    ]);
    const name = res.stdout.trim();
    return name && name !== "undefined" ? name : state.ontoSha.slice(0, 7);
  }

  /**
   * Open a Claude tab pinned to this worktree carrying `prompt`.
   *
   * Prompt injection needs the patched Claude bundle; on a stock one the stash
   * is inert and the tab would open empty, so the prompt goes to the clipboard
   * and the toast says to paste it. The hand-off still happens either way.
   */
  private async handOffToClaude(root: string, prompt: string): Promise<void> {
    const patched = (await vscode.commands.getCommands(true)).includes(
      "claude-vscode.editor.openWorktree"
    );
    if (!patched) {
      await vscode.env.clipboard.writeText(prompt);
      toast(
        "Andrey's Helper: Claude Code isn't patched, so the rebase prompt was copied to the clipboard — paste it into the tab.",
        "warning",
        4000
      );
    }
    await openWorktreeClaudeTab(root, prompt);
  }

  private openTerminal(root: string): void {
    const term = vscode.window.createTerminal({ cwd: root, name: path.basename(root) });
    term.show();
  }

  /**
   * Best guess at the branch the current branch is *currently* based on — the
   * candidate whose merge-base sits nearest to HEAD, i.e. the fewest commits
   * from the fork point up to HEAD. On a feature branch off main that's main;
   * on a stacked branch it's the branch below it, not the trunk. Candidates
   * that fork at the same point are broken apart by bestRebaseBase (trunk
   * first, then local over remote) — nothing in the graph distinguishes a
   * branch cut FROM this one from the branch this one was cut from.
   *
   * The branch's own remote counterpart is excluded: `origin/<current>` always
   * forks at or after every real base, so it would win every time while being
   * a sync target rather than a base. It stays in the pick list, just not
   * pre-selected. Returns undefined when nothing shares history with HEAD.
   */
  private async currentBase(
    root: string,
    current: string | undefined,
    candidates: string[]
  ): Promise<string | undefined> {
    const remotes: string[] = (this.repo(root)?.state?.remotes ?? []).map((r: any) => r.name);
    const mine = new Set(current ? remotes.map((r) => `${r}/${current}`) : []);
    const pool = candidates.filter((b) => !mine.has(b));
    if (pool.length === 0) {
      return undefined;
    }
    // `<cand>...HEAD --left-right --count` → "<commits only on cand>\t<only on HEAD>".
    // One cheap call per branch, run in small batches so a repo with hundreds of
    // remote refs can't spawn hundreds of git processes at once.
    const scored: BaseCandidate[] = [];
    for (let i = 0; i < pool.length; i += 16) {
      const batch = pool.slice(i, i + 16);
      const results = await Promise.all(
        batch.map((b) => runGit(root, ["rev-list", "--left-right", "--count", `${b}...HEAD`], 5000))
      );
      results.forEach((res, j) => {
        const [behind, ahead] = res.stdout.trim().split(/\s+/).map(Number);
        // Non-zero exit means unrelated histories or a bad ref — not a base.
        if (res.code === 0 && Number.isFinite(ahead) && Number.isFinite(behind)) {
          scored.push({ branch: batch[j], ahead, behind });
        }
      });
    }
    if (scored.length === 0) {
      return undefined;
    }
    return bestRebaseBase(scored, await this.trunk(root, remotes, pool), remotes);
  }

  /**
   * The repo's default branch, as a short name ("main"): whatever `<remote>/HEAD`
   * points at, which is what `git clone` records, falling back to the first
   * conventional trunk name that exists here (`origin/HEAD` is absent in repos
   * that started life as `git init`, and in older clones).
   */
  private async trunk(
    root: string,
    remotes: string[],
    candidates: string[]
  ): Promise<string | undefined> {
    for (const remote of remotes) {
      const res = await runGit(root, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], 5000);
      const ref = res.stdout.trim();
      if (res.code === 0 && ref.startsWith(`${remote}/`)) {
        return ref.slice(remote.length + 1);
      }
    }
    return conventionalTrunk(candidates, remotes);
  }

  /**
   * Force Push (safe) — `git push --force-with-lease`. Overwrites the remote
   * branch with the local one (needed after a rebase/amend), but --force-with-lease
   * aborts if the remote moved in a way we haven't fetched, so it can't silently
   * clobber a teammate's push the way a bare --force can. Confirmed via a modal
   * since it rewrites remote history.
   */
  private async forcePush(root: string): Promise<void> {
    const branch = this.repo(root)?.state?.HEAD?.name ?? path.basename(root);
    const confirm = await vscode.window.showWarningMessage(
      `Force push "${branch}"?`,
      {
        modal: true,
        detail:
          "Uses --force-with-lease: overwrites the remote branch with your local commits, but aborts if the remote has commits you haven't fetched yet. Safer than a plain --force.",
      },
      "Force Push"
    );
    if (confirm !== "Force Push") {
      return;
    }
    await this.withBusy(root, "Force pushing…", () =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: `Force pushing ${path.basename(root)}…` },
        async () => {
          const res = await runGit(root, ["push", "--force-with-lease"], 120000);
          if (res.code !== 0) {
            const full = `${res.stderr}\n${res.stdout}`.trim();
            const summary = full.split("\n").filter(Boolean).slice(-2).join(" — ");
            toast(`Andrey's Helper: force push failed — ${summary || "git error"}`, "error", 2000, full);
          } else {
            toast(`Andrey's Helper: force-pushed "${branch}".`);
          }
        }
      )
    );
    await this.refreshRepo(root);
  }

  private async undo(root: string): Promise<void> {
    const headSha = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    const full = await runGit(root, ["log", "-1", "--pretty=%B"]);
    // Keep the full body (subject + description) so re-committing preserves the
    // whole message; the label for the modal/toast is just its first line.
    const message = full.code === 0 ? full.stdout.replace(/\s+$/, "") : "";
    const label = message.split("\n")[0] || "the last commit";
    const confirm = await vscode.window.showWarningMessage(
      `Undo last commit on "${path.basename(root)}"?`,
      {
        modal: true,
        detail: `"${label}" will be uncommitted; its changes stay staged (soft reset HEAD~1) and its message returns to the commit box. Nothing is lost.`,
      },
      "Undo Commit"
    );
    if (confirm !== "Undo Commit") {
      return;
    }
    const undoArgs = ["reset", "--soft", "HEAD~1"];
    const res = await runGit(root, undoArgs);
    if (res.code !== 0) {
      toast("Andrey's Helper: undo failed (no prior commit, or git error).", "error", 2000, formatGitResult(res, undoArgs));
      return;
    }
    if (headSha) {
      this.undoneStack(root).push({ sha: headSha, message });
    }
    // Box now shows the message of the commit we just undid (the new top). A
    // second undo pushes the next-older commit, so the box walks back in time.
    this.setMessageFromTop(root);
    toast(`Andrey's Helper: undid "${label}".`);
    await this.refreshRepo(root);
  }

  /**
   * Redo a commit that Undo moved away from. When this session has an undo
   * history for the repo, re-apply the exact commit the last undo removed
   * (`reset --soft <sha>`) and move the message box to the next still-undone
   * commit above it — so undo and redo walk the message history both ways.
   * Falls back to the reflog (HEAD@{1}) for a single-level redo when there is no
   * in-session history (e.g. after a window reload).
   */
  private async redo(root: string): Promise<void> {
    const stack = this.undoneStack(root);
    if (stack.length) {
      const entry = stack[stack.length - 1];
      const head = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
      const parent = await runGit(root, ["rev-parse", "--verify", "-q", `${entry.sha}~1`]);
      // The undone commit must sit directly on top of the current HEAD to be
      // re-applied cleanly. If not, history moved on (a new commit, checkout,
      // rebase…) and this session's redo history is stale — drop it.
      if (parent.code !== 0 || parent.stdout.trim() !== head) {
        this.undone.delete(root);
        this.setMessageFromTop(root);
        return void toast("Andrey's Helper: redo history is stale — nothing to redo.", "warning");
      }
      const label = entry.message.split("\n")[0] || "the undone commit";
      const confirm = await vscode.window.showWarningMessage(
        `Redo last commit on "${path.basename(root)}"?`,
        { modal: true, detail: `Re-applies "${label}" (reset --soft ${entry.sha.slice(0, 7)}).` },
        "Redo Commit"
      );
      if (confirm !== "Redo Commit") {
        return;
      }
      const redoArgs = ["reset", "--soft", entry.sha];
      const res = await runGit(root, redoArgs);
      if (res.code !== 0) {
        return void toast("Andrey's Helper: redo failed (git error).", "error", 2000, formatGitResult(res, redoArgs));
      }
      stack.pop();
      // Box now shows the next commit still waiting to be redone (or clears once
      // the history is exhausted and we're back at the original HEAD).
      this.setMessageFromTop(root);
      toast(`Andrey's Helper: redid "${label}".`);
      await this.refreshRepo(root);
      return;
    }
    // No in-session history — single-level redo via the reflog, leaving the
    // message box untouched (there is no tracked message to restore).
    const target = await runGit(root, ["rev-parse", "--verify", "-q", "HEAD@{1}"]);
    if (target.code !== 0 || !target.stdout.trim()) {
      toast("Andrey's Helper: nothing to redo (empty reflog).", "warning");
      return;
    }
    const subj = await runGit(root, ["log", "-1", "--pretty=%s", "HEAD@{1}"]);
    const label = subj.code === 0 ? subj.stdout.trim() : "the undone commit";
    const confirm = await vscode.window.showWarningMessage(
      `Redo last commit on "${path.basename(root)}"?`,
      { modal: true, detail: `Re-applies "${label}" via the reflog (reset --soft HEAD@{1}).` },
      "Redo Commit"
    );
    if (confirm !== "Redo Commit") {
      return;
    }
    const res = await runGit(root, ["reset", "--soft", "HEAD@{1}"]);
    toast(
      res.code !== 0 ? "Andrey's Helper: redo failed (git error)." : `Andrey's Helper: redid "${label}".`,
      res.code !== 0 ? "error" : "info"
    );
    await this.refreshRepo(root);
  }

  private async fileAction(root: string, uris: string[], untracked: boolean, action: string): Promise<void> {
    if (action === "openFile") {
      // The "Open File" icon opens the working copy plainly, like the native
      // SCM pane — double-clicking the row is what shows the diff.
      const uri = vscode.Uri.parse(uris[0]);
      await vscode.window.showTextDocument(uri, { preview: true });
      return;
    }
    if (action === "open") {
      const uri = vscode.Uri.parse(uris[0]);
      const name = path.basename(uri.fsPath);
      const toGitUri = this.gitApi?.toGitUri?.bind(this.gitApi);
      if (untracked || !toGitUri) {
        await vscode.window.showTextDocument(uri, { preview: true });
        return;
      }
      await vscode.commands.executeCommand("vscode.diff", toGitUri(uri, "HEAD"), uri, `${name} (working tree)`);
      return;
    }
    if (action === "discard") {
      await this.discard(root, uris);
      // Clear any spinner even when the user cancelled (no state change fires).
      this.view?.webview.postMessage({ type: "idle" });
      return;
    }
    // Stage/unstage through the git extension API when available: it drives the
    // same code path the native SCM view uses and refreshes the extension's own
    // state right away, so our re-render is as snappy as the built-in pane. The
    // webview also updates optimistically on click. Fall back to a raw git call.
    const repo = this.repo(root);
    const fsPaths = uris.map((u) => vscode.Uri.parse(u).fsPath);
    // Remember why the Git-extension-API path failed: if the raw-git fallback
    // below also fails, we fold this in so the toast explains the whole attempt.
    let apiError: unknown;
    try {
      if (action === "stage" && typeof repo?.add === "function") {
        await repo.add(fsPaths);
        return;
      }
      if (action === "unstage" && typeof repo?.revert === "function") {
        await repo.revert(fsPaths);
        return;
      }
    } catch (err) {
      apiError = err;
      /* fall through to the raw git path below */
    }
    const rels = uris.map((u) => path.relative(root, vscode.Uri.parse(u).fsPath));
    const args = action === "stage" ? ["add", "--", ...rels] : ["reset", "-q", "HEAD", "--", ...rels];
    const res = await runGit(root, args);
    if (res.code !== 0) {
      const detail = [formatGitResult(res, args), apiError ? `Git API: ${formatGitError(apiError)}` : ""]
        .filter(Boolean)
        .join("\n\n");
      toast(`Andrey's Helper: ${action} failed.`, "error", 2000, detail);
    }
  }

  /** Discard working-tree changes for a set of files (confirmed, destructive).
   *  Tracked files revert to the index/HEAD (git checkout --); untracked files
   *  are deleted (git clean -f).
   *
   *  Classification comes from `git status` at click time, not from the cached
   *  `repo.state` the pane rendered from: a discard is destructive and batched,
   *  and `git checkout -- a b c` refuses the WHOLE batch when any one pathspec
   *  is unusable ("did not match any file(s) known to git", "path is unmerged").
   *  A single stale row — an untracked file a background agent already removed —
   *  therefore used to leave every other file untouched while showing only a
   *  generic "discard failed" toast. Conflicted paths are skipped rather than
   *  reverted (the built-in SCM view offers no discard on merge changes either),
   *  and the batch falls back to per-path calls so one bad path can't veto
   *  the rest. */
  private async discard(root: string, uris: string[]): Promise<void> {
    if (!uris.length) {
      return;
    }
    const rels = uris.map((u) =>
      path.relative(root, vscode.Uri.parse(u).fsPath).split(path.sep).join("/")
    );
    const { tracked, untracked, unmerged } = await this.classifyForDiscard(root, rels);
    if (!tracked.length && !untracked.length) {
      // Everything either resolved itself already or is conflicted; say so
      // rather than popping a confirm for a no-op.
      if (unmerged.length) {
        toast(
          `Andrey's Helper: nothing to discard — ${unmerged.length} conflicted file(s) need resolving (or abort the merge).`,
          "warning"
        );
      }
      await this.refreshRepo(root);
      return;
    }
    const n = tracked.length + untracked.length;
    const detail = [
      untracked.length
        ? `${untracked.length} untracked file(s) will be deleted; the rest revert to their last staged/committed state.`
        : "These changes revert to their last staged/committed state.",
      unmerged.length ? `${unmerged.length} conflicted file(s) will be left alone.` : "",
      "This cannot be undone.",
    ]
      .filter(Boolean)
      .join(" ");
    const confirm = await vscode.window.showWarningMessage(
      `Discard changes in ${n} file${n === 1 ? "" : "s"}?`,
      { modal: true, detail },
      "Discard Changes"
    );
    if (confirm !== "Discard Changes") {
      return;
    }
    const failures: string[] = [];
    if (tracked.length) {
      failures.push(...(await this.runPerPath(root, ["checkout", "--"], tracked)));
    }
    if (untracked.length) {
      failures.push(...(await this.runPerPath(root, ["clean", "-f", "--"], untracked)));
    }
    if (failures.length) {
      toast(
        `Andrey's Helper: discard failed for ${failures.length} of ${n} file(s).`,
        "error",
        2000,
        failures.join("\n\n")
      );
    } else if (unmerged.length) {
      toast(
        `Andrey's Helper: discarded ${n} file(s); left ${unmerged.length} conflicted file(s) alone.`,
        "warning"
      );
    }
    // git checkout/clean run outside the git extension, so nothing would tell it
    // (or us) that the files are gone — without this the pane keeps listing every
    // discarded row until some unrelated event happens to refresh it.
    await this.refreshRepo(root);
  }

  /**
   * What is each path RIGHT NOW, per git itself? `git status --porcelain -z`
   * over the exact pathspecs, so a path that stopped being changed since the
   * pane rendered simply drops out instead of poisoning the batch. Unknown
   * pathspecs are not an error for `status`, which is what makes it safe to ask.
   */
  private async classifyForDiscard(
    root: string,
    rels: string[]
  ): Promise<{ tracked: string[]; untracked: string[]; unmerged: string[] }> {
    const tracked: string[] = [];
    const untracked: string[] = [];
    const unmerged: string[] = [];
    for (const batch of chunkArgs(rels)) {
      const res = await runGit(root, ["status", "--porcelain", "-z", "-uall", "--", ...batch]);
      if (res.code !== 0) {
        // Can't ask git — fall back to treating the batch as tracked, which is
        // the pre-existing behaviour, and let the per-path runner sort it out.
        tracked.push(...batch);
        continue;
      }
      const fields = res.stdout.split("\0");
      for (let i = 0; i < fields.length; i++) {
        const entry = fields[i];
        if (entry.length < 4) {
          continue;
        }
        const x = entry[0];
        const y = entry[1];
        const rel = entry.slice(3);
        // -z renames/copies emit the original path as the very next field.
        if (x === "R" || x === "C") {
          i++;
        }
        if (x === "?" && y === "?") {
          untracked.push(rel);
        } else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
          unmerged.push(rel);
        } else {
          tracked.push(rel);
        }
      }
    }
    return { tracked, untracked, unmerged };
  }

  /**
   * Run `git <verb> -- <paths>` in argv-sized chunks, retrying a failed chunk
   * one path at a time so a single unusable pathspec costs only that path.
   * Returns a human-readable line per path that could not be discarded.
   */
  private async runPerPath(root: string, verb: string[], rels: string[]): Promise<string[]> {
    const failures: string[] = [];
    for (const batch of chunkArgs(rels)) {
      const args = [...verb, ...batch];
      const res = await runGit(root, args);
      if (res.code === 0) {
        continue;
      }
      if (batch.length === 1) {
        failures.push(formatGitResult(res, args));
        continue;
      }
      for (const rel of batch) {
        const one = [...verb, rel];
        const r = await runGit(root, one);
        if (r.code !== 0) {
          failures.push(formatGitResult(r, one));
        }
      }
    }
    return failures;
  }

  // --- html ---------------------------------------------------------------

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src data:; img-src data:; script-src 'nonce-${nonce}';`;
    const woff = setiWoffBase64();
    const codicon = codiconBase64();
    const fontFace =
      (woff ? `@font-face { font-family: 'seti'; src: url(data:font/woff;base64,${woff}) format('woff'); }` : "") +
      (codicon ? `@font-face { font-family: 'codicon'; src: url(data:font/ttf;base64,${codicon}) format('truetype'); }` : "");
    return `<!DOCTYPE html><html><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root { --row: 22px; }
  ${fontFace}
  body { padding: 0; margin: 0; font-family: var(--vscode-font-family); font-size: 13px;
    color: var(--vscode-sideBar-foreground, var(--vscode-foreground)); user-select: none; }
  .seti { font-family: 'seti'; font-size: 16px; line-height: 1; }
  .codicon { font-family: 'codicon'; font-size: 16px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; }
  .repo { border-bottom: 1px solid var(--vscode-statusBar-background, var(--vscode-panel-border)); padding-bottom: 6px; }
  .repo:last-child { border-bottom: none; padding-bottom: 0; }
  .rhead { display: flex; align-items: center; gap: 3px; padding: 3px 6px 3px 4px; }
  .rhead .chev { cursor: pointer; opacity: .9; flex: none; }
  /* Drag-to-reorder: the grabbed item rides above the rest with a lift shadow;
     the others slide out of the way via the inline transform transition. */
  body.reordering { cursor: grabbing; user-select: none; }
  .ctab.dragging, .repo.dragging { position: relative; z-index: 30; box-shadow: 0 6px 16px rgba(0,0,0,.4); }
  .repo.dragging { background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-radius: 6px; opacity: .98; }
  .rhead .name { font-weight: 700; color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The title is a flex row so only the NAME ellipsises — the dirty/behind
     asterisks are flex-none siblings and survive any amount of truncation
     (they are the whole signal; an ellipsis that ate them would read "clean"). */
  .rhead span.name { display: flex; align-items: center; }
  .rhead span.name > .ntext { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rhead span.name > .nflag { flex: none; }
  /* REBASING chip. Warning-colored and outlined rather than filled so it reads as
     a state, not an error, and flex-none like the asterisks so truncating a long
     branch name can never hide it — being invisible is the bug it exists to fix. */
  .rhead span.name > .rbchip { flex: none; margin-left: 6px; padding: 0 4px; cursor: pointer;
    font-size: 9px; font-weight: 700; letter-spacing: .04em; line-height: 14px;
    border-radius: 3px; white-space: nowrap;
    color: var(--vscode-editorWarning-foreground, #cca700);
    border: 1px solid var(--vscode-editorWarning-foreground, #cca700); }
  .rhead span.name > .rbchip:hover { background: var(--vscode-editorWarning-foreground, #cca700);
    color: var(--vscode-editor-background); }
  .rhead .name.rename { flex: 100 1 0; min-width: 40px; font: inherit; font-weight: 700; color: inherit;
    background: var(--vscode-input-background); border: 1px solid var(--vscode-focusBorder);
    border-radius: 3px; padding: 0 4px; outline: none; }
  .rhead .meta { opacity: .6; font-size: 11px; margin-left: 4px; flex: none; }
  .rhead .spacer { flex: 1; }
  .claudetabs { margin: 2px 0 6px; display: flex; flex-direction: column; gap: 3px; }
  .ctab { display: flex; align-items: center; gap: 6px; min-height: 22px; padding: 2px 8px; cursor: pointer;
    background: var(--vscode-tab-activeBackground);
    border: 1px solid var(--vscode-statusBar-background, var(--vscode-panel-border)); border-radius: 4px; }
  /* Hover keeps the background untouched and just tints the OUTER border the
     Claude-orange of the active tab. The active tab additionally carries an inner
     stroke (below), so a hovered-but-unselected row stays distinct from the
     selected one — one orange border vs. two. */
  .ctab:hover { border-color: #D97757; }
  /* The active editor tab's row gets a clean Claude-orange outline. */
  /* Double border like Claude's input: solid outer stroke, then a 1px gap of the
     box's own bg, then a half-strength inner stroke. */
  .ctab-active { border-color: #D97757;
    background: color-mix(in srgb, #FDF8EC 22%, var(--vscode-tab-activeBackground));
    box-shadow: inset 0 0 0 2px color-mix(in srgb, #FDF8EC 22%, var(--vscode-tab-activeBackground)),
                inset 0 0 0 3px rgba(217,119,87,.5); }
  .ctab-active .ctitle { color: #D97757; }
  .ctab .cstat { flex: none; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; }
  .ctab .cdot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
  .ctab .cdot.hollow { background: transparent; box-shadow: inset 0 0 0 1.5px var(--vscode-descriptionForeground); }
  .ctab .cdot.pulse { animation: ah-pulse 1.4s ease-in-out infinite; }
  @keyframes ah-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
  .ctab .cspin { flex: none; width: 11px; height: 11px; border-radius: 50%; box-sizing: border-box;
    border: 1.6px solid #D97757; border-top-color: transparent;
    animation: ah-spin 0.8s linear infinite; opacity: .85; }
  .ctab .ccheck { flex: none; color: #22C55E; display: inline-flex; }
  .ctab .ccheck svg { width: 14px; height: 14px; display: block; }
  .ctab .cask { flex: none; font-size: 14px; line-height: 1; font-weight: 700; color: #D97757; }
  .ctab .ctitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: inherit; }
  .ctab input.ctitle { height: 17px; box-sizing: border-box; font: inherit; font-size: 13px; overflow: visible;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-focusBorder); border-radius: 3px; padding: 0 4px; outline: none; }
  /* --- dynamic-workflow progress (WORKFLOW-PROGRESS.md §3.4) ---------------
     Every selector here is scoped to an element that only a row carrying a run
     ever gets, so a session box with no workflow keeps exactly the markup and
     exactly the computed layout it had before this block existed — no reserved
     chevron slot, no reflow. The palette is not new either: green is .ccheck's,
     orange is the .ctab-active / .cspin Claude orange, the hollow pending square
     is .cdot.hollow's inset stroke at 1px, and the pulse is the same ah-pulse
     keyframes the attention dots use. */
  /* Negative margins rather than a smaller row padding or gap: those are shared with
     every other row, and a workflow row must not be laid out differently from a
     plain one. -4px eats half the row's 8px left padding, -3px halves the 6px gap to
     the title. line-height:1 pins the glyph box to the declared height so the two
     chevron glyphs (right/down have different intrinsic metrics) cannot change it. */
  /* 16px matches .cstat, the status indicator on the other end of the line, so the
     two ends of the header agree. The header's own box owns the row's height now
     (see .ctabhdr), so this no longer has to prop it up. */
  .ctab .wchev { flex: none; width: 13px; height: 16px; margin-left: -4px; margin-right: -3px;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 14px; line-height: 1; opacity: .75; cursor: pointer; }
  .ctab .wchev:hover { opacity: 1; }
  /* A workflow row stacks: a fixed-height header line, then the accordion under it.
     No flex-wrap, and that is the point — wrapping made the header share one flex
     line with the accordion, so its height was DERIVED (from align-content, from the
     row's min-height, from the title's font metrics) and shifted on expand no matter
     which of those was tuned.
     The header band is 22px, not the ~18px its content needs, and that difference is
     what centres it: min-height:22px on .ctab sizes the CONTENT box, so a collapsed
     row has a 22px content area holding ~18px of content. A plain row centres that
     with align-items; a column row would park an 18px header at the TOP of it and
     read 2px high. Giving the header the whole 22px band and centring inside it puts
     the content exactly where a plain row puts it, and because the band is a fixed
     height, expanding cannot move it either. Centring the column instead
     (justify-content) fixes only the collapsed state and brings the jump back, since
     an expanded row exceeds 22px and has no spare space left to centre.
     Scoped to .wfrow so every row WITHOUT a workflow keeps today's single-line flex
     box untouched (§3.4: no reserved slot, no reflow). */
  .ctab.wfrow { flex-direction: column; align-items: stretch; gap: 0; }
  .ctab .ctabhdr { display: flex; align-items: center; gap: 6px; min-width: 0; height: 22px; }
  .ctab .wstrip { flex: none; display: flex; align-items: center; gap: 2px; }
  .wsq { flex: none; width: 6px; height: 6px; border-radius: 1px; background: transparent;
    box-shadow: inset 0 0 0 1px var(--vscode-descriptionForeground); }
  .wsq.done { background: #22C55E; box-shadow: none; }
  .wsq.failed { background: #EF4444; box-shadow: none; }
  .wsq.active { background: #D97757; box-shadow: none; animation: ah-pulse 1.4s ease-in-out infinite; }
  /* Replayed from a previous run (risk #7): the done colour, dimmed, so a resumed
     workflow that lights up instantly reads as "reused", not as work that ran. */
  .wsq.cached { background: #22C55E; box-shadow: none; opacity: .45; }
  .ctab .wcount { flex: none; font-size: 10px; opacity: .6; font-variant-numeric: tabular-nums; }
  /* The RUN's own verdict, next to the strip it belongs to. The status indicator at
     the other end of the header reports the SESSION, and after a workflow returns the
     two genuinely differ — the main loop spends minutes consuming the result, so that
     end shows a spinner while this end has to say the run is over. Same glyphs and
     same colours as the accordion's per-phase .wend; the negative margin binds it to
     the strip rather than leaving it floating in the header's 6px gap. */
  .ctab .wrend { flex: none; font-size: 11px; line-height: 1; margin-left: -3px; }
  .ctab .wrend.done { color: #22C55E; }
  .ctab .wrend.failed { color: #EF4444; }
  /* flex:none, NOT the old flex:0 0 100% — that basis meant "full width" only while
     the row was a wrapping ROW-direction flex box. The row is now column-direction,
     where flex-basis is a HEIGHT, so 100% would ask for the whole row's height. */
  .wacc { flex: none; min-width: 0; display: flex; flex-direction: column; gap: 1px;
    margin: 3px 0 1px; font-size: 11px; }
  .wacc .wph { display: flex; align-items: center; gap: 6px; min-width: 0; min-height: 16px;
    padding: 0 2px; border-radius: 3px; cursor: pointer; }
  .wacc .wph:hover { background: var(--vscode-toolbar-hoverBackground); }
  .wacc .wph.pending { cursor: default; opacity: .5; }
  .wacc .wpt { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wacc .wpm { flex: none; opacity: .6; font-variant-numeric: tabular-nums; }
  .wacc .wpr { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .6; }
  .wacc .wend { flex: none; font-size: 11px; line-height: 1; }
  .wacc .wend.done { color: #22C55E; }
  .wacc .wend.failed { color: #EF4444; }
  .wacc .wend.cached { color: #22C55E; opacity: .45; }
  .wacc .wag { display: flex; align-items: center; gap: 6px; min-width: 0; padding-left: 18px; }
  .wacc .wag.cached { opacity: .55; }
  .wacc .wal { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wacc .wat { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .6; }
  .wacc .wel { flex: none; opacity: .6; font-variant-numeric: tabular-nums; }
  .iconbtn { cursor: pointer; opacity: .8; padding: 2px 4px; border-radius: 3px; }
  .iconbtn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .iconbtn.codicon { font-size: 15px; }
  .iconbtn .svgi { display: inline-flex; }
  .iconbtn .svgi svg { width: 15px; height: 15px; display: block; }
  /* "+ Worktree" action pinned below all worktree boxes — mirrors the branch
     context menu's "New Worktree…" (same git-branch glyph + menu foreground). */
  .wtadd { display: flex; align-items: center; justify-content: center; gap: 5px; box-sizing: border-box;
    margin: 12px auto 8px; padding: 5px 10px; cursor: pointer; border-radius: 4px;
    border: 1px solid var(--vscode-statusBar-background, var(--vscode-panel-border));
    background: transparent; color: var(--vscode-menu-foreground, var(--vscode-foreground));
    font: inherit; text-align: center; opacity: .85; }
  .wtadd:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .wtadd .micon { flex: none; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; }
  .wtadd .micon svg { width: 16px; height: 16px; display: block; }
  .body { padding: 0 8px; }
  textarea { width: 100%; box-sizing: border-box; margin: 2px 0 4px; resize: none; overflow: hidden;
    min-height: 28px; height: 28px; line-height: 18px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 5px; padding: 4px 28px 4px 8px;
    font-family: var(--vscode-font-family); font-size: 13px; }
  textarea::placeholder { color: var(--vscode-input-placeholderForeground); font-size: 13px; }
  /* Placeholder overlay: a real one-line, ellipsized label that stops before the
     generate icon. A native textarea placeholder overflows into the right padding
     (under the icon) and can't be reliably ellipsized, so we render our own. Shown
     only while the textarea is empty; typed text uses the textarea itself and
     wraps/expands normally (so it never clashes with the icon — it respects the
     28px right padding). */
  .tawrap .phlabel { position: absolute; left: 9px; right: 30px; top: 2px; height: 28px;
    line-height: 28px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    color: var(--vscode-input-placeholderForeground); font-size: 13px; pointer-events: none; display: none; }
  .tawrap textarea.empty ~ .phlabel { display: block; }
  .tawrap { position: relative; }
  .tawrap .genmsg { position: absolute; right: 4px; top: 6px; width: 20px; height: 20px; box-sizing: border-box;
    display: inline-flex; align-items: center; justify-content: center; border-radius: 5px; cursor: pointer;
    opacity: .7; color: var(--vscode-input-foreground); }
  .tawrap .genmsg:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .tawrap .genmsg .codicon { font-size: 14px; }
  .tawrap .genmsg.spin { cursor: default; }
  .tawrap .genmsg.spin .codicon { animation: ah-spin 1s linear infinite; }
  .commitbar { display: flex; width: 100%; box-sizing: border-box; margin: 0 0 4px; }
  .commitbar .main { flex: 1; background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 5px 8px; cursor: pointer; border-radius: 5px 0 0 5px;
    font-family: var(--vscode-font-family); font-size: 12px; font-weight: normal;
    display: inline-flex; align-items: center; justify-content: center; }
  .commitbar .main .codicon { font-size: 14px; margin-right: 6px; }
  .commitbar .main:hover { background: var(--vscode-button-hoverBackground); }
  .commitbar .caret { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-left: 1px solid var(--vscode-button-separator, rgba(255,255,255,.2)); padding: 5px 7px; cursor: pointer;
    border-radius: 0 5px 5px 0; display: inline-flex; align-items: center; }
  .commitbar .caret .codicon { font-size: 14px; }
  .commitbar .caret:hover { background: var(--vscode-button-hoverBackground); }
  /* Match the native SCM panel: an action that can't be taken is dimmed and inert. */
  .commitbar .main:disabled, .commitbar .caret:disabled { opacity: .4; cursor: default; }
  .commitbar .main:disabled:hover, .commitbar .caret:disabled:hover { background: var(--vscode-button-background); }
  /* In-flight operation: the whole button (main + caret) dims uniformly like a disabled one; the glyph keeps spinning to signal work in progress. */
  .commitbar .main.busy .codicon { animation: ah-spin 1s linear infinite; }
  .tawrap .genmsg.disabled { opacity: .3; cursor: default; pointer-events: none; }
  /* Sync-changes modal: dim backdrop + centered sheet reusing the file-row look. */
  .ovl { position: fixed; inset: 0; z-index: 80; background: rgba(0,0,0,.45);
    display: flex; align-items: center; justify-content: center; }
  .sheet { display: flex; flex-direction: column; width: min(92%, 560px); max-height: 78vh; overflow: hidden;
    background: var(--vscode-editorWidget-background, var(--vscode-menu-background));
    color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.28)); border-radius: 8px;
    box-shadow: 0 6px 24px rgba(0,0,0,.4); }
  .sheet .shd { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
  .sheet .stitle { font-weight: 600; flex: none; }
  .sheet .ssub { flex: 1; min-width: 0; opacity: .6; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sheet .scount { flex: none; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    border-radius: 20px; min-width: 18px; height: 18px; padding: 0 6px; font-size: 11px;
    display: inline-flex; align-items: center; justify-content: center; }
  .sheet .sclose { flex: none; cursor: pointer; opacity: .7; border-radius: 4px; width: 22px; height: 22px;
    display: inline-flex; align-items: center; justify-content: center; font-size: 15px; }
  .sheet .sclose:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .sheet .sbody { overflow: auto; padding: 6px 8px 10px; }
  /* Path filter: pinned above the file sections; substring-matches the full repo-relative path. */
  .sheet .sfilter { width: 100%; box-sizing: border-box; margin: 2px 0 8px; padding: 4px 8px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, rgba(128,128,128,.28)));
    border-radius: 4px; font-size: 13px; outline: none; }
  .sheet .sfilter:focus { border-color: var(--vscode-focusBorder); }
  .sheet .sfilter::placeholder { color: var(--vscode-input-placeholderForeground); }
  .grouphdr { display: flex; align-items: center; gap: 3px; height: var(--row); box-sizing: border-box; border-radius: 3px; padding: 0 4px 0 0; font-size: 11px; text-transform: uppercase; opacity: .85; font-weight: 700; cursor: pointer; }
  .grouphdr:hover { background: var(--vscode-list-hoverBackground); }
  .grouphdr .chev { cursor: pointer; width: 16px; flex: none; }
  .grouphdr .gt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .grouphdr .count { margin-left: 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    border-radius: 20px; min-width: 18px; height: 18px; padding: 0 5px; font-size: 11px; font-weight: 400;
    box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; }
  .acts { display: none; align-items: center; gap: 1px; }
  .acts .a { cursor: pointer; opacity: .85; border-radius: 5px; font-size: 14px;
    width: 20px; height: 20px; box-sizing: border-box;
    display: inline-flex; align-items: center; justify-content: center; }
  .acts .a:not(.spin):hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .acts.busy { display: inline-flex; } /* keep the spinner visible without hover */
  .grouphdr:hover .acts, .row:hover .acts { display: inline-flex; }
  @keyframes ah-spin { 100% { transform: rotate(360deg); } }
  .a.spin { animation: ah-spin 1s linear infinite; cursor: default; opacity: .85; }
  .row { display: flex; align-items: center; height: var(--row); border-radius: 3px; padding-right: 4px; cursor: pointer; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.sel { background: var(--vscode-list-inactiveSelectionBackground); }
  .row .cslot { width: 16px; flex: none; opacity: .9; display: inline-flex; align-items: center; justify-content: center; }
  .row .cslot.codicon { cursor: pointer; }
  .row .ic { width: 16px; flex: none; text-align: center; display: inline-flex; align-items: center; justify-content: center; }
  .row .lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .dir { opacity: .55; margin-left: 6px; }
  .row .acts { margin-left: 4px; flex: none; }
  .row .st { width: 16px; text-align: center; flex: none; font-weight: 400; font-size: 11px; }
  .row .dot { width: 16px; text-align: center; flex: none; font-weight: 400; font-size: 8px; line-height: 1; }
  .M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .U { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
  .A { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .R { color: var(--vscode-gitDecoration-renamedResourceForeground); }
  .empty { opacity: .55; padding: 6px 8px; font-style: italic; }
  .menu { position: fixed; z-index: 50; background: var(--vscode-menu-background); color: var(--vscode-menu-foreground);
    border: 1px solid rgba(128,128,128,.28); border-radius: 5px; padding: 4px 0; min-width: 200px; box-shadow: 0 2px 8px rgba(0,0,0,.36); outline: none; }
  .menu :focus, .menu :focus-visible { outline: none; }
  .menu .mi { padding: 4px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px; }
  .menu .mi:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
  /* Destructive items (Remove Worktree) read in a dark red so the danger is clear. */
  .menu .mi.danger { color: #885350; }
  .menu .mi.danger:hover { color: #885350; }
  /* Pending item (e.g. a PR link still being looked up): dimmed, non-interactive,
     with a spinning glyph in the icon slot. */
  .menu .mi.pending { opacity: .55; cursor: default; }
  .menu .mi.pending:hover { background: none; color: inherit; }
  .menu .mi.pending .micon.codicon { animation: ah-spin 1s linear infinite; }
  .menu .sep { height: 1px; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); margin: 4px 0; }
  .menu .mi .micon { flex: none; width: 16px; height: 16px; opacity: .85; display: inline-flex; align-items: center; justify-content: center; }
  .menu .mi .micon svg { width: 16px; height: 16px; display: block; }
  .menu .mi .mlabel { flex: 1; min-width: 0; white-space: nowrap; }
  .menu .mi .kb { opacity: .6; font-size: 11px; flex: none; }
  .menu .mi .mtrail { flex: none; width: 20px; height: 20px; margin: -2px -4px -2px 4px; border-radius: 4px;
    opacity: .65; display: inline-flex; align-items: center; justify-content: center; }
  .menu .mi .mtrail:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .menu .mi .mtrail .micon, .menu .mi .mtrail svg { width: 15px; height: 15px; }
  /* Replicates the workbench hover widget (.workbench-hover) so our tooltips
     look and time like the native SCM view's, not the slow OS title tooltip. */
  .ah-tip { position: fixed; z-index: 100; pointer-events: none; max-width: 300px;
    background: var(--vscode-editorHoverWidget-background); color: var(--vscode-editorHoverWidget-foreground);
    border: 1px solid var(--vscode-editorHoverWidget-border); border-radius: 3px;
    box-shadow: 0 2px 8px var(--vscode-widget-shadow); padding: 4px 8px;
    font-size: 13px; line-height: 1.5; white-space: normal; overflow-wrap: anywhere; }
</style></head><body>
<div id="root"></div>
<div id="menu"></div>
<div id="modal"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const S = vscode.getState() || {};
const drafts = S.drafts || {};
const collapsedDirs = new Set(S.collapsedDirs || []);
const collapsedRepos = new Set(S.collapsedRepos || []);
const collapsedGroups = new Set(S.collapsedGroups || []);
const repoNames = S.repoNames || {}; // repoRoot -> custom display name (falls back to branch when absent/empty)
const tabOrder = S.tabOrder || {}; // repoRoot -> [sessionId...] custom ordering of session boxes (Source+ only, never touches editor tabs)
// Session boxes whose workflow accordion is expanded, keyed by Claude sessionId.
// Module-level and persisted for the same reason tabOrder and collapsedRepos are:
// render() throws the whole pane's DOM away on every status tick, several times a
// minute during a run, and an accordion that re-collapsed itself that often would
// be unusable. sessionId (not row index) because rows reorder and come and go.
const wfOpen = new Set(S.wfOpen || []);
// Per-phase manual overrides: sessionId -> { task, want:Map(phaseIndex->boolean) }.
// The boolean is the state the user asked for and it PINS that phase, overriding
// the automatic layout for as long as the run lasts — see wfPhaseIsOpen for why a
// pin and not an inverting bit. Deliberately NOT persisted, and dropped the moment
// the row reports a different taskId — an override is a statement about one run,
// and the next run must start from the automatic layout. One small entry per
// session box the user has actually toggled.
const wfPhaseOv = {};
let repoOrder = S.repoOrder || []; // [repoRoot...] custom ordering of worktree boxes; trunk is always pinned to the top regardless
let viewMode = S.viewMode || 'tree';
let repos = [];
let sel = {}; // repoRoot -> Set(uri)
const spinning = new Set(); // keys (file uri / folder key / group key) with an in-flight discard
const busyOps = {}; // repoRoot -> busy label (e.g. 'Committing…'); disables + spins the primary button
const CH_RIGHT = String.fromCharCode(0xEAB6), CH_DOWN = String.fromCharCode(0xEAB4);
const CO_CHECK = String.fromCharCode(60082), CO_SYNC = String.fromCharCode(60023), CO_CLOUD = String.fromCharCode(60099);
const CO_ADD = String.fromCharCode(0xEA60), CO_DISCARD = String.fromCharCode(0xEAE2), CO_REMOVE = String.fromCharCode(0xEB3B), CO_OPEN = String.fromCharCode(0xEA94);
const CO_LOAD = String.fromCharCode(0xEB19); // loading spinner
const CO_CLOSE = String.fromCharCode(0xEA76); // modal close (X)
const CO_SPARKLE = String.fromCharCode(0xEC10); // AI generate-commit-message glyph
const INDENT = 8; // px per tree level
const PH = ${PHOSPHOR_JSON}; // Phosphor icon bodies, keyed by name
function phIcon(name){ const s=document.createElement('span'); s.className='micon'; if(name&&PH[name]){ s.innerHTML='<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">'+PH[name]+'</svg>'; } return s; }
// Custom header glyphs (currentColor so they follow the theme).
const SVG_TABPLUS='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13.5 13.5v-3h-3v-1h3v-3h1v3h3v1h-3v3zM4.616 21q-.691 0-1.153-.462T3 19.385V8.615q0-.69.463-1.152T4.615 7h2V4.616q0-.691.463-1.153T8.231 3h11.154q.69 0 1.153.463T21 4.615V15.77q0 .69-.462 1.153t-1.153.463H17v2q0 .69-.462 1.152T15.385 21zm3.615-4.615h11.154q.23 0 .423-.193T20 15.77V4.615q0-.23-.192-.423T19.385 4H8.23q-.23 0-.422.192t-.192.423V15.77q0 .231.192.423t.423.193"/></svg>';
const SVG_WINPLUS='<svg viewBox="0 0 14 14" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect width="13" height="13" x=".5" y=".5" rx="1"/><path d="M.5 3.5h13m-4 5h-5M7 6v5"/></g></svg>';
const SVG_REBASE='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11.175 20h-3.35q-.325.875-1.088 1.438T5 22q-1.25 0-2.125-.875T2 19q0-.975.563-1.737T4 16.174v-8.35Q3.125 7.5 2.563 6.737T2 5q0-1.25.875-2.125T5 2q.975 0 1.738.563T7.825 4h3.35L10.05 2.875q-.275-.275-.275-.687t.275-.713q.3-.3.713-.3t.712.3L14.3 4.3q.3.3.3.7t-.3.7l-2.85 2.85q-.15.15-.325.225t-.362.063t-.375-.088t-.338-.225q-.275-.3-.288-.7t.288-.7L11.175 6h-3.35q-.225.65-.7 1.125T6 7.825v8.35q.65.225 1.125.7t.7 1.125h3.35l-1.125-1.125q-.275-.275-.275-.687t.275-.713q.3-.3.713-.3t.712.3L14.3 18.3q.3.3.3.7t-.3.7l-2.85 2.85q-.15.15-.325.225t-.362.063t-.375-.088t-.338-.225q-.275-.3-.288-.7t.288-.7zm5.7 1.125Q16 20.25 16 19q0-1 .563-1.763T18 16.176v-8.35q-.875-.3-1.437-1.063T16 5q0-1.25.875-2.125T19 2t2.125.875T22 5q0 1-.562 1.763T20 7.825v8.35q.875.325 1.438 1.088T22 19q0 1.25-.875 2.125T19 22t-2.125-.875M5 20q.425 0 .713-.288T6 19t-.288-.712T5 18t-.712.288T4 19t.288.713T5 20m14 0q.425 0 .713-.288T20 19t-.288-.712T19 18t-.712.288T18 19t.288.713T19 20M5 6q.425 0 .713-.288T6 5t-.288-.712T5 4t-.712.288T4 5t.288.713T5 6m14 0q.425 0 .713-.288T20 5t-.288-.712T19 4t-.712.288T18 5t.288.713T19 6M5 20q-.425 0-.712-.288T4 19t.288-.712T5 18t.713.288T6 19t-.288.713T5 20m14 0q-.425 0-.712-.288T18 19t.288-.712T19 18t.713.288T20 19t-.288.713T19 20M5 6q-.425 0-.712-.288T4 5t.288-.712T5 4t.713.288T6 5t-.288.713T5 6m14 0q-.425 0-.712-.288T18 5t.288-.712T19 4t.713.288T20 5t-.288.713T19 6"/></svg>';
// Double up-chevron — force push (distinct from the single-arrow plain Push).
const SVG_FORCEPUSH='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 4 5 11l1.4 1.4L12 6.8l5.6 5.6L19 11zm0 6-7 7 1.4 1.4L12 12.8l5.6 5.6L19 17z"/></svg>';
// Phosphor "check-fat" — the completion check shown in session boxes.
const SVG_CHECKFAT='<svg viewBox="0 0 256 256" aria-hidden="true"><path fill="currentColor" d="m243.31 90.91l-128.4 128.4a16 16 0 0 1-22.62 0l-71.62-72a16 16 0 0 1 0-22.61l20-20a16 16 0 0 1 22.58 0L104 144.22l96.76-95.57a16 16 0 0 1 22.59 0l19.95 19.54a16 16 0 0 1 .01 22.72"/></svg>';
function svgIcon(markup){ const s=document.createElement('span'); s.className='svgi'; s.innerHTML=markup; return s; }
function primaryBusyLabel(r){ return r.primary==='sync'?'Syncing…':r.primary==='publish'?'Publishing…':'Committing…'; }

function persist(){ vscode.setState({ drafts, collapsedDirs:[...collapsedDirs], collapsedRepos:[...collapsedRepos], collapsedGroups:[...collapsedGroups], repoNames, tabOrder, wfOpen:[...wfOpen], repoOrder, viewMode }); }
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function send(m){ vscode.postMessage(m); }
// Grow the message box to fit its content instead of scrolling. Must run while
// the textarea is ATTACHED to the document — a detached element reports
// scrollHeight 0. The +2 compensates for the 1px top/bottom border under
// box-sizing:border-box, which scrollHeight excludes.
// Empty (placeholder showing) stays exactly one line: a long placeholder wraps in
// the measurement and would otherwise push scrollHeight — and the box — taller. It
// only grows once there's a real value to fit.
function autosize(ta){ if(!ta) return; ta.classList.toggle('empty', !ta.value); if(!ta.value){ ta.style.height='28px'; return; } ta.style.height='auto'; ta.style.height=Math.max(28, ta.scrollHeight+2)+'px'; }
function selOf(root){ return (sel[root] = sel[root] || new Set()); }

// ----- popup menu (supports nested submenus via item.sub) -----
let menuOwner = null;
let menuBoxes = [];
let closeTimer = null;
// When a menu is opened with an items GENERATOR (a function), it can be live-
// refreshed in place on a state update — so an async item (the PR link) can swap
// from a spinner to the real link without the user reopening the menu. Holds
// {x, y, fn, sig} for the top-level box; sig gates needless rebuilds.
let menuRegen = null;
function cancelClose(){ if(closeTimer){ clearTimeout(closeTimer); closeTimer=null; } }
// Close after a short grace period so the pointer can travel across the small
// gap between a parent menu and its submenu without dismissing everything.
function scheduleClose(){ cancelClose(); closeTimer=setTimeout(closeMenu, 260); }
function closeMenu(){ cancelClose(); document.getElementById('menu').innerHTML=''; menuBoxes=[]; menuOwner=null; menuRegen=null; }
// A lightweight structural signature so refreshMenu only rebuilds when items
// actually changed (e.g. the PR item appearing/swapping), not on every state tick.
function menuSig(items){ return items.map(it=>it.sep?'-':((it.label||'')+(it.pending?'*':'')+(it.trail?'^':'')+(it.sub?'>':''))).join('|'); }
function toggleMenu(owner, x, y, items){ if(menuOwner===owner){ closeMenu(); return; } closeMenu(); const fn=(typeof items==='function')?items:()=>items; const built=fn(); menuRegen={x,y,fn,sig:menuSig(built)}; openMenu(x,y,built); menuOwner=owner; }
// Rebuild the top-level box from its generator if its contents changed. Skipped
// while a submenu is open (menuBoxes.length>1) so it never disrupts a nested
// interaction. Position is preserved.
function refreshMenu(){ if(!menuRegen||!menuOwner||menuBoxes.length!==1) return; const built=menuRegen.fn(); const sig=menuSig(built); if(sig===menuRegen.sig) return; menuRegen.sig=sig; document.getElementById('menu').innerHTML=''; menuBoxes=[]; placeBox(buildBox(built,0), menuRegen.x, menuRegen.y); }
document.addEventListener('click', closeMenu);
// Escape closes the outgoing-changes modal (then falls through to the menu).
document.addEventListener('keydown', e=>{ if(e.key==='Escape'){ if(syncModal!==null){ e.stopPropagation(); if(syncFilter.trim()){ syncFilter=''; renderModal(); } else closeSyncModal(); } } });
function clearBoxesFrom(depth){ while(menuBoxes.length>depth){ menuBoxes.pop().remove(); } }
// Keep menus clear of the viewport edge by more than the 8px shadow blur so
// the box and its drop shadow never get clipped by the narrow pane.
const EDGE = 10;
// window.innerWidth/Height INCLUDE the scrollbar in Chromium, so clamping to
// them lets a menu slide under the file list's vertical scrollbar and read as
// "cut off on the right". documentElement.clientWidth/Height exclude it.
function vw(){ return document.documentElement.clientWidth || window.innerWidth; }
function vh(){ return document.documentElement.clientHeight || window.innerHeight; }
function placeBox(box, x, y){
  const m=document.getElementById('menu'); box.style.left='0px'; box.style.top='0px'; m.appendChild(box);
  const w=box.offsetWidth, h=box.offsetHeight;
  box.style.left=Math.max(EDGE, Math.min(x, vw()-w-EDGE))+'px';
  box.style.top=Math.max(EDGE, Math.min(y, vh()-h-EDGE))+'px';
  menuBoxes.push(box);
}
// A submenu opens to the RIGHT of its parent box; when it would overflow the
// viewport it flips to the parent's LEFT rather than overlapping on top of it.
function placeSubBox(box, parentRect, itemRect){
  const m=document.getElementById('menu'); box.style.left='0px'; box.style.top='0px'; m.appendChild(box);
  const w=box.offsetWidth, h=box.offsetHeight;
  let x=parentRect.right-3;
  if(x+w > vw()-EDGE){ x=parentRect.left-w+3; } // flip to the left
  x=Math.max(EDGE, Math.min(x, vw()-w-EDGE));
  const y=Math.max(EDGE, Math.min(itemRect.top-5, vh()-h-EDGE));
  box.style.left=x+'px'; box.style.top=y+'px';
  menuBoxes.push(box);
}
function buildBox(items, depth){
  const box=document.createElement('div'); box.className='menu';
  box.onmouseenter=cancelClose; box.onmouseleave=scheduleClose; // close on mouseout (grace period bridges submenu gap)
  for(const it of items){
    if(it.sep){ const s=document.createElement('div'); s.className='sep'; box.appendChild(s); continue; }
    // Pending placeholder (e.g. a PR link still being looked up): dimmed, spinning
    // icon, non-interactive. Swallows the click so it doesn't dismiss the menu.
    if(it.pending){
      const d=document.createElement('div'); d.className='mi pending';
      const mi=document.createElement('span'); mi.className='micon codicon'; mi.textContent=CO_LOAD; d.appendChild(mi);
      const left=document.createElement('span'); left.className='mlabel'; left.textContent=it.label; d.appendChild(left);
      d.onclick=(e)=>{ e.stopPropagation(); };
      box.appendChild(d); continue;
    }
    const d=document.createElement('div'); d.className='mi'+(it.danger?' danger':'');
    if(it.svg){ const mi=document.createElement('span'); mi.className='micon'; mi.innerHTML=it.svg; d.appendChild(mi); } else { d.appendChild(phIcon(it.icon)); }
    const left=document.createElement('span'); left.className='mlabel'; left.textContent=it.label; d.appendChild(left);
    if(it.sub){
      const arr=document.createElement('span'); arr.className='kb'; arr.textContent=CH_RIGHT; arr.classList.add('codicon'); d.appendChild(arr);
      const open=()=>{ clearBoxesFrom(depth+1); placeSubBox(buildBox(it.sub, depth+1), box.getBoundingClientRect(), d.getBoundingClientRect()); };
      d.onmouseenter=open;
      d.onclick=(e)=>{ e.stopPropagation(); open(); };
    } else {
      if(it.kb){ const k=document.createElement('span'); k.className='kb'; k.textContent=it.kb; d.appendChild(k); }
      // Optional trailing action icon: its own click target (a separate action
      // from the row's), pinned to the right edge. stopPropagation so clicking
      // it runs the trail action, not the row's.
      if(it.trail){
        const t=document.createElement('span'); t.className='mtrail'; t.title=it.trail.title||'';
        if(it.trail.svg){ t.innerHTML=it.trail.svg; } else { t.appendChild(phIcon(it.trail.icon)); }
        t.onclick=(e)=>{ e.stopPropagation(); closeMenu(); it.trail.run(); };
        d.appendChild(t);
      }
      d.onmouseenter=()=>clearBoxesFrom(depth+1);
      d.onclick=(e)=>{ e.stopPropagation(); closeMenu(); it.run(); };
    }
    box.appendChild(d);
  }
  return box;
}
function openMenu(x, y, items){ document.getElementById('menu').innerHTML=''; menuBoxes=[]; placeBox(buildBox(items,0), x, y); }

function overflowItems(r){
  return [
    { label:'New Tab', svg:SVG_TABPLUS, run:()=>send({type:'op',root:r.root,op:'wtNewTab'}) },
    { label:'New Window', svg:SVG_WINPLUS, run:()=>send({type:'op',root:r.root,op:'wtNewWindow'}) },
    { label:'New Worktree…', icon:'git-branch', run:()=>send({type:'op',root:r.root,op:'wtNew'}) },
    // The trunk is the main checkout, not a worktree — it can't be removed here.
    ...(r.isTrunk ? [] : [{ label:'Remove Worktree…', icon:'trash', danger:true, run:()=>send({type:'op',root:r.root,op:'wtRemove'}) }]),
    { sep:true },
    { label:'Open Terminal', icon:'terminal-window', run:()=>send({type:'op',root:r.root,op:'openTerminal'}) },
    { label:'Copy Branch Name', icon:'copy', run:()=>send({type:'op',root:r.root,op:'copyBranch'}) },
    { label:'Copy Worktree Path', icon:'copy', run:()=>send({type:'op',root:r.root,op:'copyPath'}) },
    // PR link. Resolved async via gh: while the lookup is pending show a dimmed
    // spinner (which live-swaps to the link when it resolves, without reopening the
    // menu); once resolved, the row copies the link and the trailing arrow opens it.
    // A resolved "no PR" shows nothing.
    ...(r.prUrl
      ? [{ label:'Copy PR Link', icon:'copy', run:()=>send({type:'op',root:r.root,op:'copyPr'}), trail:{ icon:'arrow-square-out', title:'Open PR on GitHub', run:()=>send({type:'op',root:r.root,op:'openPr'}) } }]
      : r.prPending ? [{ pending:true, label:'Checking for PR…' }] : []),
    { sep:true },
    // Mid-rebase there is no branch to pick — the target is already fixed — so the
    // entry renames itself to the thing it can actually do. (The extension side
    // re-checks anyway: a rebase can start between this render and the click.)
    ...(r.rebase
      ? [{ label:'Resolve Rebase…', svg:SVG_REBASE, run:()=>send({type:'op',root:r.root,op:'rebaseRecover'}) }]
      : [{ label:'Rebase Branch…', svg:SVG_REBASE, run:()=>send({type:'op',root:r.root,op:'rebase'}) }]),
    { label:'Force Push (safe)', svg:SVG_FORCEPUSH, run:()=>send({type:'op',root:r.root,op:'forcePush'}) },
    { label:'Git', icon:'git-branch', sub:[
      { label:'Pull', icon:'arrow-line-down', run:()=>send({type:'op',root:r.root,op:'pull'}) },
      { label:'Push', icon:'arrow-line-up', run:()=>send({type:'op',root:r.root,op:'push'}) },
      { label:'Sync', icon:'arrows-clockwise', run:()=>send({type:'op',root:r.root,op:'sync'}) },
      { label:'Fetch', icon:'cloud-arrow-down', run:()=>send({type:'op',root:r.root,op:'fetch'}) },
      { sep:true },
      { label:'Undo Last Commit', icon:'arrow-counter-clockwise', run:()=>send({type:'op',root:r.root,op:'undo'}) },
      { label:'Redo Last Commit (reflog)', icon:'arrow-clockwise', run:()=>send({type:'op',root:r.root,op:'redo'}) },
      { sep:true },
      { label:'Stage All Changes', icon:'plus-square', run:()=>send({type:'op',root:r.root,op:'stageAll'}) },
      { label:'Unstage All Changes', icon:'minus-square', run:()=>send({type:'op',root:r.root,op:'unstageAll'}) },
      { sep:true },
      { label:'Create Pull Request', icon:'git-pull-request', run:()=>send({type:'op',root:r.root,op:'createPR'}) },
      { label:'View Git Graph', icon:'graph', run:()=>send({type:'op',root:r.root,op:'gitGraph'}) },
    ] },
  ];
}
function commitMenuItems(r){
  const items=[
    { label:'Commit', icon:'check', run:()=>doPrimaryWith(r,'none') },
    { label:'Commit & Push', icon:'arrow-line-up', run:()=>doPrimaryWith(r,'push') },
    { label:'Commit & Sync', icon:'arrows-clockwise', run:()=>doPrimaryWith(r,'sync') },
  ];
  // When there's something to sync (incoming and/or outgoing commits), a bottom
  // entry — below a divider — opens the modal listing the combined changed files.
  if(r.ahead>0 || r.behind>0){
    const n=((r.incomingFiles&&r.incomingFiles.length)||0)+((r.outgoingFiles&&r.outgoingFiles.length)||0);
    items.push({ sep:true });
    items.push({ label:(n?'View '+n+' changed file'+(n===1?'':'s'):'View changed files'), icon:'tree-structure', run:()=>openSyncModal(r.root) });
  }
  return items;
}
// Optimistic busy: spin the button the instant it's clicked (native feels
// instant); the extension's authoritative busy/busy:null messages reconcile it.
function startPrimary(r, ta){ if(busyOps[r.root]) return; const message=ta?ta.value:''; busyOps[r.root]=primaryBusyLabel(r); render(); send({type:'primary',root:r.root,action:r.primary,message}); }
function doPrimaryWith(r, then){ if(busyOps[r.root]) return; const ta=document.getElementById('ta-'+cssId(r.root)); const message=ta?ta.value:''; busyOps[r.root]='Committing…'; render(); send({type:'commit', root:r.root, message, then}); }

// ----- file tree -----
function buildTree(files){
  const root={dirs:{}, files:[]};
  for(const f of files){
    const parts=f.rel.split('/'); const name=parts.pop();
    let n=root;
    for(const p of parts){ n.dirs[p]=n.dirs[p]||{dirs:{},files:[]}; n=n.dirs[p]; }
    n.files.push(f);
  }
  return root;
}
function cssId(s){ return s.replace(/[^a-zA-Z0-9]/g,'_'); }

function statusSpan(f){ const s=document.createElement('span'); s.className='st '+f.letter; s.textContent=f.letter; return s; }
function fileIcon(f){ const s=document.createElement('span'); s.className='ic'; if(f.ic){ s.classList.add('seti'); s.textContent=f.ic; s.style.color=f.icColor; } return s; }
// Repo header title. Shows the custom name if one is set, else the branch; a trailing
// '*' marks a dirty tree. Clicking the title enters rename mode (the chevron owns folding);
// an empty name snaps back to the branch. The tooltip always shows the branch name.
// Rename-in-progress state: {root, value} while a title is being edited, else null.
// Held at module scope so a background render() (git/PR refresh pushes new state)
// rebuilds the input with the in-flight text instead of destroying the edit.
let renaming=null;
function repoTitle(r){
  if(renaming && renaming.root===r.root) return renameInput(r);
  const br=document.createElement('span'); br.className='name';
  // Only this inner span truncates; the flags after it are outside the ellipsis.
  const txt=document.createElement('span'); txt.className='ntext';
  txt.textContent=repoNames[r.root]||r.branch;
  br.appendChild(txt);
  if(r.dirty){
    const dty=document.createElement('span'); dty.className='nflag'; dty.textContent='*';
    br.appendChild(dty);
  }
  // A second '*', in the commit-button background color, means the upstream has
  // commits we haven't synced to local yet (behind>0). It sits AFTER the normal
  // dirty '*' so a box with local changes AND incoming remote work reads name*⁎.
  // Stays visible whether the box is folded or expanded — the whole point is to
  // flag pending pulls without unfolding.
  if(r.behind>0){
    const inc=document.createElement('span'); inc.className='nflag'; inc.textContent='*';
    inc.style.color='var(--vscode-button-background)';
    br.appendChild(inc);
  }
  // An interrupted rebase is otherwise invisible here — the row looks normal
  // while every git action on it misbehaves. The chip both announces the state
  // and is the shortest path out of it (click → recovery picker).
  if(r.rebase){
    const rb=document.createElement('span'); rb.className='nflag rbchip';
    const prog=r.rebase.step+'/'+r.rebase.total;
    rb.textContent='REBASING '+prog+(r.rebase.conflicts?' ⚠'+r.rebase.conflicts:'');
    rb.title=r.rebase.conflicts
      ? 'Rebase stopped at '+prog+' with '+r.rebase.conflicts+' conflicted file'+(r.rebase.conflicts===1?'':'s')+' — click to continue, abort, or hand it to Claude'
      : 'Rebase in progress ('+prog+') — click to continue, abort, or hand it to Claude';
    // stopPropagation: the title itself enters rename mode on click.
    rb.onclick=(e)=>{ e.stopPropagation(); send({type:'op',root:r.root,op:'rebaseRecover'}); };
    br.appendChild(rb);
  }
  br.style.cursor='text';
  // Only surface the branch tooltip when it adds information: a custom (renamed)
  // title hides the branch, or the label is truncated. Otherwise the tooltip would
  // just echo the visible text. Truncation is measured post-layout via rAF.
  const renamed=!!(repoNames[r.root] && repoNames[r.root]!==r.branch);
  const applyTip=()=>{ br.title=(renamed || txt.scrollWidth>txt.clientWidth) ? r.branch : ''; };
  if(renamed) br.title=r.branch; requestAnimationFrame(applyTip);
  br.onclick=(e)=>{ e.stopPropagation(); renaming={root:r.root, value:(repoNames[r.root]||r.branch)}; render(); };
  return br;
}
function renameInput(r){
  const inp=document.createElement('input'); inp.className='name rename'; inp.type='text';
  inp.value=renaming.value; inp.placeholder=r.branch;
  const commit=()=>{
    if(!renaming || renaming.root!==r.root) return;
    const v=renaming.value.trim();
    // Matching the branch (or empty) means "no custom name" — fall back to branch.
    if(v && v!==r.branch) repoNames[r.root]=v; else delete repoNames[r.root];
    // Mirror it to the extension: the orchestrator's rows and window heading
    // read the same custom name out of the broker snapshot.
    send({type:'setRepoName', root:r.root, name:repoNames[r.root]||''});
    renaming=null; persist(); render();
  };
  inp.oninput=()=>{ if(renaming) renaming.value=inp.value; };
  inp.onmousedown=(e)=>e.stopPropagation();
  inp.onclick=(e)=>e.stopPropagation();
  inp.onkeydown=(e)=>{ e.stopPropagation(); // let the input handle arrows / cmd+a / cmd+←→ natively
    if(e.key==='Enter'){ e.preventDefault(); commit(); }
    else if(e.key==='Escape'){ e.preventDefault(); renaming=null; render(); }
  };
  // Blur commits only on a genuine focus change — not when render() (e.g. a
  // background state push) tears the input out of the DOM mid-edit.
  inp.onblur=()=>{ if(!rerendering) commit(); };
  // Focus + select the whole name after this render paints the input, so the
  // user can start typing a new name right away.
  requestAnimationFrame(()=>{ if(document.body.contains(inp)){ inp.focus(); inp.select(); } });
  return inp;
}
// A single inline hover action (codicon glyph). stopPropagation so it never selects/folds.
function aicon(code, title, onClick){ const s=document.createElement('span'); s.className='a codicon'; s.textContent=code; s.title=title; s.onclick=(e)=>{ e.stopPropagation(); onClick(); }; return s; }
function spinnerIcon(){ const s=document.createElement('span'); s.className='a codicon spin'; s.textContent=CO_LOAD; s.title='Working…'; return s; }
function collectFiles(node){ let out=node.files.slice(); for(const k of Object.keys(node.dirs)) out=out.concat(collectFiles(node.dirs[k])); return out; }

// Optimistic UI: flip staged-ness locally and re-render immediately so staging
// feels instant (native does the same); the real state posted back reconciles.
function applyStaged(root, uris, staged){
  const r=repos.find(x=>x.root===root); if(!r) return;
  const set=new Set(uris);
  for(const f of r.files){ if(set.has(f.uri)) f.staged=staged; }
}
function doStage(root, uris){ if(!uris.length) return; applyStaged(root, uris, true); render(); send({type:'file', root, uris, action:'stage'}); }
function doUnstage(root, uris){ if(!uris.length) return; applyStaged(root, uris, false); render(); send({type:'file', root, uris, action:'unstage'}); }
// Discard has a required confirm modal, so it can't be optimistic — show a
// spinner on the clicked control until state (or an 'idle' signal) returns.
function doDiscard(root, uris, keys){ if(!uris.length) return; keys.forEach(k=>spinning.add(k)); render(); send({type:'file', root, uris, action:'discard'}); }

function fileRow(root, f, depth){
  const div=document.createElement('div'); div.className='row'; div.style.paddingLeft=(INDENT*depth)+'px'; if(selOf(root).has(f.uri)) div.classList.add('sel');
  div.appendChild(fileIcon(f)); // file icon occupies the 16px slot (aligns with folder chevrons)
  const lbl=document.createElement('span'); lbl.className='lbl';
  const slash=f.rel.lastIndexOf('/'); const name=slash===-1?f.rel:f.rel.slice(slash+1);
  lbl.textContent=name; lbl.title=f.rel; div.appendChild(lbl);
  const targets=()=>{ const s=selOf(root); return (s.has(f.uri)&&s.size>1)?[...s]:[f.uri]; };
  const acts=document.createElement('span'); acts.className='acts';
  if(spinning.has(f.uri)){ acts.classList.add('busy'); acts.appendChild(spinnerIcon()); }
  else {
    acts.appendChild(aicon(CO_OPEN,'Open File',()=>send({type:'file', root, uri:f.uri, untracked:f.untracked, action:'openFile'})));
    if(f.staged){
      acts.appendChild(aicon(CO_REMOVE,'Unstage Changes',()=>doUnstage(root, targets())));
    } else {
      acts.appendChild(aicon(CO_DISCARD,'Discard Changes',()=>{ const t=targets(); doDiscard(root, t, t); }));
      acts.appendChild(aicon(CO_ADD,'Stage Changes',()=>doStage(root, targets())));
    }
  }
  div.appendChild(acts);
  div.appendChild(statusSpan(f));
  div.onclick=(e)=>selectFile(root, f, e, div);
  div.ondblclick=()=>send({type:'file', root, uri:f.uri, untracked:f.untracked, action:'open'});
  return div;
}
function selectFile(root, f, e, div){
  const s=selOf(root);
  if(e.metaKey||e.ctrlKey){ s.has(f.uri)?s.delete(f.uri):s.add(f.uri); }
  else { s.clear(); s.add(f.uri); }
  render();
}

function folderActs(root, node, kind, key){
  const acts=document.createElement('span'); acts.className='acts';
  const uris=collectFiles(node).map(x=>x.uri);
  if(spinning.has(key)){ acts.classList.add('busy'); acts.appendChild(spinnerIcon()); return acts; }
  if(kind==='staged'){
    acts.appendChild(aicon(CO_REMOVE,'Unstage Changes',()=>doUnstage(root, uris)));
  } else {
    acts.appendChild(aicon(CO_DISCARD,'Discard Changes',()=>doDiscard(root, uris, [key])));
    acts.appendChild(aicon(CO_ADD,'Stage Changes',()=>doStage(root, uris)));
  }
  return acts;
}
// A "•" decoration on the right of a folder row, colored by the dominant status
// of the files it contains — same right-edge anchor as a file's status letter,
// so the hover actions sit to its left instead of drifting off the right edge.
function folderDot(node){
  const files=collectFiles(node); const set=new Set(files.map(f=>f.letter));
  let letter=''; for(const l of ['M','D','R','A','U']){ if(set.has(l)){ letter=l; break; } }
  const s=document.createElement('span'); s.className='dot '+letter; s.textContent='●';
  s.title=files.length+' change'+(files.length===1?'':'s'); return s;
}

function renderTree(container, node, root, prefix, depth, kind){
  for(const dname of Object.keys(node.dirs).sort()){
    let d=node.dirs[dname]; let label=dname;
    while(Object.keys(d.dirs).length===1 && d.files.length===0){ const only=Object.keys(d.dirs)[0]; label+='/'+only; d=d.dirs[only]; }
    const key=root+'|'+prefix+label; const collapsed=collapsedDirs.has(key);
    const row=document.createElement('div'); row.className='row'; row.style.paddingLeft=(INDENT*depth)+'px';
    const slot=document.createElement('span'); slot.className='cslot codicon'; slot.textContent=collapsed?CH_RIGHT:CH_DOWN; row.appendChild(slot);
    const lbl=document.createElement('span'); lbl.className='lbl'; lbl.textContent=label; row.appendChild(lbl); // Seti has no folder glyph
    row.appendChild(folderActs(root, d, kind, key));
    row.appendChild(folderDot(d));
    row.onclick=()=>{ collapsed?collapsedDirs.delete(key):collapsedDirs.add(key); persist(); render(); };
    container.appendChild(row);
    if(!collapsed) renderTree(container, d, root, prefix+label+'/', depth+1, kind);
  }
  for(const f of node.files) container.appendChild(fileRow(root, f, depth));
}

function renderList(container, files, root){
  for(const f of files){
    const div=fileRow(root, f, 1);
    // list mode shows the dir as a dimmed suffix
    const slash=f.rel.lastIndexOf('/');
    if(slash!==-1){ const d=document.createElement('span'); d.className='dir'; d.textContent=f.rel.slice(0,slash); div.querySelector('.lbl').appendChild(d); }
    container.appendChild(div);
  }
}

function group(box, title, gkey, files, root, kind){
  if(!files.length) return;
  const collapsed=collapsedGroups.has(gkey);
  const h=document.createElement('div'); h.className='grouphdr';
  const chev=document.createElement('span'); chev.className='chev codicon'; chev.textContent=collapsed?CH_RIGHT:CH_DOWN; h.appendChild(chev);
  const t=document.createElement('span'); t.className='gt'; t.textContent=title; h.appendChild(t);
  const acts=document.createElement('span'); acts.className='acts';
  const uris=files.map(f=>f.uri);
  if(spinning.has(gkey)){ acts.classList.add('busy'); acts.appendChild(spinnerIcon()); }
  else if(kind==='staged'){
    acts.appendChild(aicon(CO_REMOVE,'Unstage All Changes',()=>doUnstage(root, uris)));
  } else {
    acts.appendChild(aicon(CO_DISCARD,'Discard All Changes',()=>doDiscard(root, uris, [gkey])));
    acts.appendChild(aicon(CO_ADD,'Stage All Changes',()=>doStage(root, uris)));
  }
  h.appendChild(acts);
  const c=document.createElement('span'); c.className='count'; c.textContent=files.length; h.appendChild(c);
  h.onclick=()=>{ collapsed?collapsedGroups.delete(gkey):collapsedGroups.add(gkey); persist(); render(); };
  box.appendChild(h);
  if(collapsed) return;
  const wrap=document.createElement('div');
  if(viewMode==='tree') renderTree(wrap, buildTree(files), root, '', 1, kind); else renderList(wrap, files, root);
  box.appendChild(wrap);
}

// ----- sync-changes modal -----
// Which repo's sync files are being viewed, or null when closed. Held at module
// scope so a background state push (render) can refresh the open sheet.
let syncModal=null;
// Case-insensitive substring, matched against each file's full repo-relative path
// (so "migration" surfaces app/migrations/0001.py). Reset each time the modal opens.
let syncFilter='';
function openSyncModal(root){ syncModal=root; syncFilter=''; renderModal(); }
function closeSyncModal(){ if(syncModal===null) return; syncModal=null; syncFilter=''; renderModal(); }
function filterSyncFiles(files){
  const q=syncFilter.trim().toLowerCase();
  if(!q) return files;
  return files.filter(f=>f.rel.toLowerCase().indexOf(q)!==-1);
}
// A file row inside the modal: icon + name + status letter, no stage/discard
// actions — clicking opens that side's combined diff (merge-base to side tip).
// dir is 'in' (incoming/pull) or 'out' (outgoing/push).
function syncFileRow(root, f, dir, depth){
  const div=document.createElement('div'); div.className='row'; div.style.paddingLeft=(INDENT*depth)+'px';
  div.appendChild(fileIcon(f));
  const lbl=document.createElement('span'); lbl.className='lbl';
  const slash=f.rel.lastIndexOf('/'); lbl.textContent=slash===-1?f.rel:f.rel.slice(slash+1); lbl.title=f.rel;
  div.appendChild(lbl);
  div.appendChild(statusSpan(f));
  div.onclick=()=>send({type:'syncDiff', root, uri:f.uri, dir});
  return div;
}
function syncRenderList(container, files, root, dir){
  for(const f of files){
    const div=syncFileRow(root, f, dir, 1);
    const slash=f.rel.lastIndexOf('/');
    if(slash!==-1){ const d=document.createElement('span'); d.className='dir'; d.textContent=f.rel.slice(0,slash); div.querySelector('.lbl').appendChild(d); }
    container.appendChild(div);
  }
}
// forceExpand ignores collapsedDirs (used while a filter is active) so every
// branch containing a match is shown expanded down to the matched files.
function syncRenderTree(container, node, root, dir, prefix, depth, forceExpand){
  for(const dname of Object.keys(node.dirs).sort()){
    let d=node.dirs[dname]; let label=dname;
    while(Object.keys(d.dirs).length===1 && d.files.length===0){ const only=Object.keys(d.dirs)[0]; label+='/'+only; d=d.dirs[only]; }
    // Distinct key namespace (per direction) so folding never collides with the pane's tree.
    const key=root+'|SYNC'+dir+'|'+prefix+label; const collapsed=forceExpand?false:collapsedDirs.has(key);
    const row=document.createElement('div'); row.className='row'; row.style.paddingLeft=(INDENT*depth)+'px';
    const slot=document.createElement('span'); slot.className='cslot codicon'; slot.textContent=collapsed?CH_RIGHT:CH_DOWN; row.appendChild(slot);
    const lbl=document.createElement('span'); lbl.className='lbl'; lbl.textContent=label; row.appendChild(lbl);
    row.appendChild(folderDot(d));
    row.onclick=()=>{ collapsed?collapsedDirs.delete(key):collapsedDirs.add(key); persist(); renderModal(); };
    container.appendChild(row);
    if(!collapsed) syncRenderTree(container, d, root, dir, prefix+label+'/', depth+1, forceExpand);
  }
  for(const f of node.files) container.appendChild(syncFileRow(root, f, dir, depth));
}
// One collapsible section (Incoming ↓ / Outgoing ↑). Rendered only when it has files.
function syncSection(body, root, title, glyph, count, files, dir, forceExpand){
  if(!files.length) return;
  const h=document.createElement('div'); h.className='grouphdr';
  const g=document.createElement('span'); g.className='gt'; g.textContent=glyph+' '+title; h.appendChild(g);
  const c=document.createElement('span'); c.className='count'; c.textContent=count; h.appendChild(c);
  body.appendChild(h);
  if(viewMode==='tree') syncRenderTree(body, buildTree(files), root, dir, '', 1, forceExpand);
  else syncRenderList(body, files, root, dir);
}
// Fills the results container below the filter input: the (filtered) Incoming
// and Outgoing sections, or a "no matches" note when the filter excludes all.
function renderSyncResults(container, r){
  container.innerHTML='';
  const fe=syncFilter.trim().length>0;
  const inc=filterSyncFiles(r.incomingFiles||[]);
  const out=filterSyncFiles(r.outgoingFiles||[]);
  if(fe && !inc.length && !out.length){
    const e=document.createElement('div'); e.className='empty'; e.textContent='No files match “'+syncFilter.trim()+'”.'; container.appendChild(e); return;
  }
  syncSection(container, r.root, 'Incoming', '↓', r.behind, inc, 'in', fe);
  syncSection(container, r.root, 'Outgoing', '↑', r.ahead, out, 'out', fe);
}
function renderModal(){
  const host=document.getElementById('modal');
  // Preserve the filter input's focus + caret across full re-renders (a background
  // state push also calls renderModal); otherwise typing in it would drop focus.
  // wasOpen distinguishes a closed→open transition (focus the input) from a
  // re-render (leave focus alone, so a background push never steals it).
  const wasOpen=!!host.querySelector('.ovl');
  const prevFocus=document.activeElement;
  const keepFocus=!!(prevFocus && prevFocus.classList && prevFocus.classList.contains('sfilter'));
  const caret=keepFocus?prevFocus.selectionStart:null;
  host.innerHTML='';
  if(syncModal===null) return;
  const r=repos.find(x=>x.root===syncModal);
  // Repo gone or nothing left to sync → dismiss.
  if(!r || !(r.ahead>0 || r.behind>0)){ syncModal=null; return; }
  const incoming=r.incomingFiles||[], outgoing=r.outgoingFiles||[];
  const ov=document.createElement('div'); ov.className='ovl';
  ov.onclick=(e)=>{ if(e.target===ov) closeSyncModal(); };
  const sheet=document.createElement('div'); sheet.className='sheet';
  const hd=document.createElement('div'); hd.className='shd';
  const title=document.createElement('span'); title.className='stitle'; title.textContent='Changes to sync'; hd.appendChild(title);
  const sub=document.createElement('span'); sub.className='ssub'; sub.textContent='on '+(repoNames[r.root]||r.branch); hd.appendChild(sub);
  const x=document.createElement('span'); x.className='sclose codicon'; x.textContent=CO_CLOSE; x.title='Close'; x.onclick=closeSyncModal; hd.appendChild(x);
  sheet.appendChild(hd);
  const body=document.createElement('div'); body.className='sbody';
  // Distinguish "still loading" from "loaded, but the commits touch no files"
  // (e.g. an empty commit) — otherwise this would sit on "Computing changes…"
  // forever whenever a sync has no file-level diff.
  if(r.syncPending){ const e=document.createElement('div'); e.className='empty'; e.textContent='Computing changes…'; body.appendChild(e); }
  else if(!incoming.length && !outgoing.length){
    const e=document.createElement('div'); e.className='empty';
    const n=(r.behind||0)+(r.ahead||0);
    e.textContent='No file changes — '+n+' commit'+(n===1?'':'s')+' to sync touch'+(n===1?'es':'')+' no files.';
    body.appendChild(e);
  }
  else {
    const search=document.createElement('input'); search.type='text'; search.className='sfilter';
    search.placeholder='Filter by path…'; search.value=syncFilter; search.spellcheck=false;
    const results=document.createElement('div'); results.className='sresults';
    search.oninput=()=>{ syncFilter=search.value; renderSyncResults(results, r); };
    body.appendChild(search); body.appendChild(results);
    renderSyncResults(results, r);
  }
  sheet.appendChild(body);
  ov.appendChild(sheet);
  host.appendChild(ov);
  const inp=host.querySelector('.sfilter');
  if(inp){
    if(keepFocus){ inp.focus(); if(caret!=null){ try{ inp.setSelectionRange(caret,caret); }catch(_e){} } }
    else if(!wasOpen){ inp.focus(); } // focus on a fresh open
  }
}

// ----- native-style tooltips -----
// Mirrors VS Code's WorkbenchHoverDelegate: 250ms hover delay
// (workbench.hover.delay default), but 0ms if another hover hid < 200ms ago, so
// gliding across adjacent targets is instant. Reading the element's own title
// (and stripping it) both drives the text and suppresses the slow OS tooltip.
let tipEl=null, tipTimer=null, tipLastHide=0, tipTarget=null;
function tipText(el){ return el.getAttribute('data-tip') || el.getAttribute('title'); }
function hideTip(){ if(tipTimer){ clearTimeout(tipTimer); tipTimer=null; } if(tipEl && tipEl.style.display!=='none'){ tipEl.style.display='none'; tipLastHide=Date.now(); } tipTarget=null; }
function showTip(el){
  const text=tipText(el); if(!text) return;
  if(!tipEl){ tipEl=document.createElement('div'); tipEl.className='ah-tip'; document.body.appendChild(tipEl); }
  tipEl.textContent=text; tipEl.style.display='block'; tipEl.style.left='0px'; tipEl.style.top='0px';
  const r=el.getBoundingClientRect(), w=tipEl.offsetWidth, h=tipEl.offsetHeight, EDGE=6;
  let x=r.left, y=r.bottom+4;
  if(y+h>vh()-EDGE){ y=Math.max(EDGE, r.top-h-4); } // flip above when there's no room below
  x=Math.max(EDGE, Math.min(x, vw()-w-EDGE));
  tipEl.style.left=x+'px'; tipEl.style.top=y+'px';
}
document.addEventListener('pointerover', e=>{
  const el=e.target.closest ? e.target.closest('[title],[data-tip]') : null;
  if(!el || el===tipTarget) return;
  if(tipTarget) hideTip(); // switching targets records a hide → next one shows instantly
  if(el.hasAttribute('title')){ el.setAttribute('data-tip', el.getAttribute('title')); el.removeAttribute('title'); }
  tipTarget=el;
  const delay=(Date.now()-tipLastHide<200)?0:250;
  tipTimer=setTimeout(()=>{ if(tipTarget===el && el.isConnected) showTip(el); }, delay);
});
document.addEventListener('pointerout', e=>{
  if(!tipTarget) return;
  const to=e.relatedTarget;
  if(to && tipTarget.contains(to)) return; // moved to a child — still hovering
  if(!(to && to.closest && to.closest('[title],[data-tip]'))) hideTip();
});
document.addEventListener('pointerdown', hideTip, true);
window.addEventListener('scroll', hideTip, true);

// Distinct per-status dots for Claude tabs. Attention states (working/question/
// plan/permission) pulse; "done" (finished, unseen) is a solid green; idle is a
// hollow muted ring. Unknown statuses fall back to idle.
const CLAUDE_STATUS = {
  working:    { color:'#3B82F6', label:'Working…',            pulse:true },
  question:   { color:'#F59E0B', label:'Asking a question',   pulse:true },
  plan:       { color:'#A855F7', label:'Plan ready to review',pulse:true },
  permission: { color:'#EF4444', label:'Awaiting permission', pulse:true },
  done:       { color:'#22C55E', label:'Finished (unseen)',   pulse:false },
  idle:       { color:'',        label:'Idle',                pulse:false, hollow:true },
};
function claudeStatusMeta(s){ return CLAUDE_STATUS[s] || CLAUDE_STATUS.idle; }
// Phase-lock a CSS keyframe animation to a shared monotonic clock. renderBody()
// rebuilds the whole list on every status/focus change, so a spinner's DOM node is
// recreated constantly — and a fresh node restarts its animation at 0, which reads
// as the ring jerkily snapping back mid-spin. Setting a negative animation-delay
// equal to how far into the current cycle the shared clock is makes the new node
// resume exactly where the old one left off, so the rotation looks continuous no
// matter how often we repaint. periodMs must equal the CSS animation-duration
// (ah-spin is 0.8s, so 800). The value is negative so the animation is already
// partway through when it mounts. (Comment kept backtick-free: this whole script
// lives inside a template literal.)
function phaseDelay(periodMs){
  const t=(typeof performance!=='undefined'&&performance.now)?performance.now():Date.now();
  return (-(t%periodMs)/1000)+'s';
}
// The status indicator: a gray spinner while working, a green check when finished
// (unseen), else a colored dot (pulsing for attention states, hollow for idle).
function statusIndicator(status, meta){
  // Every icon lives in a fixed-size centered slot so spinner/dot/check line up
  // vertically across rows despite their different intrinsic sizes.
  const slot=document.createElement('span'); slot.className='cstat';
  let icon;
  if(status==='working'){ icon=document.createElement('span'); icon.className='cspin'; icon.style.animationDelay=phaseDelay(800); }
  else if(status==='done'){ icon=document.createElement('span'); icon.className='ccheck'; icon.innerHTML=SVG_CHECKFAT; }
  // Any attention state (question / plan / permission) shows a sticky orange "?"
  // until it's answered — the specific kind isn't worth distinguishing here.
  else if(!meta.hollow){ icon=document.createElement('span'); icon.className='cask'; icon.textContent='?'; }
  // Idle shows no icon: a bare ring reads too much like the spinner and says
  // nothing meaningful. The empty slot still holds width so titles stay aligned.
  if(icon) slot.appendChild(icon);
  return slot;
}
// Generic vertical drag-to-reorder for a list of sibling elements. Purely a
// presentation concern — the caller persists the new order and re-renders; the
// underlying tabs/worktrees are never touched. While dragging, the grabbed
// element follows the pointer and the others slide out of its way with a short
// transition (FLIP-lite). A drag only begins past a small threshold, so plain
// clicks (focus / fold) still work; a real drag suppresses the trailing click.
//   handle  - element you press to start (row itself, or a chevron)
//   moveEl  - element that actually moves (and defines a list item)
//   opts    - { container, itemSelector, idOf(el), onCommit(orderedIds),
//               canDrag(moveEl)?, minIndex(items)? }
function makeReorderable(handle, moveEl, opts){
  handle.style.touchAction='none';
  handle.addEventListener('pointerdown', (e)=>{
    if(e.button!==0) return;
    if(e.target.closest('input,textarea,button')) return;
    if(opts.canDrag && !opts.canDrag(moveEl)) return;
    const startX=e.clientX, startY=e.clientY;
    let started=false, items=null, boxes=null, idx=-1, step=1, minIdx=0, newIdx=-1;
    const onMove=(ev)=>{
      const dy=ev.clientY-startY;
      if(!started){
        if(Math.abs(dy)<4 && Math.abs(ev.clientX-startX)<4) return;
        items=Array.prototype.filter.call(opts.container.children, c=>c.matches&&c.matches(opts.itemSelector));
        idx=items.indexOf(moveEl);
        if(idx<0) return; // moveEl isn't one of the list's own items — nothing to reorder
        started=true;
        // Items are NOT uniform in height: a worktree box grows with its file list,
        // and a session row grows again when its workflow accordion is open. So
        // positions come from each item's own measured box instead of one shared row
        // height. Measured once, at drag start — the transforms applied below would
        // otherwise feed straight back into the next reading.
        boxes=items.map(it=>{ const b=it.getBoundingClientRect(); return { top:b.top, mid:b.top+b.height/2, bottom:b.top+b.height }; });
        const r0=boxes[idx];
        // step is how far every DISPLACED item travels, and that is the dragged
        // item's own height plus the gap: after a swap the neighbour sits exactly
        // where the dragged item started, which is that far away.
        let gap=0;
        if(boxes[idx+1]) gap=boxes[idx+1].top-r0.bottom;
        else if(boxes[idx-1]) gap=r0.top-boxes[idx-1].bottom;
        step=(r0.bottom-r0.top)+Math.max(0,gap);
        minIdx=opts.minIndex?opts.minIndex(items):0;
        moveEl.classList.add('dragging');
        for(const it of items){ if(it!==moveEl) it.style.transition='transform .18s ease'; }
        document.body.classList.add('reordering');
      }
      moveEl.style.transform='translateY('+dy+'px)';
      // Claim a slot once the dragged box's leading edge passes a neighbour's
      // midpoint. A single Math.round(dy/step) instead assumed every item was the
      // dragged one's height: an expanded row would not move until the pointer had
      // travelled its own (much larger) height, and a collapsed row dragged past an
      // expanded one jumped several slots at once.
      const r=boxes[idx];
      newIdx=idx;
      if(dy>0){ for(let i=idx+1;i<boxes.length;i++){ if(boxes[i].mid<=r.bottom+dy) newIdx=i; } }
      else if(dy<0){ for(let i=idx-1;i>=0;i--){ if(boxes[i].mid>=r.top+dy) newIdx=i; } }
      if(newIdx<minIdx) newIdx=minIdx;
      for(let i=0;i<items.length;i++){
        const it=items[i]; if(it===moveEl) continue;
        let shift=0;
        if(idx<newIdx && i>idx && i<=newIdx) shift=-step;
        else if(idx>newIdx && i<idx && i>=newIdx) shift=step;
        it.style.transform= shift? 'translateY('+shift+'px)':'';
      }
    };
    const onUp=()=>{
      document.removeEventListener('pointermove',onMove);
      document.removeEventListener('pointerup',onUp);
      if(!started) return;
      document.body.classList.remove('reordering');
      if(newIdx<0) newIdx=idx;
      const order=items.map(it=>opts.idOf(it));
      order.splice(newIdx, 0, order.splice(idx,1)[0]);
      // Kill the click that follows the pointerup so a reorder never focuses/folds.
      const kill=(ce)=>{ ce.stopPropagation(); ce.preventDefault(); document.removeEventListener('click',kill,true); };
      document.addEventListener('click',kill,true);
      setTimeout(()=>document.removeEventListener('click',kill,true),350);
      opts.onCommit(order);
    };
    document.addEventListener('pointermove',onMove);
    document.addEventListener('pointerup',onUp);
  });
}
// Apply the persisted session-box order for a repo: known ids in saved order
// first, any new sessions kept in their natural (backend) order after.
function orderedTabs(r){
  const tabs=r.claudeTabs.slice();
  const ord=tabOrder[r.root];
  if(!ord || !ord.length) return tabs;
  const pos=new Map(ord.map((sid,i)=>[sid,i]));
  return tabs
    .map((t,i)=>[t,i])
    .sort((a,b)=>{
      const pa=pos.has(a[0].sessionId)?pos.get(a[0].sessionId):1e9;
      const pb=pos.has(b[0].sessionId)?pos.get(b[0].sessionId):1e9;
      return pa!==pb ? pa-pb : a[1]-b[1];
    })
    .map(x=>x[0]);
}
// ----- dynamic-workflow progress (WORKFLOW-PROGRESS.md §3.4) -----
// t.wf is the WorkflowRun that claudeStatus.ts already parsed off the tab
// descriptor: { taskId, name, status, activity, planned:[title...],
// phases:[{index,title}], agents:[{index, phaseIndex, label, state,
// lastToolName, resultPreview, cached, startedAt, durationMs}] }. It is ABSENT on
// the overwhelming majority of rows — no workflow, or an unpatched Claude — and
// everything below is written so that absence costs a row nothing at all.
// (No backticks anywhere in this section: the whole script is a template literal.)
const WF_MAX_SQUARES = 12; // above this the strip degrades to a count — risk #10
const WF_STATE_LABEL = { pending:'not started', active:'running', done:'done',
  failed:'failed', cached:'reused from a previous run' };
// Trailing marker on a phase that will not change again. Cached gets its own
// glyph rather than a second green check, so a resumed run is legible as reused.
const WF_END_GLYPH = { done:'✓', failed:'✕', cached:'⟲' };

// = MAX_PROJECTED_PHASES in workflowProgress.ts: the hard cap on how many phases a
// projection can carry, and therefore on how long a strip can legitimately be.
const WF_MAX_PHASES = 32;
// A phase NUMBER, or 0 for anything that cannot be one. Mirrors phaseNo() in
// workflowProgress.ts, and it is a guard rather than a formality: phaseIndex is
// copied verbatim out of Claude's broadcast by the injected projection, so it is as
// untrusted here as any other field crossing the patch boundary.
//
// A fraction is the dangerous one. 1.5 passed the old less-than-1 test, then
// out[0.5] was undefined and reading .agents off it THREW — inside
// renderClaudeTabs, which has no
// try/catch above it and runs after renderBody() has already emptied rootEl, so one
// bad projection blanked the whole pane (every worktree box, every commit box, every
// file list) until some later post happened to succeed. A huge value is the other:
// phaseIndex 20000 built 20000 squares, and with the accordion open 20000 DOM rows,
// on every repaint. 0 means "no phase", which lands the agent in the orphan bucket —
// still visible, filed under nothing it doesn't belong to.
function wfPhaseNo(v){
  return (typeof v==='number' && Number.isInteger(v) && v>=1 && v<=WF_MAX_PHASES) ? v : 0;
}
// Group a run's agents into one bucket per square, in phase order.
//
// This is the webview's copy of derivePhaseStates() in workflowProgress.ts. That
// one is the unit-tested reference and this one has to keep matching it; the copy
// exists because the accordion needs the agents themselves and not just the
// per-phase verdict, and because an injected sibling of this script cannot import
// from the extension. The three rules that must not drift: the strip is
// max(planned, observed) long, it GROWS for a phase we only learn about from an
// agent citing it (risk #8), and agents with no phaseIndex — a script that never
// called phase() — collect into a synthetic trailing bucket instead of vanishing,
// because work that ran must be visible somewhere.
function wfBuckets(wf){
  const phases=wf.phases||[], planned=wf.planned||[], agents=wf.agents||[];
  let observed=0;
  for(const p of phases){ const i=wfPhaseNo(p.index); if(i>observed) observed=i; }
  const out=[];
  const push=()=>out.push({ title:'', agents:[], orphan:false, state:'pending' });
  for(let i=0;i<Math.max(Math.min(planned.length, WF_MAX_PHASES), observed);i++) push();
  const orphans=[];
  for(const a of agents){
    const pi=wfPhaseNo(a.phaseIndex);
    if(!pi){ orphans.push(a); continue; }
    while(out.length<pi) push();
    out[pi-1].agents.push(a);
  }
  for(const p of phases){ const i=wfPhaseNo(p.index); if(i>=1 && i<=out.length) out[i-1].title=p.title||''; }
  if(orphans.length) out.push({ title:'Agents', agents:orphans, orphan:true, state:'pending' });
  for(let i=0;i<out.length;i++){
    const b=out[i];
    // The announced title wins, then meta's table of contents, then the ordinal —
    // a phase can be observed before meta listed it, and vice versa.
    if(!b.title) b.title = (!b.orphan && planned[i]) ? planned[i] : ('Phase '+(i+1));
    b.state=wfPhaseState(b.agents, wf);
  }
  return out;
}
// Mirrors bucketState() in workflowProgress.ts, with one UI-only refinement:
// a phase every one of whose agents was replayed on resume is reported as
// 'cached' rather than 'done', which the derivation layer has no reason to
// distinguish but the strip does (risk #7). Rule order matters — a phase holding
// both an errored and a live agent reads failed.
//
// The run's own wf.status is what stops the pulse (risk #12). A killed or
// interrupted run says so through task_notification and NOT through a final
// progress array — the CLI marks the task terminal before aborting its agents,
// after which its batcher drops everything — so the newest array we hold still
// shows the aborted agent at 'start'/'progress'. Deriving from agent state alone
// left that square pulsing and its elapsed counter climbing until the run aged
// out of the webview's map entirely. Once the run has ended, work still shown as
// unfinished was abandoned and reads as the run's own verdict; phases that did
// finish keep theirs, since a completed phase inside a failed run is still one.
function wfPhaseState(agents, wf){
  if(!agents.length) return 'pending';
  if(agents.some(a=>a.state==='error')) return 'failed';
  if(!agents.every(a=>a.state==='done')){
    if(!wfEnded(wf)) return 'active';
    return wf.status==='completed' ? 'done' : 'failed';
  }
  return agents.every(a=>a.cached) ? 'cached' : 'done';
}
// Has the run stopped emitting for good? Written defensively because wf crosses
// the patch boundary: an older patched bundle can hand us a projection with no
// status at all, and "unknown" must read as still running rather than as ended.
function wfEnded(wf){ return !!wf && !!wf.status && wf.status!=='running'; }
// Wall-clock span of a phase, NOT the sum of its agents' durations: a pipeline()
// fan-out runs its agents concurrently, so summing would report several times the
// time that actually passed. Falls back to the longest single agent when nobody
// reported a startedAt to span between.
function wfPhaseMs(agents){
  let lo=Infinity, hi=-Infinity, longest=0;
  for(const a of agents){
    const d=(typeof a.durationMs==='number')?a.durationMs:0;
    if(d>longest) longest=d;
    if(typeof a.startedAt==='number'){
      if(a.startedAt<lo) lo=a.startedAt;
      if(a.startedAt+d>hi) hi=a.startedAt+d;
    }
  }
  return hi>lo ? hi-lo : longest;
}
// Compact duration: seconds under a minute, whole minutes under an hour, h+m
// above. Floored rather than rounded so a live counter only ever moves forward.
function wfDur(ms){
  if(!(ms>0)) return '';
  const s=Math.floor(ms/1000);
  if(s<60) return s+'s';
  const m=Math.floor(s/60);
  return m<60 ? m+'m' : (Math.floor(m/60)+'h '+(m%60)+'m');
}
// A counter that advances on its own. The value is recomputed from startedAt by
// the single shared ticker below, so elapsed time moves without a host round-trip
// and without re-rendering the pane once a second.
function wfElapsed(startedAt){
  const el=document.createElement('span'); el.className='wel';
  el.dataset.sa=String(startedAt); el.textContent=wfDur(Date.now()-startedAt);
  return el;
}
// ONE interval for the whole pane, ever. renderBody() discards and rebuilds the
// DOM several times a minute, so an interval created per row — or per render —
// would pile up invisibly and keep firing against detached nodes. This one hangs
// off a module-level handle, is started only once a live counter is actually on
// screen, and stops itself the moment the last one goes away (a finished run, a
// collapsed accordion, or a closed tab all end it).
let wfClock=null;
function wfTickClock(){
  const els=document.querySelectorAll('.wel[data-sa]');
  if(!els.length){ clearInterval(wfClock); wfClock=null; return; }
  const now=Date.now();
  els.forEach(el=>{ el.textContent=wfDur(now-Number(el.dataset.sa)); });
}
function wfStartClock(){ if(wfClock===null) wfClock=setInterval(wfTickClock, 1000); }

function wfSquare(b){
  const sq=document.createElement('span'); sq.className='wsq '+b.state;
  // The active square is the pane's other animated node, so it needs phaseDelay()
  // for exactly the reason .cspin does — see the comment there. renderBody() throws
  // this node away and builds a new one on every status/projection change, which
  // during a workflow is more often than the 1.4s pulse period, and a fresh node
  // restarts ah-pulse at 0% = full opacity: the square never completed a fade and
  // read as a stutter instead of a pulse. 1400 MUST equal the CSS animation-duration
  // of .wsq.active.
  if(b.state==='active') sq.style.animationDelay=phaseDelay(1400);
  sq.title=b.title+' — '+WF_STATE_LABEL[b.state];
  return sq;
}
// The run's own verdict, rendered next to the strip once the run is over.
//
// This exists because the header's OTHER end — statusIndicator() — reports the
// SESSION, and the two are different facts about the row. A workflow's result lands
// back in the main loop, which then works on it: in the run this was written for,
// seven minutes of it. For those seven minutes the strip was six green squares and
// the indicator was a spinner, and there was nothing on the row that said the run
// itself had finished — "all squares green" is also what the last phase looks like
// between its agents finishing and the next phase's spawning. So the run says so
// itself, here, where the strip it belongs to is.
//
// Reads wf.status, not the buckets: a phase that failed inside a run the script went
// on to complete is the red square's business, and the run's verdict is the run's.
// Nothing is rendered while the run is live — the pulsing square is that state.
function wfRunEnd(wf){
  if(!wfEnded(wf)) return null;
  const st = wf.status==='completed' ? 'done' : 'failed';
  const g=document.createElement('span'); g.className='wrend '+st;
  g.textContent=WF_END_GLYPH[st];
  g.title='workflow '+(st==='done'?'completed':'failed')+' — '+(wf.name||'');
  return g;
}
// The collapsed row's strip: one square per phase, between the title and the
// status indicator.
function wfStrip(wf, buckets){
  const strip=document.createElement('span'); strip.className='wstrip';
  if(wf.activity) strip.title=wf.activity;
  // Overflow guard (risk #10): a pipeline() over a discovered work-list can declare
  // dozens of phases, and forty squares would crush the title out of the row. Past
  // the cap we show the frontier instead — the two phases before the one in flight,
  // plus a reached/total count.
  if(buckets.length>WF_MAX_SQUARES){
    let frontier=-1;
    for(let i=0;i<buckets.length;i++){ if(buckets[i].state!=='pending') frontier=i; }
    const from=Math.max(0, frontier-2);
    for(let i=from;i<=Math.max(frontier, from);i++) strip.appendChild(wfSquare(buckets[i]));
    const c=document.createElement('span'); c.className='wcount';
    c.textContent=(frontier+1)+'/'+buckets.length; strip.appendChild(c);
    return strip;
  }
  for(const b of buckets) strip.appendChild(wfSquare(b));
  return strip;
}
// Is this phase's agent list showing? The automatic layout — the phase in flight
// expanded, every other phase a one-liner — unless the user said otherwise about
// THIS phase on THIS run, in which case what they said wins outright. A failed
// phase counts as in flight for the automatic layout: it is precisely the one
// whose agents you want to see, and collapsing it on completion would hide the
// failure behind a truncated preview.
//
// The override stores the state the user WANTS, not a bit that inverts the
// automatic one. An inverting bit is wrong because auto moves underneath it:
// closing the running phase, then letting the run finish, flips auto true->false
// and would re-expand the phase the user just closed (and worse, an inverted bit
// on a phase that then FAILS would hide the failure the 'failed' branch above
// exists to keep visible). A remembered "closed" stays closed through both.
function wfPhaseIsOpen(sid, wf, i, state){
  const auto = state==='active' || state==='failed';
  const ent = wfPhaseOv[sid];
  if(ent && ent.task===wf.taskId && ent.want.has(i)) return ent.want.get(i);
  return auto;
}
// open is the phase's current on-screen state, handed in by the caller that just
// rendered it — so the click means "give me the other one" and is recorded as a
// desired state rather than as a flip.
function wfTogglePhase(sid, wf, i, open){
  let ent=wfPhaseOv[sid];
  // A different taskId means a new run: the previous run's overrides say nothing
  // about this one, so they go rather than accumulate.
  if(!ent || ent.task!==wf.taskId){ ent=wfPhaseOv[sid]={ task:wf.taskId, want:new Map() }; }
  ent.want.set(i, !open);
  render();
}
// wf is the run the agent belongs to, and it decides whether this line is live:
// an agent still shown as unfinished inside an ended run was abandoned (see
// wfPhaseState), so it gets neither the word "running…" nor a self-advancing
// counter. The counter matters beyond wording — wfTickClock only stops once the
// last .wel[data-sa] is gone, so a single stale row kept a 1 s interval alive and
// counting for the whole life of the webview.
function wfAgentLine(a, wf){
  const row=document.createElement('div'); row.className='wag'+(a.cached?' cached':'');
  const ended=wfEnded(wf);
  if(a.cached){
    const g=document.createElement('span'); g.className='wend cached'; g.textContent=WF_END_GLYPH.cached;
    g.title='reused from a previous run'; row.appendChild(g);
  }
  const label=document.createElement('span'); label.className='wal';
  label.textContent=a.label||('agent '+a.index); row.appendChild(label);
  const tool=document.createElement('span'); tool.className='wat';
  tool.textContent = a.state==='error' ? 'failed'
    : a.cached ? 'reused'
    : a.state==='done' ? (a.lastToolName || 'done')
    : ended ? 'stopped'
    : (a.lastToolName || 'running…');
  row.appendChild(tool);
  // A live agent counts up from its own startedAt; a finished or abandoned one
  // shows the duration the runner measured, if it got as far as reporting one,
  // and never moves again.
  if(!ended && a.state!=='done' && a.state!=='error' && typeof a.startedAt==='number'){
    row.appendChild(wfElapsed(a.startedAt));
  } else {
    const d=wfDur((typeof a.durationMs==='number')?a.durationMs:0);
    if(d){ const s=document.createElement('span'); s.className='wel'; s.textContent=d; row.appendChild(s); }
  }
  return row;
}
function wfAccordion(t, buckets){
  const acc=document.createElement('div'); acc.className='wacc';
  // The row is BOTH makeReorderable's drag handle and its own focus-the-tab click
  // target, so every pointer event that lands in the accordion has to stop here —
  // otherwise reading a phase line would start a reorder (pointerdown is what
  // makeReorderable listens on) or yank editor focus (click). Descendant handlers
  // still run: they fire on the way up, before this one. closeMenu() is called by
  // hand because the click that would normally reach the document listener no
  // longer gets there.
  acc.addEventListener('pointerdown', e=>e.stopPropagation());
  acc.onmousedown=e=>e.stopPropagation();
  acc.onclick=e=>{ e.stopPropagation(); closeMenu(); };
  for(let i=0;i<buckets.length;i++){
    const b=buckets[i], open=wfPhaseIsOpen(t.sessionId, t.wf, i, b.state);
    const line=document.createElement('div'); line.className='wph'+(b.state==='pending'?' pending':'');
    line.appendChild(wfSquare(b));
    const title=document.createElement('span'); title.className='wpt'; title.textContent=b.title;
    line.appendChild(title);
    if(b.agents.length){
      const dur=wfDur(wfPhaseMs(b.agents));
      const m=document.createElement('span'); m.className='wpm';
      m.textContent=b.agents.length+' agent'+(b.agents.length===1?'':'s')+(dur?' · '+dur:'');
      line.appendChild(m);
    }
    // A phase you are no longer watching collapses to the one line worth keeping:
    // its last agent's result. Always appended (empty when there is nothing to
    // say) because it is also the flexible gap that right-aligns the end glyph.
    const last=b.agents[b.agents.length-1];
    const prev=document.createElement('span'); prev.className='wpr';
    prev.textContent=(!open && last && last.resultPreview) ? last.resultPreview : '';
    if(prev.textContent) prev.title=prev.textContent;
    line.appendChild(prev);
    const glyph=WF_END_GLYPH[b.state];
    if(glyph){ const g=document.createElement('span'); g.className='wend '+b.state; g.textContent=glyph; line.appendChild(g); }
    // Nothing to reveal under a phase that has not started.
    if(b.state!=='pending') line.onclick=()=>wfTogglePhase(t.sessionId, t.wf, i, open);
    acc.appendChild(line);
    if(open){ for(const a of b.agents) acc.appendChild(wfAgentLine(a, t.wf)); }
  }
  return acc;
}
function wfChevron(t, open){
  const ch=document.createElement('span'); ch.className='wchev codicon'; ch.textContent=open?CH_DOWN:CH_RIGHT;
  ch.title=(open?'Hide':'Show')+' workflow progress — '+t.wf.name;
  // Three separate stops, because they are three separate events and only one of
  // them is the drag (risk #13): pointerdown is what makeReorderable starts from,
  // mousedown is what moves focus, and click is what focuses the Claude tab.
  // beginRenameTab dodges the identical trap by being an <input>, which
  // makeReorderable explicitly skips; a span has to say so itself.
  ch.addEventListener('pointerdown', e=>e.stopPropagation());
  ch.onmousedown=e=>e.stopPropagation();
  ch.onclick=e=>{
    e.stopPropagation(); closeMenu();
    if(wfOpen.has(t.sessionId)) wfOpen.delete(t.sessionId); else wfOpen.add(t.sessionId);
    persist(); render();
  };
  return ch;
}
function renderClaudeTabs(body, r){
  if(!r.claudeTabs || !r.claudeTabs.length) return;
  const wrap=document.createElement('div'); wrap.className='claudetabs';
  let ticking=false;
  for(const t of orderedTabs(r)){
    const meta=claudeStatusMeta(t.status);
    const row=document.createElement('div'); row.className='ctab'+(t.active?' ctab-active':''); row.dataset.sid=t.sessionId;
    // A run with no phase or agent yet gets no chevron and no strip: buckets is
    // empty, so such a row — like every row with no workflow at all — appends the
    // same two children it always has and is byte-identical to what it renders
    // today (§3.4: no reserved slot, no reflow).
    //
    // The try/catch is not defensive habit, it is blast radius. We run after
    // renderBody() has already emptied rootEl and nothing above us catches, so a
    // throw in the workflow code takes out the ENTIRE pane — every worktree box,
    // every commit box, every file list — not just this strip, and leaves it blank
    // until some later post happens to succeed. wfPhaseNo makes wfBuckets total in
    // the index it was actually bitten by — a phaseIndex that cannot be an array
    // slot — but not unconditionally so: a null entry in agents[] still throws, and
    // nothing stops a future field from doing the same. parseWfProjection cannot
    // emit either, so this should not fire in practice; when something across the
    // patch boundary proves otherwise, the row loses its chevron and the pane
    // survives.
    let buckets=null;
    try { buckets=t.wf?wfBuckets(t.wf):null; } catch(e){ buckets=null; }
    const hasWf=!!buckets && buckets.length>0;
    const open=hasWf && wfOpen.has(t.sessionId);
    // A workflow row puts its header children in their own fixed-height line, so the
    // accordion appearing below cannot move them (see .ctab.wfrow / .ctabhdr). Rows
    // with no workflow append straight to the row exactly as they always have — the
    // wrapper is not introduced for them, so their DOM is unchanged.
    const hdr=hasWf?document.createElement('div'):row;
    if(hasWf){ hdr.className='ctabhdr'; row.classList.add('wfrow'); hdr.appendChild(wfChevron(t, open)); }
    const name=document.createElement('span'); name.className='ctitle'; name.textContent=t.title; hdr.appendChild(name);
    if(hasWf) hdr.appendChild(wfStrip(t.wf, buckets));
    // Between the strip and the session's indicator, because that is what it sits
    // between: the run's progress on one side, the session's state on the other.
    if(hasWf){ const re=wfRunEnd(t.wf); if(re) hdr.appendChild(re); }
    hdr.appendChild(statusIndicator(t.status, meta));
    if(hasWf) row.appendChild(hdr);
    if(open){
      const acc=wfAccordion(t, buckets); row.appendChild(acc);
      // Detached is fine — querySelector does not need the node in the document.
      if(acc.querySelector('.wel[data-sa]')) ticking=true;
    }
    row.onclick=()=>send({type:'focusTab',sessionId:t.sessionId});
    row.oncontextmenu=(e)=>{ e.preventDefault(); e.stopPropagation(); toggleMenu(row, e.clientX, e.clientY, [
      { label:'Focus Tab', icon:'arrow-square-out', run:()=>send({type:'focusTab',sessionId:t.sessionId}) },
      { label:'Rename Tab…', run:()=>beginRenameTab(row, t) },
    ]); };
    makeReorderable(row, row, { container:wrap, itemSelector:'.ctab', idOf:el=>el.dataset.sid,
      onCommit:order=>{ tabOrder[r.root]=order; persist(); render(); } });
    wrap.appendChild(row);
  }
  body.appendChild(wrap);
  if(ticking) wfStartClock();
}
// Inline tab rename: swap the title span for a full-width text input (arrows,
// ⌘A/⌘←/⌘→ all work — it's a real input). Enter commits, Escape/blur cancels.
// stopPropagation keeps the row's focus-on-click from firing while editing.
function beginRenameTab(row, t){
  const name=row.querySelector('.ctitle'); if(!name || name.tagName==='INPUT') return;
  const inp=document.createElement('input'); inp.className='ctitle'; inp.type='text'; inp.value=t.title;
  name.replaceWith(inp); inp.focus(); inp.select();
  let done=false;
  const finish=(save)=>{ if(done) return; done=true; const v=inp.value.trim();
    if(save && v && v!==t.title) send({type:'renameTab',sessionId:t.sessionId,title:t.title,newTitle:v}); else render(); };
  inp.onmousedown=(e)=>e.stopPropagation();
  inp.onclick=(e)=>e.stopPropagation();
  inp.onkeydown=(e)=>{ e.stopPropagation();
    if(e.key==='Enter'){ e.preventDefault(); finish(true); }
    else if(e.key==='Escape'){ e.preventDefault(); finish(false); } };
  inp.onblur=()=>finish(true);
}
let rerendering=false;
function render(){
  rerendering=true; // suppress the blur-commit that firing innerHTML='' triggers on an editing input
  try{ renderBody(); } finally { rerendering=false; }
}
// Order worktree boxes: the trunk is always pinned on top, the rest follow the
// user's persisted drag order (unknowns keep their natural order after).
function sortRepos(list){
  const pos=new Map(repoOrder.map((root,i)=>[root,i]));
  return list
    .map((r,i)=>[r,i])
    .sort((a,b)=>{
      if(!!a[0].isTrunk!==!!b[0].isTrunk) return a[0].isTrunk?-1:1;
      const pa=pos.has(a[0].root)?pos.get(a[0].root):1e9;
      const pb=pos.has(b[0].root)?pos.get(b[0].root):1e9;
      return pa!==pb ? pa-pb : a[1]-b[1];
    })
    .map(x=>x[0]);
}
function renderBody(){
  hideTip();
  const rootEl=document.getElementById('root'); rootEl.innerHTML='';
  if(!repos.length){ const e=document.createElement('div'); e.className='empty'; e.textContent='No repositories open.'; rootEl.appendChild(e); return; }
  for(const r of sortRepos(repos)){
    const box=document.createElement('div'); box.className='repo'; box.dataset.root=r.root; box.dataset.trunk=r.isTrunk?'1':'';
    const rcollapsed=collapsedRepos.has(r.root);
    // header
    const head=document.createElement('div'); head.className='rhead';
    const chev=document.createElement('span'); chev.className='chev codicon'; chev.textContent=rcollapsed?CH_RIGHT:CH_DOWN;
    chev.onclick=()=>{ rcollapsed?collapsedRepos.delete(r.root):collapsedRepos.add(r.root); persist(); render(); }; head.appendChild(chev);
    // Drag the chevron to reorder worktrees (trunk stays pinned on top). Folding
    // still works: a drag only begins past the movement threshold.
    makeReorderable(chev, box, { container:rootEl, itemSelector:'.repo', idOf:el=>el.dataset.root,
      canDrag:el=>el.dataset.trunk!=='1',
      minIndex:items=>items.filter(it=>it.dataset.trunk==='1').length,
      onCommit:order=>{ repoOrder=order.slice(); persist(); render(); } });
    head.appendChild(repoTitle(r));
    // The branch-name line stays deliberately clean: only the name and its
    // asterisks (dirty + behind). No counts (open tabs, ahead/behind) ride here.
    const sp=document.createElement('span'); sp.className='spacer'; head.appendChild(sp);
    const nt=document.createElement('span'); nt.className='iconbtn'; nt.title='New Tab'; nt.appendChild(svgIcon(SVG_TABPLUS));
    nt.onclick=(e)=>{ e.stopPropagation(); send({type:'op',root:r.root,op:'wtNewTab'}); }; head.appendChild(nt);
    const more=document.createElement('span'); more.className='iconbtn'; more.textContent='⋯';
    // Pass a generator (not a static array) so the open menu can live-refresh from
    // the latest state — e.g. the PR link resolving from its pending spinner. Looks
    // the row up by root each time so it reads fresh state, not this render's row.
    more.onclick=(e)=>{ e.stopPropagation(); const rect=more.getBoundingClientRect(); const root=r.root;
      // Opening (not closing — toggleMenu treats a repeat click on the same owner
      // as a close) re-checks a cached "no PR", so a PR created since the last
      // check shows up here without a window reload. Sent before the menu is
      // built: the row renders its pending spinner and swaps in the link in place.
      if(menuOwner!==more) send({type:'prCheck',root});
      toggleMenu(more, rect.left, rect.bottom+2, ()=>overflowItems(repos.find(x=>x.root===root)||r)); }; head.appendChild(more);
    box.appendChild(head);

    // Open Claude tabs for this worktree render right below the branch header and
    // stay visible even when the branch is folded — folding only hides the source
    // control section below (commit box, changes) but keeps the tab boxes open.
    if(rcollapsed) {
      const tabsOnly=document.createElement('div'); tabsOnly.className='body';
      renderClaudeTabs(tabsOnly, r);
      if(tabsOnly.childNodes.length) box.appendChild(tabsOnly);
      rootEl.appendChild(box); continue;
    }

    const body=document.createElement('div'); body.className='body';
    // Open Claude tabs for this worktree, right below the branch header and above
    // the commit box (hidden entirely when there are none / Claude is unpatched).
    renderClaudeTabs(body, r);
    // Mirror the native SCM panel: with nothing to commit, committing and
    // generating a message are both inert (there's no diff to act on).
    const noChanges=!r.files.length;
    const commitBlocked=r.primary==='commit' && noChanges;
    const ta=document.createElement('textarea'); ta.id='ta-'+cssId(r.root); ta.rows=1; const phText='Message (⌘⏎ to commit on "'+r.branch+'")';
    ta.value=drafts[r.root]||'';
    ta.oninput=()=>{ drafts[r.root]=ta.value; persist(); autosize(ta); };
    ta.onkeydown=(e)=>{ if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){ e.preventDefault(); if(commitBlocked||busyOps[r.root]) return; startPrimary(r,ta); } };
    const tawrap=document.createElement('div'); tawrap.className='tawrap'; tawrap.appendChild(ta);
    const spark=document.createElement('div'); spark.className='genmsg'+(noChanges?' disabled':''); spark.id='spark-'+cssId(r.root); spark.title='Generate Commit Message';
    const sg=document.createElement('span'); sg.className='codicon'; sg.textContent=CO_SPARKLE; spark.appendChild(sg);
    spark.onclick=(e)=>{ e.stopPropagation(); if(noChanges||spark.classList.contains('spin')) return; spark.classList.add('spin'); send({type:'genmsg', root:r.root}); };
    tawrap.appendChild(spark);
    const phl=document.createElement('div'); phl.className='phlabel'; phl.textContent=phText; tawrap.appendChild(phl);
    body.appendChild(tawrap);

    // While an operation is in flight (busy label present) the primary button
    // and its caret are disabled and the glyph spins, matching the native panel.
    const busy=busyOps[r.root];
    const bar=document.createElement('div'); bar.className='commitbar';
    const main=document.createElement('button'); main.className='main'+(busy?' busy':'');
    const gl=document.createElement('span'); gl.className='codicon';
    gl.textContent=busy?CO_SYNC:(r.primary==='sync'?CO_SYNC:r.primary==='publish'?CO_CLOUD:CO_CHECK); main.appendChild(gl);
    const counts=(!busy&&r.primary==='sync'&&(r.behind||r.ahead))?'  '+(r.behind?'↓'+r.behind+' ':'')+(r.ahead?'↑'+r.ahead:''):'';
    main.appendChild(document.createTextNode(busy?busy:(r.primaryLabel+counts)));
    main.disabled=commitBlocked||!!busy;
    main.onclick=()=>startPrimary(r,ta);
    bar.appendChild(main);
    const caret=document.createElement('button'); caret.className='caret'; caret.disabled=commitBlocked||!!busy; const cg=document.createElement('span'); cg.className='codicon'; cg.textContent=CH_DOWN; caret.appendChild(cg);
    caret.onclick=(e)=>{ e.stopPropagation(); const rect=caret.getBoundingClientRect(); toggleMenu(caret, rect.left, rect.bottom+2, commitMenuItems(r)); };
    bar.appendChild(caret);
    body.appendChild(bar);

    const staged=r.files.filter(f=>f.staged);
    const changes=r.files.filter(f=>!f.staged);
    group(body, 'Staged Changes', r.root+'|staged', staged, r.root, 'staged');
    group(body, 'Changes', r.root+'|changes', changes, r.root, 'unstaged');
    // No changes → leave the area empty, matching the native SCM panel (which
    // shows nothing rather than a placeholder).
    box.appendChild(body);
    rootEl.appendChild(box);
  }
  // A trailing "+ Worktree" action below every worktree box — same git-branch
  // glyph and menu foreground as the branch context menu's "New Worktree…".
  // Creates the worktree off the trunk (falling back to the first repo).
  const wtRoot = repos.find(r=>r.isTrunk) || repos[0];
  if(wtRoot){
    const add=document.createElement('button'); add.className='wtadd';
    add.appendChild(phIcon('git-branch'));
    add.appendChild(document.createTextNode('New Worktree'));
    add.onclick=()=>send({type:'op',root:wtRoot.root,op:'wtNew'});
    rootEl.appendChild(add);
  }
  // Now that every textarea is attached, size each to fit its (possibly
  // multi-line) draft — scrollHeight only reads correctly once in the document.
  rootEl.querySelectorAll('textarea').forEach(autosize);
}

window.addEventListener('message', e=>{
  const m=e.data;
  // The extension owns the custom names (it publishes them to the orchestrator
  // too), so every state push re-seats the local map rather than merging — that
  // is what makes a name cleared elsewhere actually disappear here.
  if(m.type==='state'){ repos=m.repos;
    if(m.names){ for(const k of Object.keys(repoNames)) delete repoNames[k]; Object.assign(repoNames, m.names); persist(); }
    if(spinning.size) spinning.clear(); render(); refreshMenu(); renderModal(); }
  else if(m.type==='busy'){ if(m.label) busyOps[m.root]=m.label; else delete busyOps[m.root]; render(); }
  else if(m.type==='idle'){ if(spinning.size){ spinning.clear(); render(); } }
  else if(m.type==='committed'){ drafts[m.root]=''; persist(); const ta=document.getElementById('ta-'+cssId(m.root)); if(ta){ ta.value=''; autosize(ta); } }
  // setmsg: generate-message fills a non-empty message (never clears on failure);
  // undo/redo set m.force so they can also clear the box (empty top-of-history).
  else if(m.type==='setmsg'){ const spark=document.getElementById('spark-'+cssId(m.root)); if(spark) spark.classList.remove('spin'); const ta=document.getElementById('ta-'+cssId(m.root)); if(ta && typeof m.message==='string' && (m.force || m.message.length)){ ta.value=m.message; drafts[m.root]=m.message; persist(); autosize(ta); } }
  // Title-bar view-mode toggle: adopt the requested mode, repaint, and echo it
  // back so the extension's context key swaps the toggle button's icon/tooltip.
  else if(m.type==='setViewMode'){ if(m.mode!==viewMode){ viewMode=m.mode; persist(); render(); } send({type:'viewMode', mode:viewMode}); }
});
send({type:'refresh'});
// Hand up any names this webview persisted before the extension owned them, so
// an existing rename survives the move to workspaceState. Never clobbers.
if(Object.keys(repoNames).length) send({type:'seedRepoNames', names:repoNames});
// Report the persisted view mode up front so the toggle button shows the correct
// icon (List vs Tree) as soon as the pane loads.
send({type:'viewMode', mode:viewMode});
</script></body></html>`;
  }
}

export function registerScmMirrorView(
  context: vscode.ExtensionContext,
  info: ScmInfoService,
  status: ClaudeStatusService,
  repoNames: RepoNameStore
): void {
  const provider = new ScmWebviewProvider(info, status, repoNames);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider("andreysHelper.scm", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // Names are held outside the webview now, so a change (including the
    // one-time seed from an older webview state) has to push a fresh state.
    repoNames.onDidChange(() => provider.refresh()),
    vscode.commands.registerCommand("andreysHelper.scm.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("andreysHelper.scm.viewAsList", () => provider.setViewMode("list")),
    vscode.commands.registerCommand("andreysHelper.scm.viewAsTree", () => provider.setViewMode("tree")),
    vscode.commands.registerCommand("andreysHelper.scm.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:andrey.andreys-helper")
    )
  );
  void provider.start();
}
