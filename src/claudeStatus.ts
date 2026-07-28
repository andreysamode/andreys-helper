import * as vscode from "vscode";
import * as fs from "fs";
import { BackgroundWorkMonitor } from "./backgroundWork";
import {
  WorkflowRun,
  parseWfProjection,
  parseWfStreamEntry,
  resolveWorkflowTabStatus,
} from "./workflowProgress";

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
  /**
   * The dynamic workflow (the `Workflow` tool) this tab is running, or most
   * recently ran — phases, agents and the live activity line, ready to render as
   * the session box's progress strip (WORKFLOW-PROGRESS.md §3.3).
   *
   * Absent on every tab that isn't running a workflow, and on EVERY tab when the
   * bundle predates the `applyWfTracking` patch or its anchors missed. Per the
   * design's "degrade to nothing" decision (§2) that absence is the normal,
   * expected state — never an error to report.
   */
  wf?: WorkflowRun;
}

/**
 * A tab descriptor exactly as the patched bundle hands it over, before we make
 * anything of it. `wf` is `unknown` on purpose: it crosses the patch boundary
 * carrying the compact `{t,n,s,d,P,p,a}` wire projection, an older patched bundle
 * has no such field at all, and a future Claude release could change what sits
 * there. Everything downstream sees only the parsed `ClaudeTab`.
 */
type RawClaudeTab = Omit<ClaudeTab, "wf"> & { wf?: unknown };

interface WtClaudeGlobal {
  getTabs?: () => RawClaudeTab[];
  notify?: () => void;
}

const RENAME_COMMAND = "claude-vscode.editor.renameWorktreeTab";
const REVEAL_COMMAND = "claude-vscode.editor.revealWorktreeTab";
const SUBMIT_COMMAND = "claude-vscode.editor.submitPromptToTab";
const INTERRUPT_COMMAND = "claude-vscode.editor.interruptTab";

/**
 * TEMPORARY DIAGNOSTIC — remove before shipping (see the call site in tabs()).
 *
 * Records, once per changed snapshot, whether each tab descriptor arrived carrying
 * a `wf` projection and what shape it was. Writes only while the sentinel file
 * exists so it can be switched on for one reproduction and left alone otherwise.
 */
