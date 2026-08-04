import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";
import AdmZip from "adm-zip";
import { toast } from "./notify";

/**
 * Self-contained patcher for the Claude Code extension bundle — the same two
 * patches as patch-claude.sh, but applied from inside this extension so users
 * never run a shell script:
 *
 *   1. webview/index.js — default the "include current selection/file" toggle
 *      OFF (opt-in preserved), so an open file isn't auto-attached to every
 *      message.
 *   2. extension.js — add the `claude-vscode.editor.openWorktree(cwd)` command
 *      so a Claude tab can be pinned to a git worktree's working directory.
 *
 * We target the *active* Claude extension via the extension API's
 * `extensionPath`, so we patch exactly the bundle Cursor loaded (no scanning of
 * ~/.cursor, no version guessing). Both patches are idempotent, back the
 * original up once as `<file>.bak`, and anchor on stable minified tokens so they
 * survive re-minification across Claude versions — aborting loudly rather than
 * corrupting the bundle if the shape changed.
 *
 * Patching edits files on disk; the change takes effect only after the
 * extension host reloads, so both commands offer to restart it.
 */

const CLAUDE_EXTENSION_ID = "anthropic.claude-code";

/** Canonical marker: the new command string only exists once extension.js is
 *  patched. Doubles as the "is patched?" probe. */
const MARKER = "claude-vscode.editor.openWorktree";

/**
 * Version stamp embedded in the patched bundle. Bump this whenever the CONTENT of
 * any sub-patch changes (not just when adding a new one). "Patch" self-heals: if a
 * bundle is patched but lacks the current stamp, it's restored from its .bak and
 * re-patched fresh — so a plain "Patch" always upgrades to the latest logic
 * without the user having to Unpatch first. (Per-feature markers alone can't do
 * this: they stay present when a patch's internals change, so the edit is skipped.)
 */
const PATCH_VERSION = "wtpatch-v26";
const PATCH_VERSION_MARKER = "/*" + PATCH_VERSION + "*/";

/** Marker for the rename_tab status-stash injection (extension.js). */
const STATUS_STASH_MARKER = "this.__wtWeb=e.request.wtStatus";
/** Marker for the update_session_state status-stash injection (extension.js). */
const STATE_STASH_MARKER = 'st==="running"?"working"';
/** Marker for the interrupt_claude suppression hook (extension.js). */
const INTERRUPT_STASH_MARKER = "__wtNoDoneTs=Date.now()/*int*/";
/** Command string for renaming a tab by panel id (extension.js). Doubles as the
 *  marker that the commands + getTabs() bridge are present. */
const RENAME_COMMAND = "claude-vscode.editor.renameWorktreeTab";
/** Command string for revealing/focusing a tab by panel id (extension.js). */
const REVEAL_COMMAND = "claude-vscode.editor.revealWorktreeTab";
/** Command string for submitting a prompt into an open tab by panel id (KYM
 *  pass-around: hands the next agent's prompt to a running session). */
const SUBMIT_COMMAND = "claude-vscode.editor.submitPromptToTab";
/** Command string for interrupting (Esc-equivalent) an open tab by panel id
 *  (AndreysOrchestrator `interrupt` verb; PLAN.md §6.2). Doubles as its marker. */
const INTERRUPT_COMMAND = "claude-vscode.editor.interruptTab";
/** Marker for the per-panel id assignment (extension.js). The panel id is the
 *  stable key for a TAB — unlike a session id (a tab hosts many over its life)
 *  or the title (tabs share the default "Claude Code"). */
const PANELID_MARKER = '__wtId="wt"';
/** Marker for the webview status-enrichment (webview/index.js). */
const WEBVIEW_STATUS_MARKER = "wtStatus:";
/** Marker for the prompt-injection scheduler in extension.js (KYM). */
const PROMPT_EXT_MARKER = "__g.pendingPrompt";
/** Markers for the three webview/index.js prompt-injection edits (KYM). */
const PROMPT_WEBVIEW_HANDLE_MARKER = "wtSubmit:(wtx)";
const PROMPT_WEBVIEW_REG_MARKER = "window.__wtSubmit=";
const PROMPT_WEBVIEW_DISPATCH_MARKER = '"wt_submit_prompt"';
/** Marker for the background-agent tracking injection (webview/index.js). */
const BGTASK_MARKER = "this.__wtBgTasks";
/** Marker for the dynamic-workflow tracking injection (webview/index.js).
 *
 *  A COMMENT, not an identifier, and deliberately so. Every earlier candidate was
 *  a name that other code may legitimately *mention*: `self.__wtWf` is prefix-
 *  collidable, and both `__wtWfProj` and `__wtWfPlan` are referenced by
 *  applyWebviewStatus — which runs EARLIER in the pipeline, so its injection makes
 *  an identifier-based marker read as "already applied" and this hook set is
 *  silently skipped, costing the whole feature with no error anywhere. That is not
 *  hypothetical: it happened the moment a diagnostic in applyWebviewStatus named
 *  __wtWfPlan. A comment token is emitted by this injection and nothing else, so
 *  the probe cannot be forged by a mention. */
const WFTASK_MARKER = "/*wtwf*/";
/** Marker for the dynamic-workflow STREAM capture injection (extension.js).
 *
 *  A comment token for the same reason WFTASK_MARKER is one: the probe must be
 *  emitted by this injection and by nothing else, so a mere mention of an
 *  identifier (by us, in an earlier pipeline step, or by Claude's own code) cannot
 *  forge an "already applied" verdict and silently skip the hook.
 *
 *  This is the capture point that replaced the webview one. The webview hooks are
 *  still applied (they cost nothing and remain a fallback), but nothing depends on
 *  them: `applyWebviewStatus`'s renameTab CALL SITE never executes for the live
 *  caller, which reaches the sender through a dynamically-invoked 3-argument
 *  wrapper — measured across 1,164 real rename_tab requests, not one carried a
 *  `wtStatus`, i.e. not one came from the patched call site. The stream loop hooked
 *  here runs in the EXTENSION HOST, in the same process and the same globalThis as
 *  `getTabs()`, so the capture needs no wire, no webview and no enrichment. */
const WFSTREAM_MARKER = "/*wtwfstream*/";
/** Marker for the per-tab env tag injected into the agent subprocess env
 *  (extension.js). Stamps WT_TAB_ID=<panel __wtId> into the env resolveClaudeBinary
 *  builds, so every descendant process (incl. detached background shells) carries
 *  the owning tab's id — the process-tree background-work monitor reads it back to
 *  attribute a live shell to an EXACT tab, even when several tabs share one cwd. */
const ENVTAG_MARKER = "WT_TAB_ID=String(this.__wtId)";

/** Result of one independent sub-patch, for partial-apply reporting. */
interface PatchStep {
  name: string;
  ok: boolean;
  note?: string;
}

interface Bundle {
  root: string;
  extensionJs: string;
  webviewJs: string;
  version?: string;
}

/** Resolve the active Claude bundle's files, or undefined if not installed. */
function claudeBundle(): Bundle | undefined {
  const ext = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
  if (!ext) {
    return undefined;
  }
  const root = ext.extensionPath;
  const main = (ext.packageJSON?.main as string) || "extension.js";
  return {
    root,
    extensionJs: path.join(root, main),
    webviewJs: path.join(root, "webview", "index.js"),
    version: ext.packageJSON?.version as string | undefined,
  };
}

/** True when the active Claude bundle carries ALL of our extension.js patches
 *  (worktree tabs + tab status + external rename). A bundle with only the older
 *  worktree-tabs patch reads as unpatched so the user is re-offered the upgrade. */
function isClaudePatched(): boolean {
  const bundle = claudeBundle();
  if (!bundle) {
    return false;
  }
  try {
    const src = fs.readFileSync(bundle.extensionJs, "utf8");
    return (
      src.includes(MARKER) &&
      src.includes(PANELID_MARKER) &&
      src.includes(STATUS_STASH_MARKER) &&
      src.includes(STATE_STASH_MARKER) &&
      src.includes(INTERRUPT_STASH_MARKER) &&
      src.includes(RENAME_COMMAND) &&
      src.includes(SUBMIT_COMMAND) &&
      src.includes(INTERRUPT_COMMAND) &&
      src.includes(PROMPT_EXT_MARKER) &&
      src.includes(ENVTAG_MARKER)
    );
  } catch {
    return false;
  }
}

/** Whether the Claude Code extension is installed at all. */
function isClaudeInstalled(): boolean {
  return vscode.extensions.getExtension(CLAUDE_EXTENSION_ID) !== undefined;
}

// --- the extension.js patch (capture-based, version-resilient) -------------

const INIT =
  "var __G=globalThis.__wtClaude=globalThis.__wtClaude||{pending:null};" +
  "if(!globalThis.__wtlog){globalThis.__wtlog=function(m){try{require('fs').appendFileSync(require('os').homedir()+'/.wt-claude-patch.log','['+new Date().toISOString()+'] '+m+'\\n')}catch(e){}}}";

/**
 * Apply every extension.js patch, each independent and idempotent, and report
 * which succeeded. The openWorktree patch is REQUIRED — a missing anchor there
 * throws so the caller aborts without writing a half-patched bundle. The
 * status-publish and external-rename patches are best-effort: a missing anchor
 * is recorded (so the caller can warn) but doesn't abort, since worktree tabs
 * still work without them.
 */
function patchExtensionJs(src: string): { src: string; steps: PatchStep[] } {
  const steps: PatchStep[] = [];

  // 1. Worktree tabs (required). Throws on a missing anchor.
  if (!src.includes(MARKER)) {
    src = applyOpenWorktree(src);
  }
  steps.push({ name: "worktree tabs", ok: src.includes(MARKER) });

  // 1b. Per-panel id (best-effort) — the stable key every publish/command uses.
  if (!src.includes(PANELID_MARKER)) {
    try {
      src = applyPanelId(src);
      steps.push({ name: "tab id", ok: true });
    } catch (err) {
      steps.push({ name: "tab id", ok: false, note: errMessage(err) });
    }
  } else {
    steps.push({ name: "tab id", ok: true });
  }

  // 2. Rich status stash on the controller (best-effort) — plan/question/etc.
  if (!src.includes(STATUS_STASH_MARKER)) {
    try {
      src = applyStatusStash(src);
      steps.push({ name: "tab status", ok: true });
    } catch (err) {
      steps.push({ name: "tab status", ok: false, note: errMessage(err) });
    }
  } else {
    steps.push({ name: "tab status", ok: true });
  }

  // 3. Live running/idle status stash (best-effort) — reliable busy signal.
  if (!src.includes(STATE_STASH_MARKER)) {
    try {
      src = applyStateStash(src);
      steps.push({ name: "tab status (live)", ok: true });
    } catch (err) {
      steps.push({ name: "tab status (live)", ok: false, note: errMessage(err) });
    }
  } else {
    steps.push({ name: "tab status (live)", ok: true });
  }

  // 3b. Interrupt suppression (best-effort) — Escape aborts don't latch a check.
  if (!src.includes(INTERRUPT_STASH_MARKER)) {
    try {
      src = applyInterruptStash(src);
      steps.push({ name: "interrupt suppression", ok: true });
    } catch (err) {
      steps.push({ name: "interrupt suppression", ok: false, note: errMessage(err) });
    }
  } else {
    steps.push({ name: "interrupt suppression", ok: true });
  }

  // 4. getTabs() bridge + rename/reveal commands (best-effort).
  if (!src.includes(RENAME_COMMAND)) {
    try {
      src = applyTabCommands(src);
      steps.push({ name: "tab bridge/commands", ok: true });
    } catch (err) {
      steps.push({ name: "tab bridge/commands", ok: false, note: errMessage(err) });
    }
  } else {
    steps.push({ name: "tab bridge/commands", ok: true });
  }

  // 4b. Submit-to-tab command (best-effort) — push a prompt into an ALREADY-open
  //     session by panel id, for KYM pass-around hops after the first.
  if (!src.includes(SUBMIT_COMMAND)) {
    try {
      src = applySubmitCommand(src);
      steps.push({ name: "submit-to-tab command", ok: true });
    } catch (err) {
      steps.push({ name: "submit-to-tab command", ok: false, note: errMessage(err) });
    }
  } else {
    steps.push({ name: "submit-to-tab command", ok: true });
  }

  // 4c. Interrupt-tab command (best-effort) — Esc-equivalent abort of a running
  //     session by panel id, for the AndreysOrchestrator `interrupt` verb (PLAN.md §6.2).
  if (!src.includes(INTERRUPT_COMMAND)) {
    try {
      src = applyInterruptCommand(src);
      steps.push({ name: "interrupt-tab command", ok: true });
    } catch (err) {
      steps.push({ name: "interrupt-tab command", ok: false, note: errMessage(err) });
    }
  } else {
    steps.push({ name: "interrupt-tab command", ok: true });
  }

  // 5. Prompt injection (best-effort) — on new-panel creation, push the pending
  //    prompt to the webview so a KYM marble's session starts working on its own.
  if (!src.includes(PROMPT_EXT_MARKER)) {
    try {
      src = applyPromptInjectExt(src);
      steps.push({ name: "prompt injection", ok: true });
    } catch (err) {
      steps.push({ name: "prompt injection", ok: false, note: errMessage(err) });
    }
  } else {
    steps.push({ name: "prompt injection", ok: true });
  }

  // 5b. Dynamic-workflow stream capture (best-effort) — read the Workflow tool's
  //     live phase/agent progress straight off the CLI message stream, in this
  //     process, and stash it per Claude session for getTabs() to hand over. This is
  //     the capture the phase strip actually runs on; the webview hooks are a
  //     fallback that has never delivered (see WFSTREAM_MARKER).
  if (!src.includes(WFSTREAM_MARKER)) {
    try {
      src = applyWfStreamCapture(src);
      steps.push({ name: "workflow stream capture", ok: true });
    } catch (err) {
      steps.push({ name: "workflow stream capture", ok: false, note: errMessage(err) });
    }
  } else {
    steps.push({ name: "workflow stream capture", ok: true });
  }

  // 6. Per-tab env tag (best-effort) — stamp WT_TAB_ID into the agent subprocess
  //    env so the process-tree monitor can attribute a live background shell to the
  //    exact tab (precise even when tabs share a worktree cwd).
  if (!src.includes(ENVTAG_MARKER)) {
    try {
      src = applyEnvTag(src);
      steps.push({ name: "per-tab env tag", ok: true });
    } catch (err) {
      steps.push({ name: "per-tab env tag", ok: false, note: errMessage(err) });
    }
  } else {
    steps.push({ name: "per-tab env tag", ok: true });
  }

  return { src, steps };
}

/**
 * Prompt injection (extension.js). When a new comms controller is created, if a
 * prompt is pending on the shared global (set by this extension right before it
 * runs the openWorktree command), repeatedly `send()` a `wt_submit_prompt`
 * request to the controller's webview until it takes (the webview dedupes by
 * nonce and submits once its composer has mounted). Anchored on the same
 * `this.allComms.add(<controller>)` the panel-id patch keys off — a comma
 * expression, so no block restructuring.
 */
