import * as crypto from "crypto";
import * as fs from "fs";
import * as vscode from "vscode";
import { ClaudeStatusService, ClaudeTab } from "../claudeStatus";
import { openWorktreeClaudeTab } from "../claudeTab";
import { realPath, runGit } from "../git";
import { toast } from "../notify";
import { Marble, STAGES, STAGE_LABELS, Stage } from "./model";
import { codiconBase64 } from "../setiIcons";
import { KymStore } from "./store";
import {
  ensureWorktreeForBranch,
  isWorktreeClean,
  removeWorktreePath,
} from "./worktree";

/**
 * Keep Your Marbles board — a locked editor-tab webview that renders the Kanban
 * columns and orchestrates marble transitions (see docs/kym-plan.md).
 *
 * One board per open folder / window. Opening the board rearranges the whole
 * window into two side-by-side groups: the left (~2/3) holds the board — first
 * tab, active — plus every non-Claude editor tab behind it; the right (~1/3)
 * holds every Claude session tab and is locked so new editors keep landing on
 * the left. Clicking a marble reveals/opens its session in the side group.
 */

/** Focus-group commands indexed by 0-based column position (viewColumn − 1). */
const FOCUS_GROUP = [
  "workbench.action.focusFirstEditorGroup",
  "workbench.action.focusSecondEditorGroup",
  "workbench.action.focusThirdEditorGroup",
  "workbench.action.focusFourthEditorGroup",
  "workbench.action.focusFifthEditorGroup",
  "workbench.action.focusSixthEditorGroup",
  "workbench.action.focusSeventhEditorGroup",
  "workbench.action.focusEighthEditorGroup",
];

/** A Claude Code session tab — a webview whose viewType mentions "claude". */
function isClaudeTab(tab: vscode.Tab): boolean {
  return (
    tab.input instanceof vscode.TabInputWebview &&
    /claude/i.test(tab.input.viewType)
  );
}

export class KymBoard {
  private static current: KymBoard | undefined;

  static show(
    context: vscode.ExtensionContext,
    store: KymStore,
    status: ClaudeStatusService
  ): void {
    if (KymBoard.current) {
      KymBoard.current.panel.reveal(vscode.ViewColumn.One);
      void KymBoard.current.arrangeLayout();
      return;
    }
    KymBoard.current = new KymBoard(context, store, status);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /** Webview URI of the media/marbles asset folder (color + texture images). */
  private readonly marblesUri: string;
  private readonly mediaUri: string;
  /** Sprite-sheet filenames (without extension) found in media/sprites. */
  private readonly spriteNames: string[];
  /** Marbles we've observed reach a working state, so a later `done` is real. */
  private readonly sawWorking = new Set<string>();
  /** When each pass-around run's session was opened (ms), for the hop-0 kick. */
  private readonly runStartAt = new Map<string, number>();
  /**
   * Hops whose prompt has already been submitted, keyed `${marbleId}:${hopIndex}`.
   * A run's session is opened WITHOUT a creation-time prompt; each hop's prompt is
   * delivered exactly once by driveRun when the session is bound and idle. This
   * guard is the single source of truth that prevents the same prompt being sent
   * more than once (which otherwise spammed the composer with duplicates).
   */
  private readonly deliveredHops = new Set<string>();
  /** Marbles rolling off the field after their last hop, awaiting the Verify
   *  deposit once the webview reports the roll-off finished (exactly-once). */
  private readonly rollingOff = new Set<string>();
  /**
   * Marbles whose tab binding was made in THIS window (bindNewSession). Panel
   * ids restart on reload, so only these bindings are beyond doubt — a persisted
   * one is honored only after the uuid cross-check (see sessionFor).
   */
  private readonly boundThisWindow = new Set<string>();

  private constructor(
    context: vscode.ExtensionContext,
    private readonly store: KymStore,
    private readonly status: ClaudeStatusService
  ) {
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media");
    this.panel = vscode.window.createWebviewPanel(
      "andreysHelper.kymBoard",
      "Keep Your Marbles",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaRoot],
      }
    );
    this.marblesUri = this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(mediaRoot, "marbles"))
      .toString();
    this.mediaUri = this.panel.webview.asWebviewUri(mediaRoot).toString();
    this.spriteNames = this.loadSpriteNames(
      vscode.Uri.joinPath(mediaRoot, "sprites").fsPath
    );
    this.panel.iconPath = vscode.Uri.joinPath(mediaRoot, "columns-tab.svg");
    this.panel.webview.html = this.html(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(
      (m) => this.onMessage(m),
      undefined,
      this.disposables
    );
    this.disposables.push(
      this.store.onDidChange(() => this.postState()),
      this.status.onDidChange(() => this.onStatusChange()),
      // Light the agents of whichever marble's session is the ACTIVE editor tab;
      // switching tabs re-evaluates, so lighting always follows the focused tab.
      vscode.window.tabGroups.onDidChangeTabs(() => this.postActiveSession()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.postActiveSession())
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // Arrange the window: board + other tabs left (~2/3), Claude tabs right.
    void this.arrangeLayout();
  }

  private dispose(): void {
    KymBoard.current = undefined;
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
  }

  private async arrangeLayout(): Promise<void> {
    try {
      // Clear any group locks first: a locked group can't be collapsed and
      // won't release its tabs cleanly while we restructure.
      await this.unlockAllGroups();
      await vscode.commands.executeCommand("vscode.setEditorLayout", {
        orientation: 0, // side-by-side columns
        groups: [{ size: 0.66 }, { size: 0.34 }],
      });
      // Claude session tabs stack on the right; everything else (including the
      // board) lands on the left.
      await this.sweepTabs(isClaudeTab, 2, "workbench.action.moveEditorToSecondGroup");
      await this.sweepTabs(
        (t) => !isClaudeTab(t),
        1,
        "workbench.action.moveEditorToFirstGroup"
      );
      // Lock the right group so new editors keep opening on the left, with the
      // Claude sessions undisturbed.
      await vscode.commands.executeCommand(FOCUS_GROUP[1]);
      await vscode.commands.executeCommand("workbench.action.lockEditorGroup");
      // Surface the board: first tab of the left group, active and focused.
      this.panel.reveal(vscode.ViewColumn.One, false);
      await vscode.commands.executeCommand("moveActiveEditor", {
        to: "first",
        by: "tab",
      });
    } catch {
      // Layout is a nicety; the board still works without it.
    }
  }

  /** Unlock every editor group (explicit unlock, not a toggle — idempotent). */
  private async unlockAllGroups(): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      const focusCmd = FOCUS_GROUP[group.viewColumn - 1];
      if (!focusCmd) {
        continue;
      }
      await vscode.commands.executeCommand(focusCmd);
      await vscode.commands.executeCommand("workbench.action.unlockEditorGroup");
    }
  }

  /**
   * Move every tab matching `match` into the group at `targetColumn` via
   * `moveCmd`. VSCode's stable API can only move the *active* editor of a
   * group, so for each group holding a matching tab we focus it, cycle to a
   * matching tab, and move it — repeating until none remain outside the target.
   */
  private async sweepTabs(
    match: (tab: vscode.Tab) => boolean,
    targetColumn: number,
    moveCmd: string
  ): Promise<void> {
    const matches = (tab: vscode.Tab | undefined): boolean => !!tab && match(tab);

    for (let guard = 0; guard < 60; guard++) {
      const src = vscode.window.tabGroups.all.find(
        (g) => g.viewColumn !== targetColumn && g.tabs.some((t) => matches(t))
      );
      if (!src) {
        return; // every matching tab is already in the target group
      }
      const focusCmd = FOCUS_GROUP[src.viewColumn - 1];
      if (!focusCmd) {
        return; // group beyond the addressable range — bail rather than spin
      }
      await vscode.commands.executeCommand(focusCmd);

      // Cycle the active editor within this group until a matching tab is active.
      let active = src.activeTab;
      for (let i = 0; i < src.tabs.length && !matches(active); i++) {
        await vscode.commands.executeCommand(
          "workbench.action.nextEditorInGroup"
        );
        active = vscode.window.tabGroups.all.find(
          (g) => g.viewColumn === src.viewColumn
        )?.activeTab;
      }
      if (!matches(active)) {
        return; // couldn't surface a matching tab — avoid an infinite loop
      }
      await vscode.commands.executeCommand(moveCmd);
    }
  }

  // --- messaging -----------------------------------------------------------

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case "ready":
        return this.postState();
      case "create":
        return this.createMarble(msg.marble);
      case "update":
        this.store.updateMarble(msg.id, msg.patch ?? {});
        return;
      case "move":
        return this.moveMarble(msg.id, msg.stage, msg.planMode, msg.sectionId);
      case "reorder": {
        const prevStage = this.store.marble(msg.id)?.stage;
        // A user moving a failed marble clears its run state (the Failed group
        // hides once empty). Live runs can't be reordered (drag is blocked).
        const rm = this.store.marble(msg.id);
        if (rm?.runStatus) {
          this.store.updateMarble(msg.id, {
            runStatus: undefined,
            runIndex: undefined,
            runKind: undefined,
          });
        }
        this.store.reorder(
          msg.id,
          msg.stage,
          msg.sectionId ?? undefined,
          msg.beforeId ?? null
        );
        // Only a genuine stage change kicks off / archives work — plain
        // reordering within a column must not restart the session.
        if (msg.stage !== prevStage) {
          if (msg.stage === "plan" || msg.stage === "process") {
            await this.startWork(msg.id);
          } else if (msg.stage === "archive") {
            await this.archiveMarble(msg.id);
          }
        }
        return;
      }
      case "setColWidth":
        this.store.setColWidth(String(msg.key ?? ""), Number(msg.width));
        return;
      case "resetColWidth":
        this.store.resetColWidth(String(msg.key ?? ""));
        return;
      case "setColTexture":
        this.store.setColTexture(String(msg.key ?? ""), String(msg.texture ?? "none"));
        return;
      case "delete":
        this.store.removeMarble(msg.id);
        this.sawWorking.delete(msg.id);
        return;
      case "open":
        return this.openSession(msg.id);
      case "saveSnippets":
        await this.store.setGlobalSnippets(msg.snippets ?? []);
        return this.postState();
      case "addSection":
        this.store.addSection(String(msg.label ?? "Section"));
        return;
      case "updateSection":
        this.store.updateSection(msg.id, msg.patch ?? {});
        return;
      case "removeSection":
        this.store.removeSection(msg.id);
        return;
      case "reorderSection":
        this.store.reorderSection(msg.id, msg.beforeId ?? null);
        return;
      case "addAgent":
        this.store.addAgent(
          String(msg.sprite ?? ""),
          Number(msg.x),
          Number(msg.y),
          Number(msg.hue) || 0,
        );
        return;
      case "moveAgent":
        this.store.moveAgent(
          String(msg.id ?? ""),
          Number(msg.x),
          Number(msg.y),
          msg.flip
        );
        return;
      case "updateAgent":
        this.store.updateAgent(String(msg.id ?? ""), msg.patch ?? {});
        return;
      case "removeAgent":
        this.store.removeAgent(String(msg.id ?? ""));
        return;
      case "fieldPlace":
        return this.placeOnField(
          String(msg.id ?? ""),
          Number(msg.x),
          Number(msg.y)
        );
      case "fieldAt":
        // The webview reports the ball's resting centre after a hop roll, so a
        // reload/re-render lands it on the current agent — persist quietly
        // (no re-render: rebuilding the board mid-roll flashes the agents/glow).
        this.store.updateMarbleQuiet(String(msg.id ?? ""), {
          fieldX: Number(msg.x),
          fieldY: Number(msg.y),
        });
        return;
      case "runRolledOff":
        // The ball finished rolling off the right edge — now deposit it in Verify.
        return this.depositToVerify(String(msg.id ?? ""));
      case "runControl":
        return this.runControl(String(msg.id ?? ""), String(msg.action ?? ""));
      case "resetSectionHeights":
        this.store.resetSectionHeights();
        return;
    }
  }

  /** Sprite sheets in media/sprites, sorted, as bare names (no extension). */
  private loadSpriteNames(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith(".png"))
        .map((f) => f.replace(/\.png$/i, ""))
        .sort();
    } catch {
      return [];
    }
  }

  private async postState(): Promise<void> {
    void this.panel.webview.postMessage({
      type: "state",
      stages: STAGES.map((s) => ({ id: s, label: STAGE_LABELS[s] })),
      marbles: this.store.marbles(),
      sections: this.store.sections(),
      agents: this.store.agents(),
      sprites: this.spriteNames,
      snippets: this.store.snippets(),
      branches: await this.listBranches(),
      colWidths: this.store.colWidths(),
      colTextures: this.store.colTextures(),
      statusByCwd: this.statusByCwd(),
      statusByMarble: this.statusByMarble(),
    });
  }

  /**
   * Status of the session bound to EACH marble specifically (by its own
   * sessionId), not the cwd aggregate. Several marbles usually share one worktree
   * cwd, so a cwd-keyed status made every sibling show a running marble's spinner;
   * keying by the marble's own bound tab keeps each marble's indicator its own.
   */
  private statusByMarble(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const marble of this.store.marbles()) {
      const tab = this.sessionFor(marble);
      if (tab) {
        out[marble.id] = String(tab.status);
      }
    }
    return out;
  }

  /** Local + remote branch names for the Add Task branch autocomplete. */
  private async listBranches(): Promise<string[]> {
    try {
      const res = await runGit(this.store.root, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
        "refs/remotes",
      ]);
      if (res.code !== 0) {
        return [];
      }
      const seen = new Set<string>();
      for (const raw of res.stdout.split("\n")) {
        const name = raw.trim().replace(/^origin\//, "");
        if (name && name !== "HEAD" && !name.endsWith("/HEAD")) {
          seen.add(name);
        }
      }
      return [...seen].sort();
    } catch {
      return [];
    }
  }

  /** Aggregate Claude status per worktree cwd, for marble dots. */
  private statusByCwd(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of this.status.tabs()) {
      const cwd = realPath(t.cwd);
      // Prefer an "attention" status over idle/done when several tabs share a cwd.
      const rank = (s: string) =>
        ({ question: 5, permission: 5, plan: 4, working: 3, done: 2, idle: 1 } as Record<
          string,
          number
        >)[s] ?? 0;
      if (!out[cwd] || rank(String(t.status)) > rank(out[cwd])) {
        out[cwd] = String(t.status);
      }
    }
    return out;
  }

  // --- marble lifecycle ----------------------------------------------------

  private async createMarble(form: any): Promise<void> {
    const branch = String(form?.branch ?? "").trim();
    const title = String(form?.title ?? "").trim();
    if (!title) {
      toast("KYM: a marble needs a title.", "warning");
      return;
    }
    const setup: "basic" | "full" = form?.worktreeSetup === "full" ? "full" : "basic";
    this.store.addMarble({
      title,
      branch,
      tickets: Array.isArray(form?.tickets) ? form.tickets : [],
      prompt: String(form?.prompt ?? ""),
      worktreeSetup: setup,
      openSpec: false,
      copyIgnored: setup === "full",
      color: form?.color || undefined,
      icon: form?.icon || undefined,
      sectionId: form?.sectionId || undefined,
      stage: "todo",
    });
  }

  private async moveMarble(
    id: string,
    stage: Stage,
    planMode?: "pause" | "implement",
    sectionId?: string | null
  ): Promise<void> {
    const marble = this.store.marble(id);
    if (!marble) {
      return;
    }
    const patch: Partial<Marble> = { stage };
    if (stage === "plan" && planMode) {
      patch.planMode = planMode;
    }
    // Section membership only applies within TODO; clear it when leaving.
    if (sectionId !== undefined) {
      patch.sectionId = sectionId ?? undefined;
    } else if (stage !== "todo") {
      patch.sectionId = undefined;
    }
    this.store.updateMarble(id, patch);

    if (stage === "plan" || stage === "process") {
      await this.startWork(id);
    } else if (stage === "archive") {
      await this.archiveMarble(id);
    }
  }

  /**
   * Drop a marble onto the Plan/Process field at a free position. Repositioning a
   * marble already on the field only updates its coordinates; a marble arriving
   * from elsewhere also transitions to Plan (which lazily starts its worktree).
   */
  private async placeOnField(id: string, x: number, y: number): Promise<void> {
    const marble = this.store.marble(id);
    if (!marble) {
      return;
    }
    const alreadyOnField =
      marble.stage === "plan" || marble.stage === "process";
    if (alreadyOnField) {
      // Nothing just sits on the field: dropping an idle ball (re)starts its run
      // from the drop point — a pass-around if it has a path, otherwise a solo run
      // (it processes its own prompt in place, then rolls off to Verify). A ball
      // that's already running / paused / needs attention is only repositioned.
      if (!marble.runStatus) {
        this.store.updateMarble(id, {
          fieldX: x,
          fieldY: y,
          runStatus: "running",
          runIndex: 0,
          runKind: undefined,
        });
        this.sawWorking.delete(id);
        await this.startPassAround(id);
      } else {
        this.store.updateMarble(id, { fieldX: x, fieldY: y });
      }
      return;
    }
    // Fresh arrival: apply position + stage + a running state in ONE update so the
    // board renders just once (an interrupting re-render would cut off the drop
    // bounce), then open the session. With a path it's a pass-around; with none
    // it's a solo run — either way the marble is "on its way", never idling.
    this.store.updateMarble(id, {
      fieldX: x,
      fieldY: y,
      stage: "plan",
      sectionId: undefined,
      runStatus: "running",
      runIndex: 0,
      runKind: undefined,
    });
    this.sawWorking.delete(id);
    await this.startPassAround(id);
  }

  // --- pass-around run engine ----------------------------------------------

  /** Post an animation/control message to the board webview. */
  private post(msg: Record<string, unknown>): void {
    void this.panel.webview.postMessage(msg);
  }

  /** The marble whose bound session is the ACTIVE editor tab, or null. */
  private activeSessionMarbleId(): string | null {
    const g = vscode.window.tabGroups.activeTabGroup;
    const at = g?.activeTab;
    if (!at || !isClaudeTab(at)) {
      return null;
    }
    const live = this.status.tabs();
    // Prefer the panel's own live `active` flag (patched bundle) — exact, even
    // while a fresh tab still wears the default label. Fall back to matching
    // the active label, but ONLY when it's unambiguous: several tabs share the
    // default title, and picking the first used to light the wrong marble.
    let tab = live.find((t) => t.active);
    if (!tab) {
      const byLabel = live.filter((t) => t.title === at.label);
      tab =
        byLabel.find((t) => t.col === g.viewColumn) ??
        (byLabel.length === 1 ? byLabel[0] : undefined);
    }
    if (!tab) {
      return null;
    }
    // Resolve via sessionFor (uuid cross-check + rebind), so a stale panel id
    // persisted by a previous window can never attribute the tab to the wrong
    // marble.
    const m = this.store.marbles().find((mm) => this.sessionFor(mm)?.id === tab.id);
    return m ? m.id : null;
  }

  /** Tell the board which marble's agents to light (the active tab's), or none. */
  private postActiveSession(): void {
    this.post({ type: "activeSession", mid: this.activeSessionMarbleId() });
  }

  /** The prompt an agent contributes at its hop (empty when it has none). */
  private agentPrompt(agentId: string): string {
    return (this.store.agents().find((a) => a.id === agentId)?.prompt ?? "").trim();
  }

  /**
   * The message sent at hop `index`. The FIRST hop carries the marble's own
   * prompt (even when empty) combined with the first agent's prompt; later hops
   * carry only their agent's prompt (the shared session already has the context).
   */
  private hopPrompt(marble: Marble, index: number): string {
    const agent = this.agentPrompt(marble.pathAgentIds?.[index] ?? "");
    if (index === 0) {
      return [this.composePrompt(marble), agent].filter(Boolean).join("\n\n");
    }
    return agent;
  }

  /**
   * Resolve where a marble runs: its branch's worktree, or — when it has no
   * branch — the top-level repo directory (whatever's checked out there, usually
   * main), executed in place with no new worktree.
   */
  private async resolveCwd(marble: Marble): Promise<string> {
    if (!marble.branch) {
      return this.store.root;
    }
    return ensureWorktreeForBranch(this.store.root, marble.branch, marble.copyIgnored);
  }

  /**
   * Kick off a pass-around: ensure the worktree, open the session, and send the
   * first hop's prompt (the marble's own prompt + the first agent's prompt).
   * Subsequent hops are driven by `onStatusChange` as the session goes idle.
   */
  private async startPassAround(id: string): Promise<void> {
    const marble = this.store.marble(id);
    if (!marble) {
      return;
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `KYM: starting "${marble.title}"`,
      },
      async (progress) => {
        try {
          progress.report({
            message: marble.branch ? "resolving worktree…" : "using top-level repo…",
          });
          const cwd = await this.resolveCwd(marble);
          // Fresh run → forget any stale session binding (panel id AND session
          // uuid), so we bind the NEW tab we're about to open (never a
          // pre-existing one sharing this cwd, never the old conversation).
          this.boundThisWindow.delete(id);
          this.store.updateMarble(id, {
            worktreeCwd: cwd,
            sessionId: undefined,
            claudeSessionId: undefined,
          });
          this.deliveredHops.delete(id + ":0");
          this.runStartAt.set(id, Date.now());

          progress.report({ message: "opening session…" });
          // Snapshot open tabs, open a NEW session (no creation-time prompt), then
          // bind the tab that appears — so this marble owns its own session and its
          // hops never pollute another tab. Delivery is then handled exactly once
          // by driveRun/submitPrompt against that bound session.
          const before = new Set(this.status.tabs().map((t) => t.id));
          await openWorktreeClaudeTab(cwd);
          this.bindNewSession(id, cwd, before);
          // The webview's syncRuns rolls the ball to the first agent and orbits
          // (driven by the render from the runStatus update) — no message needed.
        } catch (err) {
          toast(
            `KYM: could not start "${marble.title}" — ${
              err instanceof Error ? err.message : String(err)
            }`,
            "error"
          );
          this.failRun(id);
        }
      }
    );
  }

  /**
   * The Claude session bound to a marble — ONLY the exact tab whose id we recorded
   * when we opened it. We never fall back to "any tab in this cwd": a branchless
   * marble runs in the top-level repo, where the user's own unrelated tab shares
   * that cwd, and matching by cwd would send the marble's prompts into that tab.
   * Binding is done explicitly by bindNewSession (snapshot-diff of a fresh open).
   *
   * Panel ids restart on every window reload, so a persisted `sessionId` can
   * collide with an UNRELATED new tab. Two guards:
   *  - an id match is rejected when both sides know the persistent Claude
   *    session uuid and they disagree (stale binding from a previous window);
   *  - with no (valid) id match, the tab is re-found by that uuid, so a marble
   *    reconnects to its own session across reloads. syncSessionBindings then
   *    persists the corrected panel id.
   */
  private sessionFor(marble: Marble): ClaudeTab | undefined {
    const tabs = this.status.tabs();
    const byId = marble.sessionId
      ? tabs.find((t) => t.id === marble.sessionId)
      : undefined;
    if (
      byId &&
      // A binding made in THIS window is trustworthy even when the uuid moved
      // (the user may have started a new conversation in the marble's tab).
      (this.boundThisWindow.has(marble.id) ||
        !marble.claudeSessionId ||
        !byId.sessionId ||
        byId.sessionId === marble.claudeSessionId)
    ) {
      return byId;
    }
    if (marble.claudeSessionId) {
      return tabs.find((t) => t.sessionId === marble.claudeSessionId);
    }
    return undefined;
  }

  /**
   * Keep every marble's session binding truthful as tabs come and go:
   *  - record the persistent Claude session uuid as soon as the bound tab
   *    publishes it (a fresh session gets its uuid only after it exists);
   *  - repoint `sessionId` when the tab was re-found by uuid (panel ids reset
   *    on window reload, so the persisted one may be stale).
   * Quiet updates — bookkeeping must not trigger a board re-render.
   */
  private syncSessionBindings(): void {
    for (const marble of this.store.marbles()) {
      const tab = this.sessionFor(marble);
      if (!tab) {
        continue;
      }
      const patch: Partial<Marble> = {};
      if (tab.id !== marble.sessionId) {
        patch.sessionId = tab.id;
      }
      // Adopt the tab's uuid only when the marble already tracks this session
      // (uuid rotated, e.g. /clear) or the binding was made in THIS window. A
      // pre-reload panel-id match can point at an unrelated tab — never adopt
      // a uuid through one, or the wrong conversation becomes resumable.
      if (
        tab.sessionId &&
        tab.sessionId !== marble.claudeSessionId &&
        (marble.claudeSessionId || this.boundThisWindow.has(marble.id))
      ) {
        patch.claudeSessionId = tab.sessionId;
      }
      if (Object.keys(patch).length > 0) {
        this.store.updateMarbleQuiet(marble.id, patch);
      }
    }
  }

  /**
   * After opening a tab for a marble, find the NEW tab (its id wasn't in the
   * pre-open snapshot) in `cwd` and bind it to the marble, so all prompts target
   * exactly that session and never leak into a pre-existing tab. Polls briefly
   * because the tab appears asynchronously.
   *
   * When the open was a RESUME (`resumeSid`), the tab is matched by that
   * session uuid instead — deterministic, and it also covers Claude revealing
   * an already-open tab for the session (no new tab appears at all then).
   */
  private bindNewSession(
    id: string,
    cwd: string,
    before: Set<string>,
    resumeSid?: string,
    tries = 0
  ): void {
    setTimeout(() => {
      const marble = this.store.marble(id);
      if (!marble) {
        return;
      }
      if (marble.sessionId) {
        this.onStatusChange();
        return;
      }
      const tabs = this.status.tabs();
      // uuid match first (covers reveal-of-already-open, where no new tab
      // appears); snapshot-diff otherwise — including a resume that fell back
      // to a fresh session, whose NEW tab is still the right one to bind.
      const tab =
        (resumeSid ? tabs.find((t) => t.sessionId === resumeSid) : undefined) ??
        tabs.find((t) => !before.has(t.id) && realPath(t.cwd) === cwd);
      if (tab) {
        this.boundThisWindow.add(id);
        this.store.updateMarble(id, {
          sessionId: tab.id,
          ...(tab.sessionId ? { claudeSessionId: tab.sessionId } : {}),
        });
        // Name the tab after the marble so it's identifiable — and so the active
        // tab can be matched back to its marble by label (all Claude tabs share a
        // column, so column alone can't tell them apart).
        void this.status.rename(tab.id, marble.title);
        this.onStatusChange();
        return;
      }
      if (tries < 60) {
        this.bindNewSession(id, cwd, before, resumeSid, tries + 1);
      }
    }, 500);
  }

  /** Send hop `index`'s prompt into the existing session; false = nothing sent. */
  private async sendHop(marble: Marble, index: number): Promise<boolean> {
    const text = this.hopPrompt(marble, index);
    if (!text) return false;
    const sid = marble.sessionId;
    const sent = sid ? await this.status.submitPrompt(sid, text) : false;
    if (!sent) {
      // Unpatched bundle (or no session id): fall back to clipboard + reveal so
      // the user can paste the next agent's prompt manually.
      await vscode.env.clipboard.writeText(text);
      if (sid) await this.status.reveal(sid);
      toast(`KYM: next agent's prompt copied to clipboard — paste it into the session.`);
    }
    return true;
  }

  /** Move a marble to the locked Failed group in TODO (session closed mid-run). */
  /** Forget every hop-delivery guard for a run (on finish/fail/re-run). */
  private clearDelivered(id: string): void {
    for (const k of [...this.deliveredHops]) {
      if (k === id || k.startsWith(id + ":")) {
        this.deliveredHops.delete(k);
      }
    }
  }

  private failRun(id: string): void {
    this.sawWorking.delete(id);
    this.runStartAt.delete(id);
    this.clearDelivered(id);
    this.store.updateMarble(id, {
      stage: "todo",
      sectionId: undefined,
      fieldX: undefined,
      fieldY: undefined,
      runStatus: "failed",
      runKind: undefined,
    });
    this.post({ type: "runStop", id });
  }

  /** Pause / resume a pass-around run from the marble's on-ball control. */
  private async runControl(id: string, action: string): Promise<void> {
    const marble = this.store.marble(id);
    if (!marble) return;
    if (action === "pause") {
      if (marble.runStatus === "running" || marble.runStatus === "attention") {
        this.store.updateMarble(id, { runStatus: "paused", runKind: undefined });
        this.post({ type: "runStop", id });
      }
    } else if (action === "resume") {
      if (marble.runStatus === "paused") {
        this.store.updateMarble(id, { runStatus: "running" });
        // The hop may have finished while paused — re-check right away.
        this.advanceRun(this.store.marble(id)!);
      }
    }
  }

  /**
   * Lazily ensure a worktree + Claude session for the marble, then hand off the
   * composed prompt via the clipboard (the Claude patch has no prompt-injection
   * command yet — see docs/kym-plan.md §7). Auto-advance to Verify happens when
   * the bound session reports `done`.
   */
  private async startWork(id: string): Promise<void> {
    const marble = this.store.marble(id);
    if (!marble) {
      return;
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `KYM: preparing "${marble.title}"`,
      },
      async (progress) => {
        try {
          progress.report({
            message: marble.branch ? "resolving worktree…" : "using top-level repo…",
          });
          const cwd = await this.resolveCwd(marble);
          this.store.updateMarble(id, { worktreeCwd: cwd });

          progress.report({ message: "opening session…" });
          const prompt = this.composePrompt(marble);

          // The patched Claude bundle auto-submits the prompt into the new
          // session; copy it too as a backup for unpatched bundles.
          await openWorktreeClaudeTab(cwd, prompt);
          if (prompt.trim()) {
            await vscode.env.clipboard.writeText(prompt);
            toast(
              `KYM: "${marble.title}" session starting — prompt injected (also copied to clipboard as backup).`
            );
          }
        } catch (err) {
          toast(
            `KYM: could not prepare "${marble.title}" — ${
              err instanceof Error ? err.message : String(err)
            }`,
            "error"
          );
        }
      }
    );
  }

  /** marble.prompt + the effective per-stage extra instructions. */
  private composePrompt(marble: Marble): string {
    const stageNote = this.store.stageInstruction(marble.stage);
    return [marble.prompt.trim(), stageNote].filter(Boolean).join("\n\n");
  }

  /**
   * Archive: refuse if the worktree has uncommitted changes; otherwise remove the
   * worktree only when no other non-archived marble still targets that branch.
   */
  private async archiveMarble(id: string): Promise<void> {
    const marble = this.store.marble(id);
    if (!marble) {
      return;
    }
    const cwd = marble.worktreeCwd;
    if (!cwd) {
      return; // never processed → no worktree to clean up
    }
    // A branchless marble ran in the top-level repo — never remove that.
    if (!marble.branch || realPath(cwd) === realPath(this.store.root)) {
      this.store.updateMarble(id, { worktreeCwd: undefined });
      return;
    }
    const others = this.store.activeOnBranch(marble.branch, id);
    if (others.length > 0) {
      // Another marble still needs this worktree — keep it.
      return;
    }
    const clean = await isWorktreeClean(cwd);
    if (!clean) {
      toast(
        `KYM: "${marble.title}" has uncommitted changes — commit them before archiving. The worktree was kept.`,
        "warning"
      );
      // Revert the move so the fail-safe is visible to the user.
      this.store.updateMarble(id, { stage: "done" });
      return;
    }
    try {
      await removeWorktreePath(cwd);
      this.store.updateMarble(id, { worktreeCwd: undefined });
      toast(`KYM: archived "${marble.title}" and removed its worktree.`);
    } catch (err) {
      toast(
        `KYM: failed to remove worktree for "${marble.title}" — ${
          err instanceof Error ? err.message : String(err)
        }`,
        "error"
      );
    }
  }

  /**
   * Open the Claude session tied to a marble. Clicking a marble anywhere but the
   * TODO backlog should land on ITS session: reveal the exact bound one if it's
   * still open; otherwise RESUME the marble's previous conversation (with its
   * history) when one is recorded, or open a fresh session as the last resort —
   * in every case bound to exactly this marble so future clicks land on it.
   */
  private async openSession(id: string): Promise<void> {
    const marble = this.store.marble(id);
    if (!marble) {
      return;
    }
    // 1. The bound session is still open → reveal precisely it. sessionFor
    //    cross-checks the persisted panel id against the session uuid, so a
    //    stale id from a previous window never reveals an unrelated tab.
    const bound = this.sessionFor(marble);
    if (bound) {
      if (bound.id !== marble.sessionId) {
        this.store.updateMarbleQuiet(id, { sessionId: bound.id });
      }
      await this.status.reveal(bound.id);
      return;
    }
    // 2. Resolve where this marble runs (its worktree, or the top-level repo for a
    //    branchless one), creating the worktree only if it has a branch.
    let cwd = marble.worktreeCwd;
    if (!cwd) {
      try {
        cwd = await this.resolveCwd(marble);
        this.store.updateMarble(id, { worktreeCwd: cwd });
      } catch (err) {
        toast(
          `KYM: could not open a session for "${marble.title}" — ${
            err instanceof Error ? err.message : String(err)
          }`,
          "error"
        );
        return;
      }
    }
    // 3. Open the marble's OWN session: resume its previous conversation (with
    //    history) when we have its uuid, else a fresh one. Bind the tab that
    //    appears (snapshot-diff / uuid match) — never adopt a pre-existing tab
    //    that merely shares the cwd, so the session stays this marble's own.
    //    Snapshot NOW, after the awaits above — a tab the user opened while the
    //    worktree was being created must not be mistaken for ours.
    const resumeSid = marble.claudeSessionId;
    const before = new Set(this.status.tabs().map((t) => t.id));
    this.boundThisWindow.delete(id);
    this.store.updateMarble(id, { sessionId: undefined });
    await openWorktreeClaudeTab(cwd, undefined, resumeSid);
    this.bindNewSession(id, cwd, before, resumeSid);
  }

  // --- auto-transitions ----------------------------------------------------

  /**
   * On any Claude status change, advance marbles in Plan/Process to Verify once
   * their worktree session has actually worked and then reported `done`.
   */
  private onStatusChange(): void {
    // Bookkeeping first: record session uuids as they appear and repair panel
    // ids after a reload, so everything below (and the webview) sees truthful
    // bindings.
    this.syncSessionBindings();
    const byCwd = this.statusByCwd();
    let changed = false;
    for (const marble of this.store.marbles()) {
      // Pass-around runs are driven by their own state machine.
      if (
        marble.runStatus === "running" ||
        marble.runStatus === "paused" ||
        marble.runStatus === "attention"
      ) {
        if (this.driveRun(marble)) {
          changed = true;
        }
        continue;
      }
      // Legacy single-session advance: plan/process → verify on done.
      if (
        (marble.stage !== "plan" && marble.stage !== "process") ||
        !marble.worktreeCwd
      ) {
        continue;
      }
      const s = byCwd[marble.worktreeCwd];
      if (s === "working" || s === "plan" || s === "question" || s === "permission") {
        this.sawWorking.add(marble.id);
      } else if (s === "done" && this.sawWorking.has(marble.id)) {
        this.store.updateMarble(marble.id, { stage: "verify" });
        this.sawWorking.delete(marble.id);
        changed = true;
      }
    }
    // Always refresh the dots even if no stage changed.
    if (!changed) {
      this.postState();
    }
    // A session may have just bound → re-evaluate which agents to light.
    this.postActiveSession();
  }

  /**
   * Advance one pass-around marble on a Claude status change. Binds the session,
   * detects a mid-run close (→ Failed), surfaces attention states (→ bounce), and
   * moves to the next hop / finish when the session goes idle after working.
   * Returns true if it made a store change (so the caller skips a redundant post).
   */
  private driveRun(marble: Marble): boolean {
    const tab = this.sessionFor(marble);
    if (!tab) {
      // Bound a session earlier but it's gone now → closed mid-run.
      if (marble.sessionId) {
        this.failRun(marble.id);
        return true;
      }
      return false; // not bound yet — bindNewSession is still polling
    }
    const s = String(tab.status);
    if (marble.runStatus === "paused") {
      if (s === "working" || s === "question" || s === "permission" || s === "plan") {
        this.sawWorking.add(marble.id);
      }
      return false;
    }
    // Attention: the session needs the user — stop and bounce.
    if (s === "question" || s === "permission" || s === "plan") {
      this.sawWorking.add(marble.id);
      if (marble.runStatus !== "attention" || marble.runKind !== s) {
        this.store.updateMarble(marble.id, { runStatus: "attention", runKind: s });
        this.post({ type: "runStop", id: marble.id });
        return true;
      }
      return false;
    }
    if (s === "working") {
      this.sawWorking.add(marble.id);
      if (marble.runStatus === "attention") {
        this.store.updateMarble(marble.id, { runStatus: "running", runKind: undefined });
        return true; // render → the orbit resumes
      }
      return false;
    }
    // idle / done: the session's composer is ready.
    if (s === "idle" || s === "done") {
      const index = marble.runIndex ?? 0;
      // Deliver this hop's prompt first, exactly once. deliverHop clears
      // sawWorking, so a session's *initialization* "working" (before we ever
      // sent a prompt) can't be mistaken for this hop completing.
      if (!this.deliveredHops.has(marble.id + ":" + index)) {
        this.deliverHop(marble, index);
        return false;
      }
      // Only advance once we've seen the session work AFTER delivery and go idle
      // again — that's the hop genuinely finishing.
      if (this.sawWorking.has(marble.id)) {
        return this.advanceRun(marble);
      }
    }
    return false;
  }

  /**
   * Submit hop `index`'s prompt into the bound session exactly once. The
   * `deliveredHops` guard makes repeat driveRun cycles a no-op, so a slow or
   * re-rendering session never gets the same prompt twice. An agent with no
   * prompt has nothing to run — mark it delivered and advance after a brief visit.
   */
  private deliverHop(marble: Marble, index: number): void {
    const key = marble.id + ":" + index;
    if (this.deliveredHops.has(key)) {
      return;
    }
    this.deliveredHops.add(key);
    // Discard any pre-delivery "working" (session init) so the next idle isn't
    // read as this hop already finishing.
    this.sawWorking.delete(marble.id);
    if (!this.hopPrompt(marble, index)) {
      setTimeout(() => {
        const m = this.store.marble(marble.id);
        if (m && m.runStatus === "running" && (m.runIndex ?? 0) === index) {
          this.advanceRun(m);
        }
      }, 1200);
      return;
    }
    void this.sendHop(marble, index);
  }

  /** Move to the next hop (or finish). Returns true (a store change was made). */
  private advanceRun(marble: Marble): boolean {
    const path = marble.pathAgentIds ?? [];
    const cur = marble.runIndex ?? 0;
    if (cur < path.length - 1) {
      const next = cur + 1;
      this.sawWorking.delete(marble.id);
      this.store.updateMarble(marble.id, {
        runIndex: next,
        runStatus: "running",
        runKind: undefined,
      });
      const m = this.store.marble(marble.id)!;
      // The session just went idle after the previous hop — its composer is
      // ready, so deliver the next hop's prompt now (exactly once; empty-prompt
      // agents are visited briefly then skipped inside deliverHop).
      this.deliverHop(m, next);
      this.post({ type: "runHop", id: marble.id, index: next });
      return true;
    }
    this.finishRun(marble);
    return true;
  }

  /** Last hop done: roll off the field, then deposit into Verify as the #1 card. */
  private finishRun(marble: Marble): void {
    const id = marble.id;
    this.sawWorking.delete(id);
    this.runStartAt.delete(id);
    this.clearDelivered(id);
    // The webview rolls the ball off the right edge (a slow, full-width roll) and
    // reports back when it's actually gone — only THEN do we deposit it in Verify.
    // A fixed timer would yank it into Verify mid-roll (the "insta-pop"). Keep a
    // safety net longer than the longest possible roll in case the webview is
    // closed/reloaded mid-roll and never reports.
    this.rollingOff.add(id);
    this.post({ type: "runFinish", id });
    setTimeout(() => this.depositToVerify(id), 4000);
  }

  /** Deposit a rolled-off marble as Verify's #1 card. Exactly-once via rollingOff. */
  private depositToVerify(id: string): void {
    if (!this.rollingOff.delete(id)) return; // already deposited (or never rolling)
    const m = this.store.marble(id);
    if (!m) return;
    const firstVerify = this.store
      .marbles()
      .filter((x) => x.stage === "verify")
      .sort((a, b) => a.order - b.order)[0];
    this.store.updateMarble(id, {
      runStatus: undefined,
      runIndex: undefined,
      runKind: undefined,
    });
    this.store.reorder(id, "verify", undefined, firstVerify ? firstVerify.id : null);
    this.post({ type: "arrived", id });
  }

  // --- webview html --------------------------------------------------------

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src data:; script-src 'nonce-${nonce}';`;
    const codicon = codiconBase64();
    const fontFace = codicon
      ? `@font-face { font-family: 'codicon'; src: url(data:font/ttf;base64,${codicon}) format('truetype'); }`
      : "";
    return `<!DOCTYPE html><html><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>${fontFace}${STYLE}</style>
