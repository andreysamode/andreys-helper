import * as vscode from "vscode";
import { BackgroundWorkMonitor } from "./backgroundWork";

/**
 * Reads live Claude-tab status published by the patched Claude bundle.
 *
 * The Claude Code extension runs in the same extension host as this one, so the
 * patch (see patchClaude.ts) exposes `globalThis.__wtClaude.getTabs()` — read on
 * demand, it returns one entry per LIVE Claude panel (from Claude's own `allComms`
 * set, its source of truth for open tabs). There is no mirror dict to leak stray
 * or duplicate entries. The patch calls `globalThis.__wtClaude.notify()` on every
 * status change; we set that callback for a live repaint signal.
 *
 * `status` is one of: "working" | "question" | "plan" | "permission" | "done" |
 * "idle". The attention flavors (plan/question/permission) come from the webview's
 * active-session state (see applyWebviewStatus); "working"/"done" come from the
 * focus-independent update_session_state channel. "done" is DEBOUNCED: an idle edge
 * is provisional (Claude's `busy` toggles per CLI query, so one request spanning
 * several queries dips idle mid-work) and only becomes "done" after ~2.5s of
 * continuous idle — see the getTabs resolver / applyStateStash in patchClaude.ts.
 *
 * When Claude is unpatched (or the patch anchors didn't match its version),
 * `getTabs` is absent — callers treat that as "no data" and hide the tab list.
 */

export type ClaudeTabStatus =
  | "working"
  | "question"
  | "plan"
  | "permission"
  | "done"
  | "idle";

export interface ClaudeTab {
  /** Stable per-panel id, for focus/rename. Per-WINDOW: resets on host reload. */
  id: string;
  /** Realpath-normalized worktree cwd the tab's session runs in. */
  cwd: string;
  /** Current tab title (the editor tab's label). */
  title: string;
  /** Live status; unknown strings are surfaced verbatim (rendered as idle). */
  status: ClaudeTabStatus | string;
  /** Editor group column the panel is in (for matching to the live editor tab). */
  col?: number;
  /**
   * The PERSISTENT Claude session uuid the panel currently hosts — the key a
   * session can be resumed by (with history) after the tab or window closes.
   * Absent until the session exists / on an older patch.
   */
  sessionId?: string;
  /** Whether this panel is the active editor tab (exact, unlike label matching). */
  active?: boolean;
}

interface WtClaudeGlobal {
  getTabs?: () => ClaudeTab[];
  notify?: () => void;
}

const RENAME_COMMAND = "claude-vscode.editor.renameWorktreeTab";
const REVEAL_COMMAND = "claude-vscode.editor.revealWorktreeTab";
const SUBMIT_COMMAND = "claude-vscode.editor.submitPromptToTab";
const INTERRUPT_COMMAND = "claude-vscode.editor.interruptTab";

function wtGlobal(): WtClaudeGlobal {
  const g = globalThis as unknown as { __wtClaude?: WtClaudeGlobal };
  g.__wtClaude = g.__wtClaude || {};
  return g.__wtClaude;
}

/** Burst-coalescing window for Claude's notify() callbacks. */
const DEBOUNCE_MS = 80;
/** Ceiling on how long that coalescing may defer a repaint. */
const DEBOUNCE_MAX_WAIT_MS = 400;