function applyPromptInjectExt(src: string): string {
  const m = src.match(
    /let ([\w$]+)=new [\w$]+\(this\.context,[\w$]+,this\.settings,/
  );
  if (!m) {
    throw new Error("comms controller construction anchor not found");
  }
  const c = m[1];
  const anchor = `this.allComms.add(${c})`;
  if (src.split(anchor).length - 1 !== 1) {
    throw new Error("allComms.add anchor not unique");
  }
  const inject =
    `${anchor},(function(cc){try{var __g=globalThis.__wtClaude=globalThis.__wtClaude||{};` +
    `__g.promptInjection=!0;var __tx=__g.pendingPrompt;__g.pendingPrompt=null;` +
    `if(__tx&&cc&&typeof cc.send==="function"){` +
    `var __nc="wtp"+Date.now()+Math.floor(Math.random()*1e6),__k=0,__iv=setInterval(function(){__k++;` +
    `try{cc.send({type:"request",channelId:"",requestId:"",request:{type:"wt_submit_prompt",text:__tx,nonce:__nc}})}catch(__e){}` +
    `if(__k>=30)clearInterval(__iv)},500)}}catch(__e){}})(${c})`;
  return src.replace(anchor, inject);
}

/**
 * Add the openWorktree command. Throws with a human-readable reason if an anchor
 * can't be found (bundle reshaped) so the caller aborts without writing a
 * corrupted file.
 */
function applyOpenWorktree(src: string): string {
  // Capture the volatile minified identifiers from the setupPanel signature and
  // the realpathSync(<folders>[0]||<x>.homedir()) shape. Identifiers may contain
  // `$` (e.g. an fs alias `$C`), so use [\w$]+ everywhere, never \w+.
  const sp = src.match(
    /setupPanel\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\{let ([\w$]+)=\{isVisible:\(\)=>\1\.visible\};this\.webviews\.add\(\5\);let ([\w$]+)=[\w$]+\.workspace\.workspaceFolders\?\.map\(\([\w$]+\)=>[\w$]+\.uri\.fsPath\)\|\|\[\],([\w$]+)=([\w$]+)\.realpathSync\(\6\[0\]\|\|([\w$]+)\.homedir\(\)\)\.normalize\("NFC"\)/
  );
  if (!sp) {
    throw new Error("setupPanel/realpath anchor not found (Claude bundle reshaped?)");
  }
  const panel = sp[1], p2 = sp[2], p3 = sp[3], p4 = sp[4];
  const folders = sp[6], cwd = sp[7], rp = sp[8], hd = sp[9];

  // A. setupPanel entry: init the registry + consume the pending cwd slot.
  const spSig = `setupPanel(${panel},${p2},${p3},${p4}){`;
  if (src.split(spSig).length - 1 !== 1) {
    throw new Error("setupPanel signature not unique");
  }
  src = src.replace(
    spSig,
    spSig +
      INIT +
      "var __pend=__G.pending;__G.pending=null;" +
      `globalThis.__wtlog("setupPanel:enter sid="+(${p2}!=null)+" pend="+(!!__pend)+" pendCwd="+(__pend&&__pend.cwd));`
  );

  // B. cwd computation: honor the pending worktree cwd over the first folder.
  const rpExpr = `${cwd}=${rp}.realpathSync(${folders}[0]||${hd}.homedir()).normalize("NFC")`;
  if (src.split(rpExpr).length - 1 !== 1) {
    throw new Error("realpath expression not unique");
  }
  src = src.replace(
    rpExpr,
    `${cwd}=${rp}.realpathSync((__pend&&__pend.cwd)||${folders}[0]||${hd}.homedir()).normalize("NFC")`
  );

  // C. register the openWorktree command next to the stock primaryEditor.open
  //    registration; capture the subscriptions holder + vscode alias.
  const pe = src.match(
    /([\w$]+)\.subscriptions\.push\(([\w$]+)\.commands\.registerCommand\("claude-vscode\.primaryEditor\.open"/
  );
  if (!pe) {
    throw new Error("primaryEditor.open anchor not found");
  }
  const subs = pe[1], vs = pe[2];
  // Optional second arg: a Claude session id to RESUME. It's forwarded to the
  // stock editor.open (whose first parameter is a session id — Claude's own
  // reopen-with-history path); undefined keeps the fresh-session behavior.
  const inject =
    `${subs}.subscriptions.push(${vs}.commands.registerCommand("claude-vscode.editor.openWorktree",(cwd,sid)=>{` +
    `${INIT}globalThis.__wtlog("openWorktree cwd="+cwd+" sid="+sid);__G.pending={cwd:cwd};return ${vs}.commands.executeCommand("claude-vscode.editor.open",sid)})),`;
  return src.replace(pe[0], inject + pe[0]);
}

/**
 * Stash the rich status (plan/question/permission/done) on the comms controller
 * at the end of the `rename_tab` handler, and poke a repaint. No dict — the
 * status lives on the controller and is read on demand by getTabs(). `this` is
 * the controller (has .__wtStatus target and .cwd).
 */
function applyStatusStash(src: string): string {
  const anchor = '}return{type:"rename_tab_response"}';
  const n = src.split(anchor).length - 1;
  if (n !== 1) {
    throw new Error(
      `rename_tab handler anchor ${n === 0 ? "not found" : "not unique"} (Claude bundle reshaped?)`
    );
  }
  // Webview-computed status lands in its OWN field (__wtWeb) so the live
  // session-state stash (__wtLive) can't clobber a just-latched "done" on the
  // busy→idle edge. getTabs() resolves the two.
  const stash =
    "}try{this.__wtWeb=e.request.wtStatus||" +
    '(e.request.hasPendingPermissions?"permission":e.request.hasUnseenCompletion?"done":"idle");' +
    // Release the reliable extension-side completion latch ONLY on an explicit
    // interaction signal (wtSeen) — a real key/click inside the tab. Never on a
    // plain status send, so merely focusing/revealing the tab keeps the check.
    'if(e.request.wtSeen){this.__wtDoneLive=!1;this.__wtDonePendingTs=0;}' +
    // Interrupt (Escape) is not a completion: arm suppression so the abort's
    // running→idle is swallowed, and clear any check showing. Only while a run is
    // active (__wtPrevLive), so an Escape on an idle tab can't poison the next
    // completion. Redundant with the extension-side interrupt_claude hook — either
    // path arms the same window, so it works even if the webview signal is missed.
    'if(e.request.wtInterrupt){this.__wtDoneLive=!1;this.__wtDonePendingTs=0;if(this.__wtPrevLive==="running")this.__wtNoDoneTs=Date.now();}' +
    // Live background-work flag (a running subagent) from the webview — makes the
    // tab read as "working" even when the main loop is idle (see getTabs resolver).
    'this.__wtBg=!!e.request.wtBg;' +
    // Dynamic-workflow projection (see applyWfTracking). Unlike every other field
    // here this is stashed CONDITIONALLY: the webview omits `wtWf` whenever the
    // run's signature hasn't changed, so a plain assignment would blank a live
    // workflow on the very next unrelated status send (a keystroke, a busy flip).
    // `undefined` therefore means "unchanged, keep what you have" and an explicit
    // `null` means "no workflow" — the webview sends null exactly once when the
    // last run is pruned, which is what actually clears the strip.
    'if(e.request.wtWf!==void 0)this.__wtWf=e.request.wtWf;' +
    // "No checkmarks mid-process — spinner all the way until the workflow is done."
    // A dynamic workflow outlives the MAIN LOOP: the turn that launched it returns,
    // busy goes false, and the running→idle falling edge stamps a completion while
    // several agents are still working — so the row flashed a green check mid-run and
    // then flapped between check and spinner as backgroundWork.ts's process-tree
    // signal dropped and re-armed between agents.
    //
    // While the stashed run says "running": clear any check already showing and arm
    // the SAME suppression an interrupt uses, so the imminent falling edge is
    // swallowed rather than latched. Read off `this.__wtWf` (the stash, which
    // persists) and not off `e.request.wtWf` (sent only when the run changed), so
    // every status send re-arms and the window can't go stale under a quiet agent.
    // `__wtWfArm` remembers that WE armed it, so the first send carrying a terminal
    // (or absent) run releases the suppression immediately instead of leaving a live
    // 15s window to swallow the next real completion. Belt-and-braces with the
    // update_session_state guard, which blocks the stamp outright.
    'var __wl=!!(this.__wtWf&&this.__wtWf.s==="running");' +
    'if(__wl){this.__wtDoneLive=!1;this.__wtDonePendingTs=0;this.__wtNoDoneTs=Date.now();this.__wtWfArm=1;}' +
    'else if(this.__wtWfArm){this.__wtWfArm=0;this.__wtNoDoneTs=0;}' +
    'var __wp=globalThis.__wtClaude;if(__wp&&typeof __wp.notify==="function")__wp.notify()}catch(__e){}' +
    'return{type:"rename_tab_response"}';
  return src.replace(anchor, stash);
}

/**
 * Stash live running/idle status from Claude's own `update_session_state` channel
 * (fires on every busy transition — the reliable "working" signal) onto the
 * controller, and poke a repaint. Injected as an IIFE in the handler's
 * comma-return so no block restructuring is needed.
 *
 * ALSO records a focus-independent, DEBOUNCED completion on the running→idle
 * falling edge. This is the authoritative "done" signal: the webview can't be
 * trusted to report completion when its tab is focused or visible in a split (its
 * reactive latch only reliably fires while hidden), but this channel fires the
 * same way regardless of which tab has focus.
 *
 * The falling edge is treated as PROVISIONAL, not final: the underlying signal is
 * Claude's `busy` flag, which is toggled per CLI query (false on every stream
 * `result`, true on every `init`). A single logical request routinely spans
 * several queries — a queued follow-up prompt, an auto-continuation, hook-driven
 * restarts, or just the gap between one query's `result` and the next query's
 * `init` — so `busy` dips to false mid-work. Latching "done" on the FIRST idle
 * edge therefore flashed a premature completion check while the session was still
 * working. Instead we stamp `__wtDonePendingTs` on the falling edge and let the
 * getTabs resolver promote it to "done" only after it has stayed idle for a grace
 * window (2.5s); a `running` before then clears the stamp so no check appears. A
 * one-shot timer pokes a repaint when the grace elapses so the check isn't delayed
 * to the next poll. Cleared when a new run starts (running) and, on interaction,
 * by the rename_tab stash. A running→waiting_input edge is an attention state, not
 * a completion, so it's excluded — and so is EVERY falling edge that lands while a
 * dynamic workflow is still running, because the main loop returning is not the work
 * finishing (see the guard inline, and applyStatusStash's counterpart).
 */
function applyStateStash(src: string): string {
  const anchor = '"update_session_state")return this.onSessionStateChanged?.(';
  const n = src.split(anchor).length - 1;
  if (n !== 1) {
    throw new Error(
      `update_session_state anchor ${n === 0 ? "not found" : "not unique"} (Claude bundle reshaped?)`
    );
  }
  const iife =
    '"update_session_state")return (function(self,st,sid){try{' +
    // A session swap on this tab (/clear starts a fresh session id, likewise
    // /resume) is never a completion, but its fresh-session init emits a running→
    // idle blip that would otherwise latch a spurious check. Detecting the id
    // change, clear any check showing and arm suppression so the first following
    // falling edge (the init blip) is swallowed instead of latching.
    'if(self.__wtSid&&sid&&sid!==self.__wtSid){self.__wtNoDoneTs=Date.now();self.__wtDoneLive=!1;self.__wtDonePendingTs=0;}if(sid)self.__wtSid=sid;' +
    'var __ps=self.__wtPrevLive;self.__wtPrevLive=st;' +
    'self.__wtLive=st==="running"?"working":st==="waiting_input"?"permission":"idle";' +
    // Suppression is a single timestamp (__wtNoDoneTs), set by an interrupt or a
    // session swap and consumed by the FIRST running→idle falling edge after it
    // (the abort, or the fresh-session init). Consuming on the first edge — not a
    // boolean cleared on every "running" send — is what makes this robust: a run
    // can re-emit "running" mid-turn without wiping the pending suppression, and a
    // real completion after the suppressed edge latches normally. The window is
    // only a staleness guard.
    // A live dynamic workflow makes the falling edge a NON-EVENT: the main loop
    // finishing is not the work finishing, so the stamp is skipped outright (not
    // consumed like the interrupt suppression — a workflow spans many falling edges,
    // and each must be swallowed). Checked first so it outranks the one-shot
    // __wtNoDoneTs window, which stays owed for whatever armed it.
    'if(st==="running"){self.__wtDoneLive=!1;self.__wtDonePendingTs=0;}else if(__ps==="running"&&st!=="waiting_input"){if(self.__wtWf&&self.__wtWf.s==="running"){self.__wtDonePendingTs=0;}else if(self.__wtNoDoneTs&&Date.now()-self.__wtNoDoneTs<1.5e4){self.__wtNoDoneTs=0;}else{self.__wtDonePendingTs=Date.now();var __wp2=globalThis.__wtClaude;setTimeout(function(){try{if(self.__wtDonePendingTs&&Date.now()-self.__wtDonePendingTs>=2500&&__wp2&&typeof __wp2.notify==="function")__wp2.notify()}catch(__e2){}},2600);}}' +
    'var __wp=globalThis.__wtClaude;if(__wp&&typeof __wp.notify==="function")__wp.notify()}catch(__e){}})(this,e.request.state,e.request.sessionId),' +
    "this.onSessionStateChanged?.(";
  return src.replace(anchor, iife);
}

/**
 * Interrupt suppression (extension.js). Claude's own `interrupt_claude` request
 * (fired when the user presses Escape to interrupt a run) is the authoritative,
 * focus- and webview-independent signal that the imminent running→idle is an
 * abort, not a completion. Handled on the same controller as the state stash, so
 * arming `__wtNoDoneTs` here means the abort's falling edge is swallowed even if
 * the webview keydown listener never fires. Gated on a live run so a stray
 * interrupt can't poison a later completion.
 */
function applyInterruptStash(src: string): string {
  const anchor = 'case"interrupt_claude":this.interruptClaude(';
  const n = src.split(anchor).length - 1;
  if (n !== 1) {
    throw new Error(
      `interrupt_claude anchor ${n === 0 ? "not found" : "not unique"} (Claude bundle reshaped?)`
    );
  }
  const hook =
    'case"interrupt_claude":try{if(this.__wtPrevLive==="running"){this.__wtNoDoneTs=Date.now()/*int*/;this.__wtDoneLive=!1;this.__wtDonePendingTs=0;' +
    'var __wp=globalThis.__wtClaude;if(__wp&&typeof __wp.notify==="function")__wp.notify()}}catch(__e){}this.interruptClaude(';
  return src.replace(anchor, hook);
}

/**
 * Install the tab bridge next to the stock primaryEditor.open registration,
 * capturing the subscriptions holder, vscode alias, and panel-manager local
 * (owns `allComms` / `sessionPanels`):
 *   - globalThis.__wtClaude.getTabs(): reads LIVE allComms → [{id,cwd,title,
 *     status,col}] for every open Claude panel. No mirror dict, so no stray or
 *     duplicate entries — allComms is Claude's own source of truth for open tabs.
 *   - renameWorktreeTab(id, newTitle): resolve the panel's current session id and
 *     persist via Claude's own renameSession (survives reload).
 *   - revealWorktreeTab(id): reveal/focus the tab.
 * All addressed by the stable panel __wtId.
 */
function applyTabCommands(src: string): string {
  const pe = src.match(
    /([\w$]+)\.subscriptions\.push\(([\w$]+)\.commands\.registerCommand\("claude-vscode\.primaryEditor\.open",async\([\w$]+,[\w$]+\)=>\{([\w$]+)\.createPanel\(/
  );
  if (!pe) {
    throw new Error("primaryEditor.open manager anchor not found");
  }
  const subs = pe[1],
    vs = pe[2],
    mgr = pe[3];
  // Each tab also carries:
  //  - sessionId: the PERSISTENT Claude session uuid currently hosted by the
  //    panel (reverse-looked-up from Claude's own sessionPanels map) — the key
  //    a session can be resumed by after the tab/window closes;
  //  - active: the panel's live active flag, so the active editor tab can be
  //    resolved exactly (labels are ambiguous: fresh tabs all share a default);
  //  - wf: the compact dynamic-workflow projection last published by the webview
  //    (applyWfTracking), or undefined/null when the tab isn't running one — the
  //    source for the phase strip in the Source+ session box.
  const bridge =
    "(function(){try{var __wp=globalThis.__wtClaude=globalThis.__wtClaude||{};" +
    "__wp.getTabs=function(){try{var __o=[];var __sm=new Map;" +
    `try{for(const __kv of ${mgr}.sessionPanels)__sm.set(__kv[1],__kv[0])}catch(__e){}` +
    `for(const __c of ${mgr}.allComms){if(__c&&__c.panelTab){` +
    '__o.push({id:__c.__wtId,cwd:__c.cwd,title:__c.panelTab.title,status:(function(__w,__l,__d,__bg,__pd,__wf){' +
    // __l (update_session_state) and __d (its running→idle latch) are extension-
    // side and focus-independent — trust them for working/done. __w (webview) only
    // refines the attention flavor (plan vs question) and is ignored for "working"
    // once the reliable signals say idle/done (it can go stale while hidden).
    'if(__l==="working"||(__w==="working"&&__l!=="idle"&&!__d))return "working";' +
    'if(__w==="plan"||__w==="question")return __w;' +
    'if(__w==="permission"||__l==="permission")return "permission";' +
    // A RUNNING dynamic workflow means the tab is working, full stop: "no checkmarks
    // mid-process, spinner all the way until the workflow is done". The main loop goes
    // idle as soon as the launching turn returns, so without this the row shows a
    // completion check while agents are still running — and flaps, because
    // backgroundWork.ts's process-tree signal drops and re-arms between agents.
    // Ranked AFTER the attention states (those need the user, and a workflow can't
    // clear them) and BEFORE the completion latch (__d) it is meant to outrank. A
    // terminal run falls through here, so normal done/idle resumes the moment the run
    // finishes — this reads the run's own status, never a timer.
    // A live workflow means WORKING, whichever path delivered it: the extension-side
    // stream entry carries `status`, the webview projection carries the abbreviated
    // `s`. Checking only one of them is why the mid-run checkmark survived — the
    // suppression was reading a field the delivering path never sets.
    'if(__wf&&(__wf.status==="running"||__wf.s==="running"))return "working";' +
    // A live subagent (__bg) means the tab is still working even though the main
    // loop went idle — show the spinner, not the completion check. Ranked after the
    // attention states (which need the user) but before done/idle.
    'if(__bg)return "working";' +
    // __pd: within the post-idle completion grace window (falling edge stamped, but
    // 2.5s not yet elapsed). The idle may just be the gap between two CLI queries of
    // one request (queued prompt / continuation), so keep showing the spinner rather
    // than flashing a premature check — if work resumes, __wtDonePendingTs is cleared
    // and this never matures; if it stays idle past the window, __d below turns true.
    'if(__pd)return "working";' +
    // "Done" is owned solely by the extension-side completion (__d) — the webview no
    // longer reports done, so its status can't desync from the check. __d is true
    // only once the idle has survived the grace window (or an explicit latch), so a
    // brief busy dip between queries never surfaces a check.
    'if(__d)return "done";' +
    'return __l||__w||"idle"})(__c.__wtWeb,__c.__wtLive,(__c.__wtDoneLive||(__c.__wtDonePendingTs>0&&Date.now()-__c.__wtDonePendingTs>=2500)),__c.__wtBg,(__c.__wtDonePendingTs>0&&Date.now()-__c.__wtDonePendingTs<2500),(function(){try{var __rs=__sm.get(__c.panelTab),__rm=(globalThis.__wtClaude&&globalThis.__wtClaude.wfBySession)||null,__re=(__rm&&__rs)?__rm[__rs]:null;return __re||__c.__wtWf}catch(__e){return __c.__wtWf}})()),col:__c.panelTab.viewColumn,' +
    // These four are the PAYLOAD of the sentinel-gated dump in claudeStatus.ts
    // (wfDebugDump) — kept deliberately, not left over. They are four property reads
    // onto an object that never leaves this process (getTabs is called by the host
    // directly), and they are what makes that dump able to tell the failure modes
    // apart: __wtWeb and __wtBg are set ONLY by a rename_tab from the webview's
    // __wtSend, so reporting them beside wf distinguishes "the wf block failed" from
    // "no webview send reaches the host at all" — invisible in normal operation,
    // because the status resolver falls back to the extension-side __wtLive.
    // Arm the dump by touching ~/.andreys-helper/wf-debug; with no sentinel these are
    // read and dropped. Everything else from that debugging round has been removed.
    "dbgWeb:__c.__wtWeb,dbgBg:__c.__wtBg,dbgLive:__c.__wtLive,dbgWfT:typeof __c.__wtWf," +
    // `wf` resolves from the EXTENSION-SIDE stream capture first — that is the path
    // that actually delivers (see applyWfStreamCapture). It is keyed by the Claude
    // session uuid, which is exactly what the sessionPanels reverse-map already
    // yields for this panel, so the lookup is direct.
    //
    // The webview projection (`__c.__wtWf`) is only a FALLBACK, and the order here is
    // load-bearing: preferring it silently broke the whole feature once, because the
    // webview path publishes a diagnostic self-report object that both host parsers
    // correctly reject — so a populated, correct stream entry sat unused behind a
    // value that could never render.
    "sessionId:__sm.get(__c.panelTab),active:!!__c.panelTab.active," +
    "wf:(function(){try{var __ws=__sm.get(__c.panelTab)," +
    "__wm=(globalThis.__wtClaude&&globalThis.__wtClaude.wfBySession)||null," +
    "__we=(__wm&&__ws)?__wm[__ws]:null;return __we||__c.__wtWf}catch(__e){return __c.__wtWf}})()})}}" +
    "return __o}catch(__e){return[]}}}catch(__e){}})();";
  const rename =
    `${subs}.subscriptions.push(${vs}.commands.registerCommand("${RENAME_COMMAND}",async(__id,__nt)=>{` +
    `try{for(const __c of ${mgr}.allComms)if(__c&&__c.__wtId===__id){` +
    `let __sid;for(const __kv of ${mgr}.sessionPanels)if(__kv[1]===__c.panelTab){__sid=__kv[0];break}` +
    "try{if(__sid)await __c.renameSession(__sid,__nt,!1)}catch(__e){}" +
    "try{if(__c.panelTab)__c.panelTab.title=__nt}catch(__e){}return!0}}catch(__e){}return!1})),";
  // Reveal also clears the completion check: reveal is only ever driven by a
  // deliberate user action (clicking a tab's box in the Source+ pane or a KYM
  // marble), so opening the tab means the user has looked at it — mark it seen.
  const reveal =
    `${subs}.subscriptions.push(${vs}.commands.registerCommand("${REVEAL_COMMAND}",(__id)=>{` +
    `try{for(const __c of ${mgr}.allComms)if(__c&&__c.__wtId===__id){if(__c.panelTab&&__c.panelTab.reveal)__c.panelTab.reveal();__c.__wtDoneLive=!1;__c.__wtDonePendingTs=0;var __wp=globalThis.__wtClaude;if(__wp&&typeof __wp.notify==="function")__wp.notify();break}}catch(__e){}})),`;
  return src.replace(pe[0], bridge + rename + reveal + pe[0]);
}

/**
 * Register `submitPromptToTab(id, text)` next to the stock primaryEditor.open
 * registration (same anchor as the tab bridge, still present verbatim after that
 * patch prepended to it). It resolves the comms controller by its stable
 * `__wtId`, then repeatedly `send()`s a nonce'd `wt_submit_prompt` request to
 * that controller's (already-mounted) webview — the webview dedupes by nonce and
 * submits once (see the webview submit patch). Reuses the injection primitive
 * from `applyPromptInjectExt`; a few retries suffice since the composer exists.
 */
function applySubmitCommand(src: string): string {
  const pe = src.match(
    /([\w$]+)\.subscriptions\.push\(([\w$]+)\.commands\.registerCommand\("claude-vscode\.primaryEditor\.open",async\([\w$]+,[\w$]+\)=>\{([\w$]+)\.createPanel\(/
  );
  if (!pe) {
    throw new Error("primaryEditor.open manager anchor not found (submit command)");
  }
  const subs = pe[1],
    vs = pe[2],
    mgr = pe[3];
  const submit =
    PATCH_VERSION_MARKER +
    `${subs}.subscriptions.push(${vs}.commands.registerCommand("${SUBMIT_COMMAND}",(__id,__tx)=>{` +
    `try{for(const __c of ${mgr}.allComms)if(__c&&__c.__wtId===__id){` +
    `if(typeof __c.send==="function"&&__tx){` +
    // Only ONE retry interval per session at a time: cancel this session's prior
    // one before starting a new hop, so overlapping intervals can't resubmit.
    `try{if(__c.__wtIv)clearInterval(__c.__wtIv)}catch(__e){}` +
    `var __nc="wtp"+Date.now()+Math.floor(Math.random()*1e6),__k=0;__c.__wtIv=setInterval(function(){__k++;` +
    `try{__c.send({type:"request",channelId:"",requestId:"",request:{type:"wt_submit_prompt",text:__tx,nonce:__nc}})}catch(__e){}` +
    // Retry for up to ~15s: enough for a slow composer to mount. Only one interval
    // runs per session (prior cleared above) and the webview dedupes on the nonce,
    // so a prompt is submitted exactly once.
    `if(__k>=30)clearInterval(__c.__wtIv)},500)}return!0}}catch(__e){}return!1})),`;
  return src.replace(pe[0], submit + pe[0]);
}

/**
 * Register `interruptTab(id)` next to the stock primaryEditor.open registration
 * (same anchor as the tab bridge / submit command, still present verbatim after
 * those patches prepended to it). It resolves the comms controller by its stable
 * `__wtId`, then aborts the run the same way the user pressing Escape does:
 * Claude's `interrupt_claude` request handler calls `interruptClaude(e.channelId)`
 * on the controller (which does `channels.get(id).query.interrupt()`), so here we
 * call `interruptClaude` for every active channel on the tab. We also arm the
 * interrupt-suppression latch (`__wtNoDoneTs` / `__wtDoneLive`) exactly like the
 * `interrupt_claude` extension hook, so the abort's running→idle edge isn't
 * latched as a spurious completion check, and poke a repaint. The tab stays open
 * and resumable (PLAN.md §2 "Stop semantics").
 */
function applyInterruptCommand(src: string): string {
  const pe = src.match(
    /([\w$]+)\.subscriptions\.push\(([\w$]+)\.commands\.registerCommand\("claude-vscode\.primaryEditor\.open",async\([\w$]+,[\w$]+\)=>\{([\w$]+)\.createPanel\(/
  );
  if (!pe) {
    throw new Error("primaryEditor.open manager anchor not found (interrupt command)");
  }
  const subs = pe[1],
    vs = pe[2],
    mgr = pe[3];
  const cmd =
    `${subs}.subscriptions.push(${vs}.commands.registerCommand("${INTERRUPT_COMMAND}",(__id)=>{` +
    `try{for(const __c of ${mgr}.allComms)if(__c&&__c.__wtId===__id){` +
    // Abort every active channel on this tab (a tab hosts one active session, but
    // iterating is safe — interruptClaude on a stale/missing channel just warns).
    `try{if(__c.channels&&typeof __c.channels.keys==="function")for(const __k of __c.channels.keys()){try{__c.interruptClaude(__k)}catch(__e){}}}catch(__e){}` +
    // Same suppression the interrupt_claude hook arms: swallow the abort's falling
    // edge and clear any check currently showing, but only while a run is live.
    `try{if(__c.__wtPrevLive==="running"){__c.__wtNoDoneTs=Date.now();__c.__wtDoneLive=!1;__c.__wtDonePendingTs=0;}}catch(__e){}` +
    `try{var __wp=globalThis.__wtClaude;if(__wp&&typeof __wp.notify==="function")__wp.notify()}catch(__e){}` +
    `return!0}}catch(__e){}return!1})),`;
  return src.replace(pe[0], cmd + pe[0]);
}

/**
 * Assign a stable per-panel id (`__wtId`) to each comms controller as it's
 * created, so getTabs/commands key by the TAB, not a transient session id or a
 * shared title. Captured comms var from `let <c>=new <Ctor>(this.context,…)`.
 */
function applyPanelId(src: string): string {
  const m = src.match(/let ([\w$]+)=new [\w$]+\(this\.context,[\w$]+,this\.settings,/);
  if (!m) {
    throw new Error("comms controller construction anchor not found");
  }
  const c = m[1];
  const anchor = `this.allComms.add(${c})`;
  if (src.split(anchor).length - 1 !== 1) {
    throw new Error("allComms.add anchor not unique");
  }
  const assign =
    `(function(){try{var __g=globalThis.__wtClaude=globalThis.__wtClaude||{};` +
    `${c}.__wtId="wt"+(__g.seq=(__g.seq||0)+1)}catch(__e){}})(),this.allComms.add(${c})`;
  return src.replace(anchor, assign);
}

/**
 * Per-tab env tag (extension.js). `resolveClaudeBinary()` on the comms controller
 * builds the environment for the agent subprocess via `Id(...)` and returns it as
 * `env`, which flows into the SDK `query()` spawn. We stamp `WT_TAB_ID=<the
 * controller's stable __wtId>` onto that env right after it's built. Because a
 * child process inherits its parent's environment, EVERY descendant of the agent —
 * including a detached `run_in_background` shell that outlives the main turn —
 * carries WT_TAB_ID. The background-work monitor (backgroundWork.ts) reads it back
 * from the agent process to attribute a live shell to the exact owning tab, which
 * a cwd-based mapping can't do when several sessions share one worktree.
 *
 * `this` here is the comms controller (the allComms member carrying __wtId, set by
 * applyPanelId at construction — always before the first spawn). Anchored on the
 * stable `resolveClaudeBinary(){…resolveShellPath(this.output)…}` shape; the env
 * var and the env-builder fn are captured as minified identifiers.
 */
function applyEnvTag(src: string): string {
  const m = src.match(
    /resolveClaudeBinary\(\)\{let [\w$]+=[\w$]+\("claudeProcessWrapper"\),([\w$]+)=[\w$]+\([\w$]+\.resolveShellPath\(this\.output\)\),[\w$]+,[\w$]+;/
  );
  if (!m) {
    throw new Error("resolveClaudeBinary env anchor not found (Claude bundle reshaped?)");
  }
  if (src.split(m[0]).length - 1 !== 1) {
    throw new Error("resolveClaudeBinary env anchor not unique");
  }
  const env = m[1];
  const inject =
    `try{if(this.__wtId&&${env}&&typeof ${env}==="object")${env}.WT_TAB_ID=String(this.__wtId)}catch(__e){}`;
  return src.replace(m[0], m[0] + inject);
}

// --- the webview patch (auto-include-file default OFF) ---------------------

/**
 * Flip the "include current selection/file" toggle's useState default from true
 * to false. Best-effort and non-fatal: returns {changed:false, note} when the
 * toggle can't be located, so a webview reshape never blocks the extension.js
 * patch. All identifiers are read from the bundle, nothing hard-coded.
 */
function patchWebviewJs(src: string): { src: string; changed: boolean; note?: string } {
  const m = src.match(
    /includeSelection:([A-Za-z_$][\w$]*),onToggleIncludeSelection:\(\)=>([A-Za-z_$][\w$]*)\(/
  );
  if (!m) {
    return { src, changed: false, note: "include-selection toggle not located" };
  }
  const state = m[1], setter = m[2];

  const shimMatch = src.match(
    /([A-Za-z_$][\w$]*)=function\([\w$]\)\{return [^{}]+\.useState\([\w$]\)\}/
  );
  if (!shimMatch) {
    return { src, changed: false, note: "useState shim not located" };
  }
  const shim = shimMatch[1];
  const on = `[${state},${setter}]=${shim}(!0)`;
  const off = `[${state},${setter}]=${shim}(!1)`;

  if (src.includes(off) && !src.includes(on)) {
    return { src, changed: false, note: "already off" };
  }
  const n = src.split(on).length - 1;
  if (n !== 1) {
    return { src, changed: false, note: `default-on declaration count ${n} (expected 1)` };
  }
  return { src: src.replace(on, off), changed: true };
}

/**
 * Enrich the webview→host `rename_tab` message with a `wtStatus` field so our
 * pane can show a per-tab status dot, plus the background-work flag (`wtBg`) and
 * the dynamic-workflow projection (`wtWf`). Two edits, both idempotent (gated on
 * WEBVIEW_STATUS_MARKER).
 *
 * THE SENDER ENRICHES ITS OWN PAYLOAD, and that is the load-bearing part.
 *
 * The webview has exactly ONE construction site for the rename_tab request — the
 * `renameTab(...)` sender widened below — but the live caller reaches it through a
 * three-argument wrapper,
 *   renameTab=(e,t,i)=>{let n=this.comms.connection.value;
 *     if(n&&n.config.value?.openNewInTab)return n.renameTab(e,t,i),!0;return!1}
 * which is invoked DYNAMICALLY: no textual `.renameTab(` call site exists for it,
 * so no anchor can reach its callers. With three arguments the extra parameters are
 * `undefined`, and JSON.stringify drops undefined values — which is exactly the
 * four vanilla fields measured on the wire: across a full day of Cursor logs, 1,164
 * rename_tab requests reached the extension and NOT ONE carried `wtStatus`. Since
 * the reactive-effect patch below always computes a non-empty status string, that
 * is proof the effect never executes. Nothing is stripped by a schema (rename_tab
 * has none); the fields were simply never passed.
 *
 * So the payload may not DEPEND on a caller passing extra arguments. The sender
 * asks `window.__wtEnrich()` for them instead — installed by applyWfTracking, the
 * one patch site where the session object (permissionRequests / busy /
 * subagentTasks / __wtBgTasks / __wtWf) is in scope.
 *
 * The reactive call-site patch is KEPT as-is: it is harmless and correct if it ever
 * executes (an explicitly-passed argument wins over the enricher, so an interaction
 * send can still force wtSeen/wtInterrupt), and it is where the interaction
 * listeners live. It is simply no longer what the feature depends on.
 *
 * An absent enricher — anchors missed, or no task message has been dispatched yet
 * in this webview — leaves every added field undefined, i.e. byte-for-byte today's
 * behaviour. The enricher call is wrapped so it can never throw into Claude's own
 * send path.
 *
 * Status vocabulary (computed identically in both paths): ExitPlanMode → "plan";
 * AskUserQuestion → "question"; any other pending request → "permission"; else busy
 * → "working"; else "idle". "Done" is deliberately absent — the extension side owns
 * it (see applyStateStash).
 *
 * Best-effort: a missing anchor returns {changed:false, note} so it never blocks
 * the extension.js patch.
 */
function applyWebviewStatus(src: string): { src: string; changed: boolean; note?: string } {
  if (src.includes(WEBVIEW_STATUS_MARKER)) {
    return { src, changed: false, note: "already applied" };
  }
  const defRe =
    /renameTab\(e,t,i\)\{return this\.sendRequest\(\{type:"rename_tab",title:e,hasPendingPermissions:t,hasUnseenCompletion:i\}\)\}/;
  if (!defRe.test(src)) {
    return { src, changed: false, note: "renameTab sender not located" };
  }
  const callRe =
    /(l=this\.hasUnseenCompletion\.value;)([\w$]+)\(\(\)=>([\w$]+)\.renameTab\(s,a,l\)\)/;
  const call = src.match(callRe);
  if (!call) {
    return { src, changed: false, note: "renameTab call site not located" };
  }
  const react = call[2],
    conn = call[3];

  let out = src.replace(
    defRe,
    // `__x` is the enrichment, read ONCE per send. Every field falls back to it only
    // when the caller left the parameter out (`!==void 0`, not truthiness — `false`
    // for wtBg and an explicit `null` for wtWf are both meaningful), so the 8-arg
    // __wtSend path is unchanged and the 3-arg live wrapper now carries the same
    // payload it always should have.
    "renameTab(e,t,i,wtS,wtSe,wtI,wtBg,wtWf){var __x={};" +
      'try{if(typeof window!=="undefined"&&window.__wtEnrich)__x=window.__wtEnrich()||{}}catch(__e){}' +
      'return this.sendRequest({type:"rename_tab",title:e,hasPendingPermissions:t,hasUnseenCompletion:i,' +
      "wtStatus:(wtS!==void 0?wtS:__x.s),wtSeen:wtSe,wtInterrupt:wtI," +
      "wtBg:(wtBg!==void 0?wtBg:__x.bg),wtWf:(wtWf!==void 0?wtWf:__x.wf)})}"
  );
  out = out.replace(
    callRe,
    "$1" +
      // Install one-time interaction listeners. "Done" is owned entirely by the
      // extension side (focus-independent __wtDoneLive); the webview's only job here
      // is to report a genuine interaction so that latch can be released:
      //   - any key/click/typing anywhere in the tab (incl. the composer) sends
      //     wtSeen, time-throttled (400ms) so a burst doesn't spam the host;
      //   - Escape is an interrupt, not a completion — it bypasses the throttle and
      //     sends wtInterrupt so the extension suppresses the imminent "done" latch.
      // We listen for keydown/pointerdown AND mousedown/input: the composer is a rich
      // contenteditable that can consume pointer/key events before a window-capture
      // listener observes them, but a real click still fires mousedown and real
      // typing still fires input — so those guarantee the check clears when you click
      // into or type in the box. Passive focus (caret parked, no key/click/typing)
      // sends nothing, so a completion that lands while you sit in the tab keeps its
      // check.
      'try{if(!window.__wtIx){window.__wtIx=1;var __wtClr=function(ev){' +
      'if(ev&&ev.type==="keydown"&&ev.key==="Escape"){window.__wtSeenTs=Date.now();try{if(window.__wtSend)window.__wtSend(!0,!0)}catch(__e){}return;}' +
      'var __n=Date.now();if(window.__wtSeenTs&&__n-window.__wtSeenTs<400)return;window.__wtSeenTs=__n;' +
      'try{if(window.__wtSend)window.__wtSend(!0)}catch(__e){}};' +
      'var __wtEv=["keydown","pointerdown","mousedown","input"];for(var __wi=0;__wi<__wtEv.length;__wi++){window.addEventListener(__wtEv[__wi],__wtClr,!0);document.addEventListener(__wtEv[__wi],__wtClr,!0);}}}catch(__e){}' +
      `${react}(()=>{` +
      // Sender closure captures the current signals so the interaction handler can
      // push a freshly-computed status (with the seen / interrupt flags) without
      // waiting for the next reactive tick. No "done" here — the extension latch owns it.
      // __sa: count of live subagent tasks on the active session (n.subagentTasks
      // is a reactive Map, so reading .value here registers the dependency and this
      // effect re-runs as subagents start/finish). A running subagent means the tab
      // is still working even when the main loop has gone idle — forwarded as wtBg so
      // the extension resolver shows a spinner instead of the completion check.
      // (Detached background bash shells live in the Claude CLI subprocess and are
      // not observable from the webview, so they can't be covered here.)
      `window.__wtSend=function(seen,intr){var __r=(n&&n.permissionRequests&&n.permissionRequests.value)||[],__t=__r.length?(__r[0].toolName||(__r[0].request&&__r[0].request.toolName)):null,__b=(n&&n.busy&&n.busy.value)||!1,__sa=(n&&n.subagentTasks&&n.subagentTasks.value&&n.subagentTasks.value.size)||0;try{if(n&&n.__wtBgTasks){var __bn=Date.now();n.__wtBgTasks.forEach(function(ts,id){if(__bn-ts>6e5)n.__wtBgTasks.delete(id);else __sa++})}}catch(__e){}var __s=__t==="ExitPlanMode"?"plan":__t==="AskUserQuestion"?"question":__r.length?"permission":__b?"working":"idle";` +
      // Dynamic-workflow projection. __wtSend is the ONLY channel that carries it,
      // and it fires on every reactive tick and every interaction, so the payload
      // is left OUT of most requests: omission is the whole cost control, since a
      // heartbeat-only tick then sends the same ~40-byte status message it always
      // did and the host keeps the projection it already has (see
      // applyStatusStash's `!==void 0` guard).
      //
      // TWO gates, because the signature and the content answer different
      // questions. The signature (agents' states, phase count, status, task id) is
      // what earns a POKE — see applyWfTracking's 500 ms floor — and deliberately
      // excludes `lastToolName` and the activity line, which move constantly. But
      // gating the payload on the signature alone meant heartbeat content rode
      // along on NOTHING: an agent that transitioned to `progress` and then worked
      // for twenty minutes over dozens of tools kept a pinned signature, so the
      // accordion showed "running…" for its whole life and the strip's tooltip
      // froze at one instant (§3.2's "heartbeats ride along on the next natural
      // tick"). So a natural tick also ships the projection when its BYTES moved,
      // behind a 2 s floor of its own — no extra pokes, just a fuller ride when a
      // tick was going out anyway.
      // __wtWfProj is installed by applyWfTracking; absent (anchors missed, or no
      // workflow has ever run in this webview) simply means no wtWf is ever sent.
      "var __wf;try{if(n&&n.__wtWf&&window.__wtWfProj){var __wj=window.__wtWfProj(n.__wtWf);" +
      'if(__wj){var __wb=__wj.wf?JSON.stringify(__wj.wf):"",__wn=Date.now();' +
      "if(__wj.sig!==window.__wtWfSig||(__wb!==window.__wtWfBody&&__wn-(window.__wtWfBodyTs||0)>=2000)){" +
      "window.__wtWfSig=__wj.sig;window.__wtWfBody=__wb;window.__wtWfBodyTs=__wn;__wf=__wj.wf;}}}}catch(__e){}" +
      // `__wf` stays `undefined` when there is nothing new — that is the whole cost
      // control (see applyStatusStash's `!==void 0` guard), so nothing is substituted
      // in its place. A self-report used to ride this field while the capture layer
      // was being proven out; it shipped a small object on every send of every session
      // that never ran a workflow, and the layer is proven, so it is gone.
      `return ${conn}.renameTab(s,a,l,__s,!!seen,!!intr,__sa>0,__wf)};` +
      "return window.__wtSend();})"
  );
  return { src: out, changed: true };
}

/**
 * Prompt injection (webview/index.js) — three idempotent edits:
 *   1. Composer imperative handle: add `wtSubmit(text)`, which sets the editor's
 *      textContent and calls the existing submit fn (`Je`) — exactly what happens
 *      when the user hits Enter.
 *   2. Register a `window.__wtSubmit` shim (in the parent's at-mention effect,
 *      where the composer ref `a` is in scope) so any realm code can submit.
 *   3. Host→webview dispatcher: handle `wt_submit_prompt`, deduped by nonce so the
 *      host's retry-until-mounted sends submit exactly once.
 * Best-effort: a missing anchor returns {changed:false,note} and never blocks the
 * rest of the patch. All identifiers are the bundle's own minified names.
 */
function applyPromptInjectWebview(src: string): {
  src: string;
  changed: boolean;
  note?: string;
} {
  if (
    src.includes(PROMPT_WEBVIEW_HANDLE_MARKER) &&
    src.includes(PROMPT_WEBVIEW_REG_MARKER) &&
    src.includes(PROMPT_WEBVIEW_DISPATCH_MARKER)
  ) {
    return { src, changed: false, note: "already applied" };
  }

  // The three edits below capture every volatile minified identifier from stable
  // STRUCTURAL anchors instead of hard-coding names — those names drift on nearly
  // every Claude release (e.g. the composer ref ee→te and submit fn Je→ct between
  // 2.1.204 and 2.1.220), and a hard-coded miss here fails the whole update. All
  // identifiers use [\w$]+ (minified names can contain `$`).

  // Capture the composer's submit fn and its contentEditable ref from the submit
  // function's OWN definition — a far more stable shape than any single name:
  //   function <submit>(<p>){<p>?.preventDefault();let <x>=<ref>.current?.textContent?.trim()||"";if(!<x>)return;…
  // <submit> is what pressing Enter calls; <ref> is the editable element. Both are
  // consumed by the wtSubmit handle below (set text on <ref>, then call <submit>).
  const sub = src.match(
    /function ([\w$]+)\(([\w$]+)\)\{\2\?\.preventDefault\(\);let ([\w$]+)=([\w$]+)\.current\?\.textContent\?\.trim\(\)\|\|"";if\(!\3\)return;/
  );
  if (!sub) {
    return { src, changed: false, note: "composer submit fn not located" };
  }
  const submit = sub[1],
    ref = sub[4];

  // 1. Composer imperative handle — add wtSubmit next to setInputText. Capture the
  //    setInputText handle var and the handle's dep array, so the rewritten deps
  //    list is byte-identical apart from the added method.
  const hm = src.match(/setInputText:([\w$]+)\}\),\[([^\]]*)\]/);
  if (!hm) {
    return { src, changed: false, note: "composer handle anchor not found" };
  }
  if (src.split(hm[0]).length - 1 !== 1) {
    return { src, changed: false, note: "composer handle anchor not unique" };
  }
  const sit = hm[1],
    deps = hm[2];

  // 2. Register the window shim at the top of the at-mention effect. Capture the
  //    parent's forwardRef to the composer (its `.current` is the imperative handle
  //    carrying wtSubmit) from the effect body's `<ref>.current?.focus()` branch.
  const em = src.match(
    /let [\w$]+=[\w$]+\.atMentionEvents\.add\(\([\w$]+\)=>\{if\([\w$]+\.permissionRequests\.value\.length>0\)/
  );
  if (!em) {
    return { src, changed: false, note: "at-mention effect anchor not found" };
  }
  if (src.split(em[0]).length - 1 !== 1) {
    return { src, changed: false, note: "at-mention effect anchor not unique" };
  }
  const rm = src.match(
    /\.permissionRequests\.value\.length>0\)\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}else if\(([\w$]+)\.current\?\.focus\(\)/
  );
  if (!rm) {
    return { src, changed: false, note: "composer forwardRef not located" };
  }
  const fref = rm[1];

  // 3. Dispatcher — handle wt_submit_prompt next to insert_at_mention. This anchor
  //    has stayed literal across versions, so it's matched verbatim.
  const dispatchAnchor =
    'case"insert_at_mention":if(this.isVisible.value)this.atMentionEvents.emit(e.request.text);break;';
  if (src.split(dispatchAnchor).length - 1 !== 1) {
    return { src, changed: false, note: "dispatcher anchor not found/unique" };
  }

  let out = src.replace(
    hm[0],
    // Set the composer text once (DOM), then submit. Calling an insert fn as well
    // INSERTS a second copy (it's an insert-at-cursor, not a replace), which
    // produced doubled messages like "promptprompt" — so it's intentionally gone.
    // Returns TRUE only when the composer DOM ref is mounted and the submit was
    // invoked; FALSE when it isn't (e.g. the ref is transiently null while React
    // remounts the composer between hops). The dispatcher uses this to keep the
    // host retries alive until the submit actually lands (see below).
    `setInputText:${sit},wtSubmit:(wtx)=>{try{if(!${ref}.current)return!1;${ref}.current.textContent=wtx;${submit}(void 0);return!0}catch(__we){return!1}}}),[${deps}]`
  );
  out = out.replace(
    em[0],
    `try{window.__wtSubmit=(wtx)=>{try{return ${fref}.current?${fref}.current.wtSubmit(wtx):!1}catch(__we){return!1}}}catch(__we){}` +
      em[0]
  );
  out = out.replace(
    dispatchAnchor,
    dispatchAnchor +
      // Dedupe by a SET of consumed nonces (not a single "last" nonce): a hop's
      // host-side retry interval keeps resending its own nonce for a while, and
      // several hops overlap — a single last-nonce marker let two nonces ping-pong
      // and resubmit forever. CRITICAL: mark the nonce consumed ONLY when the submit
      // actually lands (__wtSubmit returns true). Marking it on the first dispatch
      // regardless of success defeated the host's 15s retry loop — if that first
      // dispatch arrived while the composer was momentarily unmounted (as it is
      // right after the previous hop's turn ends), the prompt was silently dropped
      // and every retry was deduped away. That was the "2nd agent's prompt never
      // injected, marble orbits forever" bug. Now the retries keep trying until the
      // composer is mounted and the submit takes, then exactly-once still holds.
      'case"wt_submit_prompt":try{if(typeof window!=="undefined"&&window.__wtSubmit){(window.__wtSeen=window.__wtSeen||{});if(!window.__wtSeen[e.request.nonce]&&window.__wtSubmit(e.request.text)===!0){window.__wtSeen[e.request.nonce]=1}}}catch(__we){}break;'
  );
  return { src: out, changed: true };
}

/**
 * Background-agent tracking (webview/index.js). A background subagent runs AFTER
 * the main turn returns its result, and Claude wipes `subagentTasks` on that
 * result — so during the agent's wait there's no live entry and the tab falls
 * back to the completion check. To hold the spinner across that gap, mirror each
 * local-agent task id into `this.__wtBgTasks` (a Map id→startTime on the session)
 * that is NOT cleared on result, and drop it when the task's completion
 * notification arrives. `__wtSend` (see applyWebviewStatus) counts this map into
 * its background-work flag, and each hook pokes an immediate resend so the status
 * flips without waiting for a reactive tick. A 10-minute age-prune (in __wtSend)
 * guards against a missed completion pinning the spinner forever.
 * Best-effort: a missing anchor returns {changed:false,note} and never blocks the
 * rest of the patch.
 */
function applyBgTaskTracking(src: string): { src: string; changed: boolean; note?: string } {
  if (src.includes(BGTASK_MARKER)) {
    return { src, changed: false, note: "already applied" };
  }
  // 1. handleTaskStarted: mirror the started task id into our durable map.
  const addAnchor = 'status:"running"}),this.subagentTasks.value=i';
  if (src.split(addAnchor).length - 1 !== 1) {
    return { src, changed: false, note: "handleTaskStarted anchor not found/unique" };
  }
  // 2. handleTaskNotification: on completion, drop it and refresh the status.
  const delAnchor = 'handleTaskNotification(e){if(!("task_id"in e))return;';
  if (src.split(delAnchor).length - 1 !== 1) {
    return { src, changed: false, note: "handleTaskNotification anchor not found/unique" };
  }
  let out = src.replace(
    addAnchor,
    addAnchor +
      ',(this.__wtBgTasks||(this.__wtBgTasks=new Map)).set(t.task_id,Date.now()),' +
      '(typeof window!=="undefined"&&window.__wtSend&&window.__wtSend())'
  );
  out = out.replace(
    delAnchor,
    delAnchor +
      'try{if(this.__wtBgTasks&&this.__wtBgTasks.delete(e.task_id)&&' +
      'typeof window!=="undefined"&&window.__wtSend)window.__wtSend()}catch(__e){}'
  );
  return { src: out, changed: true };
}

/**
 * The BODY of the planned-phase parser, as injected JS — everything between
 * `function(pfx){try{` and its `catch`. It is a constant of its own because it is
 * injected TWICE into two different bundles: into webview/index.js as
 * `W.__wtWfPlan` (WF_HELPERS, below) and into extension.js as the stream capture's
 * `PLAN` (WF_STREAM_FN). Both must parse the table of contents identically — a
 * strip that disagrees with itself depending on which capture point won would be
 * indistinguishable from a parser bug — so they share the bytes rather than each
 * carrying a copy that can drift.
 *
 * It parses the planned phase titles out of the script's `meta` table of contents.
 * workflowProgress.ts's `parsePlannedPhases` owns the host-side, unit-tested
 * definition of this parse; this copy exists only because injected bundle code
 * cannot import from our extension, and it is a TRANSLITERATION of that function
 * rather than a second guess at the problem — the conformance tests at the end of
 * workflowProgress.test.ts eval this very string (through both of its injection
 * sites) and hold them to the same 17-script corpus and the same edge cases. An
 * earlier regex-plus-candidate-loop version drifted from the reference in three
 * ways that all showed up as a silently wrong table of contents: a prefix cut
 * mid-`phases` yielded nothing at all, a decorative `phases:[{title:…}]` inside
 * meta's own `description` string shadowed the real array, and `subtitle:` counted
 * as a title (a phantom pending square for the whole run). Hence the shape below:
 * the scan is bounded to the `phases:[…]` array by a quote-aware bracket counter
 * (spec risk #6), keys are matched only on an identifier boundary, and an unmatched
 * bracket means "scan to the end of what we were given".
 *
 * Contract: reads `pfx` (the first 4096 chars of the script), returns a string
 * array, declares only its own locals, and touches nothing else — so it can be
 * dropped into any function body in either bundle.
 */
const WF_PLAN_BODY =
  // The five primitives the reference parse is built from: is-quote, skip-string
  // (92 is a backslash, so skip whatever it escapes — an escaped quote must not
  // end the literal), slice-bracketed, skip-whitespace, and is-bare-key. Locals
  // rather than shared upvalues so this function stands alone; it runs once per
  // run, at task_started, so five closures cost nothing.
  "var IQ=function(c){return c==='\"'||c===\"'\"||c===\"\\x60\"};" +
  "var SK=function(s,i){var q=s.charAt(i);for(var j=i+1;j<s.length;j++){" +
  "if(s.charCodeAt(j)===92)j++;else if(s.charAt(j)===q)return j+1}return s.length};" +
  // Interior of the bracket pair opening at `o`, to its match or — the prompt is
  // a 4096-char CUT of the script, so this happens for real — to the end of what
  // we were given. Only the one pair is counted, and string literals are skipped
  // so a bracket inside a title can't throw the count.
  'var SB=function(s,o){var oc=s.charAt(o),cc=oc==="["?"]":"}",d=0,c;' +
  "for(var i=o;i<s.length;i++){c=s.charAt(i);" +
  "if(IQ(c))i=SK(s,i)-1;else if(c===oc)d++;else if(c===cc&&--d===0)return s.slice(o+1,i)}" +
  "return s.slice(o+1)};" +
  "var NS=function(s,i){while(i<s.length&&/\\s/.test(s.charAt(i)))i++;return i};" +
  "var KY=function(s,i,k){return s.slice(i,i+k.length)===k&&" +
  "(i===0||!/[A-Za-z0-9_$]/.test(s.charAt(i-1)))};" +
  'var mi=pfx.indexOf("export const meta");if(mi<0)return[];' +
  'var bo=pfx.indexOf("{",mi);if(bo<0)return[];' +
  // `phases` as a KEY of meta, looked for outside string literals: a decorative
  // `phases:[{title:"…"}]` in meta's own `description` is not the table of
  // contents, and must not be able to shadow the real one.
  "var bd=SB(pfx,bo),ar=-1,c,x,q;" +
  "for(x=0;x<bd.length;x++){c=bd.charAt(x);" +
  "if(IQ(c)){x=SK(bd,x)-1;continue}" +
  'if(c!=="p"||!KY(bd,x,"phases"))continue;' +
  'var co=NS(bd,x+6);if(bd.charAt(co)!==":")continue;' +
  'var br=NS(bd,co+1);if(bd.charAt(br)==="["){ar=br;break}}' +
  "if(ar<0)return[];" +
  // Same discipline for `title`, which is why `subtitle:` is not one. A
  // non-literal title (a variable, a template with substitutions) is skipped
  // rather than guessed at — we render what we can prove.
  "var ab=SB(bd,ar),out=[],t;" +
  "for(x=0;x<ab.length&&out.length<32;x++){c=ab.charAt(x);" +
  "if(IQ(c)){x=SK(ab,x)-1;continue}" +
  'if(c!=="t"||!KY(ab,x,"title"))continue;' +
  'var tc=NS(ab,x+5);if(ab.charAt(tc)!==":")continue;' +
  "var op=NS(ab,tc+1);q=ab.charAt(op);" +
  "if(!IQ(q)){x=tc;continue}" +
  // Unterminated: the prefix was cut mid-title, so nothing usable follows.
  "var en=SK(ab,op);if(ab.charAt(en-1)!==q)break;" +
  't=ab.slice(op+1,en-1).replace(/\\\\(.)/g,function(m,e){' +
  'return e==="n"?"\\n":e==="t"?"\\t":e==="r"?"\\r":e});' +
  "out.push(t.length>40?t.slice(0,40):t);x=en-1}" +
  "return out";

/**
 * The two window-scoped helpers the WEBVIEW-side dynamic-workflow capture depends
 * on, as a statement block that installs them once. It's emitted INSIDE each hook's
 * IIFE (where `W` is the window alias), not at file scope, because the dispatcher
 * anchors we hook are expression positions inside an if/else chain — a block
 * statement there would leave a stray `;` before the next `else` and break the
 * bundle.
 *
 * Installed from BOTH the task_started and the task_progress hook rather than
 * once: a webview reloaded mid-run never sees that run's task_started, so
 * task_progress has to be able to bootstrap on its own. The duplicated bytes are
 * irrelevant against a 4.8 MB bundle; a missing helper would silently cost the
 * whole feature.
 *
 * This whole path is now a FALLBACK. The capture that the feature actually runs on
 * lives in extension.js (WF_STREAM_FN / applyWfStreamCapture): it reads the same
 * messages out of the CLI stream loop in the extension host, where there is no wire
 * to squeeze a projection onto and no webview to depend on. These hooks are kept
 * because they cost nothing and would still help if they ever start landing, but
 * `getTabs()` prefers the stream entry and nothing depends on this one.
 *
 *   W.__wtWfPlan(prefix) → the planned phase titles (see WF_PLAN_BODY, whose bytes
 *     this shares with the extension.js capture). Parsed webview-side rather than
 *     shipping the 4 KB script prefix to the host, because the projection travels
 *     on rename_tab, which fires on every status change.
 *
 *   W.__wtWfProj(map) → { sig, wf }: the compact projection of the MOST RECENTLY
 *     UPDATED run (concurrent workflows in one session are keyed by task id and
 *     only the freshest is shown — spec risk #11), plus a cheap signature over
 *     it. `sig` is what makes this path cheap: the poke discipline and the
 *     omit-when-unchanged in applyWebviewStatus both key off it. Fields are
 *     truncated (label 40, lastToolName 24, resultPreview/activity 120) and capped
 *     (32 phases, 64 agents) so a runaway pipeline() fan-out can't inflate the
 *     channel (spec risk #10). It also prunes the map, but NEVER by age off a
 *     terminal run: spec §2 keeps the most recent run on screen for the rest of
 *     the session, and a 10-minute age prune erased a completed strip mid-session
 *     on the next unrelated tick. Only a run still claiming to be `running` after
 *     10 quiet minutes is dropped (it emits a heartbeat at least every 10s, so
 *     that one is genuinely stuck), and a terminal run that is no longer the
 *     freshest is dropped because nothing can ever render it again — which bounds
 *     the map by count instead of by clock.
 */
const WF_HELPERS =
  "if(W&&!W.__wtWfProj){" +
  "W.__wtWfPlan=function(pfx){try{" +
  WF_PLAN_BODY +
  "}catch(__e){return[]}};" +
  "W.__wtWfProj=function(mp){try{" +
  "var TR=function(s,n){if(s==null)return void 0;s=String(s);return s.length>n?s.slice(0,n):s};" +
  'if(!mp||!mp.size)return{sig:"-",wf:null};' +
  "var now=Date.now(),bs=null,bid=null;" +
  // Age-prune ONLY a run that still claims to be running: it heartbeats at least
  // every 10s, so ten quiet minutes means it is stuck and will never terminate.
  // A terminal run is kept — it is the "most recent run" §2 says to show, and
  // dropping it here sent an explicit `wf:null` that erased a completed strip
  // mid-session, on whatever unrelated tick happened to come next.
  'mp.forEach(function(en,id){if(en.status==="running"&&now-en.ts>6e5){mp.delete(id);return}' +
  "if(!bs||en.ts>bs.ts){bs=en;bid=id}});" +
  'if(!bs)return{sig:"-",wf:null};' +
  // Only the freshest run is ever rendered, so a terminal run that is no longer
  // the freshest can never be seen again. Dropping it bounds the map by COUNT —
  // at most the current run plus whatever is genuinely still in flight — instead
  // of letting one ~1 KB entry per run accumulate for the webview's lifetime.
  'mp.forEach(function(en,id){if(id!==bid&&en.status!=="running")mp.delete(id)});' +
  "var pg=bs.progress||[],ph=[],ag=[],it;" +
  "for(var x=0;x<pg.length;x++){it=pg[x];if(!it)continue;" +
  'if(it.type==="workflow_phase"){if(ph.length<32)ph.push({i:it.index,T:TR(it.title,40)})}' +
  'else if(it.type==="workflow_agent"){if(ag.length<64)ag.push({i:it.index,p:it.phaseIndex,' +
  "l:TR(it.label,40),st:it.state,tn:TR(it.lastToolName,24),c:it.cached?1:void 0," +
  // startedAt/durationMs ride along so the UI can show elapsed time for a live
  // agent without inventing its own clock (spec §3.1 WfAgent, §3.4 accordion).
  "r:TR(it.resultPreview,120),sa:it.startedAt,dm:it.durationMs})}}" +
  // The signature deliberately covers only what the strip renders — which agents
  // exist and what state they're in, how many phases there are, and the run's
  // own identity/status. Token counts, tool names and the activity line move
  // constantly and are NOT in it, so heartbeats don't earn a resend.
  'var sg=bid+"|"+bs.status+"|"+ph.length;' +
  'for(var y=0;y<ag.length;y++)sg+="|"+ag[y].i+ag[y].st;' +
  // The name is truncated like every other string on the wire. It was the one
  // that wasn't, and it is attacker-shaped by accident: `meta.name` is whatever
  // the script's author wrote, so an untruncated `n` put an unbounded string on a
  // channel whose entire cost story is "everything is capped" (risk #10). 40 is
  // MAX_LABEL — the chevron tooltip is the only place it is shown.
  "return{sig:sg,wf:{t:bid,n:TR(bs.name,40),s:bs.status,d:TR(bs.activity,120)," +
  "P:bs.planned||[],p:ph,a:ag}}" +
  '}catch(__e){return{sig:"-",wf:null}}}}';

/**
 * `window.__wtEnrich()` — the payload the `rename_tab` SENDER fills itself with.
 *
 * This is the fix for the defect that kept the whole feature off-screen: the live
 * caller reaches the sender through a dynamically-invoked 3-argument wrapper, so
 * every field beyond the vanilla four was `undefined` and JSON.stringify dropped it
 * (see applyWebviewStatus's header for the measurement that proves it). The sender
 * cannot ask its caller for the data, so it asks here instead.
 *
 * Installed from the dispatcher hooks below because THIS is where the session is in
 * scope — the hooks receive it as `self`, and it owns every signal the payload needs
 * (permissionRequests, busy, subagentTasks, __wtBgTasks, __wtWf). The session is
 * re-captured on EVERY hook entry (`W.__wtEnrichSess`, refreshed outside the
 * install guard) so a session swap on this tab can never leave the enricher reading
 * a dead object; the function itself is installed once.
 *
 * Returns `{s,bg,wf}`, each field OPTIONAL — an absent key means "sender, keep your
 * own default", which is how "no enricher" and "nothing new to say" both degrade to
 * exactly the pre-patch payload:
 *
 *  - `s`  — same status vocabulary and precedence as __wtSend (plan > question >
 *           permission > working > idle). No "done": the extension side owns that.
 *  - `bg` — live subagents plus the __wtBgTasks mirror, with the same 10-minute
 *           age-prune __wtSend does (a missed completion must not pin the spinner).
 *  - `wf` — the compact projection, and ONLY when it has something new to say. Both
 *           gates are the existing ones, reusing the same window-scoped state
 *           (__wtWfSig / __wtWfBody / __wtWfBodyTs) rather than a second copy of the
 *           discipline: the signature earns a send, and a content change behind a
 *           2 s floor lets heartbeat detail (tool names, the activity line) ride a
 *           tick that was going out anyway. `undefined` = "unchanged, keep what you
 *           have"; an explicit `null` (empty map) = "no workflow".
 */
const WF_ENRICH =
  "if(W){W.__wtEnrichSess=self;if(!W.__wtEnrich){W.__wtEnrich=function(){var o={};try{" +
  "var n=W.__wtEnrichSess;if(!n)return o;" +
  "var r=(n.permissionRequests&&n.permissionRequests.value)||[]," +
  "tn=r.length?(r[0].toolName||(r[0].request&&r[0].request.toolName)):null," +
  "bz=(n.busy&&n.busy.value)||!1," +
  "sa=(n.subagentTasks&&n.subagentTasks.value&&n.subagentTasks.value.size)||0;" +
  "try{if(n.__wtBgTasks){var bn=Date.now();n.__wtBgTasks.forEach(function(ts,id){" +
  "if(bn-ts>6e5)n.__wtBgTasks.delete(id);else sa++})}}catch(__e1){}" +
  'o.s=tn==="ExitPlanMode"?"plan":tn==="AskUserQuestion"?"question":r.length?"permission":bz?"working":"idle";' +
  "o.bg=sa>0;" +
  "try{var j=(n.__wtWf&&W.__wtWfProj)?W.__wtWfProj(n.__wtWf):null;" +
  'if(j){var bd=j.wf?JSON.stringify(j.wf):"",nw=Date.now();' +
  "if(j.sig!==W.__wtWfSig||(bd!==W.__wtWfBody&&nw-(W.__wtWfBodyTs||0)>=2000)){" +
  "W.__wtWfSig=j.sig;W.__wtWfBody=bd;W.__wtWfBodyTs=nw;o.wf=j.wf;}}" +
  "}catch(__e3){}" +
  // As in applyWebviewStatus: `o.wf` absent means "unchanged, keep what you have",
  // and nothing rides that field in place of a projection. The hook-liveness counters
  // that used to be attached here are gone with the hooks' liveness settled.
  "}catch(__e5){}return o}}}";

/**
 * Dynamic-workflow tracking (webview/index.js). The `Workflow` tool's live
 * progress registry IS broadcast to the webview — `task_progress` carries the
 * whole `workflow_progress` array — but the webview throws it away:
 * `handleTaskStarted` bails on `task_type!=="local_agent"`, so a workflow task is
 * never registered, so `handleTaskProgress`'s `if(!i)return` drops every update
 * on the floor. (The pre-existing __wtBgTasks mirror sits *after* that same bail,
 * which is why it has never seen a workflow either.)
 *
 * So all three hooks go on the DISPATCHER — `if(e.subtype==="task_…")this.handleX(e)`
 * — which runs before any of those filters, as a comma expression so no block
 * restructuring is needed (the same idiom as applyStateStash in extension.js).
 * They maintain `this.__wtWf`, a Map taskId → {name,planned,progress,status,
 * activity,ts} on the session, next to __wtBgTasks.
 *
 * These hooks are ALSO where `window.__wtEnrich` is installed (WF_ENRICH), because
 * the dispatcher's `this` is the one object that owns every signal the rename_tab
 * payload needs. That is what actually gets the projection onto the wire: the
 * sender enriches itself from here, instead of depending on a caller to pass extra
 * arguments — which the live caller has never done. See applyWebviewStatus.
 *
 * The one rule that must not be got wrong: `workflow_progress` is ABSENT, not
 * empty, on a throttled tick. The CLI attaches the array on every state
 * transition but at most once per 10s for runs of pure "progress" heartbeats, so
 * `en.progress = ev.workflow_progress` unconditionally would blank the strip
 * every 10 seconds — silently and intermittently (spec risk #1). Absent means
 * "no change": update the activity line and the timestamp, keep the array.
 *
 * Poke discipline (spec risk #2): progress batches coalesce at 16 ms, so poking
 * `__wtSend()` per batch would flood the rename_tab channel. We poke only when
 * the projection's signature changes — a handful of times per run — behind a
 * 500 ms floor; pure heartbeats ride the next natural reactive tick.
 *
 * That gate is deliberately measured against the hook's OWN last-poked signature
 * (`self.__wtWfPoked`) and not only against the published one (`__wtWfSig`, which
 * only __wtSend advances). Gating on the published signature alone closed the loop
 * through the consumer: whenever __wtSend cannot publish this run's projection —
 * the workflow is on a session that is not the active one, so __wtSend's captured
 * session has no __wtWf; or __wtSend predates the wf payload entirely (a stale
 * bundle whose tab-status patch reads "already applied" while this one applies) —
 * the signature never moves, the gate stays open, and every subsequent heartbeat
 * pokes. Measured at ~2 rename_tab messages/second for the whole run, i.e. tens of
 * thousands of round-trips on a long one: risk #2's flood, re-entering by the back
 * door. Latching what we poked FOR caps an unpublishable signature at one attempt
 * instead of one per tick, and leaves the healthy path byte-for-byte unchanged
 * (one poke per real transition — the publish then advances both).
 *
 * Best-effort: any anchor miss returns {changed:false,note} and the feature
 * degrades to nothing (no chevron, no strip), like every other webview patch.
 */
function applyWfTracking(src: string): { src: string; changed: boolean; note?: string } {
  if (src.includes(WFTASK_MARKER)) {
    return { src, changed: false, note: "already applied" };
  }
  // Each anchor is `<guard>this.handleX(e)`; the guard is kept verbatim in the
  // replacement and only the call is turned into `<hook>,this.handleX(e)`.
  const guard = (sub: string) => 'else if(e.type==="system"&&e.subtype==="' + sub + '")';
  const startedGuard = guard("task_started");
  const progressGuard = guard("task_progress");
  const notifyGuard = guard("task_notification");
  const startedAnchor = startedGuard + "this.handleTaskStarted(e)";
  const progressAnchor = progressGuard + "this.handleTaskProgress(e)";
  const notifyAnchor = notifyGuard + "this.handleTaskNotification(e)";
  // Verify all three up front, against the untouched source: a partial hook set
  // is worse than none (a map that fills but never terminates, or terminates but
  // never fills), so we bail before writing anything if any one is off.
  for (const [name, anchor] of [
    ["task_started", startedAnchor],
    ["task_progress", progressAnchor],
    ["task_notification", notifyAnchor],
  ] as const) {
    if (src.split(anchor).length - 1 !== 1) {
      return { src, changed: false, note: `${name} dispatch anchor not found/unique` };
    }
  }

  // `W` is the window alias every hook shares — the helpers, the signature cache
  // (__wtWfSig, owned by __wtSend) and the poke floor (__wtWfPokeTs) all live
  // there because they're per-webview, not per-session. The one piece of poke
  // state that is NOT on the window is __wtWfPoked: it belongs to the session
  // whose map produced the signature, so two sessions each running a workflow
  // still get one poke per transition each instead of taking turns re-opening
  // each other's gate.
  const head = 'var W=(typeof window!=="undefined")?window:null;';

  // task_started — the only place the script source is ever seen. We keep the
  // workflow's name and parse the meta TOC out of the FIRST 4096 CHARS of the
  // prompt (the CLI sets `prompt` to the whole script; `meta` is required by the
  // Workflow contract to be the first statement, and is inside 4 KB on all 17
  // corpus scripts). The prefix itself is never retained — only the titles.
  const startedHook =
    startedGuard +
    WFTASK_MARKER +
    "(function(self,ev){try{" +
    head +
    WF_HELPERS +
    // Installed BEFORE the local_workflow bail: the enricher carries the tab's
    // status and background flag for every session, not just ones running a
    // workflow, so any task dispatch at all must be enough to bring it up.
    WF_ENRICH +
    'if(!ev||ev.task_type!=="local_workflow"||!ev.task_id)return;' +
    "var mp=self.__wtWf||(self.__wtWf=new Map);" +
    'mp.set(ev.task_id,{name:ev.workflow_name||ev.description||"workflow",' +
    'planned:(W&&W.__wtWfPlan)?W.__wtWfPlan(String(ev.prompt||"").slice(0,4096)):[],' +
    'progress:[],status:"running",activity:ev.description||"",ts:Date.now()});' +
    // A new run is a guaranteed signature change and happens once, so poke
    // immediately: the chevron should appear the moment the workflow starts.
    "if(W){W.__wtWfPokeTs=Date.now();if(W.__wtSend)W.__wtSend()}" +
    "}catch(__e){}})(this,e)," +
    "this.handleTaskStarted(e)";

  const progressHook =
    progressGuard +
    "(function(self,ev){try{" +
    head +
    WF_HELPERS +
    WF_ENRICH +
    // Risk #3 (does task_progress reach the webview at all, given the CLI's
    // `!isInteractive`/`replBridgeActive` gates?) was settled empirically under
    // Cursor; the one-shot console.log that settled it is gone.
    "var mp=self.__wtWf;if(!mp||!ev||!ev.task_id)return;var en=mp.get(ev.task_id);if(!en)return;" +
    // description is "PhaseTitle: label" on a workflow tick — a live activity line
    // that keeps arriving even when the array itself is throttled away.
    "if(ev.description)en.activity=ev.description;" +
    // THE throttle-vs-absent rule (risk #1). Present → the CLI shipped a freshly
    // merged, whole array; replace wholesale (it upserts by `${type}:${index}`
    // before broadcasting, so there is nothing for us to merge). Absent → this was
    // a throttled heartbeat, NOT an empty run; keep the previous array.
    "if(ev.workflow_progress)en.progress=ev.workflow_progress;" +
    "en.ts=Date.now();" +
    // TWO signatures, and the poke needs BOTH to disagree. __wtWfSig is what the
    // channel last carried (advanced only by __wtSend, which may be unable to
    // publish this session's run at all); __wtWfPoked is what this hook last
    // ASKED for. Without the second, an unpublishable signature leaves the gate
    // permanently open and every heartbeat past the floor pokes — risk #2's flood
    // by way of the consumer. The latch is set inside the floor branch, so a poke
    // the floor suppressed is still owed and will be made on a later tick.
    "if(!W)return;var pj=W.__wtWfProj&&W.__wtWfProj(mp);" +
    "if(pj&&pj.sig!==W.__wtWfSig&&pj.sig!==self.__wtWfPoked){var nw=Date.now();" +
    "if(!W.__wtWfPokeTs||nw-W.__wtWfPokeTs>=500){W.__wtWfPokeTs=nw;self.__wtWfPoked=pj.sig;" +
    "if(W.__wtSend)W.__wtSend()}}" +
    "}catch(__e){}})(this,e)," +
    "this.handleTaskProgress(e)";

  // task_notification is the terminal signal (status "completed"|"failed"|
  // "stopped"). Marking the run terminal here is what stops the active-phase pulse
  // when the last agent's state never gets a closing task_progress (spec risk
  // #12); a killed run reads as failed, since it didn't finish. Always pokes —
  // it's once per run, and it's the update the user is waiting to see.
  const notifyHook =
    notifyGuard +
    "(function(self,ev){try{" +
    head +
    // No WF_HELPERS here (this hook never bootstraps a run), but the enricher still
    // goes in: it reads W.__wtWfProj lazily, so a notification-first webview installs
    // it now and the first task_started/task_progress supplies the helpers.
    WF_ENRICH +
    "var mp=self.__wtWf;if(!mp||!ev||!ev.task_id)return;var en=mp.get(ev.task_id);if(!en)return;" +
    'en.status=ev.status==="completed"?"completed":"failed";en.ts=Date.now();' +
    "if(W){W.__wtWfPokeTs=Date.now();if(W.__wtSend)W.__wtSend()}" +
    "}catch(__e){}})(this,e)," +
    "this.handleTaskNotification(e)";

  let out = src.replace(startedAnchor, startedHook);
  out = out.replace(progressAnchor, progressHook);
  out = out.replace(notifyAnchor, notifyHook);
  return { src: out, changed: true };
}

/**
 * The dynamic-workflow capture, as it runs in the EXTENSION HOST (extension.js).
 *
 * WHY THIS EXISTS AT ALL — the webview capture above is data-correct (replaying real
 * captured messages through it yields a correct projection) but its delivery path is
 * not: the `rename_tab` sender is reached by a dynamically-invoked 3-argument
 * wrapper, so for the whole time the feature shipped, the projection never left the
 * webview. The stream loop hooked here is upstream of all of that. It is the loop
 * that consumes EVERY message the CLI emits on a channel, it runs in our own
 * process, and `globalThis` here is the very object `getTabs()` reads. So there is
 * no wire, no serialization, no enrichment, no webview: the capture writes the full
 * typed shape into `globalThis.__wtClaude.wfBySession` and getTabs picks it up.
 *
 * SHAPE. `wfBySession[session_id] = {taskId,name,planned,progress,status,activity,ts}`
 * where `progress` is Claude's own `workflow_progress` array, untouched and
 * untruncated — there is nothing to pay for keeping it whole here, and the host-side
 * parse (`parseWfStreamEntry`) applies the display caps once, on read.
 *
 * Keyed by `session_id` rather than by task id because that is the key the CONSUMER
 * has: `getTabs()` already resolves each panel's Claude session uuid out of Claude's
 * own `sessionPanels` map, so `wfBySession[sid]` is a direct lookup with nothing to
 * correlate. One entry per session means the most recent run wins, which is exactly
 * spec §2 ("current / most recent run only") and spec risk #11.
 *
 * THE FOUR RULES THAT MUST NOT BE GOT WRONG:
 *
 *  1. `task_progress` REPLACES `progress` only when `workflow_progress` is present.
 *     The CLI attaches the array on every state transition but at most once per 10 s
 *     for a batch of pure `progress` heartbeats, so assigning it unconditionally
 *     blanks the strip every ten seconds — silently and intermittently (spec risk
 *     #1). Absent means "no change": only `activity` and `ts` move.
 *  2. Progress and notification are gated on `en.taskId === m.task_id`. This is not
 *     defensive tidiness: a session runs OTHER tasks (`local_bash`, `local_agent`)
 *     whose `task_notification` arrives on the same session id, and the real captured
 *     stream contains exactly that — a `local_bash` task completing mid-workflow.
 *     Without the gate, that notification marks the WORKFLOW completed and the
 *     spinner stops while agents are still running.
 *  3. `task_notification` is what marks a run terminal. A killed or aborted run's
 *     last word is the notification, not a closing progress array, so without this
 *     the active phase pulses forever (spec risk #12). Anything that isn't
 *     "completed" reads as failed — it did not finish.
 *  4. Age-prune ONLY an entry still claiming to be `running` after 10 quiet minutes
 *     (it heartbeats at least every 10 s, so that one is genuinely stuck). A
 *     terminal run is KEPT: spec §2 shows the most recent run for the rest of the
 *     session, and pruning it by age erased a completed strip mid-session.
 *
 * POKE DISCIPLINE (spec risk #2): progress batches coalesce at 16 ms in the CLI, so
 * poking the host repaint per message would flood it. We poke only when the run's
 * SIGNATURE changes — which agents exist, what state each is in, how many phases,
 * the run's identity and status — behind a 500 ms floor. Heartbeats (a moving tool
 * name, a moving token count) never poke; they ride the next repaint, of which there
 * are plenty (the 1.5 s poll, every session-state change, every rename_tab). The
 * latched signature lives on the ENTRY, so two sessions each running a workflow get
 * one poke per transition each instead of cancelling each other's gate.
 *
 * CANNOT THROW INTO CLAUDE'S STREAM LOOP. The injection is a comma expression in
 * front of the loop's existing `this.send(...)`, wrapped in its own try/catch, and
 * it declares its own single parameter — so a hostile message (missing session_id,
 * `workflow_progress` a non-array, `prompt` undefined, a frozen object) costs us the
 * capture for that message and nothing else. The bridge_state branch `continue`s
 * before reaching us, so its control flow is untouched.
 *
 * Defined here, after WF_PLAN_BODY, because it embeds it (a `const` cannot be read
 * above its declaration), even though it patches extension.js.
 */
const WF_STREAM_FN =
  "(function(__wtm){" +
  WFSTREAM_MARKER +
  "try{" +
  "var G=globalThis.__wtClaude=globalThis.__wtClaude||{};" +
  // Installed once, lazily, on the first message through the loop: the closure holds
  // the parser and the small helpers so the per-message cost is one property read
  // and one call. `G` is captured, and it is the same object getTabs() hangs off.
  "if(!G.__wtWfCap)G.__wtWfCap=(function(){" +
  "var PLAN=function(pfx){try{" +
  WF_PLAN_BODY +
  "}catch(__e){return[]}};" +
  // The signature covers ONLY what a square can show. Tool names, token counts and
  // the activity line move constantly and are deliberately absent, so a heartbeat
  // produces the same signature and earns no poke.
  'var SIG=function(en){var s=en.taskId+"|"+en.status,p=en.progress||[],np=0,i,it;' +
  "for(i=0;i<p.length;i++){it=p[i];if(!it)continue;" +
  'if(it.type==="workflow_phase")np++;' +
  'else if(it.type==="workflow_agent")s+="|"+it.index+it.state}' +
  'return s+"|"+np};' +
  // `force` is for the two once-per-run events (a run starting, a run ending): the
  // user is waiting to see exactly those, and they cannot repeat. Everything else
  // must clear both gates. The latch is set only when we actually poke, so a poke
  // the floor suppressed is still OWED and happens on a later tick.
  "var POKE=function(en,force){try{var sg=SIG(en);" +
  "if(!force&&sg===en.psig)return;" +
  "var nw=Date.now();" +
  "if(!force&&G.__wtWfPokeTs&&nw-G.__wtWfPokeTs<500)return;" +
  "en.psig=sg;G.__wtWfPokeTs=nw;" +
  'if(typeof G.notify==="function")G.notify()}catch(__e){}};' +
  // Housekeeping, throttled to once a minute because it runs off the message path.
  // Rule 4 above governs WHAT may be dropped; the count cap is what keeps the map
  // from holding one entry per session that ever ran a workflow for the whole life
  // of the extension host (each `progress` array is a few KB), and it only ever
  // evicts TERMINAL entries, oldest first.
  "var PRUNE=function(mp,now){try{" +
  "if(G.__wtWfPruneTs&&now-G.__wtWfPruneTs<6e4)return;G.__wtWfPruneTs=now;" +
  "var ks=Object.keys(mp),live=[],i,k,en;" +
  "for(i=0;i<ks.length;i++){k=ks[i];en=mp[k];" +
  'if(!en||typeof en!=="object"){delete mp[k];continue}' +
  'if(en.status==="running"&&now-en.ts>6e5){delete mp[k];continue}' +
  "live.push(k)}" +
  "if(live.length>32){live.sort(function(a,b){return (mp[a].ts||0)-(mp[b].ts||0)});" +
  'for(i=0;i<live.length-32;i++)if(mp[live[i]].status!=="running")delete mp[live[i]]}' +
  "}catch(__e){}};" +
  // The suppression predicate the "no checkmarks mid-process" fix reads (see
  // applyStatusStash / applyStateStash). Exposed here rather than re-derived there
  // because those hooks hold a session id and nothing else, and because a bundle
  // where THIS patch missed must fall back cleanly: absent function → old behaviour.
  // The staleness bound is the same 10 minutes rule 4 prunes on, so a stuck entry
  // cannot pin the spinner for the rest of the session.
  "G.wfRunningFor=function(sid){try{var mp=G.wfBySession,en=(mp&&sid)?mp[sid]:null;" +
  'return !!(en&&en.status==="running"&&Date.now()-en.ts<6e5)}catch(__e){return!1}};' +
  "return function(m){" +
  // Only the three task subtypes matter; everything else (assistant deltas, hooks,
  // results — the overwhelming majority) leaves after two comparisons.
  'if(!m||m.type!=="system")return;' +
  "var sb=m.subtype;" +
  'if(sb!=="task_started"&&sb!=="task_progress"&&sb!=="task_notification")return;' +
  // No session id → nothing we could ever attribute to a tab. No task id → nothing
  // we could match to a run. Both are always present in practice; neither is assumed.
  "var sid=m.session_id,tid=m.task_id;" +
  'if(typeof sid!=="string"||!sid||typeof tid!=="string"||!tid)return;' +
  // Object.create(null): the keys are session uuids, and a prototype-less map means
  // no lookup can ever return an inherited function instead of an entry.
  "var mp=G.wfBySession||(G.wfBySession=Object.create(null));" +
  "var now=Date.now(),en;" +
  'if(sb==="task_started"){' +
  // The ONLY place the script source is ever seen — the TOC is parsed out of the
  // first 4096 chars (`meta` is required to be the script's first statement, and is
  // inside 4 KB on all 17 corpus scripts) and the prefix itself is never retained.
  'if(m.task_type!=="local_workflow")return;' +
  "en={taskId:tid," +
  'name:(typeof m.workflow_name==="string"&&m.workflow_name)||(typeof m.description==="string"&&m.description)||"workflow",' +
  'planned:PLAN(String(m.prompt==null?"":m.prompt).slice(0,4096)),' +
  'progress:[],status:"running",' +
  'activity:(typeof m.description==="string"?m.description:""),ts:now};' +
  "mp[sid]=en;PRUNE(mp,now);POKE(en,1);return}" +
  // Rule 2: an entry only accepts updates for the task it IS. Another task's
  // notification on this session must not terminate this run.
  "en=mp[sid];if(!en||en.taskId!==tid)return;" +
  'if(sb==="task_progress"){' +
  'if(typeof m.description==="string"&&m.description)en.activity=m.description;' +
  // Rule 1. Array.isArray, not truthiness: absent means "keep what you have", and a
  // present-but-not-an-array value says nothing a strip could render, so replacing
  // the good array with it would be the same silent blanking by another route.
  "if(Array.isArray(m.workflow_progress))en.progress=m.workflow_progress;" +
  "en.ts=now;PRUNE(mp,now);POKE(en,0);return}" +
  // Rule 3.
  'en.status=m.status==="completed"?"completed":"failed";en.ts=now;' +
  "PRUNE(mp,now);POKE(en,1)}})();" +
  "G.__wtWfCap(__wtm)}catch(__e){}" +
  WFSTREAM_MARKER +
  "})";

/**
 * Hook the CLI stream loop in extension.js and hand every message to WF_STREAM_FN.
 *
 * The anchor is the loop body's own `this.send({type:"io_message"...})` — the single
 * point every message on every channel passes through on its way to the webview:
 *
 *   for await(let g of f){ if(g.type==="system"&&g.subtype==="bridge_state"){…continue}
 *     this.send({type:"io_message",channelId:e,message:g,done:!1}), X_e(g) }
 *
 * Verified unique in the 2.1.220 bundle. Both the loop header and the send are
 * matched, and the message variable must be THE SAME identifier in both, so this
 * cannot latch onto some unrelated `io_message` send that happens to survive
 * re-minification: we only inject where we can prove we are in that loop.
 *
 * The injection is a comma expression prepended to the send, so the statement stays
 * one expression statement, the loop's control flow (including the bridge_state
 * `continue` above it) is untouched, and every message is still forwarded exactly
 * once — the capture runs BEFORE the send, and cannot prevent it.
 *
 * Extension.js-side helper, so it THROWS a human-readable Error on a bad anchor
 * (the neighbouring idiom); the pipeline catches it and reports the step as failed,
 * and the feature degrades to nothing per spec §2.
 */
function applyWfStreamCapture(src: string): string {
  // The loop header proves the context: `for await(let <m> of <it>){if(<m>.type===
  // "system"&&<m>.subtype==="bridge_state"){`.
  const loopRe =
    /for await\(let ([\w$]+) of [\w$]+\)\{if\(\1\.type==="system"&&\1\.subtype==="bridge_state"\)\{/g;
  const loops = [...src.matchAll(loopRe)];
  if (loops.length !== 1) {
    throw new Error(
      `CLI stream loop anchor ${loops.length === 0 ? "not found" : "not unique"} (Claude bundle reshaped?)`
    );
  }
  const sendRe =
    /this\.send\(\{type:"io_message",channelId:[\w$]+,message:([\w$]+),done:!1\}\)/g;
  const sends = [...src.matchAll(sendRe)];
  if (sends.length !== 1) {
    throw new Error(
      `io_message send anchor ${sends.length === 0 ? "not found" : "not unique"} (Claude bundle reshaped?)`
    );
  }
  const msgVar = loops[0][1];
  if (sends[0][1] !== msgVar) {
    throw new Error(
      `io_message send carries "${sends[0][1]}" but the stream loop iterates "${msgVar}" (Claude bundle reshaped?)`
    );
  }
  return src.replace(sends[0][0], WF_STREAM_FN + "(" + msgVar + ")," + sends[0][0]);
}

// --- public actions --------------------------------------------------------

function backupOnce(file: string): void {
  const bak = file + ".bak";
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(file, bak);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function offerRestart(message: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    message,
    "Restart Extension Host"
  );
  if (choice === "Restart Extension Host") {
    await vscode.commands.executeCommand("workbench.action.restartExtensionHost");
  }
}

/** Apply both patches to the active Claude bundle. Idempotent and safe to
 *  re-run; aborts without writing if the extension.js anchors changed. */
async function patchClaude(): Promise<void> {
  const bundle = claudeBundle();
  if (!bundle) {
    toast("Andrey's Helper: Claude Code extension is not installed.", "warning");
    return;
  }

  let extSrc: string;
  try {
    extSrc = fs.readFileSync(bundle.extensionJs, "utf8");
  } catch (err) {
    toast(`Andrey's Helper: can't read the Claude bundle — ${errMessage(err)}`, "error");
    return;
  }

  // Self-heal a STALE patch: the bundle is patched, but with an older version of
  // our injected code (per-feature markers stay present when a patch's internals
  // change, so re-running "Patch" would otherwise skip the updated logic). Restore
  // the pristine .bak for both files, then patch the clean source below — so a
  // single "Patch" always upgrades to the current PATCH_VERSION.
  if (extSrc.includes(MARKER) && !extSrc.includes(PATCH_VERSION_MARKER)) {
    let restored = true;
    for (const file of [bundle.extensionJs, bundle.webviewJs]) {
      const bak = file + ".bak";
      if (fs.existsSync(bak)) {
        try {
          fs.copyFileSync(bak, file);
        } catch {
          restored = false;
        }
      } else {
        restored = false;
      }
    }
    if (restored) {
      try {
        extSrc = fs.readFileSync(bundle.extensionJs, "utf8");
      } catch (err) {
        toast(`Andrey's Helper: can't read the Claude bundle — ${errMessage(err)}`, "error");
        return;
      }
    } else {
      toast(
        "Andrey's Helper: an older patch is installed but its backup is missing, so it can't be cleanly upgraded. Run Unpatch, then Patch.",
        "warning"
      );
    }
  }

  // Nothing to do only when EVERY patch is already present. If worktree tabs are
  // patched but the newer status/rename patches aren't (an upgrade), fall through
  // and apply the missing ones.
  const fullyPatched =
    extSrc.includes(MARKER) &&
    extSrc.includes(PATCH_VERSION_MARKER) &&
    extSrc.includes(PANELID_MARKER) &&
    extSrc.includes(STATUS_STASH_MARKER) &&
    extSrc.includes(STATE_STASH_MARKER) &&
    extSrc.includes(INTERRUPT_STASH_MARKER) &&
    extSrc.includes(RENAME_COMMAND) &&
    extSrc.includes(SUBMIT_COMMAND) &&
    extSrc.includes(INTERRUPT_COMMAND) &&
    extSrc.includes(PROMPT_EXT_MARKER) &&
    extSrc.includes(ENVTAG_MARKER);

  // extension.js — the openWorktree patch is required; a missing anchor there
  // aborts the whole operation. Status/rename anchors degrade to a warning.
  let patchedExt: string;
  let extSteps: PatchStep[];
  try {
    const res = patchExtensionJs(extSrc);
    patchedExt = res.src;
    extSteps = res.steps;
  } catch (err) {
    toast(
      `Andrey's Helper: patch aborted (nothing written) — ${errMessage(err)}. Claude may have updated; the patch needs re-deriving.`,
      "error"
    );
    return;
  }

  // webview — both edits are best-effort; a miss here is non-fatal.
  let webviewSrc: string | undefined;
  let webviewChanged = false;
  const webviewSteps: PatchStep[] = [];
  try {
    let raw = fs.readFileSync(bundle.webviewJs, "utf8");
    const sel = patchWebviewJs(raw);
    if (sel.changed) {
      raw = sel.src;
      webviewChanged = true;
    }
    webviewSteps.push({
      name: "auto-include-file default off",
      ok: sel.changed || sel.note === "already off",
      note: sel.note,
    });
    const st = applyWebviewStatus(raw);
    if (st.changed) {
      raw = st.src;
      webviewChanged = true;
    }
    webviewSteps.push({
      name: "tab status",
      ok: st.changed || st.note === "already applied",
      note: st.note,
    });
    const pi = applyPromptInjectWebview(raw);
    if (pi.changed) {
      raw = pi.src;
      webviewChanged = true;
    }
    webviewSteps.push({
      name: "prompt injection",
      ok: pi.changed || pi.note === "already applied",
      note: pi.note,
    });
    const bg = applyBgTaskTracking(raw);
    if (bg.changed) {
      raw = bg.src;
      webviewChanged = true;
    }
    webviewSteps.push({
      name: "background-agent tracking",
      ok: bg.changed || bg.note === "already applied",
      note: bg.note,
    });
    const wf = applyWfTracking(raw);
    if (wf.changed) {
      raw = wf.src;
      webviewChanged = true;
    }
    webviewSteps.push({
      name: "workflow progress tracking",
      ok: wf.changed || wf.note === "already applied",
      note: wf.note,
    });
    webviewSrc = raw;
  } catch (err) {
    webviewSteps.push({ name: "webview", ok: false, note: `not read (${errMessage(err)})` });
  }

  if (fullyPatched && !webviewChanged) {
    toast("Andrey's Helper: Claude Code is already fully patched.");
    return;
  }

  try {
    backupOnce(bundle.extensionJs);
    fs.writeFileSync(bundle.extensionJs, patchedExt);
    if (webviewChanged && webviewSrc !== undefined) {
      backupOnce(bundle.webviewJs);
      fs.writeFileSync(bundle.webviewJs, webviewSrc);
    }
  } catch (err) {
    toast(`Andrey's Helper: failed to write patched bundle — ${errMessage(err)}`, "error");
    return;
  }
  refreshClaudePatchStatus();

  // Surface partial application: the tab-status / rename features silently no-op
  // when their anchors don't match, so tell the user rather than let them wonder.
  const failed = [...extSteps, ...webviewSteps].filter((s) => !s.ok);
  if (failed.length > 0) {
    const which = failed.map((s) => `“${s.name}”`).join(", ");
    await offerRestart(
      `Andrey's Helper: Claude Code partially patched — ${which} could not be applied to this Claude version ` +
        `(${bundle.version ?? "unknown"}); those features will be unavailable. This usually means Claude Code updated and ` +
        `the patch needs re-deriving — try installing an earlier Claude Code extension version. Restart the extension host to apply what did patch.`
    );
    return;
  }

  await offerRestart(
    "Andrey's Helper: Claude Code patched — worktree tabs, tab status, and external rename enabled. Restart the extension host to apply."
  );
}

/** Revert both files to their pre-patch backups. */
async function unpatchClaude(): Promise<void> {
  const bundle = claudeBundle();
  if (!bundle) {
    toast("Andrey's Helper: Claude Code extension is not installed.", "warning");
    return;
  }

  let restored = 0;
  let failed: string | undefined;
  for (const file of [bundle.extensionJs, bundle.webviewJs]) {
    const bak = file + ".bak";
    if (fs.existsSync(bak)) {
      try {
        fs.copyFileSync(bak, file);
        restored++;
      } catch (err) {
        failed = errMessage(err);
      }
    }
  }

  if (failed) {
    toast(`Andrey's Helper: failed to restore the Claude bundle — ${failed}`, "error");
    return;
  }
  if (restored === 0) {
    toast(
      "Andrey's Helper: no backup found to restore — Claude Code was never patched by this extension (or the backups were removed).",
      "warning"
    );
    return;
  }
  refreshClaudePatchStatus();
  await offerRestart(
    "Andrey's Helper: Claude Code restored to its unpatched state. Restart the extension host to apply."
  );
}

/**
 * On startup: keep the Claude patch current, and nudge to patch if it's missing.
 *
 *  - Already patched with the CURRENT PATCH_VERSION → nothing to do.
 *  - Patched but with an OLDER stamp (this extension updated, but the Claude
 *    bundle still carries a prior patch) → silently self-heal to the current
 *    logic and offer a restart. This is the key ergonomic fix: a re-patch is
 *    never something the user has to remember after updating the extension —
 *    otherwise they'd keep testing stale patch code without realizing.
 *  - Not patched at all → the existing suppressible nudge.
 */
async function maybeOfferPatchOnStartup(
  context: vscode.ExtensionContext
): Promise<void> {
  if (!isClaudeInstalled()) {
    return;
  }
  if (isClaudePatched()) {
    // Patched — is the stamp current? If not, auto-upgrade to this build's logic.
    const bundle = claudeBundle();
    let current = true;
    try {
      current =
        !bundle ||
        fs.readFileSync(bundle.extensionJs, "utf8").includes(PATCH_VERSION_MARKER);
    } catch {
      current = true; // can't read → don't churn
    }
    if (!current) {
      // patchClaude() self-heals a stale bundle (restore .bak → re-apply) and
      // offers a restart to load the refreshed patch.
      await patchClaude();
    }
    return;
  }
  const SUPPRESS_KEY = "andreysHelper.suppressPatchPrompt";
  if (context.globalState.get<boolean>(SUPPRESS_KEY)) {
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    "Andrey's Helper: Claude Code isn't fully patched yet — patching enables worktree-scoped tabs, per-branch tab status, external tab rename, and the auto-include-file fix. You can patch/unpatch anytime under Settings → Andrey's Helper → “Claude Code Patch”.",
    "Patch Now",
    "Not Now",
    "Don't Ask Again"
  );
  if (choice === "Patch Now") {
    await patchClaude();
  } else if (choice === "Don't Ask Again") {
    await context.globalState.update(SUPPRESS_KEY, true);
  }
}

// --- patch status scan + viewer -------------------------------------------

/** One scanned sub-patch: what it enables and whether it's present on disk. */
interface PatchCheck {
  file: "extension.js" | "webview/index.js";
  name: string;
  detail: string;
  active: boolean;
  note?: string;
}
interface PatchScan {
  installed: boolean;
  claudeVersion?: string;
  versionCurrent: boolean;
  checks: PatchCheck[];
}

/**
 * Inspect the on-disk Claude bundle and report, per sub-patch, whether its
 * marker is present — the same markers the patcher writes and gates on. Read
 * fresh each call so it always reflects the current bundle (post patch/unpatch).
 */
function scanPatchStatus(): PatchScan {
  const bundle = claudeBundle();
  if (!bundle) {
    return { installed: false, versionCurrent: false, checks: [] };
  }
  let ext = "";
  let web = "";
  try {
    ext = fs.readFileSync(bundle.extensionJs, "utf8");
  } catch {
    /* leave empty → all extension checks read inactive */
  }
  try {
    web = fs.readFileSync(bundle.webviewJs, "utf8");
  } catch {
    /* leave empty → all webview checks read inactive */
  }
  const has = (src: string, marker: string) => src.length > 0 && src.includes(marker);

  const checks: PatchCheck[] = [
    {
      file: "extension.js",
      name: "Worktree-scoped tabs",
      detail: "Open a Claude tab pinned to a specific worktree's working directory.",
      active: has(ext, MARKER),
    },
    {
      file: "extension.js",
      name: "Stable per-tab id",
      detail: "A durable key for each tab so status, rename, focus and prompt delivery target the right one.",
      active: has(ext, PANELID_MARKER),
    },
    {
      file: "extension.js",
      name: "Rich tab status",
      detail: "Publishes plan / question / permission / done / working per tab — drives the Source+ status icons and the completion check.",
      active: has(ext, STATUS_STASH_MARKER),
    },
    {
      file: "extension.js",
      name: "Live running/idle status",
      detail: "Reliable busy signal read from Claude's own session-state channel.",
      active: has(ext, STATE_STASH_MARKER),
    },
    {
      file: "extension.js",
      name: "Interrupt suppression",
      detail: "An Escape interrupt (or /clear session swap) doesn't leave a completion check.",
      active: has(ext, INTERRUPT_STASH_MARKER),
    },
    {
      file: "extension.js",
      name: "Tab list + external rename",
      detail: "The getTabs() bridge that lists open tabs, plus renaming a Claude tab from Source+ (persists across reloads).",
      active: has(ext, RENAME_COMMAND),
    },
    {
      file: "extension.js",
      name: "Focus / reveal tab",
      detail: "Clicking a Source+ session box focuses its Claude tab by id.",
      active: has(ext, REVEAL_COMMAND),
    },
    {
      file: "extension.js",
      name: "Prompt submit command",
      detail: "Hand a prompt to a running session (Keep Your Marbles pass-around).",
      active: has(ext, SUBMIT_COMMAND),
    },
    {
      file: "extension.js",
      name: "Interrupt tab command",
      detail: "Interrupt (Esc-equivalent) a running session by tab id — the AndreysOrchestrator stop verb.",
      active: has(ext, INTERRUPT_COMMAND),
    },
    {
      file: "extension.js",
      name: "Prompt scheduler",
      detail: "Deliver a queued prompt when a new session mounts.",
      active: has(ext, PROMPT_EXT_MARKER),
    },
    {
      file: "webview/index.js",
      name: "Webview status + interaction signal",
      detail: "Reports each tab's status and signals a real key/click (or an Escape interrupt) so the completion check clears when — and only when — you interact.",
      active: has(web, WEBVIEW_STATUS_MARKER),
    },
    {
      file: "webview/index.js",
      name: "Composer submit handle",
      detail: "Lets the host set the composer text and submit it.",
      active: has(web, PROMPT_WEBVIEW_HANDLE_MARKER),
    },
    {
      file: "webview/index.js",
      name: "Submit shim registration",
      detail: "Exposes the submit function to the host bridge.",
      active: has(web, PROMPT_WEBVIEW_REG_MARKER),
    },
    {
      file: "webview/index.js",
      name: "Prompt dispatcher",
      detail: "Receives host submit requests, deduped so a prompt is sent exactly once.",
      active: has(web, PROMPT_WEBVIEW_DISPATCH_MARKER),
    },
    {
      file: "webview/index.js",
      name: "Background-agent tracking",
      detail: "Keeps the Source+ spinner while a background subagent is still running, even after the main turn has finished.",
      active: has(web, BGTASK_MARKER),
    },
    {
      file: "webview/index.js",
      // applyWfTracking is best-effort: if a Claude release reshapes the task_*
      // dispatch, it declines and the strip/chevron simply never appear. The
      // patch-time toast is a one-shot, so without this row the panel would
      // report a fully-patched, up-to-date bundle while the feature is missing.
      name: "Dynamic-workflow progress",
      detail:
        "Captures the Workflow tool's live phase/agent progress so the Source+ session box can show the chevron, phase strip and accordion.",
      active: has(web, WFTASK_MARKER),
    },
  ];

  // Auto-include-file default OFF is detected dynamically (the toggle's local
  // names vary per bundle), so re-run the real patcher and read its verdict:
  // "already off" means it's active; anything else means it isn't applied.
  let incActive = false;
  let incNote: string | undefined;
  try {
    const r = patchWebviewJs(web);
    incActive = !r.changed && r.note === "already off";
    incNote = web.length === 0 ? "webview not read" : r.note;
  } catch (err) {
    incNote = errMessage(err);
  }
  checks.push({
    file: "webview/index.js",
    name: "Auto-include-file default OFF",
    detail: "Stops the current file being auto-attached to every message (opt-in still available).",
    active: incActive,
    note: incNote,
  });

  return {
    installed: true,
    claudeVersion: bundle.version,
    versionCurrent: has(ext, PATCH_VERSION_MARKER),
    checks,
  };
}

let statusPanel: vscode.WebviewPanel | undefined;

function nonce(): string {
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 24; i++) {
    s += c[Math.floor(Math.random() * c.length)];
  }
  return s;
}

/**
 * Open (or reveal) the Claude Code Patch control panel — a scripted webview with
 * the overall status, Patch / Unpatch / Restart buttons, a live version dropdown
 * (marking the installed one) with an Update button, a persistent result line,
 * and the per-sub-patch ✓/✗ checklist. Native VS Code settings can't render live
 * dropdowns, buttons, or status, so this panel is the control surface; Settings
 * just links here.
 */
function showClaudePatchStatus(): void {
  if (!statusPanel) {
    statusPanel = vscode.window.createWebviewPanel(
      "andreysHelper.claudePatchStatus",
      "Claude Code Patch",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    statusPanel.onDidDispose(() => {
      statusPanel = undefined;
    });
    statusPanel.webview.onDidReceiveMessage((m) => void onPanelMessage(m));
    statusPanel.webview.html = renderPanelHtml();
    // The webview requests its initial scan + versions once its script loads
    // (avoids a post-before-listener race).
  } else {
    statusPanel.reveal();
    postScan();
    void postVersions();
  }
}

/** Push a fresh scan (status banner + checklist) to the open panel. */
function refreshClaudePatchStatus(): void {
  postScan();
}

function postScan(): void {
  if (!statusPanel) {
    return;
  }
  const scan = scanPatchStatus();
  void statusPanel.webview.postMessage({
    type: "scan",
    banner: bannerHtml(scan),
    checks: checksHtml(scan),
  });
}

/** Fetch the version list from Open VSX and push it to the panel's dropdown. */
async function postVersions(): Promise<void> {
  if (!statusPanel) {
    return;
  }
  const installed = claudeBundle()?.version ?? null;
  void statusPanel.webview.postMessage({ type: "versionsLoading", installed });
  try {
    const info = await fetchVersions();
    void statusPanel?.webview.postMessage({
      type: "versions",
      latest: info.latest,
      versions: info.versions,
      installed,
    });
  } catch (err) {
    void statusPanel?.webview.postMessage({
      type: "versionsError",
      message: errMessage(err),
    });
  }
}

async function onPanelMessage(m: any): Promise<void> {
  if (!m || typeof m.cmd !== "string") {
    return;
  }
  switch (m.cmd) {
    case "ready":
      postScan();
      void postVersions();
      break;
    case "refresh":
      postScan();
      void postVersions();
      break;
    case "patch":
      await patchClaude();
      break;
    case "unpatch":
      await unpatchClaude();
      break;
    case "restart":
      await vscode.commands.executeCommand("workbench.action.restartExtensionHost");
      break;
    case "update":
      await panelUpdate(String(m.version || ""));
      break;
  }
}

/** Drive an update from the panel, streaming progress and a persistent result. */
async function panelUpdate(version: string): Promise<void> {
  if (!statusPanel || !version) {
    return;
  }
  const installed = claudeBundle()?.version;
  void statusPanel.webview.postMessage({ type: "updateBusy", busy: true });
  let result: UpdateResult;
  try {
    result = await performUpdate(version, installed, (message) =>
      statusPanel?.webview.postMessage({ type: "updateProgress", message })
    );
  } catch (err) {
    result = { ok: false, message: errMessage(err) };
  }
  void statusPanel?.webview.postMessage({ type: "updateBusy", busy: false });
  void statusPanel?.webview.postMessage({
    type: "updateResult",
    ok: result.ok,
    message: result.message,
  });
  postScan();
  void postVersions();
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

/** The status banner + one-line summary (Claude version, patch stamp). */
function bannerHtml(scan: PatchScan): string {
  if (!scan.installed) {
    return '<div class="banner warn">Claude Code isn\'t installed — nothing to scan.</div>';
  }
  const total = scan.checks.length;
  const active = scan.checks.filter((c) => c.active).length;
  const full = active === total && scan.versionCurrent;
  const cls = full ? "ok" : active === 0 ? "warn" : "part";
  const label = full
    ? "Fully patched"
    : active === 0
      ? "Not patched"
      : `Partially patched — ${active}/${total} features`;
  const ver = scan.versionCurrent
    ? '<span class="mk ok">✓</span> up to date'
    : '<span class="mk no">✗</span> a newer patch is available — click Patch / Repair';
  return (
    `<div class="banner ${cls}">${esc(label)}</div>` +
    `<div class="sub">Claude Code ${esc(scan.claudeVersion || "unknown")} · patch stamp: ${ver}</div>`
  );
}

/** The grouped per-sub-patch ✓/✗ checklist. */
function checksHtml(scan: PatchScan): string {
  if (!scan.installed) {
    return "";
  }
  const row = (c: PatchCheck): string => {
    const mark = c.active
      ? '<span class="mk ok">✓</span>'
      : '<span class="mk no">✗</span>';
    const note = c.note && !c.active ? `<div class="note">${esc(c.note)}</div>` : "";
    return (
      `<div class="chk ${c.active ? "on" : "off"}">${mark}` +
      `<div class="body"><div class="name">${esc(c.name)}</div>` +
      `<div class="detail">${esc(c.detail)}</div>${note}</div></div>`
    );
  };
  const group = (file: string): string => {
    const items = scan.checks.filter((c) => c.file === file).map(row).join("");
    return `<div class="grp"><div class="ghd">${esc(file)}</div>${items}</div>`;
  };
  return group("extension.js") + group("webview/index.js");
}

/** The scripted control-panel shell. Status/checklist/versions are filled in via
 *  postMessage once the script sends "ready" (see onPanelMessage). */
function renderPanelHtml(): string {
  const n = nonce();
  const script =
    "const vscode=acquireVsCodeApi();" +
    "function $(id){return document.getElementById(id);}" +
    "function send(cmd,extra){var o={cmd:cmd};if(extra)for(var k in extra)o[k]=extra[k];vscode.postMessage(o);}" +
    "function setResult(ok,msg){var r=$('update-status');var pre=ok===true?'✓ ':ok===false?'✗ ':'';r.textContent=msg?pre+msg:'';r.className='result'+(ok===true?' ok':ok===false?' err':'');}" +
    "function fillVersions(m){var sel=$('version');sel.disabled=false;sel.innerHTML='';" +
    "function opt(val,label){var o=document.createElement('option');o.value=val;o.textContent=label;return o;}" +
    "sel.appendChild(opt(m.latest,'Latest — '+m.latest+(m.latest===m.installed?' (installed)':'')));" +
    "var list=m.versions||[];for(var i=0;i<list.length;i++){var v=list[i];var label=v;if(v===m.installed)label+=' — installed';else if(v===m.latest)label+=' — latest';sel.appendChild(opt(v,label));}" +
    "sel.value=(m.installed&&list.indexOf(m.installed)>=0)?m.installed:m.latest;}" +
    "$('btn-patch').addEventListener('click',function(){send('patch');});" +
    "$('btn-unpatch').addEventListener('click',function(){send('unpatch');});" +
    "$('btn-refresh').addEventListener('click',function(){send('refresh');});" +
    "$('btn-restart').addEventListener('click',function(){send('restart');});" +
    "$('btn-restart2').addEventListener('click',function(){send('restart');});" +
    "$('btn-update').addEventListener('click',function(){var v=$('version').value;if(v)send('update',{version:v});});" +
    "window.addEventListener('message',function(e){var m=e.data;if(!m)return;" +
    "if(m.type==='scan'){$('banner-wrap').innerHTML=m.banner;$('checks').innerHTML=m.checks;}" +
    "else if(m.type==='versionsLoading'){var s=$('version');s.disabled=true;s.innerHTML='<option>Loading versions…</option>';}" +
    "else if(m.type==='versions'){fillVersions(m);}" +
    "else if(m.type==='versionsError'){var s2=$('version');s2.disabled=true;s2.innerHTML='<option>Failed to load</option>';setResult(false,'Couldn’t load versions: '+m.message);}" +
    "else if(m.type==='updateBusy'){$('btn-update').disabled=m.busy;$('version').disabled=m.busy;$('btn-update').textContent=m.busy?'Updating…':'Update & Patch';if(m.busy){setResult(null,'');$('restart-row').style.display='none';}}" +
    "else if(m.type==='updateProgress'){setResult(null,m.message);}" +
    "else if(m.type==='updateResult'){setResult(m.ok,m.message);$('restart-row').style.display=m.ok?'flex':'none';}});" +
    "send('ready');";

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    padding: 14px 18px; font-size: 13px; line-height: 1.4; }
  h1 { font-size: 15px; margin: 0 0 12px; font-weight: 600; }
  .banner { display: inline-block; padding: 4px 10px; border-radius: 5px; font-weight: 600; margin-bottom: 6px; }
  .banner.ok { background: rgba(34,197,94,.16); color: #22C55E; }
  .banner.part { background: rgba(217,119,87,.16); color: #D97757; }
  .banner.warn { background: rgba(149,32,32,.18); color: #d86b6b; }
  .sub { opacity: .8; margin-bottom: 14px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 4px 0 18px; }
  button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    border: 1px solid transparent; padding: 5px 12px; border-radius: 4px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px 14px; margin: 0 0 18px; }
  .card h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; opacity: .7; margin: 0 0 10px; font-weight: 600; }
  .uprow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  select { font: inherit; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border); padding: 4px 8px; border-radius: 4px; min-width: 240px; }
  .result { margin-top: 10px; font-size: 12px; min-height: 16px; opacity: .9; }
  .result.ok { color: #22C55E; }
  .result.err { color: #d86b6b; }
  #restart-row { display: none; margin-top: 10px; gap: 8px; align-items: center; }
  #restart-row span { opacity: .8; }
  .grp { margin-bottom: 16px; }
  .ghd { text-transform: uppercase; font-size: 11px; letter-spacing: .05em; opacity: .6;
    margin: 0 0 6px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 3px; }
  .chk { display: flex; gap: 9px; padding: 6px 0; align-items: flex-start; }
  .mk { flex: none; width: 18px; text-align: center; font-weight: 700; }
  .mk.ok { color: #22C55E; }
  .mk.no { color: #952020; }
  .chk.off .name { opacity: .8; }
  .name { font-weight: 600; }
  .detail { opacity: .75; font-size: 12px; }
  .note { opacity: .7; font-size: 11px; font-style: italic; margin-top: 2px; }
  .foot { margin-top: 12px; opacity: .6; font-size: 11px; }
</style></head><body>
<h1>Claude Code Patch</h1>
<div id="banner-wrap"></div>
<div class="actions">
  <button id="btn-patch">Patch / Repair</button>
  <button id="btn-unpatch" class="secondary">Unpatch</button>
  <button id="btn-restart" class="secondary">Restart Extension Host</button>
  <button id="btn-refresh" class="secondary">Re-scan</button>
</div>
<div class="card">
  <h2>Update Claude Code</h2>
  <div class="uprow">
    <select id="version" disabled><option>Loading versions…</option></select>
    <button id="btn-update">Update &amp; Patch</button>
  </div>
  <div id="update-status" class="result"></div>
  <div id="restart-row"><span>Update applied on disk — restart to load it:</span><button id="btn-restart2">Restart Extension Host</button></div>
</div>
<div id="checks"></div>
<div class="foot">Patch, Unpatch, and Update edit the Claude bundle on disk — changes take effect after the extension host restarts.</div>
<script nonce="${n}">${script}</script>
</body></html>`;
}

// --- update the Claude bundle (download + verify + install + patch) --------

/**
 * "Update Claude Code" installs a chosen (or the latest) Claude Code version and
 * re-applies our patch to it — the safe way to move to a new Claude release when
 * you depend on the patched bundle. It NEVER touches the working install until it
 * has proven the new version is patchable:
 *
 *   1. list versions from Open VSX (the registry Cursor installs from);
 *   2. download the target version's vsix (platform-specific when available);
 *   3. dry-run EVERY sub-patch against the vsix's sources in memory — if any fail,
 *      the current install is left untouched and the user is told to try an
 *      earlier version;
 *   4. only then install the pristine vsix and write the (already-computed)
 *      patched files into the freshly-installed folder, backing up the originals.
 */

const OPEN_VSX_API = "https://open-vsx.org/api";
const OPEN_VSX_NS = "anthropic";
const OPEN_VSX_NAME = "claude-code";

/** Map the running platform/arch to a VS Code target-platform string, matching
 *  Open VSX's platform-specific vsix targets (e.g. "darwin-arm64"). */
function targetPlatform(): string {
  const plat =
    process.platform === "win32"
      ? "win32"
      : process.platform === "darwin"
        ? "darwin"
        : "linux";
  const arch =
    process.arch === "arm64"
      ? "arm64"
      : process.arch === "x64"
        ? "x64"
        : process.arch === "arm"
          ? "armhf"
          : process.arch;
  return `${plat}-${arch}`;
}

/** GET a URL following redirects, resolving to the raw body buffer. */
function httpGet(url: string, redirects = 5): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "andreys-helper" } }, (res) => {
      const status = res.statusCode ?? 0;
      const loc = res.headers.location;
      if (status >= 300 && status < 400 && loc && redirects > 0) {
        res.resume();
        resolve(httpGet(new URL(loc, url).toString(), redirects - 1));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => resolve({ status, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error("request timed out")));
  });
}

async function fetchJson(url: string): Promise<any> {
  const r = await httpGet(url);
  if (r.status !== 200) {
    throw new Error(`HTTP ${r.status}`);
  }
  return JSON.parse(r.body.toString("utf8"));
}

interface VersionInfo {
  latest: string;
  versions: string[];
}

/** List available Claude Code versions from Open VSX (newest first). */
async function fetchVersions(): Promise<VersionInfo> {
  const j = await fetchJson(`${OPEN_VSX_API}/${OPEN_VSX_NS}/${OPEN_VSX_NAME}/latest`);
  const versions = Object.keys(j.allVersions ?? {}).filter((v) => v !== "latest");
  return { latest: String(j.version), versions };
}

/** Resolve the vsix download URL for a version, preferring the platform-specific
 *  build and falling back to a universal one. */
async function resolveDownloadUrl(version: string): Promise<string> {
  const tp = targetPlatform();
  try {
    const j = await fetchJson(`${OPEN_VSX_API}/${OPEN_VSX_NS}/${OPEN_VSX_NAME}/${tp}/${version}`);
    if (j.files?.download) {
      return String(j.files.download);
    }
  } catch {
    /* fall through to the universal build */
  }
  const j = await fetchJson(`${OPEN_VSX_API}/${OPEN_VSX_NS}/${OPEN_VSX_NAME}/${version}`);
  if (j.files?.download) {
    return String(j.files.download);
  }
  throw new Error(`no download available for ${version} (${tp})`);
}

/** Read the two patch-target sources out of a vsix (zip) buffer. */
function readVsixSources(buf: Buffer): {
  extSrc: string;
  webSrc: string;
  main: string;
  version?: string;
} {
  const zip = new AdmZip(buf);
  const pkgText = zip.readAsText("extension/package.json");
  if (!pkgText) {
    throw new Error("vsix has no extension/package.json");
  }
  const pkg = JSON.parse(pkgText);
  const main = String(pkg.main || "extension.js").replace(/^\.\//, "");
  const extSrc = zip.readAsText(`extension/${main}`);
  const webSrc = zip.readAsText("extension/webview/index.js");
  if (!extSrc) {
    throw new Error(`vsix has no extension/${main}`);
  }
  if (!webSrc) {
    throw new Error("vsix has no extension/webview/index.js");
  }
  return { extSrc, webSrc, main, version: pkg.version as string | undefined };
}

/** Dry-run every patch against a candidate bundle's sources. `ok` is true only
 *  when ALL sub-patches apply cleanly — the bar for replacing the install. */
interface UpdateVerify {
  ok: boolean;
  steps: PatchStep[];
  patchedExt: string;
  patchedWeb: string;
}
function verifyPatchable(extSrc: string, webSrc: string): UpdateVerify {
  const steps: PatchStep[] = [];
  let patchedExt = extSrc;
  try {
    const r = patchExtensionJs(extSrc);
    patchedExt = r.src;
    steps.push(...r.steps);
  } catch (err) {
    // The required worktree-tabs anchor is missing → not patchable at all.
    steps.push({ name: "worktree tabs", ok: false, note: errMessage(err) });
    return { ok: false, steps, patchedExt: extSrc, patchedWeb: webSrc };
  }
  let patchedWeb = webSrc;
  const sel = patchWebviewJs(patchedWeb);
  if (sel.changed) {
    patchedWeb = sel.src;
  }
  steps.push({
    name: "auto-include-file default off",
    ok: sel.changed || sel.note === "already off",
    note: sel.note,
  });
  const st = applyWebviewStatus(patchedWeb);
  if (st.changed) {
    patchedWeb = st.src;
  }
  steps.push({
    name: "tab status (webview)",
    ok: st.changed || st.note === "already applied",
    note: st.note,
  });
  const pi = applyPromptInjectWebview(patchedWeb);
  if (pi.changed) {
    patchedWeb = pi.src;
  }
  steps.push({
    name: "prompt injection (webview)",
    ok: pi.changed || pi.note === "already applied",
    note: pi.note,
  });
  const bg = applyBgTaskTracking(patchedWeb);
  if (bg.changed) {
    patchedWeb = bg.src;
  }
  steps.push({
    name: "background-agent tracking (webview)",
    ok: bg.changed || bg.note === "already applied",
    note: bg.note,
  });
  const wf = applyWfTracking(patchedWeb);
  if (wf.changed) {
    patchedWeb = wf.src;
  }
  steps.push({
    name: "workflow progress tracking (webview)",
    ok: wf.changed || wf.note === "already applied",
    note: wf.note,
  });
  return { ok: steps.every((s) => s.ok), steps, patchedExt, patchedWeb };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The extensions dir Cursor/VS Code installed Claude into (parent of its root). */
function extensionsDir(): string | undefined {
  const b = claudeBundle();
  return b ? path.dirname(b.root) : undefined;
}

/** After an install, find the freshly-written extension folder for `version`
 *  (platform-suffixed or not). Polls briefly since the install writes async. */
async function locateInstalledDir(version: string): Promise<string | undefined> {
  const dir = extensionsDir();
  if (!dir) {
    return undefined;
  }
  const exact = `${OPEN_VSX_NS}.${OPEN_VSX_NAME}-${version}`;
  for (let i = 0; i < 40; i++) {
    try {
      const found = fs
        .readdirSync(dir)
        .find((n) => n === exact || n.startsWith(`${exact}-`));
      if (found && fs.existsSync(path.join(dir, found, "package.json"))) {
        return path.join(dir, found);
      }
    } catch {
      /* retry */
    }
    await delay(250);
  }
  return undefined;
}

/** Result of an update attempt, surfaced verbatim (and persistently) in the panel. */
interface UpdateResult {
  ok: boolean;
  message: string;
}

/**
 * Core update: resolve → download → verify → install → patch for one version.
 * Reports coarse progress via `report` and returns a persistent result instead of
 * firing a fading toast, so the panel can show success/failure and a restart
 * prompt. Never throws — every failure path returns { ok:false } with a reason.
 */
async function performUpdate(
  target: string,
  installed: string | undefined,
  report: (message: string) => void
): Promise<UpdateResult> {
  if (!isClaudeInstalled()) {
    return { ok: false, message: "Claude Code isn't installed — nothing to update." };
  }

  let url: string;
  try {
    report("Resolving download…");
    url = await resolveDownloadUrl(target);
  } catch (err) {
    return {
      ok: false,
      message: `Version ${target} isn't available on Open VSX (${errMessage(err)}). Try another version.`,
    };
  }

  let buf: Buffer;
  try {
    report("Downloading…");
    const r = await httpGet(url);
    if (r.status !== 200) {
      throw new Error(`HTTP ${r.status}`);
    }
    buf = r.body;
  } catch (err) {
    return { ok: false, message: `Download failed — ${errMessage(err)}.` };
  }

  let sources: ReturnType<typeof readVsixSources>;
  try {
    report("Verifying patches…");
    sources = readVsixSources(buf);
  } catch (err) {
    return { ok: false, message: `The downloaded vsix couldn't be read — ${errMessage(err)}.` };
  }

  const verify = verifyPatchable(sources.extSrc, sources.webSrc);
  if (!verify.ok) {
    const failed = verify.steps
      .filter((s) => !s.ok)
      .map((s) => `“${s.name}”`)
      .join(", ");
    return {
      ok: false,
      message: `Claude Code ${target} isn't supported by the patch — ${failed} couldn't be applied. Nothing was changed; try an earlier version.`,
    };
  }

  // Verified patchable — install the pristine vsix (skip when it's already the
  // installed version), then write the computed patched files into its folder.
  const tmp = path.join(os.tmpdir(), `claude-code-${target}-${process.pid}.vsix`);
  try {
    if (target !== installed) {
      report("Installing…");
      fs.writeFileSync(tmp, buf);
      await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        vscode.Uri.file(tmp)
      );
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return { ok: false, message: `Installing the vsix failed — ${errMessage(err)}.` };
  }

  try {
    report("Patching…");
    const installDir = await locateInstalledDir(target);
    if (!installDir) {
      throw new Error("installed, but the new extension folder wasn't found to patch");
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(installDir, "package.json"), "utf8"));
    const main = String(pkg.main || "extension.js").replace(/^\.\//, "");
    const extFile = path.join(installDir, main);
    const webFile = path.join(installDir, "webview", "index.js");
    backupOnce(extFile);
    fs.writeFileSync(extFile, verify.patchedExt);
    backupOnce(webFile);
    fs.writeFileSync(webFile, verify.patchedWeb);
  } catch (err) {
    return {
      ok: false,
      message: `Claude Code ${target} installed, but patching it failed — ${errMessage(err)}. Reload the window, then run Patch.`,
    };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }

  return {
    ok: true,
    message: `Updated to ${target} and patched. Restart the extension host to apply.`,
  };
}

/** The "Update & Patch Claude Code" command — opens the control panel where the
 *  version dropdown + Update button live. */
function updateClaudeCode(): void {
  showClaudePatchStatus();
}

// --- registration ----------------------------------------------------------

/**
 * Wire up all Claude-patch entry points: the first-launch nudge, and the two
 * commands that open the control panel (Settings links here, and the palette).
 * All Patch / Unpatch / Update / Restart actions live inside that panel now — the
 * old one-shot Settings dropdown was redundant and has been removed.
 */
export function registerClaudePatch(context: vscode.ExtensionContext): void {
  void maybeOfferPatchOnStartup(context);
  context.subscriptions.push(
    vscode.commands.registerCommand("andreysHelper.claudePatchStatus", () =>
      showClaudePatchStatus()
    ),
    vscode.commands.registerCommand("andreysHelper.updateClaudeCode", () =>
      updateClaudeCode()
    )
  );
}