</head><body>
<div id="board"></div>
<div id="modal" class="hidden"><div id="modalCard"></div></div>
<script nonce="${nonce}">const MARBLES_URI=${JSON.stringify(
      this.marblesUri
    )};const MEDIA_URI=${JSON.stringify(this.mediaUri)};</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body></html>`;
  }
}

// --- webview assets (inlined) ----------------------------------------------

const STYLE = `
:root{--gap:8px;}
*{box-sizing:border-box;}
html,body{height:100%;}
body{margin:0;padding:0;font-family:var(--vscode-font-family);color:var(--vscode-foreground);
  background:var(--vscode-editor-background);font-size:13px;display:flex;
  flex-direction:column;overflow:hidden;}
/* One Kanban pane split into sections by dividers (no per-column boxes). */
#board{position:relative;display:flex;flex:1 1 auto;min-height:0;overflow-x:auto;overflow-y:hidden;user-select:none;
  border-left:1px solid var(--vscode-statusBar-background);
  border-right:1px solid var(--vscode-statusBar-background);}
.col{position:relative;flex:1 0 300px;min-width:300px;display:flex;flex-direction:column;min-height:0;
  border-right:1px solid var(--vscode-statusBar-background);}
.col.todo{flex:1 0 300px;min-width:300px;}
.col.planprocess{flex:2 0 520px;min-width:520px;}
.col:last-child{border-right:none;}
/* 4px-wide column resize handle straddling the right divider. */
.col-resize{position:absolute;top:0;right:-2px;width:4px;height:100%;cursor:col-resize;z-index:6;}
.col-resize:hover{background:var(--vscode-focusBorder);opacity:.5;}
.col h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin:0;
  padding:6px 8px 6px 10px;border-bottom:1px solid var(--vscode-statusBar-background);
  flex:0 0 auto;color:#1e1e1e;background-repeat:repeat;background-size:300px 300px;
  text-shadow:0 1px 1px rgba(255,255,255,.4);display:flex;align-items:center;
  justify-content:space-between;gap:8px;min-height:32px;user-select:none;}
.col h2 .hlabel{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:none;}
.col h2 .hbtns{display:flex;gap:6px;flex:0 0 auto;align-items:center;}
.hbtn{display:inline-flex;align-items:center;justify-content:center;gap:3px;cursor:pointer;border:none;
  box-sizing:border-box;border-radius:4px;height:18px;margin:0;padding:0 7px;font-size:9px;line-height:1;font-weight:600;
  vertical-align:middle;text-transform:uppercase;letter-spacing:.03em;user-select:none;
  color:var(--vscode-button-foreground);background:var(--vscode-button-background);}
.hbtn:hover{background:var(--vscode-button-hoverBackground);}
.hbtn .plus{font-size:11px;line-height:1;font-weight:700;display:inline-flex;align-items:center;}
.hbtn.hmenu{padding:0;width:20px;background:transparent;color:#1e1e1e;font-size:15px;
  letter-spacing:0;text-shadow:0 1px 1px rgba(255,255,255,.4);}
.hbtn.hmenu:hover{background:rgba(0,0,0,.12);}
.colmenu{position:fixed;z-index:60;min-width:150px;padding:4px;border-radius:6px;
  background:var(--vscode-menu-background,var(--vscode-editorWidget-background));
  color:var(--vscode-menu-foreground,var(--vscode-foreground));
  border:1px solid var(--vscode-menu-border,var(--vscode-editorWidget-border,rgba(128,128,128,.3)));
  box-shadow:0 3px 12px rgba(0,0,0,.4);}
.colmenu-head{padding:4px 8px 6px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;
  opacity:.6;}
.colmenu-item{display:flex;align-items:center;gap:6px;width:100%;padding:5px 8px;cursor:pointer;
  border:none;border-radius:4px;background:transparent;color:inherit;font:inherit;font-size:13px;
  text-align:left;}
.colmenu-item:hover{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground));
  color:var(--vscode-menu-selectionForeground,inherit);}
.colmenu-tick{flex:0 0 auto;width:14px;text-align:center;font-size:12px;}
.col .drop{padding:8px;display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;
  overflow-y:auto;overflow-x:hidden;scrollbar-width:none;}
.col .drop::-webkit-scrollbar{display:none;}
/* Marbles: samodeus-style honeycomb packing + layered spheres, title inside. */
.mgrid{display:grid;grid-template-columns:repeat(var(--per-row,3),minmax(0,1fr));
  grid-auto-rows:var(--note-height,90px);--note-gap:3px;gap:0;flex:0 0 auto;min-height:60px;
  overflow:visible;align-content:start;}
/* The ungrouped group hugs its content (like a section) so its honeycomb-packed
   grid's negative marginBottom pulls the divider below flush against the last
   marble instead of leaving a gap or spilling past it. Only the column scrolls;
   groups/grids never scroll internally and never clip the marbles' drop shadows. */
.groupwrap{display:flex;flex-direction:column;flex:0 0 auto;min-height:0;overflow:visible;}
.marble{position:relative;z-index:2;overflow:visible;cursor:grab;touch-action:none;
  --marble-d:calc(min(var(--cell-width,90px), var(--note-height,90px)) - var(--note-gap,6px));}
.marble.dragging{opacity:0;}
/* Lift the hovered marble above its honeycomb neighbours: otherwise the marble
   overlapping from above paints over the top edge and its face drop-shadow
   darkens the edit circle, making it look different from the path chevron. */