export class ClaudeStatusService implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires (debounced) when Claude publishes a tab status/title change. */
  readonly onDidChange = this._onDidChange.event;

  private patched: boolean | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  /** When the oldest update still waiting behind the debounce arrived. */
  private debouncePendingSince: number | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private lastSerialized = "";
  /**
   * Process-tree background-work signal (the herdr mechanism). Catches work the
   * webview can't see — a `run_in_background` shell still running after the main
   * loop went idle — so getTabs's "done"/"idle" is upgraded back to "working"
   * instead of flashing a premature completion check. See backgroundWork.ts.
   */
  private readonly bgMonitor = new BackgroundWorkMonitor();

  start(): void {
    // Primary signal: the patched bundle calls notify() on every tab update.
    wtGlobal().notify = () => this.fireDebounced();
    // Repaint when a background shell starts/stops under a tab's claude process.
    this.bgMonitor.onDidChange(() => this.fireDebounced());
    this.bgMonitor.start();
    // Fallback: some status transitions (e.g. a background tab going busy) may not
    // reliably reach notify, so poll the live snapshot and fire only on a real
    // change. Cheap — it reads Claude's in-process allComms and compares a string.
    this.lastSerialized = this.serialize();
    this.poll = setInterval(() => {
      const now = this.serialize();
      if (now !== this.lastSerialized) {
        this.lastSerialized = now;
        this._onDidChange.fire();
      }
    }, 1500);
  }

  private serialize(): string {
    try {
      return JSON.stringify(this.tabs());
    } catch {
      return "";
    }
  }

  dispose(): void {
    const g = wtGlobal();
    if (g.notify) {
      // Only clear our own hook.
      g.notify = undefined;
    }
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    if (this.poll) {
      clearInterval(this.poll);
    }
    this.bgMonitor.dispose();
    this._onDidChange.dispose();
  }

  private fireDebounced(): void {
    const now = Date.now();
    if (this.debouncePendingSince === undefined) {
      this.debouncePendingSince = now;
    }
    // Coalesce bursts (a working→done transition can fire several updates) —
    // but never longer than DEBOUNCE_MAX_WAIT_MS. Claude's notify() fires
    // continuously while a session streams; a trailing debounce that resets on
    // every call would never reach its trailing edge and the whole window would
    // go quiet for the duration of the run.
    const waited = now - this.debouncePendingSince;
    if (waited >= DEBOUNCE_MAX_WAIT_MS) {
      this.fireNow();
      return;
    }
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.debounce = setTimeout(
      () => this.fireNow(),
      Math.min(DEBOUNCE_MS, DEBOUNCE_MAX_WAIT_MS - waited)
    );
  }

  private fireNow(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
    }
    this.debouncePendingSince = undefined;
    this.lastSerialized = this.serialize();
    this._onDidChange.fire();
  }

  /** Live snapshot of open Claude tabs, read on demand from Claude's allComms.
   *  Empty when unpatched. Never a mirror dict → no stray/duplicate entries. */
  tabs(): ClaudeTab[] {
    const get = wtGlobal().getTabs;
    if (typeof get !== "function") {
      return [];
    }
    let raw: ClaudeTab[];
    try {
      raw = get() ?? [];
    } catch {
      return [];
    }
    // herdr parity: a tab whose main loop has gone quiet ("done"/"idle") but whose
    // claude process still has a live background shell is really still WORKING. The
    // webview can't see those shells; the process-tree monitor can, and attributes
    // them to the exact tab via the WT_TAB_ID env tag (t.id === the tab's __wtId),
    // so same-worktree sessions are told apart. Upgrade only in that direction —
    // never downgrade a working/attention state — so an active turn's own foreground
    // tool shell (webview already "working") is unaffected.
    return raw.map((t) =>
      (t.status === "done" || t.status === "idle") &&
      this.bgMonitor.hasBackgroundWork(t.id)
        ? { ...t, status: "working" }
        : t
    );
  }

  /**
   * Whether the active Claude bundle carries the status/rename patch. Cached
   * after the first successful positive result (the command can only appear
   * once, on host start). Returns false until Claude has activated & patched.
   */
  async isPatched(): Promise<boolean> {
    if (this.patched) {
      return true;
    }
    try {
      const all = await vscode.commands.getCommands(true);
      this.patched = all.includes(RENAME_COMMAND);
    } catch {
      this.patched = false;
    }
    return this.patched;
  }

  /**
   * Rename a Claude tab externally via the patched command, addressed by session
   * id so same-titled tabs are never confused. Persists across reloads.
   */
  async rename(sessionId: string, newTitle: string): Promise<boolean> {
    if (!(await this.isPatched())) {
      return false;
    }
    try {
      const ok = await vscode.commands.executeCommand<boolean>(
        RENAME_COMMAND,
        sessionId,
        newTitle
      );
      return ok === true;
    } catch {
      return false;
    }
  }

  /**
   * Submit a prompt into an already-open Claude tab (by session id) via the
   * patched command — used to hand the next agent's prompt to a running
   * pass-around session. Returns false when unpatched or the tab isn't found, so
   * callers can fall back (e.g. clipboard). Requires a bundle carrying the
   * submit sub-patch; older patched bundles without it return false.
   */
  async submitPrompt(sessionId: string, text: string): Promise<boolean> {
    if (!(await this.isPatched())) {
      return false;
    }
    try {
      const ok = await vscode.commands.executeCommand<boolean>(
        SUBMIT_COMMAND,
        sessionId,
        text
      );
      return ok === true;
    } catch {
      return false;
    }
  }

  /**
   * Interrupt (Esc-equivalent) the run in a Claude tab, addressed by its panel id
   * (`ClaudeTab.id`) — the same key `reveal`/`submitPrompt` use. The tab stays
   * open and resumable (PLAN.md §2 "Stop semantics", §6.2 `interrupt`). Routes to
   * the patched `interruptTab` command, which calls the comms controller's own
   * `interruptClaude(channelId)` on each active channel and arms the interrupt-
   * suppression latch so the abort's running→idle edge isn't mistaken for a
   * completion (mirrors the webview Escape / `interrupt_claude` hook). Returns
   * false when unpatched or the tab isn't found, so callers can no-op safely.
   */
  async interrupt(tabId: string): Promise<boolean> {
    if (!(await this.isPatched())) {
      return false;
    }
    try {
      const ok = await vscode.commands.executeCommand<boolean>(
        INTERRUPT_COMMAND,
        tabId
      );
      return ok === true;
    } catch {
      return false;
    }
  }

  /** Reveal/focus a Claude tab by its session id (via the patched command). The
   *  patched command also marks the tab's completion check seen — revealing a tab
   *  is a deliberate user action, so opening it counts as having looked at it. */
  async reveal(sessionId: string): Promise<void> {
    if (!(await this.isPatched())) {
      return;
    }
    try {
      await vscode.commands.executeCommand(REVEAL_COMMAND, sessionId);
    } catch {
      // best-effort
    }
  }
}