let wfDebugLast = "";
function wfDebugDump(raw: Array<{ id?: string; title?: string; status?: string; wf?: unknown }>): void {
  const home = process.env.HOME;
  if (!home) {
    return;
  }
  const sentinel = `${home}/.andreys-helper/wf-debug`;
  if (!fs.existsSync(sentinel)) {
    return;
  }
  // The stream capture lives in Claude's extension.js — the SAME extension host as
  // this code — so its state is directly readable here rather than inferable. That
  // distinguishes the two remaining failure modes without another patch cycle:
  // an empty/absent map means the injected capture never ran, while a populated map
  // whose keys don't match a tab's sessionId means the lookup key is wrong.
  const g = globalThis as unknown as {
    __wtClaude?: { wfBySession?: Record<string, unknown>; __wtWfCap?: unknown };
  };
  const cap = g.__wtClaude ?? {};
  const wfMap = cap.wfBySession ?? {};
  const capState = {
    capInstalled: cap.__wtWfCap !== undefined,
    wfSessionKeys: Object.keys(wfMap).map((k) => k.slice(0, 8)),
    wfEntries: Object.keys(wfMap).length,
    sample: Object.values(wfMap)[0],
  };
  const shot = raw.map((t: Record<string, unknown>) => ({
    id: t.id,
    title: typeof t.title === "string" ? t.title.slice(0, 30) : t.title,
    status: t.status,
    sessionId: typeof t.sessionId === "string" ? t.sessionId.slice(0, 8) : t.sessionId,
    // Webview-sourced fields: present only if a rename_tab from __wtSend landed.
    dbgWeb: t.dbgWeb,
    dbgBg: t.dbgBg,
    dbgLive: t.dbgLive,
    dbgWfT: t.dbgWfT,
    wfType: t.wf === undefined ? "undefined" : t.wf === null ? "null" : typeof t.wf,
    wfKeys: t.wf && typeof t.wf === "object" ? Object.keys(t.wf as object) : undefined,
    wf: t.wf,
  }));
  const line = JSON.stringify({ cap: capState, tabs: shot });
  if (line === wfDebugLast) {
    return;
  }
  wfDebugLast = line;
  // pid identifies WHICH extension host (i.e. which window) observed these tabs —
  // essential when several windows are open and only some have reloaded since the
  // bundle was patched, because a stale window's webview runs pre-patch code.
  fs.appendFileSync(
    `${sentinel}.log`,
    `${new Date().toISOString()} pid=${process.pid} tabs=${raw.length} ${line}\n`
  );
}

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
  /**
   * Parsed workflow runs, memoized per tab against the RAW projection's JSON.
   *
   * This exists to keep `serialize()` honest. That method JSON-stringifies the
   * whole tab list to decide whether the 1.5 s poll should fire a repaint, so any
   * field that differs on every read makes every poll a change — a repaint (and a
   * broker snapshot) every 1.5 s for as long as a workflow runs, plus the same
   * churn on the far more frequent notify()-driven reads. `WorkflowRun.updatedAt`
   * is exactly such a field if it's stamped with `Date.now()` on each parse.
   *
   * So a re-read of an UNCHANGED projection returns the very same run object,
   * timestamp included, and only a projection whose bytes actually moved gets a
   * fresh parse and a fresh `updatedAt`. That also makes `updatedAt` mean what the
   * UI wants — when this run last changed, not when we last looked at it.
   *
   * The capture side already suppresses most of the churn (it omits `wtWf` unless
   * the run's signature changed, §3.2), but that guard lives in an injected patch
   * we may or may not be running; the host must not depend on it for correctness.
   */
  private readonly wfByTab = new Map<string, { wire: string; run: WorkflowRun }>();

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

  /** Change key for the poll. Stable across reads while nothing moves — see
   *  {@link wfByTab} for why a live workflow doesn't break that. */
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
    this.wfByTab.clear();
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
    let raw: RawClaudeTab[];
    try {
      raw = get() ?? [];
    } catch {
      return [];
    }
    // TEMPORARY DIAGNOSTIC — remove before shipping. Dumps what getTabs() actually
    // hands over, so the webview→host hop can be observed from outside the editor
    // (webview console logs never reach disk). Inert unless the sentinel file
    // ~/.andreys-helper/wf-debug exists, so it costs a single existsSync per poll.
    try {
      wfDebugDump(raw);
    } catch {
      // never let a diagnostic break the status path
    }
    const out = raw.map((t) => {
      // Split the raw projection off: what leaves here carries the PARSED run (or
      // nothing), never the wire shape, so no consumer has to know the wire exists.
      const { wf: wire, ...rest } = t;
      const tab: ClaudeTab = rest;
      // herdr parity: a tab whose main loop has gone quiet ("done"/"idle") but whose
      // claude process still has a live background shell is really still WORKING. The
      // webview can't see those shells; the process-tree monitor can, and attributes
      // them to the exact tab via the WT_TAB_ID env tag (t.id === the tab's __wtId),
      // so same-worktree sessions are told apart. Upgrade only in that direction —
      // never downgrade a working/attention state — so an active turn's own foreground
      // tool shell (webview already "working") is unaffected.
      if (
        (tab.status === "done" || tab.status === "idle") &&
        this.bgMonitor.hasBackgroundWork(tab.id)
      ) {
        tab.status = "working";
      }
      const wf = this.workflowFor(tab.id, wire);
      if (wf !== undefined) {
        tab.wf = wf;
      }
      // "No checkmarks mid-process — spinner all the way until the workflow is done."
      // A running workflow outlives the main loop, so the completion latch would show
      // a check (and flap against the background-work signal) while agents are still
      // going. The patched resolver applies the same rule inside getTabs(); this is the
      // host-side statement of it — unit-tested precedence, and still correct on an
      // older patched bundle whose resolver predates the rank.
      tab.status = resolveWorkflowTabStatus(tab.status, wf);
      return tab;
    });
    // Tabs come and go; drop memoized runs for panels that are no longer live so a
    // long session doesn't accumulate one stale projection per closed tab.
    if (this.wfByTab.size > 0) {
      const live = new Set(out.map((t) => t.id));
      for (const id of [...this.wfByTab.keys()]) {
        if (!live.has(id)) {
          this.wfByTab.delete(id);
        }
      }
    }
    return out;
  }

  /**
   * Parse (or re-serve) the workflow run attached to one tab descriptor.
   *
   * Total by construction: absent, malformed, or unparseable input all yield
   * `undefined`, never a throw and never a half-built run. That matters because
   * `getTabs()` output crosses the patch boundary — an older patched bundle has no
   * `wf` field, and anything at all could sit there if a future Claude release
   * moves under us. `tabs()` is on the repaint path for the whole pane; it must
   * not be the thing that takes it down.
   */
  private workflowFor(tabId: string, wire: unknown): WorkflowRun | undefined {
    if (wire === undefined || wire === null) {
      this.wfByTab.delete(tabId);
      return undefined;
    }
    let key: string;
    try {
      key = JSON.stringify(wire) ?? "";
    } catch {
      return undefined; // circular / unserializable — not something we can render
    }
    const hit = this.wfByTab.get(tabId);
    if (hit && hit.wire === key) {
      return hit.run;
    }
    // Two shapes reach here. The PRIMARY one is the extension-side stream capture's
    // entry (`taskId`/`progress` — built in this same process, nothing abbreviated).
    // The secondary is the webview's compact wire projection (`t`/`a`), kept only as
    // a fallback for a bundle where the stream anchor missed. Dispatch on a field
    // unique to the stream shape rather than trying both blindly, so a malformed
    // value still resolves to "no workflow" instead of half-parsing as the other.
    const o = wire as Record<string, unknown>;
    const run =
      typeof o.taskId === "string"
        ? parseWfStreamEntry(wire, Date.now())
        : parseWfProjection(wire, Date.now());
    if (!run) {
      this.wfByTab.delete(tabId);
      return undefined;
    }
    this.wfByTab.set(tabId, { wire: key, run });
    return run;
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