.marble:hover{z-index:5;}
/* Edit toggle: a circle at the TOP of the ball, symmetric to the path chevron at
   the bottom and sharing its style (unfilled ring, fills on hover). */
.marble .edit{position:absolute;z-index:5;left:50%;top:9%;transform:translateX(-50%);
  width:16px;height:16px;padding:0;border-radius:50%;cursor:pointer;
  opacity:0;transition:opacity .12s ease, background .12s ease, color .12s ease;
  background:transparent;border:2px solid var(--vscode-editor-background);
  color:var(--vscode-editor-background);
  font-family:'codicon';font-size:9px;line-height:12px;text-align:center;
  box-shadow:0 1px 2px rgba(0,0,0,.4), inset 0 1px 3px rgba(0,0,0,.35);}
.marble:hover .edit{opacity:.9;}
.marble .edit:hover{opacity:1;
  background:var(--vscode-button-background);border-color:var(--vscode-button-background);
  color:var(--vscode-button-foreground);}
/* Path-editor toggle: a small chevron circle at the BOTTOM of the ball (below the
   title, inside the edge). Unfilled with a background-color ring; fills on hover
   or while active. Shown only on marble hover. */
.marble .pathtoggle{position:absolute;z-index:5;left:50%;bottom:9%;transform:translateX(-50%);
  width:16px;height:16px;padding:0;border-radius:50%;cursor:pointer;
  opacity:0;transition:opacity .12s ease, background .12s ease, color .12s ease;
  background:transparent;border:2px solid var(--vscode-editor-background);
  color:var(--vscode-editor-background);
  font-family:'codicon';font-size:9px;line-height:12px;text-align:center;
  box-shadow:0 1px 2px rgba(0,0,0,.4), inset 0 1px 3px rgba(0,0,0,.35);}
.marble:hover .pathtoggle{opacity:.9;}
.marble .pathtoggle:hover,.marble .pathtoggle.active{opacity:1;
  background:var(--vscode-button-background);border-color:var(--vscode-button-background);
  color:var(--vscode-button-foreground);}
/* Session-status indicator: shares the chevron's bottom-centre spot. Visible by
   default (so a done marble shows its check without hovering) and fades out on
   hover, revealing the path chevron underneath. Mirrors the Source+ pane glyphs. */
.marble .statusind{position:absolute;z-index:4;left:50%;bottom:9%;transform:translateX(-50%);
  width:16px;height:16px;display:flex;align-items:center;justify-content:center;
  pointer-events:none;opacity:1;transition:opacity .12s ease;
  filter:drop-shadow(0 1px 2px rgba(0,0,0,.55));}
.marble:hover .statusind{opacity:0;}
.marble .statusind .ccheck{font-family:'codicon';font-size:15px;line-height:1;color:#22C55E;}
.marble .statusind .cdot{width:9px;height:9px;border-radius:50%;
  background:var(--vscode-descriptionForeground);box-shadow:0 0 0 1.5px rgba(0,0,0,.25);}
.marble .statusind .cdot.pulse{animation:kym-pulse 1.4s ease-in-out infinite;}
.marble .statusind .cspin{width:12px;height:12px;border-radius:50%;box-sizing:border-box;
  border:1.7px solid rgba(255,255,255,.9);border-top-color:transparent;
  animation:kym-spin .8s linear infinite;filter:drop-shadow(0 1px 1px rgba(0,0,0,.5));}
@keyframes kym-spin{100%{transform:rotate(360deg);}}
/* Agent-path overlay — full-viewport, above the columns. Only shown while
   editing or hovering the chevron, so it isn't in the way otherwise. */
/* The path lives inside #board, painted above the field/column backgrounds but
   below the agents (z2) and the marbles/balls (z2) — so sprites and balls sit on
   top of the dashed line instead of the line covering them. */
#pathoverlay{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:1;overflow:visible;}
body.pathedit{cursor:crosshair;}
body.pathedit .agent{cursor:pointer;}
/* Soft warm white-gold glow around an agent that's on the path (or being hovered
   while drawing one) — a gentle bloom rather than the flat commit-button color. */
.agent.onpath .sprite,.agent.litagent .sprite{filter:drop-shadow(0 0 4px rgba(255,244,214,.95))
  drop-shadow(0 0 9px rgba(255,214,130,.75))
  drop-shadow(0 0 16px rgba(255,198,92,.45)) hue-rotate(var(--hue,0deg));}
/* The marble whose session is active (or is being hovered) glows the same warm
   gold — on its face in a column, or its ball on the field. */
.marble.litmarble .face{box-shadow:0 0 0 2px rgba(255,224,150,.95),
  0 0 12px 2px rgba(255,198,92,.7),0 2px 6px rgba(0,0,0,.25);}
.fieldmarble.litmarble .ballbody{box-shadow:0 0 0 2px rgba(255,224,150,.95),
  0 0 14px 3px rgba(255,198,92,.65);border-radius:50%;}
.face{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  width:var(--marble-d);height:var(--marble-d);border-radius:50%;overflow:hidden;
  container-type:inline-size;display:flex;align-items:center;justify-content:center;
  box-shadow:0 2px 6px rgba(0,0,0,.25);will-change:transform;}
.face .layer{position:absolute;inset:0;border-radius:50%;pointer-events:none;}
.face .base{background-repeat:repeat;background-size:500px 500px;}
body.vscode-dark .face .base,body.vscode-high-contrast:not(.vscode-high-contrast-light) .face .base{
  background-blend-mode:multiply;background-color:rgba(0,0,0,.64);
  filter:saturate(0.6) hue-rotate(-10deg) contrast(1.78) brightness(1.6);}
.face .shine{background:
  radial-gradient(circle at 28% 28%, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0.15) 12%, transparent 28%),
  radial-gradient(ellipse 90% 40% at 35% 18%, rgba(255,255,255,0.35) 0%, transparent 100%),
  radial-gradient(ellipse 90% 40% at 55% 88%, rgba(0,0,0,0.25) 0%, transparent 100%);}
body.vscode-dark .face .shine{background:
  radial-gradient(circle at 28% 28%, rgba(255,255,255,0.45) 0%, rgba(255,255,255,0.08) 12%, transparent 28%),
  radial-gradient(ellipse 90% 40% at 35% 18%, rgba(255,255,255,0.18) 0%, transparent 100%),
  radial-gradient(ellipse 90% 40% at 55% 98%, rgba(0,0,0,0.6) 0%, transparent 100%);}
.face .tex{background-size:100% 100%;mix-blend-mode:overlay;opacity:.26;}
body.vscode-dark .face .tex{mix-blend-mode:soft-light;opacity:.24;}
.face .ring{border:1px solid rgba(0,0,0,0.12);box-sizing:border-box;}
body.vscode-dark .face .ring{border:1.5px solid rgba(0,0,0,0.35);}
/* Title lines are broken explicitly by fitTitle() (max 3, circle-aware widths:
   top/bottom rows on the shorter chords, middle row wider). nowrap so the text
   never re-wraps past our measured break points — a mis-measure clips at the
   circle edge instead of adding a 4th line. */
.face .t{position:relative;z-index:1;font-weight:500;text-align:center;
  font-size:15cqw;line-height:1.12;width:100%;color:#111;
  text-shadow:0 1px 2px rgba(255,255,255,0.55);white-space:nowrap;}
body.vscode-dark .face .t{color:#eee;text-shadow:0 1px 2px rgba(0,0,0,0.6);}
.face .icon{position:relative;z-index:1;}
.face .dot{position:absolute;z-index:2;top:8%;right:8%;width:14%;height:14%;
  max-width:12px;max-height:12px;border-radius:50%;box-shadow:0 0 0 2px rgba(0,0,0,.15);}
.dot.working{background:#3794ff;} .dot.done{background:#4caf50;}
.dot.question,.dot.permission{background:#e5a300;} .dot.plan{background:#a074ff;}
.dot.idle{display:none;}
/* The field ball carries its own run visuals; the little corner status dot just
   reads as a stray blue speck clipped at the ball edge, so hide it there. */
.fieldmarble .face .dot{display:none;}
/* An agent whose bound session is active wears a STEADY warm gold glow (no pulse
   — a pulse read as flickering). setAgentProcessing adds .processing instantly
   (transition suppressed) so a mid-run re-render that rebuilds the sprite doesn't
   replay the .5s fade-in; removing it fades out via the base .sprite transition. */
.agent.processing .sprite{filter:drop-shadow(0 0 5px rgba(255,247,224,.95))
  drop-shadow(0 0 12px rgba(255,206,110,.8)) drop-shadow(0 0 20px rgba(255,190,80,.5))
  hue-rotate(var(--hue,0deg));}
.col .drop.over{outline:2px solid var(--vscode-focusBorder);outline-offset:-4px;}
/* Plan/Process field: free-placed balls + animated agent characters. */
.drop.field{position:relative;overflow:hidden;padding:0;background-repeat:repeat;}
/* Field marble = zero-size anchor at the ball's CENTER. A constant shadow sits
   just below the center; the ball BODY scales about its own center, so hover and
   the drop bounce zoom the ball equidistantly and may cover the shadow — but the
   shadow itself never moves or resizes. */
.fieldmarble{position:absolute;left:0;top:0;width:0;height:0;cursor:grab;touch-action:none;z-index:2;}
.fieldmarble .ballbody{position:absolute;left:0;top:0;width:84px;height:84px;
  transform:translate(-50%,-50%) scale(1);transform-origin:center center;will-change:transform;}
/* Transition only in the resting state (for hover) — never during the drop
   bounce, so the keyframes play cleanly with nothing competing. */
.fieldmarble.settled .ballbody{transform:translate(-50%,-50%) scale(0.3333);
  transition:transform .45s cubic-bezier(.2,.85,.3,1);}
.fieldmarble.settled:hover{z-index:6;}
.fieldmarble.settled:hover .ballbody{transform:translate(-50%,-50%) scale(1);}
.fieldmarble.grabbing{z-index:7;}
.fieldmarble .t{opacity:0;transition:opacity .35s ease;}
.fieldmarble.settled:hover .t{opacity:1;}
.fieldmarble .ballshadow{position:absolute;left:0;top:14px;width:24px;height:8px;
  transform:translate(-50%,-50%);border-radius:50%;pointer-events:none;z-index:0;
  background:radial-gradient(ellipse at center, rgba(0,0,0,.45) 0%, rgba(0,0,0,0) 70%);}
/* Pass-around run: the ball orbits an agent; attention bobs for the user. */
.fieldmarble.running .ballbody{transition:none !important;}
.fieldmarble.run-attention{animation:kym-bob .6s ease-in-out infinite;}
@keyframes kym-bob{0%,100%{transform:translateY(0);}50%{transform:translateY(-11px);}}
/* Status badge above an attention marble (reuses .dot colors). */
.fieldmarble .runbadge{position:absolute;left:0;top:-18px;width:14px;height:14px;
  transform:translate(-50%,-50%);border-radius:50%;z-index:8;pointer-events:none;
  box-shadow:0 0 0 2px var(--vscode-editor-background),0 0 6px rgba(0,0,0,.5);
  animation:kym-pulse 1.1s ease-in-out infinite;}
@keyframes kym-pulse{0%,100%{opacity:1;}50%{opacity:.4;}}
/* Pause / resume control on a running ball — only while hovered/inspected, so it
   isn't riding along the top of the ball as it rolls. */
.fieldmarble .runctl{position:absolute;left:0;top:-50px;width:18px;height:18px;
  transform:translate(-50%,-50%);z-index:9;border:none;border-radius:50%;cursor:pointer;
  opacity:0;transition:opacity .12s ease;
  background:var(--vscode-button-background);color:var(--vscode-button-foreground);
  font-size:10px;line-height:18px;text-align:center;padding:0;box-shadow:0 1px 3px rgba(0,0,0,.45);}
.fieldmarble:hover .runctl,.fieldmarble.inspect .runctl,.fieldmarble.run-paused .runctl{opacity:1;}
.fieldmarble.run-paused{filter:saturate(.7) brightness(.92);}
/* A hover-inspected running ball sits on top and shows its title. */
.fieldmarble.inspect{z-index:8;}
.fieldmarble.inspect .t{opacity:1;}
/* Edit (top) + path (bottom) buttons on a field ball — same ring style as the
   TODO marble's, positioned at the top/bottom of the expanded ball and revealed
   only when it's hovered/inspected (i.e. when the title is showing). */
.fieldmarble .edit.fmbtn,.fieldmarble .pathtoggle.fmbtn{
  position:absolute;left:0;transform:translate(-50%,-50%);z-index:9;
  width:16px;height:16px;padding:0;border-radius:50%;cursor:pointer;
  opacity:0;transition:opacity .12s ease, background .12s ease, color .12s ease;
  background:transparent;border:2px solid var(--vscode-editor-background);
  color:var(--vscode-editor-background);
  font-family:'codicon';font-size:9px;line-height:12px;text-align:center;
  box-shadow:0 1px 2px rgba(0,0,0,.4);}
.fieldmarble .edit.fmbtn{top:-30px;}
.fieldmarble .pathtoggle.fmbtn{top:30px;}
/* Reveal only after the ball has finished expanding (.45s) and the title has
   faded in; the base rule carries no delay so they vanish immediately on leave. */
.fieldmarble.settled:hover .edit.fmbtn,.fieldmarble.settled:hover .pathtoggle.fmbtn,
.fieldmarble.inspect .edit.fmbtn,.fieldmarble.inspect .pathtoggle.fmbtn{opacity:.9;transition-delay:.45s;}
.fieldmarble .edit.fmbtn:hover,.fieldmarble .pathtoggle.fmbtn:hover,
.fieldmarble .pathtoggle.fmbtn.active{opacity:1;transition-delay:0s;
  background:var(--vscode-button-background);border-color:var(--vscode-button-background);
  color:var(--vscode-button-foreground);}
/* A card that just arrived in a column flashes in (opacity/glow only — its
   transform is owned by the honeycomb layout, so we must not animate it). */
.marble.arrived .face{animation:kym-arrive .55s cubic-bezier(.2,.85,.3,1);}
@keyframes kym-arrive{
  0%{opacity:0;box-shadow:0 0 0 3px var(--vscode-button-background),0 2px 6px rgba(0,0,0,.25);}
  100%{opacity:1;box-shadow:0 2px 6px rgba(0,0,0,.25);}}
/* Locked Failed group: muted, no interactive header chrome. */
.section.failed{border-top-color:var(--vscode-inputValidation-errorBorder,#EF4444);}
.section.failed .section-head{cursor:default;color:var(--vscode-inputValidation-errorBorder,#EF4444);opacity:.9;}
.agent{position:absolute;left:0;top:0;cursor:grab;touch-action:none;z-index:2;}
.agent.grabbing{cursor:grabbing;}
.agent .sprite{image-rendering:pixelated;}
/* Ground shadow centered on the very bottom (feet) pixel, tight to the sides. */
.agent .spriteshadow{position:absolute;left:50%;bottom:0;width:38%;height:7px;
  transform:translate(-50%,50%);border-radius:50%;pointer-events:none;
  background:radial-gradient(ellipse at center, rgba(0,0,0,.45) 0%, rgba(0,0,0,0) 70%);}
.sprite{image-rendering:pixelated;background-position:0 0;filter:hue-rotate(var(--hue,0deg));transition:filter .5s ease;}
body.placing{cursor:crosshair;}
.spriteghost{position:fixed;z-index:9998;pointer-events:none;transform:translate(-50%,-100%);
  filter:drop-shadow(0 4px 6px rgba(0,0,0,.4));}
/* Character picker — reuses the task modal chrome; cells are transparent with a
   status-bar-colored outline and bottom-anchored sprites (they "stand"). */
.spritegrid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;}
/* Cells are bottom-anchored (sprites "stand"); the height is 4px shorter than the
   sprite's empty top margin so the character sits a touch higher in frame without
   ever clipping its feet. */
.spritecell{height:93px;overflow:hidden;display:flex;align-items:flex-end;justify-content:center;cursor:pointer;
  border:1px solid var(--vscode-statusBar-background);border-radius:8px;background:transparent;
  transition:background .12s ease,border-color .12s ease;}
/* Hover: keep the outline, but wash the cell with a bright whitish tint (matching
   the light feel of the hue strip) instead of the muted gray toolbar-hover. */
.spritecell:hover{border-color:var(--vscode-focusBorder);background:rgba(255,255,255,.18);}
.huerow{display:flex;align-items:center;gap:10px;margin-top:12px;}
.huerow label{margin:0;}
/* Hue strip: a full-width rainbow pill with no inner border/padding, so the knob
   travels edge to edge; rounded track ends match the round knob (no square corner
   bits peeking out at the extremes). */
.huerow input[type=range]{flex:1;-webkit-appearance:none;appearance:none;height:14px;border-radius:7px;
  padding:0;margin:0;border:none;outline:none;cursor:pointer;
  background:linear-gradient(to right,
    hsl(0,80%,60%),hsl(60,80%,60%),hsl(120,80%,60%),hsl(180,80%,60%),
    hsl(240,80%,60%),hsl(300,80%,60%),hsl(360,80%,60%));}
.huerow input[type=range]::-webkit-slider-runnable-track{height:14px;border-radius:7px;background:transparent;}
/* Knob: ring in the commit-button colour (not the near-invisible focus border). */
.huerow input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;
  width:16px;height:16px;border-radius:50%;margin-top:-1px;background:var(--vscode-editor-background);
  border:2px solid var(--vscode-button-background);cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.45);}
/* Foldable TODO sections: each is exactly as tall as its marbles (no fixed height,
   no inner scroll, no resizing) — only the whole column scrolls. A full-width
   divider + label; folding hides the grid. */
.section{position:relative;display:flex;flex-direction:column;gap:4px;flex:0 0 auto;min-height:0;
  overflow:visible;
  border-top:1px solid var(--vscode-statusBar-background);
  margin:2px -8px 0;padding:3px 8px 0;}
/* Placeholder gap shown where a dragged section will land (drag reorder). */
.sec-placeholder{margin:2px -8px 0;border:1px dashed var(--vscode-focusBorder);
  border-radius:6px;opacity:.5;box-sizing:border-box;}
.section-head{display:flex;align-items:center;gap:6px;font-size:11px;text-transform:uppercase;
  letter-spacing:.04em;opacity:.85;user-select:none;flex:0 0 auto;cursor:grab;}
/* While dragging, the section floats (position set inline in JS) above the list
   with its own backdrop + shadow so siblings reflow cleanly around a placeholder. */
.section.sdragging{opacity:.95;z-index:9999;border-radius:6px;
  background:var(--vscode-editor-background);box-shadow:0 8px 24px rgba(0,0,0,.45);}
.section.sdragging .section-head{cursor:grabbing;}
.section-head .caret{width:16px;height:18px;display:inline-flex;align-items:center;justify-content:center;
  cursor:pointer;font-family:'codicon';font-size:16px;flex:0 0 auto;}
.section-head .slabel{flex:0 1 auto;min-width:0;font-weight:600;cursor:pointer;line-height:18px;height:18px;display:flex;
  align-items:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.section-head input.slabel{background:transparent;border:none;color:inherit;font:inherit;
  text-transform:inherit;letter-spacing:inherit;padding:0;outline:none;cursor:text;user-select:text;}
.section-head input.slabel:focus{border-bottom:1px solid var(--vscode-focusBorder);}
.section-head .scount{opacity:.6;cursor:pointer;line-height:18px;height:18px;display:flex;align-items:center;flex:0 0 auto;}
.section-head .spencil{cursor:pointer;background:transparent;border:none;color:inherit;opacity:0;
  font-size:12px;line-height:18px;height:18px;padding:0 2px;margin-right:auto;display:flex;align-items:center;
  justify-content:center;flex:0 0 auto;}
.section-head:hover .spencil{opacity:.55;}
.section-head .spencil:hover{opacity:1;}
.section-head .srm{cursor:pointer;background:transparent;border:none;color:inherit;opacity:.5;
  font-size:16px;line-height:1;height:18px;width:18px;padding:0;display:flex;align-items:center;
  justify-content:center;flex:0 0 auto;}
.section-head .srm:hover{opacity:1;}
.section.collapsed{flex:0 0 auto;}
.section.collapsed .mgrid{display:none;}
.hidden{display:none!important;}
#modal{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;
  align-items:flex-start;justify-content:center;padding-top:40px;z-index:1000;}
#modalCard{background:var(--vscode-editorWidget-background);border:1px solid
  var(--vscode-button-background);border-radius:8px;padding:16px;width:520px;max-width:92vw;
  max-height:88vh;overflow:auto;display:flex;flex-direction:column;gap:10px;}
#modalCard label{font-size:11px;text-transform:uppercase;opacity:.7;display:block;margin-bottom:3px;}
#modalCard input,#modalCard textarea,#modalCard select{width:100%;padding:6px;border-radius:4px;
  border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);
  color:var(--vscode-input-foreground);font-family:inherit;font-size:13px;}
#modalCard input::placeholder,#modalCard textarea::placeholder{
  color:var(--vscode-input-placeholderForeground);}
#modalCard textarea{min-height:70px;resize:vertical;}
.row{display:flex;gap:10px;} .row>div{flex:1;}
.chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
.chip{font-size:11px;padding:3px 4px 3px 8px;border-radius:12px;background:var(--vscode-badge-background);
  color:var(--vscode-badge-foreground);cursor:grab;display:inline-flex;align-items:center;gap:4px;}
.chip .chipX{cursor:pointer;border:none;background:transparent;color:inherit;opacity:.6;
  font-size:13px;line-height:1;padding:0 2px;border-radius:8px;width:auto;}
.chip .chipX:hover{opacity:1;}
.snipAdd{display:flex;gap:6px;margin-top:6px;}
.snipAdd input{flex:1;}
.snipAdd #snip-tag{flex:0 0 120px;}
.snipAdd button{flex:0 0 auto;width:auto;cursor:pointer;padding:5px 12px;border-radius:4px;
  border:1px solid var(--vscode-panel-border);background:transparent;color:var(--vscode-foreground);}
/* Small circle-plus add buttons (snippets, tickets). */
.lblrow{display:flex;align-items:center;justify-content:space-between;margin-bottom:3px;}
.lblrow label{margin:0;}
.addcircle{flex:0 0 auto;width:18px;height:18px;padding:0;border-radius:50%;cursor:pointer;
  box-sizing:border-box;border:1px solid var(--vscode-button-background);background:transparent;
  color:var(--vscode-button-background);font-size:15px;line-height:0;display:flex;align-items:center;
  justify-content:center;}
.addcircle:hover{background:var(--vscode-button-background);color:var(--vscode-button-foreground);}
/* Segmented "Worktree Setup" toggle (Basic | Full). */
.seg{display:flex;border:1px solid var(--vscode-button-background);border-radius:4px;overflow:hidden;}
.seg button{flex:1 1 0;cursor:pointer;border:none;background:transparent;color:var(--vscode-foreground);
  padding:6px 4px;font-size:12px;font-family:inherit;}
