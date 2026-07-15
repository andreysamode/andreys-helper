import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { getGitApi, realPath, runGit, runGh } from "./git";
import { toast } from "./notify";
import { ClaudeStatusService } from "./claudeStatus";
import { ScmInfoService } from "./scmInfo";
import { PHOSPHOR_JSON } from "./phosphorIcons";
import { codiconBase64, initSetiIcons, resolveFileIcon, setiWoffBase64 } from "./setiIcons";

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
interface ClaudeTabModel {
  /** Claude session id — the stable, unique key for focus/rename. */
  sessionId: string;
  /** Current tab title (the editor tab's label). */
  title: string;
  /** "working" | "question" | "plan" | "permission" | "done" | "idle" | other. */
  status: string;
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
  isTrunk: boolean;
  migration: boolean;
  migrationFiles: string[];
  trunkHead: string;
  tabs: number;
  /** Open Claude tabs whose session cwd is this worktree, with live status.
   *  Empty when Claude is unpatched (no status published) — the list stays hidden. */
  claudeTabs: ClaudeTabModel[];
  commitLabel: string;
  primary: "commit" | "sync" | "publish";
  primaryLabel: string;
  files: FileModel[];
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
    private readonly status: ClaudeStatusService
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
    const res = await runGh(root, ["pr", "view", "--json", "url", "--jq", ".url"]);
    if (res.code !== 0) {
      return undefined; // "no pull requests found" (exit 1) or gh unavailable
    }
    const url = res.stdout.trim();
    return url.startsWith("http") ? url : undefined;
  }

  /** Populate the PR cache for `root`@`branch` in the background (deduped), then
   *  re-render if the link changed. Skips work when the cache already knows this
   *  branch (positive or negative). */
  private schedulePrRefresh(root: string, branch: string): void {
    const cached = this.prCache.get(root);
    if ((cached && cached.branch === branch) || this.prInFlight.has(root)) {
      return;
    }
    this.prInFlight.add(root);
    void this.fetchPrUrl(root)
      .then((url) => {
        const prev = this.prCache.get(root)?.url ?? "";
        this.prCache.set(root, { branch, url: url ?? "" });
        if (prev !== (url ?? "")) {
          this.post();
        }
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
        const pick =
          pool.find((c) => c.title === tab.label) ??
          pool[0] ??
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
        list.push({ sessionId: pick.id, title: tab.label, status: pick.status });
        out.set(owner, list);
      }
    }
    return out;
  }

  /** Reveal/focus a Claude tab by its session id (via the patched command). */
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
        isTrunk: !!wt?.isTrunk,
        migration: !!wt?.migration,
        migrationFiles: wt?.migrationFiles ?? [],
        trunkHead: wt?.trunkHead ?? "",
        tabs: wt?.tabs ?? 0,
        claudeTabs: claudeByRoot.get(realPath(root)) ?? [],
        commitLabel,
        primary,
        primaryLabel,
        files,
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
    this.view?.webview.postMessage({ type: "state", repos: this.buildModel() });
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
      case "watched":
        return this.showWatched(m.root);
      case "op":
        return this.op(m.root, m.op);
      case "file":
        return this.fileAction(m.root, m.uris ?? [m.uri], m.untracked, m.action);
      case "focusTab":
        return this.focusClaudeTab(m.sessionId);
      case "renameTab":
        return this.renameClaudeTab(m.sessionId, m.title, m.newTitle);
      case "refresh":
        return this.post();
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

  /**
   * The ⚠ next to a branch means files diverging from trunk matched the watch
   * globs (scmBranchInfo.migrationGlobs — not necessarily migrations). Clicking
   * it lists those files; picking one shows what this branch introduces to it
   * versus trunk (trunk baseline on the left, the working copy on the right).
   */
  private async showWatched(root: string): Promise<void> {
    const wt = this.info.getSnapshot().worktrees.find((w) => w.path === realPath(root));
    const files = wt?.migrationFiles ?? [];
    if (files.length === 0) {
      return;
    }
    const branch = this.repo(root)?.state?.HEAD?.name ?? path.basename(root);
    const items = files.map((file) => ({ label: `$(diff) ${file}`, file }));
    const pick = await vscode.window.showQuickPick(items, {
      title: `Watched files changed — ${branch}`,
      placeHolder: "These changes touch watched files — pick one to see what this branch introduces vs trunk.",
      matchOnDescription: true,
    });
    if (!pick) {
      return;
    }
    const fileUri = vscode.Uri.file(path.join(root, pick.file));
    const toGitUri = this.gitApi?.toGitUri?.bind(this.gitApi);
    if (!toGitUri || !wt?.trunkHead) {
      await vscode.window.showTextDocument(fileUri, { preview: true });
      return;
    }
    await vscode.commands.executeCommand(
      "vscode.diff",
      toGitUri(fileUri, wt.trunkHead),
      fileUri,
      `${path.basename(pick.file)} (vs trunk)`
    );
  }

  private async op(root: string, op: string): Promise<void> {
    if (op === "createPR") {
      return void vscode.commands.executeCommand("pr.create");
    }
    if (op === "gitGraph") {
      return void vscode.commands.executeCommand("git-graph.view");
    }
    if (op === "wtNewTab" || op === "wtNewWindow" || op === "wtNew" || op === "wtRemove") {
      const cmd = { wtNewTab: "wt.newTab", wtNewWindow: "wt.newWindow", wtNew: "wt.newWorktree", wtRemove: "wt.removeWorktree" }[op];
      return void vscode.commands.executeCommand(cmd, { rootUri: vscode.Uri.file(root) });
    }
    if (op === "openTerminal") {
      const term = vscode.window.createTerminal({ cwd: root, name: path.basename(root) });
      term.show();
      return;
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
        toast(`Andrey's Helper: ${op} failed.`, "error");
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
              const remote = repo.state.remotes?.[0]?.name ?? "origin";
              await repo.push(remote, repo.state.HEAD?.name, true);
            }
          } catch (err) {
            toast(`Andrey's Helper: ${op} failed — ${err instanceof Error ? err.message : String(err)}`, "error");
          }
        }
      )
    );
  }

  /**
   * Rebase Branch… — mirrors the native SCM command: pick a branch, then rebase
   * the current branch onto it. Runs in this exact worktree (git -C) so it's
   * always the right one; conflicts leave git in its normal rebasing state for
   * the user to resolve, and the error toast carries git's message.
   */
  private async rebase(root: string): Promise<void> {
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
      return void toast("Andrey's Helper: no other branch to rebase onto.", "warning");
    }
    const onto = await vscode.window.showQuickPick(branches, {
      title: `Rebase "${current ?? path.basename(root)}" onto…`,
      placeHolder: "Select a branch to rebase the current branch onto",
    });
    if (!onto) {
      return;
    }
    await this.withBusy(root, "Rebasing…", () =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: `Rebasing onto ${onto}…` },
        async () => {
          const res = await runGit(root, ["rebase", onto], 120000);
          if (res.code !== 0) {
            const detail = `${res.stderr}\n${res.stdout}`.trim().split("\n").filter(Boolean).slice(-2).join(" — ");
            toast(`Andrey's Helper: rebase onto ${onto} failed — ${detail || "git error"}`, "error");
          } else {
            toast(`Andrey's Helper: rebased "${current ?? path.basename(root)}" onto ${onto}.`);
          }
        }
      )
    );
    await this.refreshRepo(root);
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
            const detail = `${res.stderr}\n${res.stdout}`.trim().split("\n").filter(Boolean).slice(-2).join(" — ");
            toast(`Andrey's Helper: force push failed — ${detail || "git error"}`, "error");
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
    const res = await runGit(root, ["reset", "--soft", "HEAD~1"]);
    if (res.code !== 0) {
      toast("Andrey's Helper: undo failed (no prior commit, or git error).", "error");
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
      const res = await runGit(root, ["reset", "--soft", entry.sha]);
      if (res.code !== 0) {
        return void toast("Andrey's Helper: redo failed (git error).", "error");
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
    try {
      if (action === "stage" && typeof repo?.add === "function") {
        await repo.add(fsPaths);
        return;
      }
      if (action === "unstage" && typeof repo?.revert === "function") {
        await repo.revert(fsPaths);
        return;
      }
    } catch {
      /* fall through to the raw git path below */
    }
    const rels = uris.map((u) => path.relative(root, vscode.Uri.parse(u).fsPath));
    const args = action === "stage" ? ["add", "--", ...rels] : ["reset", "-q", "HEAD", "--", ...rels];
    const res = await runGit(root, args);
    if (res.code !== 0) {
      toast(`Andrey's Helper: ${action} failed.`, "error");
    }
  }

  /** Discard working-tree changes for a set of files (confirmed, destructive).
   *  Tracked files revert to the index/HEAD (git checkout --); untracked files
   *  are deleted (git clean -f). Untracked-ness is read from live repo state so
   *  multi-file group/folder discards classify each path correctly. */
  private async discard(root: string, uris: string[]): Promise<void> {
    if (!uris.length) {
      return;
    }
    const repo = this.repo(root);
    const untrackedSet = new Set<string>(
      (repo?.state?.workingTreeChanges ?? [])
        .filter((c: any) => c.status === UNTRACKED)
        .map((c: any) => c.uri.toString())
    );
    const tracked: string[] = [];
    const untracked: string[] = [];
    for (const u of uris) {
      const rel = path.relative(root, vscode.Uri.parse(u).fsPath);
      (untrackedSet.has(u) ? untracked : tracked).push(rel);
    }
    const n = uris.length;
    const detail = untracked.length
      ? `${untracked.length} untracked file(s) will be deleted; the rest revert to their last staged/committed state. This cannot be undone.`
      : "These changes revert to their last staged/committed state. This cannot be undone.";
    const confirm = await vscode.window.showWarningMessage(
      `Discard changes in ${n} file${n === 1 ? "" : "s"}?`,
      { modal: true, detail },
      "Discard Changes"
    );
    if (confirm !== "Discard Changes") {
      return;
    }
    if (tracked.length) {
      const res = await runGit(root, ["checkout", "--", ...tracked]);
      if (res.code !== 0) {
        toast("Andrey's Helper: discard failed (git checkout error).", "error");
      }
    }
    if (untracked.length) {
      const res = await runGit(root, ["clean", "-f", "--", ...untracked]);
      if (res.code !== 0) {
        toast("Andrey's Helper: discard failed (git clean error).", "error");
      }
    }
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
  .rhead .name { font-weight: 700; color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rhead .name.rename { flex: 100 1 0; min-width: 40px; font: inherit; font-weight: 700; color: inherit;
    background: var(--vscode-input-background); border: 1px solid var(--vscode-focusBorder);
    border-radius: 3px; padding: 0 4px; outline: none; }
  .rhead .meta { opacity: .6; font-size: 11px; margin-left: 4px; flex: none; }
  .rhead .spacer { flex: 1; }
  .rhead .warn { color: var(--vscode-editorWarning-foreground); font-size: 14px; flex: none; cursor: pointer; margin-left: 4px; border-radius: 3px; padding: 0 2px; line-height: 1; }
  .rhead .warn:hover { background: var(--vscode-toolbar-hoverBackground); }
  .claudetabs { margin: 2px 0 6px; display: flex; flex-direction: column; gap: 3px; }
  .ctab { display: flex; align-items: center; gap: 6px; min-height: 22px; padding: 2px 8px; cursor: pointer;
    border: 1px solid var(--vscode-statusBar-background, var(--vscode-panel-border)); border-radius: 4px; }
  .ctab:hover { background: var(--vscode-list-hoverBackground); }
  .ctab .cdot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
  .ctab .cdot.hollow { background: transparent; box-shadow: inset 0 0 0 1.5px var(--vscode-descriptionForeground); }
  .ctab .cdot.pulse { animation: ah-pulse 1.4s ease-in-out infinite; }
  @keyframes ah-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
  .ctab .cspin { flex: none; width: 11px; height: 11px; border-radius: 50%; box-sizing: border-box;
    border: 1.6px solid var(--vscode-descriptionForeground); border-top-color: transparent;
    animation: ah-spin 0.8s linear infinite; opacity: .85; }
  .ctab .ccheck { flex: none; font-size: 14px; line-height: 1; color: #22C55E; }
  .ctab .ctitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: inherit; }
  .ctab input.ctitle { height: 17px; box-sizing: border-box; font: inherit; font-size: 13px; overflow: visible;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-focusBorder); border-radius: 3px; padding: 0 4px; outline: none; }
  .iconbtn { cursor: pointer; opacity: .8; padding: 2px 4px; border-radius: 3px; }
  .iconbtn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .iconbtn.codicon { font-size: 15px; }
  .iconbtn .svgi { display: inline-flex; }
  .iconbtn .svgi svg { width: 15px; height: 15px; display: block; }
  .body { padding: 0 8px; }
  textarea { width: 100%; box-sizing: border-box; margin: 2px 0 4px; resize: none; overflow: hidden;
    min-height: 26px; height: 26px; line-height: 16px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 5px; padding: 4px 26px 4px 8px;
    font-family: var(--vscode-font-family); font-size: 13px; }
  textarea::placeholder { color: var(--vscode-input-placeholderForeground); font-size: 13px; }
  .tawrap { position: relative; }
  .tawrap .genmsg { position: absolute; right: 4px; bottom: 7px; width: 20px; height: 20px; box-sizing: border-box;
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
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const S = vscode.getState() || {};
const drafts = S.drafts || {};
const collapsedDirs = new Set(S.collapsedDirs || []);
const collapsedRepos = new Set(S.collapsedRepos || []);
const collapsedGroups = new Set(S.collapsedGroups || []);
const repoNames = S.repoNames || {}; // repoRoot -> custom display name (falls back to branch when absent/empty)
let viewMode = S.viewMode || 'tree';
let repos = [];
let sel = {}; // repoRoot -> Set(uri)
const spinning = new Set(); // keys (file uri / folder key / group key) with an in-flight discard
const busyOps = {}; // repoRoot -> busy label (e.g. 'Committing…'); disables + spins the primary button
const CH_RIGHT = String.fromCharCode(0xEAB6), CH_DOWN = String.fromCharCode(0xEAB4);
const CO_CHECK = String.fromCharCode(60082), CO_SYNC = String.fromCharCode(60023), CO_CLOUD = String.fromCharCode(60099);
const CO_ADD = String.fromCharCode(0xEA60), CO_DISCARD = String.fromCharCode(0xEAE2), CO_REMOVE = String.fromCharCode(0xEB3B), CO_OPEN = String.fromCharCode(0xEA94);
const CO_LOAD = String.fromCharCode(0xEB19); // loading spinner
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
function svgIcon(markup){ const s=document.createElement('span'); s.className='svgi'; s.innerHTML=markup; return s; }
function primaryBusyLabel(r){ return r.primary==='sync'?'Syncing…':r.primary==='publish'?'Publishing…':'Committing…'; }

function persist(){ vscode.setState({ drafts, collapsedDirs:[...collapsedDirs], collapsedRepos:[...collapsedRepos], collapsedGroups:[...collapsedGroups], repoNames, viewMode }); }
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function send(m){ vscode.postMessage(m); }
// Grow the message box to fit its content instead of scrolling. Must run while
// the textarea is ATTACHED to the document — a detached element reports
// scrollHeight 0. The +2 compensates for the 1px top/bottom border under
// box-sizing:border-box, which scrollHeight excludes.
function autosize(ta){ if(!ta) return; if(!ta.value){ ta.style.height='26px'; return; } ta.style.height='auto'; ta.style.height=Math.max(26, ta.scrollHeight+2)+'px'; }
function selOf(root){ return (sel[root] = sel[root] || new Set()); }

// ----- popup menu (supports nested submenus via item.sub) -----
let menuOwner = null;
let menuBoxes = [];
let closeTimer = null;
function cancelClose(){ if(closeTimer){ clearTimeout(closeTimer); closeTimer=null; } }
// Close after a short grace period so the pointer can travel across the small
// gap between a parent menu and its submenu without dismissing everything.
function scheduleClose(){ cancelClose(); closeTimer=setTimeout(closeMenu, 260); }
function closeMenu(){ cancelClose(); document.getElementById('menu').innerHTML=''; menuBoxes=[]; menuOwner=null; }
function toggleMenu(owner, x, y, items){ if(menuOwner===owner){ closeMenu(); return; } closeMenu(); openMenu(x,y,items); menuOwner=owner; }
document.addEventListener('click', closeMenu);
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
    const d=document.createElement('div'); d.className='mi';
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
    ...(r.isTrunk ? [] : [{ label:'Remove Worktree…', icon:'trash', run:()=>send({type:'op',root:r.root,op:'wtRemove'}) }]),
    { sep:true },
    { label:'Open Terminal', icon:'terminal-window', run:()=>send({type:'op',root:r.root,op:'openTerminal'}) },
    { label:'Copy Branch Name', icon:'copy', run:()=>send({type:'op',root:r.root,op:'copyBranch'}) },
    { label:'Copy Worktree Path', icon:'copy', run:()=>send({type:'op',root:r.root,op:'copyPath'}) },
    // Only when an open PR exists for this branch. Row copies the PR link; the
    // trailing ↗ icon opens the PR in the browser instead.
    ...(r.prUrl ? [{ label:'Copy PR Link', icon:'copy', run:()=>send({type:'op',root:r.root,op:'copyPr'}), trail:{ icon:'arrow-square-out', title:'Open PR on GitHub', run:()=>send({type:'op',root:r.root,op:'openPr'}) } }] : []),
    { sep:true },
    { label:'Rebase Branch…', svg:SVG_REBASE, run:()=>send({type:'op',root:r.root,op:'rebase'}) },
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
  return [
    { label:'Commit', icon:'check', run:()=>doPrimaryWith(r,'none') },
    { label:'Commit & Push', icon:'arrow-line-up', run:()=>doPrimaryWith(r,'push') },
    { label:'Commit & Sync', icon:'arrows-clockwise', run:()=>doPrimaryWith(r,'sync') },
  ];
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
  const display=(repoNames[r.root]||r.branch)+(r.dirty?'*':'');
  const br=document.createElement('span'); br.className='name'; br.title=r.branch; br.textContent=display;
  br.style.cursor='text';
  br.onclick=(e)=>{ e.stopPropagation(); renaming={root:r.root, value:repoNames[r.root]||''}; render(); };
  return br;
}
function renameInput(r){
  const inp=document.createElement('input'); inp.className='name rename'; inp.type='text';
  inp.value=renaming.value; inp.placeholder=r.branch;
  const commit=()=>{
    if(!renaming || renaming.root!==r.root) return;
    const v=renaming.value.trim();
    if(v) repoNames[r.root]=v; else delete repoNames[r.root];
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
// The status indicator: a gray spinner while working, a green check when finished
// (unseen), else a colored dot (pulsing for attention states, hollow for idle).
function statusIndicator(status, meta){
  if(status==='working'){ const s=document.createElement('span'); s.className='cspin'; return s; }
  if(status==='done'){ const s=document.createElement('span'); s.className='ccheck codicon'; s.textContent=CO_CHECK; return s; }
  const d=document.createElement('span'); d.className='cdot'+(meta.pulse?' pulse':'')+(meta.hollow?' hollow':'');
  if(meta.color) d.style.background=meta.color;
  return d;
}
function renderClaudeTabs(body, r){
  if(!r.claudeTabs || !r.claudeTabs.length) return;
  const wrap=document.createElement('div'); wrap.className='claudetabs';
  for(const t of r.claudeTabs){
    const meta=claudeStatusMeta(t.status);
    const row=document.createElement('div'); row.className='ctab'; row.title=t.title+' — '+meta.label;
    const name=document.createElement('span'); name.className='ctitle'; name.textContent=t.title; row.appendChild(name);
    row.appendChild(statusIndicator(t.status, meta));
    row.onclick=()=>send({type:'focusTab',sessionId:t.sessionId});
    row.oncontextmenu=(e)=>{ e.preventDefault(); e.stopPropagation(); toggleMenu(row, e.clientX, e.clientY, [
      { label:'Focus Tab', icon:'arrow-square-out', run:()=>send({type:'focusTab',sessionId:t.sessionId}) },
      { label:'Rename Tab…', run:()=>beginRenameTab(row, t) },
    ]); };
    wrap.appendChild(row);
  }
  body.appendChild(wrap);
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
function renderBody(){
  hideTip();
  const rootEl=document.getElementById('root'); rootEl.innerHTML='';
  if(!repos.length){ const e=document.createElement('div'); e.className='empty'; e.textContent='No repositories open.'; rootEl.appendChild(e); return; }
  for(const r of repos){
    const box=document.createElement('div'); box.className='repo';
    const rcollapsed=collapsedRepos.has(r.root);
    // header
    const head=document.createElement('div'); head.className='rhead';
    const chev=document.createElement('span'); chev.className='chev codicon'; chev.textContent=rcollapsed?CH_RIGHT:CH_DOWN;
    chev.onclick=()=>{ rcollapsed?collapsedRepos.delete(r.root):collapsedRepos.add(r.root); persist(); render(); }; head.appendChild(chev);
    head.appendChild(repoTitle(r));
    if(r.hasUpstream && (r.behind||r.ahead)){ const m=document.createElement('span'); m.className='meta'; m.textContent=(r.behind?'↓'+r.behind+' ':'')+(r.ahead?'↑'+r.ahead:''); head.appendChild(m); }
    if(r.tabs){ const m=document.createElement('span'); m.className='meta'; m.textContent=r.tabs+'⇥'; head.appendChild(m); }
    if(r.migration){ const w=document.createElement('span'); w.className='warn'; w.textContent='⚠'; w.title='Changes touch watched files — click to view'; w.onclick=(e)=>{ e.stopPropagation(); send({type:'watched', root:r.root}); }; head.appendChild(w); }
    const sp=document.createElement('span'); sp.className='spacer'; head.appendChild(sp);
    const nt=document.createElement('span'); nt.className='iconbtn'; nt.title='New Tab'; nt.appendChild(svgIcon(SVG_TABPLUS));
    nt.onclick=(e)=>{ e.stopPropagation(); send({type:'op',root:r.root,op:'wtNewTab'}); }; head.appendChild(nt);
    const more=document.createElement('span'); more.className='iconbtn'; more.textContent='⋯'; more.title='More Actions';
    more.onclick=(e)=>{ e.stopPropagation(); const rect=more.getBoundingClientRect(); toggleMenu(more, rect.left, rect.bottom+2, overflowItems(r)); }; head.appendChild(more);
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
    const ta=document.createElement('textarea'); ta.id='ta-'+cssId(r.root); ta.rows=1; ta.placeholder='Message (⌘⏎ to commit on "'+r.branch+'")';
    ta.value=drafts[r.root]||'';
    ta.oninput=()=>{ drafts[r.root]=ta.value; persist(); autosize(ta); };
    ta.onkeydown=(e)=>{ if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){ e.preventDefault(); if(commitBlocked||busyOps[r.root]) return; startPrimary(r,ta); } };
    const tawrap=document.createElement('div'); tawrap.className='tawrap'; tawrap.appendChild(ta);
    const spark=document.createElement('div'); spark.className='genmsg'+(noChanges?' disabled':''); spark.id='spark-'+cssId(r.root); spark.title='Generate Commit Message';
    const sg=document.createElement('span'); sg.className='codicon'; sg.textContent=CO_SPARKLE; spark.appendChild(sg);
    spark.onclick=(e)=>{ e.stopPropagation(); if(noChanges||spark.classList.contains('spin')) return; spark.classList.add('spin'); send({type:'genmsg', root:r.root}); };
    tawrap.appendChild(spark);
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
  // Now that every textarea is attached, size each to fit its (possibly
  // multi-line) draft — scrollHeight only reads correctly once in the document.
  rootEl.querySelectorAll('textarea').forEach(autosize);
}

window.addEventListener('message', e=>{
  const m=e.data;
  if(m.type==='state'){ repos=m.repos; if(spinning.size) spinning.clear(); render(); }
  else if(m.type==='busy'){ if(m.label) busyOps[m.root]=m.label; else delete busyOps[m.root]; render(); }
  else if(m.type==='idle'){ if(spinning.size){ spinning.clear(); render(); } }
  else if(m.type==='committed'){ drafts[m.root]=''; persist(); const ta=document.getElementById('ta-'+cssId(m.root)); if(ta){ ta.value=''; ta.style.height='26px'; } }
  // setmsg: generate-message fills a non-empty message (never clears on failure);
  // undo/redo set m.force so they can also clear the box (empty top-of-history).
  else if(m.type==='setmsg'){ const spark=document.getElementById('spark-'+cssId(m.root)); if(spark) spark.classList.remove('spin'); const ta=document.getElementById('ta-'+cssId(m.root)); if(ta && typeof m.message==='string' && (m.force || m.message.length)){ ta.value=m.message; drafts[m.root]=m.message; persist(); autosize(ta); } }
  // Title-bar view-mode toggle: adopt the requested mode, repaint, and echo it
  // back so the extension's context key swaps the toggle button's icon/tooltip.
  else if(m.type==='setViewMode'){ if(m.mode!==viewMode){ viewMode=m.mode; persist(); render(); } send({type:'viewMode', mode:viewMode}); }
});
send({type:'refresh'});
// Report the persisted view mode up front so the toggle button shows the correct
// icon (List vs Tree) as soon as the pane loads.
send({type:'viewMode', mode:viewMode});
</script></body></html>`;
  }
}

export function registerScmMirrorView(
  context: vscode.ExtensionContext,
  info: ScmInfoService,
  status: ClaudeStatusService
): void {
  const provider = new ScmWebviewProvider(info, status);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider("andreysHelper.scm", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("andreysHelper.scm.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("andreysHelper.scm.viewAsList", () => provider.setViewMode("list")),
    vscode.commands.registerCommand("andreysHelper.scm.viewAsTree", () => provider.setViewMode("tree")),
    vscode.commands.registerCommand("andreysHelper.scm.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:andrey.andreys-helper")
    )
  );
  void provider.start();
}