.seg button+button{border-left:1px solid var(--vscode-button-background);}
.seg button.sel{background:var(--vscode-button-background);color:var(--vscode-button-foreground);}
.seg button:not(.sel):hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2));}
/* Ticket URL rows. */
.ticketRow{display:flex;gap:6px;margin-top:6px;align-items:center;}
.ticketRow input{flex:1;}
.ticketRow .trm{flex:0 0 auto;width:auto;cursor:pointer;background:transparent;border:none;
  color:inherit;opacity:.6;font-size:15px;line-height:1;padding:0 4px;}
.ticketRow .trm:hover{opacity:1;}
/* Themed branch combobox (replaces the unthemed native datalist). */
.combo{position:relative;}
.combo-list{position:absolute;left:0;right:0;top:calc(100% + 2px);z-index:10;max-height:180px;
  overflow-y:auto;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);
  border:1px solid var(--vscode-dropdown-border,var(--vscode-panel-border));border-radius:4px;
  box-shadow:0 3px 8px rgba(0,0,0,.35);}
.combo-list .opt{padding:5px 8px;cursor:pointer;font-size:13px;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;}
.combo-list .opt:hover,.combo-list .opt.active{background:var(--vscode-list-hoverBackground);}
#modalCard .checks{display:flex;gap:16px;align-items:center;}
#modalCard .checks label{display:inline-flex;gap:6px;align-items:center;text-transform:none;
  font-size:13px;opacity:1;margin-bottom:0;cursor:pointer;}
#modalCard .checks input[type=checkbox]{width:16px;height:16px;flex:0 0 auto;margin:0;
  accent-color:var(--vscode-button-background);cursor:pointer;}
.palette{display:flex;gap:6px;flex-wrap:wrap;}
.palette .swatch{width:26px;height:26px;padding:0;border-radius:50%;cursor:pointer;
  background-size:120px 120px;background-repeat:repeat;
  border:2px solid transparent;box-shadow:0 1px 3px rgba(0,0,0,.3);}
.palette .swatch.sel{border-color:var(--vscode-focusBorder);}
.modalBtns{display:flex;gap:8px;margin-top:8px;}
.modalBtns button{flex:1 1 0;cursor:pointer;padding:8px 14px;border:none;border-radius:4px;font-size:13px;}
.btnPrimary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600;}
.btnPrimary:hover{background:var(--vscode-button-hoverBackground);}
.btnGhost{background:transparent;color:var(--vscode-foreground);
  border:1px solid var(--vscode-input-border,transparent)!important;}
.btnGhost:hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2));
  border-color:var(--vscode-button-background)!important;}
/* Agent modal buttons: Remove sits far left (red outline, fills on hover). */
.modalBtns.agentbtns button{flex:0 0 auto;}
.modalBtns.agentbtns .spacer{flex:1 1 auto;}
.btnRemove{background:transparent;color:var(--vscode-errorForeground,#e5534b);
  border:1px solid var(--vscode-errorForeground,#e5534b)!important;}
.btnRemove:hover{background:var(--vscode-errorForeground,#e5534b);color:#fff;}
/* Name bubble above an agent (black bubble, soft-white text). */
.agent .agentname{position:absolute;left:50%;bottom:100%;transform:translate(-50%,-4px);
  background:#000;color:rgba(255,255,255,.9);font-size:11px;line-height:1;padding:3px 8px;
  border-radius:9px;white-space:nowrap;pointer-events:none;max-width:180px;overflow:hidden;
  text-overflow:ellipsis;box-shadow:0 1px 4px rgba(0,0,0,.4);
  opacity:.5;transition:opacity .2s ease;}
.agent:hover .agentname{opacity:1;}
/* Modal header + close X. */
.modalHead{display:flex;align-items:center;justify-content:space-between;}
.modalHead h2{margin:0;}
#modalCard .mClose{width:26px;height:26px;padding:0;border:none;background:transparent;
  cursor:pointer;color:var(--vscode-foreground);opacity:.6;font-size:18px;line-height:1;border-radius:4px;}
#modalCard .mClose:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2));}
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
let state = { stages: [], marbles: [], sections: [], agents: [], sprites: [], snippets: [], branches: [], statusByCwd: {}, statusByMarble: {}, colTextures: {} };
// The marble diameter (px) at full size on the Plan/Process field; balls rest
// at a third of this and grow back to full on hover.
const FIELD_FULL = 84;
// Agent sprites are sized by their own frame-pixel height × this factor, so
// bigger characters render bigger (a hare < a wizard).
const FIELD_SPRITE_SCALE = 1.05;
// Per-character ground-shadow width, as a fraction of the sprite's display width.
// Four-legged animals span wider than a standing person, so they get a wider
// shadow; tweak individual entries to taste. Unlisted sprites use the default.
const SPRITE_SHADOW = {
  'boar-idle': 0.8, 'cat-idle': 0.72, 'cat-orange-idle': 0.78, 'countess-idle': 0.58,
  'deer-idle': 0.78, 'dog-idle': 0.88, 'dog-golden-idle': 0.82, 'fighter-idle': 1.5,
  'fox-idle': 0.78, 'hare-idle': 0.9, 'kunoichi-idle': 1.5, 'monk-idle': 0.6,
  'vampire-girl-idle': 0.6, 'wizard-idle': 0.55,
};
const SPRITE_SHADOW_DEFAULT = 0.5;
// Per-character ground-shadow horizontal nudge, in px (negative = left,
// positive = right) from the default bottom-center position.
const SPRITE_SHADOW_DX = {
  'boar-idle': -2, 'deer-idle': -2, 'fox-idle': 4, 'kunoichi-idle': 2,
  'swordsman-idle': 2, 'vampire-girl-idle': 2, 'warrior-2-idle': -4, 'warrior-3-idle': -3,
};
// Per-character name-label vertical nudge, in px (negative = up, above the head;
// positive = down, toward the body) from the default position just above the top.
const SPRITE_LABEL_DY = {
  'deer-idle': 3, 'fighter-idle': 1, 'kunoichi-idle': -2, 'monk-idle': -2,
  // Spear tip extends well above the head, so the label needs a big push down.
  'warrior-3-idle': 26,
};
// Per-character size multiplier on top of FIELD_SPRITE_SCALE. Tweak to taste.
const SPRITE_SIZE = {
  'boar-idle': 2, 'cat-idle': 1.2, 'cat-orange-idle': 1.2, 'deer-idle': 1.8,
  'fighter-idle': 0.9, 'fox-idle': 1.6, 'hare-idle': 1.6,
  'musketeer-idle': 0.7, 'samurai-idle': 0.85, 'swordsman-idle': 0.7, 'wizard-idle': 0.7,
  'vampire-girl-idle': 1.08, 'warrior-1-idle': 1.2, 'warrior-2-idle': 1.2, 'warrior-3-idle': 1.2,
};
const SPRITE_SIZE_DEFAULT = 1;
function spriteScale(name){
  return FIELD_SPRITE_SCALE * ((name in SPRITE_SIZE) ? SPRITE_SIZE[name] : SPRITE_SIZE_DEFAULT);
}
// Resting marble diameter on the field is a third of full (grows on hover).
const FIELD_REST = 1/3;
// How far above the drop point a freshly-dropped marble begins its fall (px).
const BOUNCE_RISE = 64;
// Column background textures: key -> {label, css builder}. "none" = no texture.
const COL_TEXTURES = {
  none:  { label: 'None' },
  grass: { label: 'Grass', url: ()=> MEDIA_URI + '/bg-grass.jpg', size: '160px 160px' },
};
let mdrag = null, flipRects = null, sdrag = null, pendingBounce = null, bounceGhostFor = null;
// The field-ball drag ghost lives on document.body, outside the board. If a
// state update re-renders mid-drag, the dragged element (and its pointer
// handlers) are destroyed, so nothing would ever remove the ghost — it would
// sit on the pane as a full-size, uninteractable phantom ball. Track it
// globally so render() can abort the drag and clean it up.
let fieldDrag = null; // {ghost: HTMLElement|null}
function abortDrags(){
  if(mdrag){ if(mdrag.ghost) mdrag.ghost.remove(); mdrag = null; }
  if(fieldDrag){ if(fieldDrag.ghost) fieldDrag.ghost.remove(); fieldDrag = null; }
  stopDragScroll();
}
// --- edge auto-scroll while dragging a marble -------------------------------
// So a marble can be dropped into a section (or column) that's scrolled out of
// view: near an edge, scroll the board horizontally / the hovered column
// vertically on a rAF loop (a plain per-move handler stalls when the pointer
// holds still at the edge). updateDragScroll(px,py) is called on every move.
let dragScrollRAF = 0, dragScroll = null;
function updateDragScroll(px, py){
  const board = document.getElementById('board'); if(!board){ stopDragScroll(); return; }
  const EDGE = 56, SPEED = 16;
  const br = board.getBoundingClientRect();
  let vx = 0;
  if(px < br.left + EDGE) vx = -SPEED * Math.min(1, (br.left + EDGE - px)/EDGE);
  else if(px > br.right - EDGE) vx = SPEED * Math.min(1, (px - (br.right - EDGE))/EDGE);
  let target = null, vy = 0;
  for(const n of document.elementsFromPoint(px, py)){
    const d = n.closest ? n.closest('.col .drop') : null; if(d){ target = d; break; }
  }
  if(target){
    const cr = target.getBoundingClientRect();
    if(py < cr.top + EDGE) vy = -SPEED * Math.min(1, (cr.top + EDGE - py)/EDGE);
    else if(py > cr.bottom - EDGE) vy = SPEED * Math.min(1, (py - (cr.bottom - EDGE))/EDGE);
  }
  dragScroll = { board, target, vx, vy };
  if((vx || vy) && !dragScrollRAF) dragScrollRAF = requestAnimationFrame(stepDragScroll);
}
function stepDragScroll(){
  dragScrollRAF = 0;
  const s = dragScroll; if(!s) return;
  if(s.vx) s.board.scrollLeft += s.vx;
  if(s.vy && s.target) s.target.scrollTop += s.vy;
  if(s.vx || s.vy) dragScrollRAF = requestAnimationFrame(stepDragScroll);
}
function stopDragScroll(){
  if(dragScrollRAF) cancelAnimationFrame(dragScrollRAF);
  dragScrollRAF = 0; dragScroll = null;
}
// Active path-editor session: { mid, ids:[agentId,...], mouse:{x,y}|null }.
let pathEdit = null;
// Marble whose committed path is currently shown on hover (for scroll redraws).
let hoverPathMid = null;
// Running ball currently hover-inspected (orbit frozen, expanded to full marble).
let inspectMid = null;
// Dashed agent-path line: fat rounded dashes (button color) with a background
// halo drawn underneath so it reads on any texture.
const PATH_MAIN_W = 5, PATH_BORDER_W = 9, PATH_DASH = '5 12';
const SVGNS = 'http://www.w3.org/2000/svg';
const MARBLE_COLORS = ['plum','mud','red','orange','yellow','purple','blue','gray','green','lime'];
// Codicon chevron glyphs (chevron-right / chevron-down) — same as the SCM+ tree.
const CH_RIGHT = String.fromCharCode(0xEAB6), CH_DOWN = String.fromCharCode(0xEAB4);
const CH_EDIT = String.fromCharCode(0xEA73);   // codicon "edit" (pencil)
const CH_CHECK = String.fromCharCode(0xEAB2);  // codicon "check" — matches Source+
// Attention-state dot colours, matching the Source+ pane's Claude-tab status dots.
const STATUS_DOT_COLOR = { question:'#F59E0B', plan:'#A855F7', permission:'#EF4444' };
// Target marble diameter (px); columns fit as many per row as their width allows.
const TARGET_CELL = 92;
// The board columns: Plan + Process are merged into one double-width column.
// Header background uses a marble texture (tex = color-<tex>.webp).
const COLUMNS = [
  {key:'todo',        label:'TODO',           stages:['todo'],            perRow:4, tex:'gray'},
  {key:'planprocess', label:'Plan & Process', stages:['plan','process'],  perRow:6, tex:'green', combined:true},
  {key:'verify',      label:'Verify',         stages:['verify'],          perRow:4, tex:'red'},
  {key:'done',        label:'Done',           stages:['done'],            perRow:4, tex:'green'},
  {key:'archive',     label:'Archive',        stages:['archive'],         perRow:4, tex:'gray'},
];

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'state') { state = m; render(); }
  else if (m.type === 'runHop') { runHop(m.id, m.index); }
  else if (m.type === 'runFinish') { runFinish(m.id); }
  else if (m.type === 'runStop') { runStop(m.id); }
  else if (m.type === 'arrived') { flashArrived(m.id); }
  else if (m.type === 'activeSession') {
    // The active editor tab changed → light that tab's marble + its agents (or
    // nothing when the tab has no marble).
    sessionLitMid = m.mid || null;
    lightSession(sessionLitMid);
  }
});
window.addEventListener('resize', ()=>{ layoutMarbles(); layoutField(); redrawActivePath(); });
// Keep the agent-path overlay glued to the board as it scrolls horizontally.
document.addEventListener('scroll', ()=>{ redrawActivePath(); }, true);

// Status shown on a marble's own indicator: its OWN bound session, not the cwd
// aggregate — otherwise every marble sharing a worktree shows a sibling's spinner.
function marbleStatus(marble){
  return (state.statusByMarble && state.statusByMarble[marble.id]) || 'idle';
}

function render(){
  abortDrags();
  captureRects();
  const board = document.getElementById('board');
  // Rebuilding the board resets its scroll; capture and restore so a state
  // update never jumps the horizontal scroll position out from under the user.
  const savedScroll = board.scrollLeft;
  // Same for each column's vertical scroll — otherwise folding/unfolding a section
  // (which re-renders) snaps the column back to the top, which is disorienting.
  const savedTops = {};
  board.querySelectorAll('.col').forEach(function(c){
    const d = c.querySelector(':scope > .drop');
    if(d && c.dataset.key) savedTops[c.dataset.key] = d.scrollTop;
  });
  board.innerHTML = '';
  const cw = state.colWidths || {};
  COLUMNS.forEach(function(col, ci){
    const c = document.createElement('div');
    c.className = 'col ' + col.key;
    c.dataset.key = col.key;
    if(cw[col.key]){ c.style.flex = '0 0 ' + cw[col.key] + 'px'; c.style.minWidth = cw[col.key] + 'px'; }

    const items = state.marbles.filter(x => col.stages.includes(x.stage));

    const h = document.createElement('h2');
    h.style.backgroundImage = "url('" + MARBLES_URI + "/color-" + col.tex + ".webp')";
    const hl = document.createElement('span'); hl.className='hlabel';
    hl.textContent = col.label + '  (' + items.length + ')';
    h.appendChild(hl);
    // The Task / Section actions live in the TODO header (green textured).
    if(col.key === 'todo'){
      const btns = document.createElement('div'); btns.className='hbtns';
      btns.appendChild(headerBtn('Task', ()=> openModal()));
      btns.appendChild(headerBtn('Section', ()=>
        vscode.postMessage({type:'addSection', label:'New Section'})));
      h.appendChild(btns);
    }
    // The Plan/Process header gets a + Agent button and a ⋯ texture menu.
    if(col.combined){
      const btns = document.createElement('div'); btns.className='hbtns';
      btns.appendChild(headerBtn('Agent', ()=> openSpriteSelector()));
      btns.appendChild(colMenuBtn(col.key));
      h.appendChild(btns);
    }
    c.appendChild(h);

    const drop = document.createElement('div'); drop.className = 'drop';
    if(col.key === 'todo'){
      applyColTexture(drop, (state.colTextures||{})[col.key]);
      const secIds = (state.sections||[]).map(s=>s.id);
      // Failed marbles (closed mid-run) live in a locked group pinned at the
      // bottom, shown only while it holds any; they never belong to a section.
      const failed = items.filter(x => x.runStatus === 'failed');
      const normal = items.filter(x => x.runStatus !== 'failed');
      const ungrouped = normal.filter(x => !x.sectionId || !secIds.includes(x.sectionId));
      const ugWrap = document.createElement('div'); ugWrap.className = 'groupwrap';
      ugWrap.appendChild(groupEl('todo', '', ungrouped, col.perRow, false));
      drop.appendChild(ugWrap);
      for(const sec of (state.sections||[]))
        drop.appendChild(sectionEl(sec, normal.filter(x => x.sectionId === sec.id), col.perRow));
      if(failed.length) drop.appendChild(failedSectionEl(failed, col.perRow));
    } else if(col.combined){
      // Plan/Process is a free-placement "field": grass by default, holding
      // dropped marble-balls and animated agent characters.
      drop.classList.add('field');
      const tex = (state.colTextures||{})[col.key];
      applyColTexture(drop, (tex===undefined || tex==='') ? 'grass' : tex);
      for(const it of items) drop.appendChild(fieldMarbleEl(it));
      for(const ag of (state.agents||[])) drop.appendChild(agentEl(ag));
    } else {
      drop.appendChild(groupEl(col.key, '', items, col.perRow, false));
    }
    c.appendChild(drop);

    // Column resize handle (all but the last column).
    if(ci < COLUMNS.length - 1) c.appendChild(colResizeHandle(col.key));

    board.appendChild(c);
  });
  board.scrollLeft = savedScroll;
  requestAnimationFrame(()=>{
    layoutMarbles(); layoutField(); flipFaces();
    // Restore each column's vertical scroll after layout has set the heights.
    board.querySelectorAll('.col').forEach(function(c){
      const d = c.querySelector(':scope > .drop');
      const t = c.dataset.key ? savedTops[c.dataset.key] : undefined;
      if(d && t != null) d.scrollTop = t;
    });
    // The board DOM was rebuilt — re-assert an in-progress path edit over it.
    if(pathEdit){ markToggle(pathEdit.mid, true); redrawPathEdit(); }
    // Elements were rebuilt — re-assert the active session's lit marble + agents.
    if(sessionLitMid && !pathEdit) lightSession(sessionLitMid);
    syncRuns();
  });
}

function headerBtn(label, onclick){
  const b = document.createElement('button'); b.className='hbtn'; b.type='button';
  const plus = document.createElement('span'); plus.className='plus'; plus.textContent='+';
  const txt = document.createElement('span'); txt.textContent = label;
  b.appendChild(plus); b.appendChild(txt);
  b.onclick = onclick;
  return b;
}

// Apply (or clear) a column's background texture onto its drop area.
function applyColTexture(el, texture){
  const t = COL_TEXTURES[texture];
  if(!t || !t.url){
    el.style.backgroundImage = '';
    el.style.backgroundRepeat = '';
    el.style.backgroundSize = '';
    return;
  }
  el.style.backgroundImage = "url('" + t.url() + "')";
  el.style.backgroundRepeat = 'repeat';
  el.style.backgroundSize = t.size || 'auto';
}

// ⋯ overflow-menu button for a column header (texture picker for now).
function colMenuBtn(colKey){
  const b = document.createElement('button');
  b.className = 'hbtn hmenu'; b.type = 'button'; b.title = 'Column options';
  b.textContent = '\\u22EF'; // horizontal ellipsis
  b.onclick = (e)=>{ e.stopPropagation(); openColMenu(b, colKey); };
  return b;
}

function openColMenu(anchor, colKey){
  closeColMenu();
  let cur = (state.colTextures||{})[colKey];
  if(cur===undefined || cur==='') cur = (colKey==='planprocess') ? 'grass' : 'none';
  const menu = document.createElement('div');
  menu.className = 'colmenu'; menu.id = 'colmenu';
  const head = document.createElement('div'); head.className='colmenu-head';
  head.textContent = 'Texture'; menu.appendChild(head);
  for(const key of Object.keys(COL_TEXTURES)){
    const item = document.createElement('button');
    item.className = 'colmenu-item' + (key === cur ? ' sel' : '');
    item.type = 'button';
    const tick = document.createElement('span'); tick.className='colmenu-tick';
    tick.textContent = key === cur ? '\\u2713' : '';
    const lbl = document.createElement('span'); lbl.textContent = COL_TEXTURES[key].label;
    item.appendChild(tick); item.appendChild(lbl);
    item.onclick = (e)=>{
      e.stopPropagation();
      vscode.postMessage({type:'setColTexture', key:colKey, texture:key});
      closeColMenu();
    };
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + 'px';
  menu.style.left = Math.max(4, r.right - menu.offsetWidth) + 'px';
  setTimeout(()=> document.addEventListener('mousedown', onDocMenuDown), 0);
}
function onDocMenuDown(e){
  const m = document.getElementById('colmenu');
  if(m && !m.contains(e.target)) closeColMenu();
}
function closeColMenu(){
  const m = document.getElementById('colmenu');
  if(m) m.remove();
  document.removeEventListener('mousedown', onDocMenuDown);
}

function colResizeHandle(key){
  const h = document.createElement('div'); h.className='col-resize';
  // Double-click resets this (the left) column to its default width.
  h.ondblclick = (e)=>{
    e.preventDefault(); e.stopPropagation();
    const col = h.parentElement;
    col.style.flex = ''; col.style.minWidth = '';
    layoutMarbles();
    vscode.postMessage({type:'resetColWidth', key});
  };
  h.onpointerdown = (e)=>{
    if(e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const col = h.parentElement;
    const startX = e.clientX, startW = col.getBoundingClientRect().width;
    h.setPointerCapture(e.pointerId);
    h.onpointermove = (ev)=>{
      const w = Math.max(180, startW + (ev.clientX - startX));
      col.style.flex = '0 0 ' + w + 'px'; col.style.minWidth = w + 'px';
      layoutMarbles();
    };
    const up = (ev)=>{ try{ h.releasePointerCapture(ev.pointerId); }catch(_e){}
      h.onpointermove = null; h.onpointerup = null;
      vscode.postMessage({type:'setColWidth', key, width: Math.round(col.getBoundingClientRect().width)}); };
    h.onpointerup = up;
  };
  return h;
}

// The locked "Failed" group at the bottom of TODO — holds marbles whose session
// was closed mid-run. No add/rename/drag-in chrome; dragging a marble out (a
// normal reorder) clears its failed state on the backend and this group hides
// again once empty.
function failedSectionEl(items, perRow){
  const sec = document.createElement('div'); sec.className = 'section failed';
  const head = document.createElement('div'); head.className = 'section-head';
  const lbl = document.createElement('span'); lbl.className = 'slabel'; lbl.textContent = 'Failed';
  const cnt = document.createElement('span'); cnt.className = 'scount'; cnt.textContent = '(' + items.length + ')';
  head.appendChild(lbl); head.appendChild(cnt); sec.appendChild(head);
  sec.appendChild(groupEl('todo', '', items, perRow, false));
  return sec;
}
function groupEl(stage, sectionId, items, perRow, combined){
  const g = document.createElement('div');
  g.className = 'mgrid';
  g.dataset.stage = stage;
  g.dataset.section = sectionId || '';
  if(combined) g.dataset.combined = '1';
  g.style.setProperty('--per-row', String(perRow || 3));
  for(const it of items) g.appendChild(marbleEl(it));
  return g;
}

// --- honeycomb layout (samodeus close-packing: N then N-1 nestled) ----------
function layoutMarbles(){
  document.querySelectorAll('#board .mgrid').forEach(function(g){
    const marbles = [].slice.call(g.querySelectorAll(':scope > .marble'));
    const w = g.clientWidth;
    if(!w){ return; }
    // Fit as many marbles per row as the current width allows (min 3), so
    // resizing a column packs more marbles rather than enlarging them.
    const perRow = Math.max(3, Math.round(w / TARGET_CELL));
    g.style.setProperty('--per-row', String(perRow));
    const cell = w / perRow;
    g.style.setProperty('--cell-width', cell + 'px');
    g.style.setProperty('--note-height', cell + 'px');
    const cycle = 2*perRow - 1;
    let maxRow = 0;
    marbles.forEach(function(el, i){
      const pos = i % cycle;
      const off = pos >= perRow;
      const row = Math.floor(i / cycle) * 2 + (off ? 1 : 0);
      if(row > maxRow) maxRow = row;
      el.style.gridColumn = String(off ? (pos - perRow + 1) : (pos + 1));
      el.style.gridRow = String(row + 1);
      const parts = [];
      if(off) parts.push('translateX(50%)');
      if(row > 0) parts.push('translateY(calc(' + (-row) + ' * (var(--note-height) - 0.866 * min(var(--cell-width), var(--note-height)))))');
      el.style.transform = parts.join(' ');
    });
    g.style.marginBottom = maxRow > 0
      ? 'calc(' + maxRow + ' * (0.866 * min(var(--cell-width), var(--note-height)) - var(--note-height)))'
      : '';
  });
  fitTitles();
}

// --- circle-aware title fitting ----------------------------------------------
// Break each marble title into at most 3 explicitly measured lines. The old
// -webkit-line-clamp approach laid out the last line with its FULL overflowing
// content (a full-width line box), centered that, then painted "…" mid-line —
// so the visible text hugged the left edge and looked shifted. Breaking the
// lines ourselves makes every line a real, truly centered line, and lets each
// row use the chord the sphere actually offers at its height.
// Row width limits as fractions of the face diameter, indexed from the top row:
// the outer rows sit on shorter chords (the old 86% bound — "test a b c d"
// keeps its exact bounds), the middle row crosses the widest part and may run
// out to 94%.
const ROW_FRAC = [0.86, 0.94, 0.86];
const MEASURE_CTX = document.createElement('canvas').getContext('2d');
function fitTitles(){
  document.querySelectorAll('.face .t').forEach(fitTitle);
}
function fitTitle(t){
  const full = t._full != null ? t._full : t.textContent;
  const face = t.parentElement;
  const w = face ? face.clientWidth : 0;
  if(!w || t._fitW === w) return;   // not laid out yet, or already fitted at this size
  t._fitW = w;
  // Measure with canvas (same text metrics engine, zero reflows) instead of
  // poking the DOM per word — this runs during column-resize drags.
  const st = getComputedStyle(t);
  MEASURE_CTX.font = st.fontWeight + ' ' + st.fontSize + ' ' + st.fontFamily;
  const fits = (s, row) => MEASURE_CTX.measureText(s).width <= w * ROW_FRAC[row];
  // Plain-space split, NOT a regex: this script is embedded in a TS template
  // literal, which eats backslashes — /\s+/ would reach the browser as /s+/.
  const words = full.split(' ').filter(Boolean);
  const lines = [];
  let i = 0;
  for(let row = 0; row < 3 && i < words.length; row++){
    let line = words[i++];   // a word longer than the chord stays and clips at the circle
    while(i < words.length && fits(line + ' ' + words[i], row)) line += ' ' + words[i++];
    lines.push(line);
  }
  if(i < words.length && lines.length === 3){
    // Words left over: ellipsise the bottom row at a word boundary so it stays
    // a naturally short, centered line within the same bounds as the top row.
    let last = lines[2];
    while(!fits(last + ' …', 2) && last.includes(' ')) last = last.slice(0, last.lastIndexOf(' '));
    lines[2] = last + ' …';
  }
  t.textContent = '';
  lines.forEach(function(line, k){
    if(k) t.appendChild(document.createElement('br'));
    t.appendChild(document.createTextNode(line));
  });
}

// --- FLIP: animate marble faces from their pre-render positions -------------
function captureRects(){
  flipRects = {};
  document.querySelectorAll('#board .marble').forEach(function(el){
    const f = el.querySelector('.face'); if(!f) return;
    const r = f.getBoundingClientRect();
    // Skip marbles hidden in a collapsed section (zero-size rect): recording
    // (0,0) would make them fly in from the viewport corner when the section
    // unfolds. With no old rect, flipFaces leaves them in place — they just
    // appear, as if they'd been there all along.
    if(r.width || r.height) flipRects[el.dataset.mid] = r;
  });
}
function flipFaces(){
  if(!flipRects) return;
  const rects = flipRects; flipRects = null;
  document.querySelectorAll('#board .marble').forEach(function(el){
    const f = el.querySelector('.face'); if(!f) return;
    const old = rects[el.dataset.mid]; if(!old) return;
    const nu = f.getBoundingClientRect();
    const dx = old.left - nu.left, dy = old.top - nu.top;
    if(!dx && !dy) return;
    f.style.transition = 'none';
    f.style.transform = 'translate(-50%,-50%) translate(' + dx + 'px,' + dy + 'px)';
    requestAnimationFrame(function(){
      f.style.transition = 'transform 200ms ease';
      f.style.transform = 'translate(-50%,-50%)';
    });
  });
}

function sectionEl(sec, items, perRow){
  const wrap = document.createElement('div');
  wrap.className = 'section' + (sec.collapsed ? ' collapsed' : '');
  wrap.dataset.sid = sec.id;
  // Sections size to their content (no fixed height, no resize handle) — only the
  // column scrolls.

  const head = document.createElement('div'); head.className='section-head';
  const toggle = ()=> vscode.postMessage({type:'updateSection', id:sec.id, patch:{collapsed:!sec.collapsed}});

  const caret = document.createElement('span'); caret.className='caret';
  caret.textContent = sec.collapsed ? CH_RIGHT : CH_DOWN;
  caret.onpointerdown = (e)=> e.stopPropagation();
  caret.onclick = (e)=>{ e.stopPropagation(); toggle(); };

  // Title: click folds, drag reorders the section (handled at the head level);
  // the pencil switches it to a rename input.
  const label = document.createElement('span'); label.className='slabel';
  label.textContent = sec.label; label.title='Click to fold · drag to move · pencil to rename';

  const startRename = ()=>{
    const inp = document.createElement('input'); inp.className='slabel';
    inp.value = sec.label; inp.title='Rename section';
    inp.onpointerdown = (e)=> e.stopPropagation();
    inp.onclick = (e)=> e.stopPropagation();
    inp.onblur = ()=> vscode.postMessage({type:'updateSection', id:sec.id, patch:{label:inp.value}});
    inp.onkeydown = (e)=>{ e.stopPropagation();
      if(e.key==='Enter'){ e.preventDefault(); inp.blur(); }
      else if(e.key==='Escape'){ e.preventDefault(); inp.value=sec.label; inp.blur(); } };
    label.replaceWith(inp); inp.focus();
    requestAnimationFrame(()=>{ try{ inp.select(); }catch(_e){} });
  };

  const count = document.createElement('span'); count.className='scount'; count.textContent='('+items.length+')';
  count.onpointerdown = (e)=> e.stopPropagation();
  count.onclick = (e)=>{ e.stopPropagation(); toggle(); };

  const pencil = document.createElement('button'); pencil.className='spencil'; pencil.type='button';
  pencil.textContent='✎'; pencil.title='Rename section';
  pencil.onpointerdown = (e)=> e.stopPropagation();
  pencil.onclick = (e)=>{ e.stopPropagation(); startRename(); };

  const rm = document.createElement('button'); rm.className='srm'; rm.type='button';
  rm.textContent='×'; rm.title='Remove section';
  rm.onpointerdown = (e)=> e.stopPropagation();
  rm.onclick = (e)=>{ e.stopPropagation(); vscode.postMessage({type:'removeSection', id:sec.id}); };
  head.appendChild(caret); head.appendChild(label); head.appendChild(pencil);
  head.appendChild(count); head.appendChild(rm);
  // Drag the head to reorder the whole section; a click (no move) folds it.
  head.onpointerdown = (e)=> startSectionDrag(e, sec, wrap, head);
  wrap.appendChild(head);

  wrap.appendChild(groupEl('todo', sec.id, items, perRow, false));
  return wrap;
}

// Drag a section (head) to reorder it among the other sections, carrying its
// marbles along. A press without movement folds/unfolds it instead. The ungrouped
// area and the Failed group have no draggable head, so they never move.
//
// The dragged section is LIFTED out of flow (position:fixed, following the
// pointer) and a same-height placeholder holds its slot. Because the live layout
// never contains the dragged section, siblings don't get pushed away as it moves
// — so the drop target never "chases" the cursor (the old in-flow reorder made it
// feel stuck after one step), and it's equally smooth folded or expanded.
function startSectionDrag(e, sec, wrap, head){
  if(e.button !== 0) return;
  if(e.target.closest('.caret,.spencil,.srm,.scount,input')) return;
  sdrag = { id:sec.id, wrap, head, startY:e.clientY, moved:false, collapsed:!!sec.collapsed,
            ph:null, grabDY:0, w:0, left:0 };
  head.setPointerCapture(e.pointerId);
  head.onpointermove = onSectionMove;
  head.onpointerup = onSectionUp;
  head.onpointercancel = onSectionUp;
}
// The first real (non-failed) section, excluding the dragged one, whose vertical
// midpoint sits below the cursor — the placeholder goes just before it.
function sectionPlaceTarget(drop, wrap, clientY){
  const others = [].slice.call(drop.querySelectorAll(':scope > .section'))
    .filter(s => s !== wrap && !s.classList.contains('failed'));
  for(const s of others){
    const r = s.getBoundingClientRect();
    if(clientY < r.top + r.height/2) return s;
  }
  return null;
}
function onSectionMove(e){
  if(!sdrag) return;
  const wrap = sdrag.wrap;
  const drop = wrap.parentElement; if(!drop) return;
  if(!sdrag.moved){
    if(Math.abs(e.clientY - sdrag.startY) <= 4) return;
    sdrag.moved = true;
    if(document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const r = wrap.getBoundingClientRect();
    sdrag.grabDY = e.clientY - r.top; sdrag.w = r.width; sdrag.left = r.left;
    const ph = document.createElement('div'); ph.className='sec-placeholder';
    ph.style.height = r.height + 'px';
    drop.insertBefore(ph, wrap); sdrag.ph = ph;
    wrap.classList.add('sdragging');
    wrap.style.position='fixed'; wrap.style.margin='0'; wrap.style.pointerEvents='none';
    wrap.style.width = sdrag.w + 'px'; wrap.style.left = sdrag.left + 'px';
  }
  wrap.style.top = (e.clientY - sdrag.grabDY) + 'px';
  const before = sectionPlaceTarget(drop, wrap, e.clientY);
  if(before){ if(sdrag.ph.nextSibling !== before) drop.insertBefore(sdrag.ph, before); }
  else {
    const failed = drop.querySelector(':scope > .section.failed');
    if(failed){ if(sdrag.ph.nextSibling !== failed) drop.insertBefore(sdrag.ph, failed); }
    else if(drop.lastElementChild !== sdrag.ph){ drop.appendChild(sdrag.ph); }
  }
}
function onSectionUp(e){
  if(!sdrag) return;
  const head = sdrag.head;
  try{ head.releasePointerCapture(e.pointerId); }catch(_e){}
  head.onpointermove = null; head.onpointerup = null; head.onpointercancel = null;
  const sd = sdrag; sdrag = null;
  if(!sd.moved){
    vscode.postMessage({type:'updateSection', id:sd.id, patch:{collapsed:!sd.collapsed}});
    return;
  }
  const wrap = sd.wrap; const drop = wrap.parentElement;
  wrap.classList.remove('sdragging');
  wrap.style.position=''; wrap.style.margin=''; wrap.style.pointerEvents='';
  wrap.style.width=''; wrap.style.left=''; wrap.style.top='';
  if(sd.ph){ drop.insertBefore(wrap, sd.ph); sd.ph.remove(); }
  const ids = [].slice.call(drop.querySelectorAll(':scope > .section'))
    .filter(s => !s.classList.contains('failed')).map(s=>s.dataset.sid);
  const idx = ids.indexOf(sd.id);
  const beforeId = (idx>=0 && idx < ids.length-1) ? ids[idx+1] : null;
  vscode.postMessage({type:'reorderSection', id:sd.id, beforeId});
}

function marbleEl(m){
  const el = document.createElement('div');
  el.className = 'marble';
  el.dataset.mid = m.id;
  el.onpointerdown = (e)=>{ if(e.target.closest('.edit')) return; startMarbleDrag(e, m, el); };
  // Hovering a marble lights up the agents it routes through (no dashed path —
  // that's the chevron's job).
  el.addEventListener('pointerenter', ()=> hoverLightAgents(m.id));
  el.addEventListener('pointerleave', ()=> unhoverLightAgents());

  el.appendChild(makeEditBtn(m));
  el.appendChild(buildFace(m));
  // Bottom centre carries two things that swap on hover: the session-status
  // indicator (a green check on a done-but-unseen marble, etc.) by default, and
  // the path chevron when hovered — so any marble (TODO or Verify) can have its
  // path viewed/edited, and a finished marble advertises itself until you do.
  el.appendChild(makeStatusInd(m));
  el.appendChild(makePathToggle(m));
  return el;
}
// Edit toggle (top-center circle). Shared by grid marbles and field balls.
function makeEditBtn(m){
  const edit = document.createElement('button'); edit.className='edit'; edit.type='button';
  edit.title='Edit marble'; edit.textContent = CH_EDIT;
  edit.onpointerdown = (e)=> e.stopPropagation();
  edit.onclick = (e)=>{ e.stopPropagation(); openModal(m); };
  return edit;
}
// Path-editor chevron (bottom-center circle). Hovering reveals the saved path;
// clicking edits it. Shared by grid marbles and field balls.
function makePathToggle(m){
  const pt = document.createElement('button'); pt.className='pathtoggle'; pt.type='button';
  pt.title='Draw the path this marble takes through the agents';
  pt.textContent = CH_RIGHT;
  if(pathEdit && pathEdit.mid === m.id) pt.classList.add('active');
  pt.onpointerdown = (e)=> e.stopPropagation();
  pt.onclick = (e)=>{ e.stopPropagation(); togglePathEdit(m); };
  pt.onpointerenter = ()=> hoverPath(m.id);
  pt.onpointerleave = ()=> unhoverPath();
  return pt;
}

// The layered sphere "face" shared by grid marbles and field balls.
function buildFace(m){
  const face = document.createElement('div'); face.className='face';
  const color = MARBLE_COLORS.includes(m.color) ? m.color : 'gray';
  const base = document.createElement('div'); base.className='layer base';
  base.style.backgroundImage = "url('" + MARBLES_URI + "/color-" + color + ".webp')";
  face.appendChild(base);

  const t = document.createElement('div'); t.className='t';
  // Full title kept aside: fitTitle() re-breaks it into measured lines whenever
  // the face size (and so the cqw font size) changes.
  t._full = (m.icon ? m.icon+' ' : '') + m.title;
  t.textContent = t._full; face.appendChild(t);

  const shine = document.createElement('div'); shine.className='layer shine'; face.appendChild(shine);
  const tn = Math.min(Math.max(parseInt(m.texture,10)||1,1),35);
  const tex = document.createElement('div'); tex.className='layer tex';
  tex.style.backgroundImage = "url('" + MARBLES_URI + "/sphere-" + tn + ".svg')"; face.appendChild(tex);
  const ring = document.createElement('div'); ring.className='layer ring'; face.appendChild(ring);
  // The session status is shown by a bottom-centre indicator (see makeStatusInd),
  // in the same spot as the path chevron — not a corner dot that clips at the edge.
  return face;
}
// Session-status indicator for a column marble — mirrors the Source+ pane glyphs:
// a spinner while working, a green check when finished (unseen/"done"), a pulsing
// coloured dot for other attention states, and NOTHING when idle. It sits at the
// bottom centre (same place as the path chevron) and fades out on hover to reveal
// the chevron, so a done marble reads as "reviewable" until you go to edit it.
function makeStatusInd(m){
  const st = marbleStatus(m);
  const wrap = document.createElement('div'); wrap.className = 'statusind status-' + st;
  if(st === 'working'){
    const s = document.createElement('span'); s.className='cspin'; wrap.appendChild(s);
  } else if(st === 'done'){
    const s = document.createElement('span'); s.className='ccheck codicon'; s.textContent = CH_CHECK; wrap.appendChild(s);
  } else if(st === 'idle'){
    return wrap;   // empty + hidden: a clean marble with just the hover chevron
  } else {
    const d = document.createElement('span'); d.className='cdot pulse';
    d.style.background = STATUS_DOT_COLOR[st] || 'var(--vscode-descriptionForeground)';
    wrap.appendChild(d);
  }
  return wrap;
}

// --- Plan/Process field: free-placed balls + animated agents ---------------

// A marble resting on the field. The element is a zero-size anchor at the
// contact point (bottom-center); a constant shadow sits at that point while the
// ball BODY scales above it (grows on hover, bounces on a fresh drop) — so the
// shadow never zooms. fieldX/fieldY are the contact point in absolute px.
function fieldMarbleEl(m){
  const el = document.createElement('div');
  el.className = 'fieldmarble';
  el.dataset.mid = m.id;
  el.style.setProperty('--marble-d', FIELD_FULL + 'px');
  const sh = document.createElement('div'); sh.className='ballshadow'; el.appendChild(sh);
  const body = document.createElement('div'); body.className='ballbody';
  body.style.width = FIELD_FULL + 'px'; body.style.height = FIELD_FULL + 'px';
  body.appendChild(buildFace(m));
  el.appendChild(body);
  // Resting balls render already shrunk; a freshly-dropped one bounces first —
  // start it raised + full-size so there's no flash before the animation runs.
  if(m.id !== pendingBounce){ el.classList.add('settled'); }
  else { body.style.transform = 'translate(-50%,-50%) translateY(' + (-BOUNCE_RISE) + 'px) scale(1)'; }
  // Pass-around run visuals: attention bounce + a status badge, and a pause/
  // resume control. A live orbit owns left/top; these are just chrome.
  if(m.runStatus){
    el.classList.add('run', 'run-' + m.runStatus);
    if(m.runStatus === 'attention'){
      const badge = document.createElement('div');
      badge.className = 'runbadge dot ' + (m.runKind || 'question');
      el.appendChild(badge);
    }
    const ctl = document.createElement('button'); ctl.className='runctl'; ctl.type='button';
    const paused = m.runStatus === 'paused';
    ctl.textContent = paused ? '▶' : '⏸';
    ctl.title = paused ? 'Resume run' : 'Pause run';
    ctl.onpointerdown = (e)=> e.stopPropagation();
    ctl.onclick = (e)=>{ e.stopPropagation();
      vscode.postMessage({ type:'runControl', id:m.id, action: paused ? 'resume' : 'pause' }); };
    el.appendChild(ctl);
  }
  // Edit + path buttons, revealed on hover/inspect (when the title shows) so a
  // marble on the field can be edited and its path (re)drawn just like in TODO.
  const eb = makeEditBtn(m); eb.classList.add('fmbtn'); el.appendChild(eb);
  const pb = makePathToggle(m); pb.classList.add('fmbtn'); el.appendChild(pb);
  el.onpointerdown = (e)=> startFieldMarbleDrag(e, m, el);
  // Hovering a running ball freezes it and expands it (no path — that's chevron-only).
  el.onpointerenter = ()=> inspectStart(m.id);
  el.onpointerleave = ()=> inspectEnd(m.id);
  return el;
}
// Hovering a running ball freezes its orbit and expands it to the full marble
// (title + full size), like hovering a resting ball. Leaving resumes the orbit.
function inspectStart(mid){
  const m = (state.marbles||[]).find(function(x){ return x.id===mid; });
  if(!(m && m.runStatus === 'running')) return;
  inspectMid = mid;
  stopRun(mid);
  const el = fmEl(mid); if(!el) return;
  // The orbit sets an inline z-index each frame (1 behind the agent on the far
  // arc, 5 in front on the near arc). Freezing mid-far-arc leaves a stale inline
  // z-index:1 that beats the CSS — so a hovered ball would sit BEHIND the agent
  // and read as passing through it. Clear it so the .inspect rule (z-index:8)
  // wins and the held ball always sits in front.
  el.style.zIndex = '';
  el.classList.add('inspect'); el.classList.remove('running');
  const body = el.querySelector('.ballbody');
  if(body){
    body.style.transition = 'transform .3s cubic-bezier(.2,.85,.3,1)';
    body.style.transform = 'translate(-50%,-50%) scale(1)';
  }
}
function inspectEnd(mid){
  if(inspectMid !== mid) return;
  inspectMid = null;
  const el = fmEl(mid); if(el) el.classList.remove('inspect');
  const m = (state.marbles||[]).find(function(x){ return x.id===mid; });
  const hop = pendingHop[mid]; delete pendingHop[mid];
  if(m && m.runStatus === 'running'){
    // Prefer the latest backend hop that arrived while held; else re-establish
    // the current orbit in place.
    if(typeof hop === 'number'){ runHop(mid, hop); }
    else{ startRunAnim(mid); }
  }
}
// Briefly play a drop-in on a marble card that just arrived in a column.
function flashArrived(id){
  const el = document.querySelector('#board .marble[data-mid="' + id + '"]');
  if(!el) return;
  el.classList.add('arrived');
  setTimeout(function(){ el.classList.remove('arrived'); }, 600);
}

function agentEl(ag){
  const el = document.createElement('div');
  el.className = 'agent';
  el.dataset.aid = ag.id;
  // Anchor bottom-center; only the SPRITE flips (so the name bubble reads L→R).
  el.style.transform = 'translate(-50%,-100%)';
  const sh = document.createElement('div'); sh.className='spriteshadow';
  const swf = (ag.sprite in SPRITE_SHADOW) ? SPRITE_SHADOW[ag.sprite] : SPRITE_SHADOW_DEFAULT;
  sh.style.width = Math.round(swf*100) + '%';      // relative to the sprite width
  if (ag.sprite in SPRITE_SHADOW_DX) sh.style.marginLeft = SPRITE_SHADOW_DX[ag.sprite] + 'px';
  el.appendChild(sh);
  const spr = makeSprite(ag.sprite, {pixelScale: spriteScale(ag.sprite)});
  spr.style.transform = 'scaleX(' + (ag.flip ? -1 : 1) + ')';
  if(ag.hue) spr.style.setProperty('--hue', ag.hue + 'deg');
  el.appendChild(spr);
  if(ag.name){
    const nm = document.createElement('div'); nm.className='agentname';
    const dy = (ag.sprite in SPRITE_LABEL_DY) ? SPRITE_LABEL_DY[ag.sprite] : 0;
    nm.style.transform = 'translate(-50%,' + (-4 + dy) + 'px)';  // -4 base, +per-sprite nudge
    nm.textContent = ag.name; el.appendChild(nm);
  }
  el.onpointerdown = (e)=> startAgentDrag(e, ag, el, spr);
  return el;
}

// Scan a loaded sprite sheet and return the character's content bounding box —
// the union across every frame of its non-transparent pixels. This lets us crop
// away the empty margins so sprites can be trimmed (top removed), centered, and
// bottom-aligned regardless of where the artist placed them in the square frame.
const spriteBoxCache = {};
function spriteBox(img, name){
  if(spriteBoxCache[name]) return spriteBoxCache[name];
  const fh = img.naturalHeight || 1;
  const fw = fh;                                   // square frames
  const frames = Math.max(1, Math.round(img.naturalWidth / fh));
  let box;
  try{
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let minX = fw, maxX = -1, minY = fh, maxY = -1;
    for(let f=0; f<frames; f++){
      const ox = f*fw;
      for(let y=0; y<fh; y++){
        const row = y*c.width;
        for(let x=0; x<fw; x++){
          if(data[(row + ox + x)*4 + 3] > 12){     // alpha threshold
            const rx = x;
            if(rx<minX)minX=rx; if(rx>maxX)maxX=rx;
            if(y<minY)minY=y; if(y>maxY)maxY=y;
          }
        }
      }
    }
    box = (maxX>=0) ? {x:minX,y:minY,w:maxX-minX+1,h:maxY-minY+1,fw,frames}
                    : {x:0,y:0,w:fw,h:fh,fw,frames};
  }catch(_e){ box = {x:0,y:0,w:fw,h:fh,fw,frames}; }
  spriteBoxCache[name] = box;
  return box;
}

// Build an animating sprite element, cropped to the character's content box so
// the empty top is trimmed, the feet sit at the element's bottom, and the body
// is centered. Sized by content height × opts.pixelScale (so a hare < a wizard),
// optionally capped by opts.max.
function makeSprite(name, opts){
  opts = opts || {};
  const el = document.createElement('div');
  el.className = 'sprite';
  const url = MEDIA_URI + '/sprites/' + name + '.png';
  const configure = (img)=>{
    const b = spriteBox(img, name);
    let targetH = opts.pixelScale ? (b.h * opts.pixelScale) : (opts.size || 64);
    if(opts.max) targetH = Math.min(targetH, opts.max);
    const scale = targetH / b.h;
    el.style.width = Math.round(b.w * scale) + 'px';
    el.style.height = Math.round(b.h * scale) + 'px';
    el.style.backgroundImage = "url('" + url + "')";
    el.style.backgroundRepeat = 'no-repeat';
    el.style.backgroundSize = (img.naturalWidth * scale) + 'px ' + (img.naturalHeight * scale) + 'px';
    el.style.backgroundPositionY = (-b.y * scale) + 'px';   // crop the empty top
    const startX = -b.x * scale;                            // crop within the frame
    el.style.backgroundPositionX = startX + 'px';
    const dur = opts.duration || 1000;
    try{
      el.animate(
        [{ backgroundPositionX: startX + 'px' },
         { backgroundPositionX: (startX - b.frames * b.fw * scale) + 'px' }],
        { duration: dur, iterations: Infinity, easing: 'steps(' + b.frames + ')' }
      );
    }catch(_e){ /* WAA missing → static first frame */ }
  };
  // A board re-render rebuilds every agent element; without a cache each one
  // would spin up a fresh Image() and wait for its async onload, blanking the
  // sprite for a frame — the "everything regenerated" flash. Reuse the decoded
  // Image so a re-render configures synchronously with no reload.
  const cached = spriteImgCache[url];
  if(cached && cached.complete && cached.naturalWidth){ configure(cached); return el; }
  // Load with CORS so the content-box scan (canvas) isn't tainted; if that fails,
  // fall back to a plain load (spriteBox will then return the full frame).
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = ()=>{ spriteImgCache[url] = img; configure(img); };
  img.onerror = ()=>{
    const img2 = new Image();
    img2.onload = ()=>{ spriteImgCache[url] = img2; configure(img2); };
    img2.src = url;
  };
  img.src = url;
  return el;
}
// Decoded sprite-sheet images, keyed by url, so re-renders never reload/flash.
const spriteImgCache = {};

// A stored coord is an absolute pixel offset. Legacy values in (0,1] were
// fractional — migrate them by multiplying by the current bound.
function fieldCoord(v, size, dflt){
  if(typeof v !== 'number' || !isFinite(v)) return dflt;
  if(v > 0 && v <= 1) return v * size;   // legacy fraction → px
  return v;
}
// Position every field ball / agent from its ABSOLUTE pixel coords (clamped to
// the bounds), so resizing the pane only changes what's visible — never moves
// anyone. Marble coords are the contact point (bottom-center of the ball);
// agent coords are the feet (bottom-center of the sprite).
function layoutField(){
  const field = document.querySelector('#board .drop.field');
  if(!field) return;
  const W = field.clientWidth, H = field.clientHeight;
  const rad = FIELD_FULL*FIELD_REST/2;             // resting ball radius (~14)
  field.querySelectorAll(':scope > .fieldmarble').forEach(function(el){
    const m = (state.marbles||[]).find(x=>x.id===el.dataset.mid); if(!m) return;
    // A live run animation owns this ball's position — don't fight it.
    if(runView[el.dataset.mid] && runView[el.dataset.mid].active) return;
    // fieldX/fieldY are the ball's CENTER; keep it fully inside (right is free).
    let x = fieldCoord(m.fieldX, W, 50), y = fieldCoord(m.fieldY, H, 50);
    x = Math.max(rad, x);
    y = Math.max(rad, Math.min(H - rad, y));
    el.style.left = Math.round(x) + 'px';
    el.style.top  = Math.round(y) + 'px';
    // While a landing-bounce ghost is playing for this marble, keep the real
    // ball hidden underneath it; playGhostDrop reveals it when the ghost ends.
    if(el.dataset.mid === bounceGhostFor){ el.style.opacity = '0'; }
    if(el.dataset.mid === pendingBounce){ pendingBounce = null; playDropBounce(el); }
  });
  field.querySelectorAll(':scope > .agent').forEach(function(el){
    const ag = (state.agents||[]).find(x=>x.id===el.dataset.aid); if(!ag) return;
    const spr = el.querySelector('.sprite');
    const w = (spr && spr.offsetWidth) || 40, h = (spr && spr.offsetHeight) || 40;
    let x = fieldCoord(ag.x, W, 60), y = fieldCoord(ag.y, H, H*0.7);
    x = Math.max(w/2, x);
    y = Math.max(h, Math.min(H, y));
    el.style.left = Math.round(x) + 'px';
    el.style.top  = Math.round(y) + 'px';
  });
}

function fieldUnderPoint(px, py){
  const els = document.elementsFromPoint(px, py);
  for(const el of els){ const f = el.closest ? el.closest('.drop.field') : null; if(f) return f; }
  return null;
}

// --- Agent-path editor -----------------------------------------------------
// A marble carries an ordered list of agent ids (Marble.pathAgentIds) — the
// route it takes from TODO through the Plan/Process agents to Verify. The editor
// draws that route on a full-viewport SVG overlay: start pinned to the marble
// (or, once the marble is on the field, to the TODO pane edge nearest the first
// agent), a click-ordered series of agent waypoints, and an end that follows the
// cursor while editing or clamps perpendicular to the Verify pane edge once set.

// A full-viewport overlay (client coords) so the path can spring from the
// marble's centre in TODO and reach across into the field. Shown only while
// editing or hovering the chevron — never on a plain ball hover.
function pathOverlay(){
  let o = document.getElementById('pathoverlay');
  const board = document.getElementById('board');
  if(!o){ o = document.createElementNS(SVGNS, 'svg'); o.id = 'pathoverlay'; }
  // Live inside #board so the line paints between the field background and the
  // agents/balls, and scrolls with the board content.
  if(board && o.parentElement !== board) board.appendChild(o);
  return o;
}
// Convert a viewport (client) point into #board content coordinates, so overlay
// paths anchored inside #board stay glued as the board scrolls horizontally.
function toBoard(p){
  const board = document.getElementById('board');
  if(!board || !p) return p;
  const r = board.getBoundingClientRect();
  return { x: p.x - r.left + board.scrollLeft, y: p.y - r.top + board.scrollTop };
}
function clearPath(){ const o = document.getElementById('pathoverlay'); if(o) o.innerHTML=''; clearAgentMarks(); }
function clearAgentMarks(){
  document.querySelectorAll('#board .agent.onpath').forEach(function(a){ a.classList.remove('onpath'); });
}
function markAgents(ids){
  clearAgentMarks();
  for(const id of ids){
    const a = document.querySelector('#board .agent[data-aid="' + id + '"]');
    if(a) a.classList.add('onpath');
  }
}
// --- Lit agents (gold glow WITHOUT drawing the path) ------------------------
// Used when hovering a marble, and persistently while a marble's session is
// open — highlights the agents that marble routes through, no dashed line.
let sessionLitMid = null;   // marble whose session is the ACTIVE tab → stays lit
function clearLitAgents(){
  document.querySelectorAll('#board .agent.litagent').forEach(function(a){ a.classList.remove('litagent'); });
}
function litMarbleAgents(mid){
  clearLitAgents();
  const m = (state.marbles||[]).find(function(x){ return x.id===mid; });
  const ids = (m && m.pathAgentIds) || [];
  for(const id of ids){
    const a = document.querySelector('#board .agent[data-aid="' + id + '"]');
    if(a) a.classList.add('litagent');
  }
}
// The marble whose session is active glows gold too — wherever it lives (TODO,
// field, Verify, Done). Managed separately from agent lighting so hover doesn't
// disturb it.
function clearLitMarble(){
  document.querySelectorAll('#board .litmarble').forEach(function(el){ el.classList.remove('litmarble'); });
}
function lightSessionMarble(mid){
  clearLitMarble();
  if(!mid) return;
  document.querySelectorAll('#board [data-mid="' + mid + '"]').forEach(function(el){
    if(el.classList.contains('marble') || el.classList.contains('fieldmarble')) el.classList.add('litmarble');
  });
}
// Light everything tied to the active-session marble: its agents AND itself.
function lightSession(mid){
  if(pathEdit) return;
  if(mid){ litMarbleAgents(mid); lightSessionMarble(mid); }
  else { clearLitAgents(); clearLitMarble(); }
}
// Hovering a marble lights the marble AND its agents (same look as the active
// session), so the whole flow reads as one unit. Leaving restores whatever the
// active session had lit. Suppressed while editing a path.
function hoverLightAgents(mid){ if(pathEdit) return; litMarbleAgents(mid); lightSessionMarble(mid); }
function unhoverLightAgents(){ if(pathEdit) return; if(sessionLitMid) lightSession(sessionLitMid); else { clearLitAgents(); clearLitMarble(); } }
// A marble's session was opened → optimistically light it until the active-tab
// signal (authoritative) confirms/corrects.
function setSessionLit(mid){ sessionLitMid = mid; lightSession(mid); }
// Client-coord center of an agent.
function agentCenter(id){
  const el = document.querySelector('#board .agent[data-aid="' + id + '"]');
  if(!el) return null;
  const spr = el.querySelector('.sprite');
  const r = (spr || el).getBoundingClientRect();
  return { x: r.left + r.width/2, y: r.top + r.height/2 };
}
// The path anchors at the marble ball's centre (wherever the marble is).
function marbleCenter(mid){
  // The marble may be a TODO/grid card (.marble) or a ball on the field
  // (.fieldmarble); anchor the path at whichever is present.
  const el = document.querySelector('#board .marble[data-mid="' + mid + '"]')
    || document.querySelector('#board .fieldmarble[data-mid="' + mid + '"]');
  if(!el) return null;
  const face = el.querySelector('.face') || el;
  const r = face.getBoundingClientRect();
  return { x: r.left + r.width/2, y: r.top + r.height/2 };
}
function colEdgeX(key, side){
  const c = document.querySelector('#board .col.' + key);
  if(!c) return null;
  const r = c.getBoundingClientRect();
  return side === 'left' ? r.left : r.right;
}
// Build the point list (client coords): ball centre → agents → cursor (editing)
// or the Verify pane edge (committed).
function pathPoints(mid, ids, mouse){
  const agents = ids.map(agentCenter).filter(Boolean);
  const pts = [];
  const anchor = marbleCenter(mid);
  if(anchor) pts.push(anchor);
  for(const p of agents) pts.push(p);
  if(mouse){ pts.push(mouse); }
  else if(agents.length){
    const x = colEdgeX('verify','left');
    if(x != null) pts.push({ x: x, y: agents[agents.length-1].y });
  }
  // All collected in viewport coords; convert to #board content space so the
  // overlay (a child of #board) is anchored correctly and scroll-stable.
  return { pts: pts.map(toBoard), nodes: agents.map(toBoard) };
}
function svgLine(d, w, color, dash){
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', d); p.setAttribute('fill', 'none');
  p.setAttribute('stroke', color); p.setAttribute('stroke-width', String(w));
  p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
  if(dash) p.setAttribute('stroke-dasharray', dash);
  return p;
}
function drawPath(mid, ids, mouse){
  const o = pathOverlay(); if(!o) return; o.innerHTML = '';
  const built = pathPoints(mid, ids, mouse);
  const pts = built.pts;
  if(pts.length < 2){ markAgents(ids); return; }
  const d = pts.map(function(p,i){ return (i?'L':'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1); }).join(' ');
  o.appendChild(svgLine(d, PATH_BORDER_W, 'var(--vscode-editor-background)', PATH_DASH));
  o.appendChild(svgLine(d, PATH_MAIN_W, 'var(--vscode-button-background)', PATH_DASH));
  for(const n of built.nodes){
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', n.x.toFixed(1)); c.setAttribute('cy', n.y.toFixed(1));
    c.setAttribute('r', '5');
    c.setAttribute('fill', 'var(--vscode-button-background)');
    c.setAttribute('stroke', 'var(--vscode-editor-background)'); c.setAttribute('stroke-width', '2');
    o.appendChild(c);
  }
  markAgents(ids);
}

function togglePathEdit(m){
  // Clicking the chevron a second time (while editing this marble) clears the
  // path entirely — sets it to none.
  if(pathEdit && pathEdit.mid === m.id){
    vscode.postMessage({ type:'update', id: m.id, patch: { pathAgentIds: [] } });
    const mm = (state.marbles||[]).find(function(x){ return x.id === m.id; });
    if(mm) mm.pathAgentIds = [];
    endPathEdit();
    return;
  }
  if(pathEdit) cancelPathEdit();
  // A fresh click always restarts the path from the beginning (empty), never
  // resumes the previously-saved one.
  pathEdit = { mid: m.id, ids: [], mouse: null };
  document.body.classList.add('pathedit');
  markToggle(m.id, true);
  document.addEventListener('mousemove', onPathMouse, true);
  document.addEventListener('keydown', onPathKey, true);
  document.addEventListener('click', onPathClick, true);
  redrawPathEdit();
}
function redrawPathEdit(){ if(pathEdit) drawPath(pathEdit.mid, pathEdit.ids, pathEdit.mouse); }
function onPathMouse(e){ if(!pathEdit) return; pathEdit.mouse = { x: e.clientX, y: e.clientY }; redrawPathEdit(); }
function onPathKey(e){
  if(!pathEdit) return;
  if(e.key === 'Enter'){ e.preventDefault(); finalizePath(); }
  else if(e.key === 'Escape'){ e.preventDefault(); cancelPathEdit(); }
}
function onPathClick(e){
  if(!pathEdit) return;
  const ag = e.target.closest && e.target.closest('#board .agent');
  if(ag){ e.preventDefault(); e.stopPropagation(); toggleAgentOnPath(ag.dataset.aid); return; }
  // Clicking (into) the Verify column commits the path.
  const verify = e.target.closest && e.target.closest('#board .col.verify');
  if(verify){ e.preventDefault(); e.stopPropagation(); finalizePath(); return; }
  // Clicking the toggle itself is handled by its own onclick (cancels).
}
function toggleAgentOnPath(id){
  if(!pathEdit) return;
  const i = pathEdit.ids.indexOf(id);
  if(i >= 0) pathEdit.ids.splice(i, 1);   // toggle off
  else pathEdit.ids.push(id);             // append in click order
  redrawPathEdit();
}
function finalizePath(){
  if(!pathEdit) return;
  const mid = pathEdit.mid, ids = pathEdit.ids.slice();
  vscode.postMessage({ type:'update', id: mid, patch: { pathAgentIds: ids } });
  const m = (state.marbles||[]).find(function(x){ return x.id === mid; });
  if(m) m.pathAgentIds = ids;            // reflect locally so hover shows it at once
  endPathEdit();
}
function cancelPathEdit(){ endPathEdit(); }   // discard: nothing was saved
function endPathEdit(){
  const mid = pathEdit && pathEdit.mid;
  document.body.classList.remove('pathedit');
  document.removeEventListener('mousemove', onPathMouse, true);
  document.removeEventListener('keydown', onPathKey, true);
  document.removeEventListener('click', onPathClick, true);
  pathEdit = null;
  if(mid) markToggle(mid, false);
  clearPath();
}
function markToggle(mid, on){
  document.querySelectorAll('#board [data-mid="' + mid + '"] .pathtoggle')
    .forEach(function(btn){ btn.classList.toggle('active', on); });
}

// Hover a marble → show its committed path (suppressed while editing one).
function hoverPath(mid){
  if(pathEdit) return;
  const m = (state.marbles||[]).find(function(x){ return x.id === mid; });
  if(!m || !m.pathAgentIds || !m.pathAgentIds.length){ return; }
  hoverPathMid = mid;
  drawPath(mid, m.pathAgentIds, null);
}
function unhoverPath(){ if(!pathEdit){ hoverPathMid = null; clearPath(); } }
// The overlay uses viewport coords, so it must be redrawn as the board scrolls
// horizontally (otherwise the path lags until the next mouse move).
function redrawActivePath(){
  if(pathEdit){ redrawPathEdit(); return; }
  if(hoverPathMid){
    const m = (state.marbles||[]).find(function(x){ return x.id === hoverPathMid; });
    if(m && m.pathAgentIds && m.pathAgentIds.length) drawPath(hoverPathMid, m.pathAgentIds, null);
    else { hoverPathMid = null; clearPath(); }
  }
}

// --- Pass-around run animation ---------------------------------------------
// A marble on a path rolls from agent to agent, orbiting each one (isometric
// ellipse) while its hop runs, then rolls off the right edge when finished. The
// backend drives the sequence via messages (runHop / runFinish / runStop); the
// animation loops re-query the element each frame so a board re-render never
// breaks them, and re-establish themselves from marble.runStatus after a reload.
const runView = {};                       // mid -> { raf, ang, rot, idx, active }
// Marbles that have rolled off the field and are awaiting the backend's Verify
// deposit. Their state is still runStatus:'running' in that brief window, so
// syncRuns must NOT restart their orbit if a re-render lands mid-gap.
const rolledOff = {};
// A hop that arrived while its marble was being held (inspected). Rolling the ball
// away to the next agent from under the user's cursor mid-inspect left it in an
// inconsistent frozen+rolling state (it could roll out of the field's clipped
// bounds and vanish). We stash the target index and roll to it on inspectEnd.
const pendingHop = {};
const ORBIT_RX = 34, ORBIT_RY = 14;       // isometric orbit radii (px)
// A pathless "solo" marble processes in place: a smaller isometric orbit around
// its OWN drop point (no agent to circle), so it reads distinctly from a
// pass-around and stays put where it was dropped until it finishes.
const SOLO_RX = 20, SOLO_RY = 9;
const ORBIT_SPEED = 2.3;                  // rad/sec
const BALL_R = FIELD_FULL * FIELD_REST / 2;
// Rolls (drop→agent, agent→agent, roll-off) move at the orbit's own linear speed
// so every ball movement reads as one continuous, slow, smooth roll — never a
// teleport. px/sec ≈ the orbit's peak tangential speed (rx · ω).
const ROLL_PXPS = ORBIT_RX * ORBIT_SPEED;
function rollDur(from, to){
  const d = Math.hypot(to.x-from.x, to.y-from.y);
  return Math.max(320, Math.min(3200, d / ROLL_PXPS * 1000));
}

function fmEl(mid){ return document.querySelector('#board .drop.field > .fieldmarble[data-mid="' + mid + '"]'); }
function marblePos(mid){ const el = fmEl(mid); if(!el) return null;
  return { x: parseFloat(el.style.left)||0, y: parseFloat(el.style.top)||0 }; }
function agentFieldPos(id){
  const el = document.querySelector('#board .drop.field > .agent[data-aid="' + id + '"]');
  if(!el) return null;
  // The agent el is anchored bottom-center (translate(-50%,-100%)), so its
  // left/top IS the feet. Orbit one ball-radius above the feet so the ball
  // circles the character's feet — on the near arc it rolls at floor level.
  return { x: parseFloat(el.style.left)||0, y: (parseFloat(el.style.top)||0) - BALL_R };
}
function setBall(body, rotDeg){
  if(!body) return;
  body.style.transition = 'none';
  body.style.transform = 'translate(-50%,-50%) scale(' + FIELD_REST.toFixed(3) + ') rotate(' + rotDeg.toFixed(1) + 'deg)';
}
function stopRun(mid){ const v = runView[mid]; if(v){ v.active = false; if(v.raf) cancelAnimationFrame(v.raf); v.raf = 0; } }

// Roll the ball from the start point to the end point over dur ms (easeInOut),
// spinning by rolled distance, then call onDone. Re-queries the el every frame.
function rollBall(mid, from, to, dur, onDone){
  const v = runView[mid] = runView[mid] || {};
  v.active = true;
  const dx = to.x-from.x, dy = to.y-from.y, dist = Math.hypot(dx,dy);
  const dir = dx>=0 ? 1 : -1;
  const rot0 = v.rot || 0;
  const start = performance.now();
  function frame(t){
    const el = fmEl(mid); if(!el){ if(onDone) onDone(); return; }
    el.classList.remove('settled'); el.classList.add('running');
    const k = Math.min(1, (t-start)/dur);
    const e = k<0.5 ? 2*k*k : 1-Math.pow(-2*k+2,2)/2;
    el.style.left = (from.x+dx*e).toFixed(1)+'px';
    el.style.top  = (from.y+dy*e).toFixed(1)+'px';
    const rr = rot0 + dir*(dist*e)/BALL_R*(180/Math.PI);
    setBall(el.querySelector('.ballbody'), rr);
    if(k<1){ v.raf = requestAnimationFrame(frame); }
    else { v.rot = rr; v.raf = 0; if(onDone) onDone(); }
  }
  v.raf = requestAnimationFrame(frame);
}
// Continuously orbit the center point (isometric); z drops behind on the far arc.
// rx/ry default to the agent-orbit radii; a solo run passes the smaller SOLO ones.
function orbitBall(mid, center, rx, ry){
  rx = rx || ORBIT_RX; ry = ry || ORBIT_RY;
  const v = runView[mid] = runView[mid] || {};
  v.active = true; if(v.ang == null) v.ang = -Math.PI/2;
  let last = performance.now();
  function frame(t){
    const el = fmEl(mid); if(!el){ v.raf=0; return; }
    el.classList.remove('settled'); el.classList.add('running');
    const dt = Math.min(0.05, (t-last)/1000); last = t;
    v.ang += ORBIT_SPEED*dt;
    const x = center.x + Math.cos(v.ang)*rx;
    const y = center.y + Math.sin(v.ang)*ry;
    el.style.left = x.toFixed(1)+'px'; el.style.top = y.toFixed(1)+'px';
    const vx = -Math.sin(v.ang)*rx*ORBIT_SPEED;
    v.rot = (v.rot||0) + (vx*dt)/BALL_R*(180/Math.PI);
    setBall(el.querySelector('.ballbody'), v.rot);
    el.style.zIndex = Math.sin(v.ang) < 0 ? '1' : '5';
    if(v.active) v.raf = requestAnimationFrame(frame);
  }
  v.raf = requestAnimationFrame(frame);
}
// A pathless marble runs "solo": it rolls a short hop off its drop point into a
// small orbit around that point and circles there while its own session works.
// The centre is the drop point — captured once (v.center) and reused on resume so
// hover-inspect/re-render never drifts it. Never posts fieldAt: fieldX/fieldY must
// stay the drop point so a reload recomputes the same centre.
function isSoloRun(m){ return !!(m && m.runStatus === 'running' && (!m.pathAgentIds || !m.pathAgentIds.length)); }
function beginSolo(mid){
  const v = runView[mid] = runView[mid] || {};
  stopRun(mid);
  if(v.agentId){ setAgentProcessing(v.agentId, false); v.agentId = null; }
  v.idx = 0;
  const center = v.center || marblePos(mid);
  if(!center){ return; }
  v.center = center;
  const from = marblePos(mid) || center;
  const entry = { x: center.x, y: center.y - SOLO_RY };
  rollBall(mid, from, entry, rollDur(from, entry), function(){
    if(!runView[mid]) return;
    v.ang = -Math.PI/2;
    orbitBall(mid, center, SOLO_RX, SOLO_RY);
  });
}
// Start/resume whatever run this marble is — a solo orbit or a pass-around hop.
function startRunAnim(mid){
  const m = (state.marbles||[]).find(function(x){ return x.id===mid; });
  if(!m) return;
  if(isSoloRun(m)) beginSolo(mid);
  else startOrResumeHop(mid, (typeof m.runIndex === 'number') ? m.runIndex : 0);
}

// Roll to agent[index] (from the previous agent) and orbit — a backend-driven
// hop advance.
function runHop(mid, index){
  // Held for inspection → don't roll it away now; remember where to go and let
  // inspectEnd resume to the latest hop when the user releases it.
  if(mid === inspectMid){ pendingHop[mid] = index; return; }
  const v = runView[mid] = runView[mid] || {};
  const m = (state.marbles||[]).find(function(x){ return x.id===mid; });
  const ids = (m && m.pathAgentIds) || [];
  const center = agentFieldPos(ids[index]);
  if(!center){ return; }
  stopRun(mid);
  // Depart from the ball's ACTUAL current position (mid-orbit), not the previous
  // agent's centre — otherwise the ball jumps to the centre before rolling. This
  // makes the orbit→roll transition continuous.
  const from = marblePos(mid) || (v.idx != null ? agentFieldPos(ids[v.idx]) : null) || center;
  beginRoll(mid, index, from, center);
}
// Roll from the ball's CURRENT position to agent[index] — used for the initial
// drop→first-agent roll and to re-establish a run after a reload/re-render.
function startOrResumeHop(mid, index){
  const m = (state.marbles||[]).find(function(x){ return x.id===mid; });
  const ids = (m && m.pathAgentIds) || [];
  const center = agentFieldPos(ids[index]);
  if(!center){ return; }
  beginRoll(mid, index, marblePos(mid) || center, center);
}
function beginRoll(mid, index, from, center){
  const v = runView[mid] = runView[mid] || {};
  stopRun(mid);
  // Leaving the previous agent — let its processing glow fade out.
  if(v.agentId){ setAgentProcessing(v.agentId, false); v.agentId = null; }
  v.idx = index;
  // Roll to the TOP of the orbit ellipse (not the agent's centre), so the ball
  // never rolls through the character and joins the circular path seamlessly.
  const entry = { x: center.x, y: center.y - ORBIT_RY };
  rollBall(mid, from, entry, rollDur(from, entry), function(){
    if(!runView[mid]) return;
    v.ang = -Math.PI/2;                 // top of the ellipse — matches the entry point
    orbitBall(mid, center);
    // The ball is now circling this agent and its hop is live — light it up.
    const m = (state.marbles||[]).find(function(x){ return x.id===mid; });
    const aid = m && m.pathAgentIds && m.pathAgentIds[index];
    if(aid){ v.agentId = aid; setAgentProcessing(aid, true); }
    // Persist the resting centre at this agent so a reload/re-render lands here.
    vscode.postMessage({ type:'fieldAt', id:mid, x: Math.round(center.x), y: Math.round(center.y) });
  });
}
function agentElById(id){ return document.querySelector('#board .drop.field > .agent[data-aid="' + id + '"]'); }
// Toggle the STEADY gold "actively processing" glow on an agent. Turning it ON is
// applied with the sprite's filter transition suppressed, so a mid-run re-render
// (which rebuilds the sprite element from scratch and re-asserts .processing via
// syncRuns) lands already-glowing instead of replaying the .5s fade-in — that
// repeated fade-in is what read as a flicker. Turning it OFF just removes the
// class, letting the base .sprite transition (filter .5s) ease the glow away.
function setAgentProcessing(id, on){
  const el = agentElById(id); if(!el) return;
  const spr = el.querySelector('.sprite'); if(!spr) return;
  if(on){
    if(el.classList.contains('processing')) return;   // already lit — leave it steady
    const prev = spr.style.transition;
    spr.style.transition = 'none';
    el.classList.add('processing');
    void spr.offsetWidth;                              // commit the no-transition filter
    spr.style.transition = prev || '';
  } else {
    el.classList.remove('processing');
  }
}
function runFinish(mid){
  stopRun(mid);
  clearRunGlow(mid);
  const field = document.querySelector('#board .drop.field');
  const w = field ? field.clientWidth : 400;
  const cur = marblePos(mid) || { x: w-40, y: 60 };
  const off = { x: w+80, y: cur.y };
  rollBall(mid, cur, off, rollDur(cur, off), function(){
    rolledOff[mid] = true;   // gone; don't let a mid-gap re-render restart it
    endRun(mid);
    // Only now has the ball fully rolled off — tell the backend to deposit it in
    // Verify (a fixed backend timer would insta-pop it mid-roll instead).
    vscode.postMessage({ type:'runRolledOff', id:mid });
  });
}
function runStop(mid){ stopRun(mid); clearRunGlow(mid); }   // freeze in place (pause / attention)
function endRun(mid){ stopRun(mid); clearRunGlow(mid); delete runView[mid]; delete pendingHop[mid]; }
// Fade out the processing glow on whatever agent this marble was circling.
function clearRunGlow(mid){ const v = runView[mid]; if(v && v.agentId){ setAgentProcessing(v.agentId, false); v.agentId = null; } }

// After every render, re-assert steady-state orbits for running marbles whose
// animation loop isn't live (fresh webview, reload, or a re-render that raced a
// hop). Rolls are only played on explicit runHop messages.
function syncRuns(){
  for(const m of (state.marbles||[])){
    if(m.runStatus === 'running'){
      // Don't start the roll while the landing bounce is still playing, while the
      // ball is being hover-inspected (expanded and held), or while it's already
      // rolled off and awaiting the backend's Verify deposit.
      if(m.id === bounceGhostFor || m.id === inspectMid || rolledOff[m.id]) continue;
      const v = runView[m.id];
      if(!v || !v.active){
        startRunAnim(m.id);
      } else if(v.agentId){
        // A re-render (e.g. a hop advance) rebuilt the agents and dropped the
        // pulsing gold "processing" glow off the one this ball is orbiting —
        // re-assert it in the same frame so it never visibly flashes off.
        setAgentProcessing(v.agentId, true);
      }
    } else if(runView[m.id] && m.runStatus !== undefined){
      // paused / attention → hold still where it is.
      stopRun(m.id);
    }
  }
  // Drop views for marbles no longer running.
  for(const id in runView){
    const m = (state.marbles||[]).find(function(x){ return x.id===id; });
    if(!m || !m.runStatus){ endRun(id); }
  }
  // Clear the rolled-off guard once the marble has actually left the run (the
  // backend deposited it in Verify) — so a future run can orbit again.
  for(const id in rolledOff){
    const m = (state.marbles||[]).find(function(x){ return x.id===id; });
    if(!m || m.runStatus !== 'running'){ delete rolledOff[id]; }
  }
}

// Continuously morph the drag ghost (already under the cursor) into a landing
// bounce at the drop point — it shrinks from its drag size to the resting third
// with a squash-and-hop settle. The real field ball stays hidden until this
// finishes, so there's never a gap or a reposition jump.
function playGhostDrop(ghost, cx, cy, id){
  bounceGhostFor = id;
  const w = ghost.getBoundingClientRect().width || (FIELD_FULL*0.7);
  ghost.style.left = (cx - w/2) + 'px';
  ghost.style.top  = (cy - w/2) + 'px';
  ghost.style.transformOrigin = 'center center';
  // The lifted drag glow around the marble should melt away as soon as it's
  // dropped — not hang for the whole bounce and then vanish. Transition just the
  // box-shadow (transform is driven by the Web Animation below) down to the
  // resting ground shadow immediately on release.
  ghost.style.transition = 'box-shadow .2s ease';
  ghost.style.boxShadow = '0 2px 6px rgba(0,0,0,.25)';
  const R = (FIELD_FULL*FIELD_REST) / w;      // rest scale relative to ghost size
  const D = BOUNCE_RISE;                       // falls from the drop point down to rest
  const tf = (y, sx, sy)=> 'translateY(' + y.toFixed(2) + 'px) scale(' + sx.toFixed(3) + ',' + sy.toFixed(3) + ')';
  const UP = 'cubic-bezier(.1,.7,.5,1)', DOWN = 'cubic-bezier(.33,0,.9,.35)';
  const reveal = ()=>{
    bounceGhostFor = null;
    const real = document.querySelector('#board .drop.field > .fieldmarble[data-mid="' + id + '"]');
    if(real) real.style.opacity = '';
    if(ghost) ghost.remove();
    // The marble has now landed at the drop point — begin its run (a roll to
    // agent 1 for a pass-around, or a small in-place orbit for a solo run).
    const m = (state.marbles||[]).find(function(x){ return x.id===id; });
    if(m && m.runStatus === 'running' && m.id !== inspectMid){
      startRunAnim(id);
    }
  };
  // Appears exactly at the drop point (y=0) at full drag size, then falls under
  // gravity to its rest depth (y=D), shrinking to a third and bouncing a few
  // decaying times — boom, boom, boom.
  try{
    const anim = ghost.animate([
      { offset: 0.00, transform: tf(0,        1.00,   1.00 ),  easing: DOWN },  // release, full size
      { offset: 0.32, transform: tf(D,        R*1.22, R*0.80),  easing: UP   },  // 1st impact — big squash
      { offset: 0.55, transform: tf(D-D*0.40, R*0.94, R*1.06),  easing: DOWN },  // bounce up, stretched
      { offset: 0.72, transform: tf(D,        R*1.14, R*0.88),  easing: UP   },  // 2nd impact
      { offset: 0.84, transform: tf(D-D*0.15, R*0.98, R*1.02),  easing: DOWN },  // small hop
      { offset: 0.93, transform: tf(D,        R*1.06, R*0.95),  easing: UP   },  // 3rd tiny impact
      { offset: 1.00, transform: tf(D,        R,      R      ) }                  // settle
    ], { duration: 820, fill: 'forwards' });
    anim.onfinish = reveal;
  }catch(_e){ reveal(); }
}

// A marble dropping onto the grass: it starts full-size just above the contact
// point (where the mouse released — NOT the top of the pane), falls under
// gravity shrinking to a third, and bounces a few decaying times — boom, boom,
// boom. The ball BODY is animated (bottom-origin), so the ground shadow is left
// untouched. Runs only on a fresh drop; then CSS owns the resting/hover sizes.
function playDropBounce(el){
  const body = el.querySelector('.ballbody');
  const t = el.querySelector('.t');
  if(!body) return;
  if(t){ t.style.opacity='0'; }
  const R = 1/3;                              // resting scale (a third of full)
  const H = BOUNCE_RISE;                      // initial fall height above the point
  // translate(-50%,-50%) keeps the body centered on the drop point; translateY is
  // the bounce; scale(sx,sy) does the shrink + squash/stretch (about the center).
  const tf = (y, sx, sy)=> 'translate(-50%,-50%) translateY(' + y.toFixed(2) + 'px) scale(' + sx.toFixed(3) + ',' + sy.toFixed(3) + ')';
  const DOWN = 'cubic-bezier(.33,0,.9,.35)';  // accelerate (gravity) on the way down
  const UP   = 'cubic-bezier(.1,.7,.5,1)';    // decelerate on the way up
  try{
    const anim = body.animate([
      { offset: 0.00, transform: tf(-H,        1.00,   1.00 ),  easing: DOWN },  // release, full size
      { offset: 0.32, transform: tf(0,         R*1.22, R*0.80),  easing: UP   },  // 1st impact — big squash
      { offset: 0.55, transform: tf(-H*0.40,   R*0.94, R*1.06),  easing: DOWN },  // bounce up, stretched
      { offset: 0.72, transform: tf(0,         R*1.14, R*0.88),  easing: UP   },  // 2nd impact
      { offset: 0.84, transform: tf(-H*0.15,   R*0.98, R*1.02),  easing: DOWN },  // small hop
      { offset: 0.93, transform: tf(0,         R*1.06, R*0.95),  easing: UP   },  // 3rd tiny impact
      { offset: 0.97, transform: tf(-H*0.05,   R,      R      ),  easing: DOWN },
      { offset: 1.00, transform: tf(0,         R,      R      ) }                  // settle
    ], { duration: 820, fill: 'both' });
    anim.onfinish = ()=>{
      // Hand off to CSS: settled state matches the animation's final transform.
      el.classList.add('settled');
      body.style.transform = '';
      try{ anim.cancel(); }catch(_e){}
    };
  }catch(_e){ el.classList.add('settled'); body.style.transform=''; }
}

// Drag a resting field ball: within the field it repositions freely; dragged
// over another column it moves back into that column (via a floating ghost, so
// it isn't clipped by the field's overflow). A click (no drag) opens it.
function startFieldMarbleDrag(e, m, el){
  if(pathEdit) return;
  if(e.button !== 0) return;
  if(e.target.closest('.runctl')) return;   // let the pause/resume button handle it
  // A running / paused / attention marble isn't repositioned — clicking it
  // focuses its Claude session so the user can watch or type "continue".
  if(m.runStatus){ vscode.postMessage({ type:'open', id:m.id }); return; }
  if(e.target.closest('.edit')) return;
  e.stopPropagation();
  const field = el.closest('.drop.field'); if(!field) return;
  const startX = e.clientX, startY = e.clientY;
  let moved = false, ghost = null;
  fieldDrag = { ghost: null };
  el.setPointerCapture(e.pointerId);
  el.onpointermove = (ev)=>{
    if(!moved){
      if(Math.hypot(ev.clientX-startX, ev.clientY-startY) <= 3) return;
      moved = true; el.classList.add('grabbing');
      // Floating ghost follows the cursor everywhere (field has overflow:hidden).
      // Full size — dragging reads as the hover (inspected) state, not a shrunken
      // in-between.
      const g = el.querySelector('.face').cloneNode(true);
      const d = FIELD_FULL;
      g.style.position='fixed'; g.style.margin='0'; g.style.transform='none';
      g.style.width=d+'px'; g.style.height=d+'px'; g.style.pointerEvents='none';
      g.style.zIndex='9999'; g.style.boxShadow='0 8px 24px rgba(0,0,0,.4)';
      g.style.setProperty('--marble-d', d+'px');
      const tt=g.querySelector('.t'); if(tt) tt.style.opacity='0';
      document.body.appendChild(g); ghost=g;
      if(fieldDrag) fieldDrag.ghost = g;
      el.style.opacity='0';
    }
    const d = FIELD_FULL;
    ghost.style.left=(ev.clientX - d/2)+'px'; ghost.style.top=(ev.clientY - d/2)+'px';
  };
  const up = (ev)=>{
    try{ el.releasePointerCapture(ev.pointerId); }catch(_e){}
    el.onpointermove = null; el.onpointerup = null; el.onpointercancel = null;
    fieldDrag = null;
    if(!moved){ vscode.postMessage({type:'open', id:m.id}); setSessionLit(m.id); return; }
    el.classList.remove('grabbing');
    // Dropped back on the field → reposition with the same landing bounce as a
    // fresh drop: the ghost morphs into the bounce in place, and the real ball
    // stays hidden until the animation reveals it (so hover can't kick in early).
    const fld = fieldUnderPoint(ev.clientX, ev.clientY);
    if(fld){
      const fr = fld.getBoundingClientRect();
      // The ball falls BOUNCE_RISE px from the release point to rest.
      const x = Math.max(0, ev.clientX-fr.left);
      const y = Math.max(0, ev.clientY-fr.top) + BOUNCE_RISE;
      if(ghost){ playGhostDrop(ghost, ev.clientX, ev.clientY, m.id); }
      else { el.style.opacity=''; }
      vscode.postMessage({type:'fieldPlace', id:m.id, x, y});
      return;
    }
    if(ghost) ghost.remove();
    // Dropped over another column's grid → move it into that stage/section.
    let grid = null;
    for(const n of document.elementsFromPoint(ev.clientX, ev.clientY)){
      const gg = n.closest ? n.closest('.mgrid') : null; if(gg){ grid=gg; break; }
    }
    if(grid){
      // Hide the ball now (don't restore opacity) so it doesn't flash back on
      // the field before the re-render moves it into the target column.
      el.remove();
      const stage = grid.dataset.stage;
      const section = grid.dataset.section || '';
      vscode.postMessage({type:'reorder', id:m.id, stage,
        sectionId: stage==='todo' ? (section || null) : null, beforeId:null});
      return;
    }
    // Dropped nowhere useful → restore it in place.
    el.style.opacity='';
  };
  el.onpointerup = up; el.onpointercancel = up;
}

// Drag an agent to reposition it, preserving the grab point and clamped to the
// field bounds (left/top/bottom; right is free). Only the sprite flips to face
// the direction of travel. A click without a drag opens the agent's modal.
function startAgentDrag(e, ag, el, spr){
  if(pathEdit) return;
  if(e.button !== 0) return;
  e.stopPropagation();
  const field = el.closest('.drop.field'); if(!field) return;
  const startX = e.clientX, startY = e.clientY;
  const r0 = el.getBoundingClientRect();
  const anchorX = r0.left + r0.width/2, anchorY = r0.bottom;
  const grabDX = startX - anchorX, grabDY = startY - anchorY;
  const w = (spr && spr.offsetWidth) || r0.width || 40;
  const h = (spr && spr.offsetHeight) || r0.height || 40;
  let moved = false, flip = !!ag.flip, lastX = startX;
  el.setPointerCapture(e.pointerId);
  el.onpointermove = (ev)=>{
    if(!moved){ if(Math.hypot(ev.clientX-startX, ev.clientY-startY) <= 3) return; moved = true; el.classList.add('grabbing'); }
    const dx = ev.clientX - lastX;
    if(dx < -1 && !flip){ flip = true; if(spr) spr.style.transform='scaleX(-1)'; }
    else if(dx > 1 && flip){ flip = false; if(spr) spr.style.transform='scaleX(1)'; }
    lastX = ev.clientX;
    const fr = field.getBoundingClientRect();
    let x = (ev.clientX - grabDX) - fr.left, y = (ev.clientY - grabDY) - fr.top;
    x = Math.max(w/2, x);                       // left edge (right is free)
    y = Math.max(h, Math.min(fr.height, y));    // top / bottom edges
    el.style.left = Math.round(x) + 'px';
    el.style.top  = Math.round(y) + 'px';
  };
  const up = (ev)=>{
    try{ el.releasePointerCapture(ev.pointerId); }catch(_e){}
    el.onpointermove = null; el.onpointerup = null; el.onpointercancel = null;
    if(!moved){ openAgentModal(ag); return; }
    el.classList.remove('grabbing');
    vscode.postMessage({type:'moveAgent', id:ag.id, flip,
      x: Math.max(0, parseFloat(el.style.left)),
      y: Math.max(0, parseFloat(el.style.top))});
  };
  el.onpointerup = up; el.onpointercancel = up;
}

// Clicking an agent opens a modal (name + prompt), with Remove on the far left.
function openAgentModal(ag){
  const card = document.getElementById('modalCard');
  card.innerHTML = \`
    <div class="modalHead">
      <h2>Character</h2>
      <button class="mClose" id="ag-x" type="button" title="Close">×</button>
    </div>
    <div><label>Name</label><input id="ag-name" placeholder="e.g. Scout"/></div>
    <div><label>Prompt</label><textarea id="ag-prompt" placeholder="What is this character for?"></textarea></div>
    <div class="modalBtns agentbtns">
      <button class="btnRemove" id="ag-remove" type="button">Remove</button>
      <div class="spacer"></div>
      <button class="btnGhost" id="ag-cancel" type="button">Cancel</button>
      <button class="btnPrimary" id="ag-save" type="button">Save</button>
    </div>\`;
  document.getElementById('modal').classList.remove('hidden');
  const nameI = document.getElementById('ag-name');
  const promptI = document.getElementById('ag-prompt');
  nameI.value = ag.name || ''; promptI.value = ag.prompt || '';
  document.getElementById('ag-x').onclick = closeModal;
  document.getElementById('ag-cancel').onclick = closeModal;
  document.getElementById('ag-remove').onclick = ()=>{
    vscode.postMessage({type:'removeAgent', id:ag.id}); closeModal();
  };
  document.getElementById('ag-save').onclick = ()=>{
    vscode.postMessage({type:'updateAgent', id:ag.id,
      patch:{name: nameI.value.trim(), prompt: promptI.value}});
    closeModal();
  };
  setTimeout(()=>{ try{ nameI.focus(); }catch(_e){} }, 0);
}

// --- + Agent: sprite selector + cursor-follow placement --------------------
let spritePlacing = null; // {name, ghost, onMove, onDown, onKey}

function openSpriteSelector(){
  const card = document.getElementById('modalCard');
  card.innerHTML = \`
    <div class="modalHead">
      <h2>Choose a character</h2>
      <button class="mClose" id="sp-x" type="button" title="Close">×</button>
    </div>
    <div class="spritegrid" id="sp-grid"></div>
    <div class="huerow">
      <label for="sp-hue">Hue</label>
      <input id="sp-hue" type="range" min="0" max="360" step="1" value="0"/>
    </div>\`;
  const grid = document.getElementById('sp-grid');
  const hueI = document.getElementById('sp-hue');
  const hue = ()=> Number(hueI.value) || 0;
  hueI.oninput = ()=> grid.style.setProperty('--hue', hue() + 'deg');
  for(const name of (state.sprites||[])){
    const cell = document.createElement('button'); cell.className='spritecell'; cell.type='button';
    cell.title = name.replace(/-idle$/,'').replace(/-/g,' ');
    cell.appendChild(makeSprite(name, {pixelScale: spriteScale(name), max:88}));
    cell.onclick = ()=>{ const h = hue(); closeModal(); beginSpritePlacement(name, h); };
    grid.appendChild(cell);
  }
  document.getElementById('sp-x').onclick = closeModal;
  document.getElementById('modal').classList.remove('hidden');
}

function beginSpritePlacement(name, hue){
  cancelSpritePlacement();
  const ghost = makeSprite(name, {pixelScale: spriteScale(name)});
  ghost.className += ' spriteghost';
  if(hue) ghost.style.setProperty('--hue', hue + 'deg');
  document.body.appendChild(ghost);
  const onMove = (e)=>{ ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px'; };
  const onDown = (e)=>{
    const field = fieldUnderPoint(e.clientX, e.clientY);
    if(field){
      e.preventDefault(); e.stopPropagation();
      const r = field.getBoundingClientRect();
      vscode.postMessage({type:'addAgent', sprite:name, hue: hue||0,
        x: Math.max(0, e.clientX-r.left), y: Math.max(0, e.clientY-r.top)});
    }
    cancelSpritePlacement();
  };
  const onKey = (e)=>{ if(e.key==='Escape') cancelSpritePlacement(); };
  document.addEventListener('mousemove', onMove);
  // Defer the click hook so the selecting click doesn't immediately place it.
  setTimeout(()=> document.addEventListener('mousedown', onDown, true), 0);
  document.addEventListener('keydown', onKey);
  spritePlacing = { name, ghost, onMove, onDown, onKey };
  document.body.classList.add('placing');
}
function cancelSpritePlacement(){
  if(!spritePlacing) return;
  const p = spritePlacing; spritePlacing = null;
  if(p.ghost) p.ghost.remove();
  document.removeEventListener('mousemove', p.onMove);
  document.removeEventListener('mousedown', p.onDown, true);
  document.removeEventListener('keydown', p.onKey);
  document.body.classList.remove('placing');
}

// --- pointer drag: marbles (samodeus port — transform-only, DOM committed once)
// The DOM is NOT mutated while dragging; siblings slide via CSS transforms
// (FLIP) and the real reorder is posted a single time on drop. This is what
// makes it stable (no mid-drag re-layout thrash).
function faceCenter(el){
  const f = el.querySelector('.face') || el;
  const r = f.getBoundingClientRect();
  return { cx:r.left + r.width/2, cy:r.top + r.height/2, w:r.width };
}
function setShift(el, dx, dy, ot){
  el.style.transform = ('translate(' + dx + 'px,' + dy + 'px) ' + (ot||'')).trim();
}
// Viewport-space center of honeycomb slot index in a grid — mirrors the exact
// geometry layoutMarbles applies (grid cell + offset-row translateX + row nestle
// translateY). Used to place the "append" slot for a foreign drop: the next slot
// can wrap DOWN-AND-LEFT to a new row, which a linear extrapolation of the last
// two marbles gets wrong (it points up-right), so a drop into the visual new row
// missed "append" and became a mid-insert that cascaded the last marble.
function slotCenter(grid, index){
  if(!grid) return null;
  const r = grid.getBoundingClientRect();
  const w = grid.clientWidth; if(!w) return null;
  const perRow = Math.max(3, Math.round(w / TARGET_CELL));
  const cell = w / perRow;
  const noteH = cell;
  const nestle = noteH - 0.866 * Math.min(cell, noteH);   // per-row upward pull
  const cycle = 2*perRow - 1;
  const pos = index % cycle;
  const off = pos >= perRow;
  const row = Math.floor(index / cycle) * 2 + (off ? 1 : 0);
  const col = off ? (pos - perRow + 1) : (pos + 1);        // 1-based grid column
  const cx = (col - 0.5) * cell + (off ? cell*0.5 : 0);
  const cy = row * noteH + noteH/2 - row * nestle;
  return { cx: r.left + cx, cy: r.top + cy };
}
function startMarbleDrag(e, m, el){
  if(pathEdit) return;
  if(e.button !== 0) return;
  mdrag = { id:m.id, el, startX:e.clientX, startY:e.clientY, hasMoved:false,
            ghost:null, ghostL:0, ghostT:0, fromIndex:-1, currentTarget:-1,
            sourceGroup:null, siblings:[], targetGroup:null, targetSiblings:null };
  el.setPointerCapture(e.pointerId);
  el.onpointermove = onMarbleMove;
  el.onpointerup = onMarbleUp;
  el.onpointercancel = onMarbleUp;
}
function beginMarbleDrag(){
  const el = mdrag.el;
  const group = el.closest('.mgrid');
  if(!group) return false;
  mdrag.sourceGroup = group;
  const sibs = [].slice.call(group.querySelectorAll(':scope > .marble'));
  mdrag.siblings = sibs.map(function(s){
    const c = faceCenter(s);
    s.style.transition = 'transform 200ms ease';
    return { el:s, cx:c.cx, cy:c.cy, ot:s.style.transform };
  });
  mdrag.fromIndex = sibs.indexOf(el);
  mdrag.currentTarget = mdrag.fromIndex;
  if(mdrag.fromIndex < 0) return false;
  const face = el.querySelector('.face');
  const r = face.getBoundingClientRect();
  const g = face.cloneNode(true);
  g.style.position='fixed'; g.style.left=r.left+'px'; g.style.top=r.top+'px';
  g.style.width=r.width+'px'; g.style.height=r.height+'px'; g.style.margin='0';
  g.style.transform='none'; g.style.transition='none'; g.style.pointerEvents='none';
  g.style.zIndex='9999'; g.style.boxShadow='0 8px 24px rgba(0,0,0,.4)';
  document.body.appendChild(g);
  mdrag.ghost=g; mdrag.ghostL=r.left; mdrag.ghostT=r.top;
  el.classList.add('dragging');
  return true;
}
function onMarbleMove(e){
  if(!mdrag) return;
  const dx=e.clientX-mdrag.startX, dy=e.clientY-mdrag.startY;
  if(!mdrag.hasMoved){
    if(Math.hypot(dx,dy) <= 3) return;
    mdrag.hasMoved = true;
    if(document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if(!beginMarbleDrag()){ mdrag=null; return; }
  }
  mdrag.ghost.style.left=(mdrag.ghostL+dx)+'px';
  mdrag.ghost.style.top=(mdrag.ghostT+dy)+'px';
  const px=e.clientX, py=e.clientY;
  // Near an edge → scroll the board/column so hidden sections can be reached.
  updateDragScroll(px, py);
  // Ghost has pointer-events:none, so elementsFromPoint ignores it.
  const els = document.elementsFromPoint(px, py);
  let hover = null;
  for(const el of els){ const gg = el.closest ? el.closest('.mgrid') : null; if(gg){ hover=gg; break; } }
  const isForeign = hover && hover !== mdrag.sourceGroup;

  // Leaving a previously-hovered foreign group → reset its shifts.
  if(mdrag.targetGroup && mdrag.targetGroup !== hover){
    for(const s of (mdrag.targetSiblings||[])) s.el.style.transform = s.ot;
    mdrag.targetGroup=null; mdrag.targetSiblings=null;
  }

  if(isForeign){
    if(mdrag.targetGroup !== hover){
      mdrag.targetGroup = hover;
      const sibs = [].slice.call(hover.querySelectorAll(':scope > .marble'));
      mdrag.targetSiblings = sibs.map(function(s){
        const c = faceCenter(s);
        s.style.transition = 'transform 200ms ease';
        return { el:s, cx:c.cx, cy:c.cy, w:c.w, ot:s.style.transform };
      });
    }
    // Collapse the gap left behind in the source group.
    const sib = mdrag.siblings, from = mdrag.fromIndex;
    for(let i=0;i<sib.length;i++){
      if(i===from) continue;
      const vi = i > from ? i-1 : i;
      setShift(sib[i].el, sib[vi].cx - sib[i].cx, sib[vi].cy - sib[i].cy, sib[i].ot);
    }
    // Nearest slot in the target group (append == length).
    const t = mdrag.targetSiblings;
    let closest = t.length, min = Infinity;
    for(let i=0;i<t.length;i++){ const d=Math.hypot(px-t[i].cx, py-t[i].cy); if(d<min){ min=d; closest=i; } }
    if(t.length>0){
      // Append slot from real honeycomb geometry (handles the row wrap), not a
      // linear guess off the last two marbles.
      const ap = slotCenter(mdrag.targetGroup, t.length);
      if(ap && Math.hypot(px-ap.cx, py-ap.cy) < min) closest = t.length;
    }
    mdrag.currentTarget = closest;
    for(let i=0;i<t.length;i++){
      if(i < closest){ t[i].el.style.transform = t[i].ot; }
      else {
        const next=t[i+1], o=t[i]; let sx=0, sy=0;
        if(next){ sx=next.cx-o.cx; sy=next.cy-o.cy; }
        else if(i>0){ sx=o.cx-t[i-1].cx; sy=o.cy-t[i-1].cy; }
        else { sx=o.w||60; }
        setShift(o.el, sx, sy, o.ot);
      }
    }
  } else {
    // Same-group reorder: nearest-center target, shift the others.
    const sib = mdrag.siblings, from = mdrag.fromIndex;
    let closest = from, min = Infinity;
    for(let i=0;i<sib.length;i++){ const d=Math.hypot(px-sib[i].cx, py-sib[i].cy); if(d<min){ min=d; closest=i; } }
    mdrag.currentTarget = closest;
    for(let i=0;i<sib.length;i++){
      if(i===from) continue;
      let vi=i;
      if(closest<from){ if(i>=closest && i<from) vi=i+1; }
      else if(closest>from){ if(i>from && i<=closest) vi=i-1; }
      setShift(sib[i].el, sib[vi].cx - sib[i].cx, sib[vi].cy - sib[i].cy, sib[i].ot);
    }
  }
}
function onMarbleUp(e){
  if(!mdrag) return;
  stopDragScroll();
  const el = mdrag.el;
  try{ el.releasePointerCapture(e.pointerId); }catch(_e){}
  el.onpointermove = null; el.onpointerup = null; el.onpointercancel = null;

  // A click (no drag): open the marble's own session and keep its agents lit
  // while that session is the active one.
  if(!mdrag.hasMoved){
    const id=mdrag.id; mdrag=null;
    vscode.postMessage({type:'open', id});
    setSessionLit(id);
    return;
  }

  // Dropped onto the Plan/Process field → free placement (with a bounce for
  // marbles arriving from elsewhere), not a honeycomb reorder.
  const field = fieldUnderPoint(e.clientX, e.clientY);
  if(field){
    const md2 = mdrag; mdrag = null;
    const r = field.getBoundingClientRect();
    const x = Math.max(0, e.clientX - r.left);   // absolute px within the field
    // The ball appears at the release point then falls BOUNCE_RISE px to rest, so
    // its resting centre is that much lower than where the mouse let go.
    const y = Math.max(0, e.clientY - r.top) + BOUNCE_RISE;
    // Keep the source marble hidden (still '.dragging') until the re-render swaps
    // it for the field ball — restoring it here flashes it back into TODO.
    const settling = md2.siblings.concat(md2.targetSiblings||[]);
    for(const s of settling){ s.el.style.transform = ''; }
    setTimeout(function(){ for(const s of settling) s.el.style.transition=''; }, 220);
    // Morph the drag ghost into the landing bounce IN PLACE — a continuous
    // element, so there's no gap while the round-trip creates the real ball
    // (which stays hidden until the ghost finishes). No round-trip, no jump.
    const cur = (state.marbles.find(z=>z.id===md2.id)||{}).stage;
    const fresh = cur!=='plan' && cur!=='process';
    // Always land with the drop bounce first (even path marbles) — the roll to
    // the first agent begins only once the bounce reveals the resting ball.
    if(fresh && md2.ghost){ playGhostDrop(md2.ghost, e.clientX, e.clientY, md2.id); }
    else if(md2.ghost){ md2.ghost.remove(); }
    vscode.postMessage({type:'fieldPlace', id:md2.id, x, y});
    return;
  }

  const md = mdrag; mdrag = null;
  const group = md.targetGroup || md.sourceGroup;
  const toIndex = md.currentTarget;

  // Destination ids in DOM order, minus the dragged marble → resolve beforeId.
  const destIds = [].slice.call(group.querySelectorAll(':scope > .marble'))
    .map(x=>x.dataset.mid).filter(id=>id!==md.id);
  const beforeId = (toIndex>=0 && toIndex<destIds.length) ? destIds[toIndex] : null;

  let stage = group.dataset.stage;
  const section = group.dataset.section || '';
  if(group.dataset.combined){
    const cur = (state.marbles.find(x=>x.id===md.id)||{}).stage;
    if(cur==='plan' || cur==='process') stage = cur; // keep existing lane on reorder
  }

  // Commit locally for instant feedback, then reconcile from the round-trip.
  // Settle via FLIP on the faces: reinserting changes grid cells instantly and
  // layoutMarbles rewrites the honeycomb transforms, so a lingering transform
  // transition on the marbles would tween from stale preview values (the
  // outward-then-back wobble). Capture the current face positions, move
  // everything with transitions off, then animate the faces old → new.
  const beforeEl = beforeId ? group.querySelector(':scope > .marble[data-mid="'+beforeId+'"]') : null;
  captureRects();
  // The dragged marble should settle in from where it was dropped (the ghost),
  // not from its old slot.
  if(md.ghost && flipRects) flipRects[md.id] = md.ghost.getBoundingClientRect();
  group.insertBefore(el, beforeEl);
  el.classList.remove('dragging');
  const settling = md.siblings.concat(md.targetSiblings||[]);
  for(const s of settling){ s.el.style.transition = 'none'; s.el.style.transform = ''; }
  layoutMarbles();
  flipFaces();
  if(md.ghost) md.ghost.remove();
  setTimeout(function(){ for(const s of settling) s.el.style.transition=''; }, 220);

  vscode.postMessage({ type:'reorder', id:md.id, stage,
    sectionId: stage==='todo' ? (section || null) : null, beforeId });
}

// --- Add / Edit Task modal -------------------------------------------------
function closeModal(){ document.getElementById('modal').classList.add('hidden'); }
// Close when clicking the backdrop (outside the card).
document.getElementById('modal').onpointerdown = (e)=>{ if(e.target.id === 'modal') closeModal(); };

function openModal(ed){
  const editing = ed && ed.id;
  const card = document.getElementById('modalCard');
  card.innerHTML = \`
    <div class="modalHead">
      <h2>\${editing ? 'Edit Task' : 'Add Task'}</h2>
      <button class="mClose" id="m-x" type="button" title="Close">×</button>
    </div>
    <div><label>Title</label><input id="f-title" placeholder="e.g. Add a button"/></div>
    <div class="row">
      <div style="flex:2 1 0"><label>Branch</label>
        <div class="combo">
          <input id="f-branch" autocomplete="off" placeholder="andrey/PRO-123-add-button"/>
          <div class="combo-list hidden" id="branchlist"></div>
        </div>
      </div>
      <div style="flex:1 1 0"><label>Worktree Setup</label>
        <div class="seg" id="f-setup">
          <button type="button" data-v="basic" class="sel" title="Create the worktree and open it">Basic</button>
          <button type="button" data-v="full" title="Also copy gitignored files (build caches / deps)">Full</button>
        </div>
      </div>
    </div>
    <div>
      <div class="lblrow"><label>Tickets (URLs)</label>
        <button class="addcircle" id="ticket-add" type="button" title="Add ticket URL">+</button></div>
      <div id="ticketRows"></div>
    </div>
    <div><label>Prompt</label><textarea id="f-prompt" placeholder="What should Claude do?"></textarea></div>
    <div>
      <div class="lblrow"><label>Snippets (drag into prompt · stored globally)</label>
        <button class="addcircle" id="snip-toggle" type="button" title="Add snippet">+</button></div>
      <div class="chips" id="snipChips"></div>
      <div class="snipAdd hidden" id="snipAddBox">
        <input id="snip-tag" placeholder="tag"/>
        <input id="snip-body" placeholder="snippet text"/>
        <button id="snip-add" type="button">Add</button>
      </div>
    </div>
    <div><label>Color</label><div class="palette" id="f-palette"></div></div>
    <div class="modalBtns">
      <button class="btnGhost" id="m-cancel" type="button">Cancel</button>
      <button class="btnPrimary" id="m-add" type="button">\${editing ? 'Save' : 'Add'}</button>
    </div>\`;
  document.getElementById('modal').classList.remove('hidden');

  // Worktree setup segmented toggle.
  let worktreeSetup = (editing && ed.worktreeSetup === 'full') ? 'full' : 'basic';
  const seg = document.getElementById('f-setup');
  function paintSeg(){ seg.querySelectorAll('button').forEach(function(b){
    b.classList.toggle('sel', b.dataset.v === worktreeSetup); }); }
  seg.querySelectorAll('button').forEach(function(b){
    b.onclick = ()=>{ worktreeSetup = b.dataset.v; paintSeg(); }; });
  paintSeg();

  if(editing){
    document.getElementById('f-title').value = ed.title || '';
    document.getElementById('f-branch').value = ed.branch || '';
    document.getElementById('f-prompt').value = ed.prompt || '';
  }

  // Themed branch combobox (filters as you type; replaces the native datalist).
  const branchInput = document.getElementById('f-branch');
  const branchList = document.getElementById('branchlist');
  function renderBranches(){
    const q = branchInput.value.trim().toLowerCase();
    const matches = (state.branches||[]).filter(b => !q || b.toLowerCase().includes(q)).slice(0,60);
    branchList.innerHTML = '';
    if(!matches.length){ branchList.classList.add('hidden'); return; }
    matches.forEach(function(b){
      const o = document.createElement('div'); o.className='opt'; o.textContent=b;
      o.onmousedown = (e)=>{ e.preventDefault(); branchInput.value=b; branchList.classList.add('hidden'); };
      branchList.appendChild(o);
    });
    branchList.classList.remove('hidden');
  }
  branchInput.onfocus = renderBranches;
  branchInput.oninput = renderBranches;
  branchInput.onblur = ()=> setTimeout(()=> branchList.classList.add('hidden'), 120);

  const prompt = document.getElementById('f-prompt');
  prompt.ondragover = (e)=> e.preventDefault();
  prompt.ondrop = (e)=>{ e.preventDefault();
    const body = e.dataTransfer.getData('text/plain');
    if(body){ const p=prompt.value; prompt.value = p + (p && !p.endsWith('\\n') ? '\\n' : '') + body; } };

  // Ticket URL rows — added on demand via the + circle button.
  let tickets = (editing && Array.isArray(ed.tickets))
    ? ed.tickets.map(t => t.url || t.label || '').filter(Boolean) : [];
  function renderTickets(){
    const box = document.getElementById('ticketRows'); box.innerHTML='';
    tickets.forEach(function(url, i){
      const row = document.createElement('div'); row.className='ticketRow';
      const inp = document.createElement('input'); inp.type='url';
      inp.placeholder='https://linear.app/…'; inp.value=url;
      inp.oninput = ()=>{ tickets[i] = inp.value; };
      const rm = document.createElement('button'); rm.className='trm'; rm.type='button';
      rm.textContent='×'; rm.title='Remove ticket';
      rm.onclick = ()=>{ tickets.splice(i,1); renderTickets(); };
      row.appendChild(inp); row.appendChild(rm); box.appendChild(row);
    });
  }
  document.getElementById('ticket-add').onclick = ()=>{
    tickets.push(''); renderTickets();
    const inputs = document.querySelectorAll('#ticketRows input');
    if(inputs.length) inputs[inputs.length-1].focus();
  };
  renderTickets();

  // Editable snippet list, persisted to global settings on every change.
  let snips = (state.snippets||[]).map(s => ({tag:s.tag, body:s.body}));
  function persistSnips(){ vscode.postMessage({type:'saveSnippets', snippets:snips}); }
  function renderSnips(){
    const box = document.getElementById('snipChips');
    box.innerHTML = '';
    if(!snips.length){ box.innerHTML = '<span style="opacity:.5">none</span>'; return; }
    snips.forEach((s, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip'; chip.draggable = true;
      chip.setAttribute('data-body', s.body);
      const label = document.createElement('span'); label.textContent = s.tag;
      const x = document.createElement('button'); x.className='chipX'; x.type='button';
      x.textContent = '×'; x.title = 'Remove snippet';
      x.onclick = (e)=>{ e.stopPropagation(); snips.splice(i,1); renderSnips(); persistSnips(); };
      chip.appendChild(label); chip.appendChild(x);
      chip.ondragstart = (e)=> e.dataTransfer.setData('text/plain', s.body);
      box.appendChild(chip);
    });
  }
  renderSnips();

  document.getElementById('snip-toggle').onclick = ()=>{
    const box = document.getElementById('snipAddBox');
    box.classList.toggle('hidden');
    if(!box.classList.contains('hidden')) document.getElementById('snip-tag').focus();
  };
  document.getElementById('snip-add').onclick = ()=>{
    const tagEl = document.getElementById('snip-tag');
    const bodyEl = document.getElementById('snip-body');
    const tag = tagEl.value.trim(), body = bodyEl.value.trim();
    if(!tag || !body){ (tag?bodyEl:tagEl).focus(); return; }
    const existing = snips.findIndex(s => s.tag === tag);
    if(existing >= 0) snips[existing] = {tag, body}; else snips.push({tag, body});
    tagEl.value = ''; bodyEl.value = '';
    renderSnips(); persistSnips();
    document.getElementById('snipAddBox').classList.add('hidden'); // close after add
  };

  // Color palette — marble swatches; edit keeps the marble's color, add picks random.
  let chosenColor = (editing && MARBLE_COLORS.includes(ed.color))
    ? ed.color : MARBLE_COLORS[Math.floor(Math.random()*MARBLE_COLORS.length)];
  const pal = document.getElementById('f-palette');
  MARBLE_COLORS.forEach(c => {
    const sw = document.createElement('button'); sw.type='button';
    sw.className = 'swatch' + (c===chosenColor?' sel':'');
    sw.title = c;
    sw.style.backgroundImage = "url('" + MARBLES_URI + "/color-" + c + ".webp')";
    sw.onclick = ()=>{ chosenColor = c;
      pal.querySelectorAll('.swatch').forEach(x=>x.classList.remove('sel'));
      sw.classList.add('sel'); };
    pal.appendChild(sw);
  });

  document.getElementById('m-x').onclick = closeModal;
  document.getElementById('m-cancel').onclick = closeModal;
  document.getElementById('m-add').onclick = ()=>{
    const title = document.getElementById('f-title').value.trim();
    if(!title){ document.getElementById('f-title').focus(); return; }
    const ticketObjs = tickets.map(u => u.trim()).filter(Boolean).map(u => ({label:u, url:u}));
    const fields = {
      title, branch: document.getElementById('f-branch').value.trim(),
      tickets: ticketObjs, worktreeSetup, copyIgnored: worktreeSetup === 'full',
      prompt: document.getElementById('f-prompt').value,
      color: chosenColor,
    };
    if(editing) vscode.postMessage({ type:'update', id:ed.id, patch:fields });
    else vscode.postMessage({ type:'create', marble:fields });
    closeModal();
  };
}

function escapeHtml(s){ return String(s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function escapeAttr(s){ return escapeHtml(s).replace(/"/g,'&quot;'); }

vscode.postMessage({type:'ready'});
`;
