import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
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
const PATCH_VERSION = "wtpatch-v6";
const PATCH_VERSION_MARKER = "/*" + PATCH_VERSION + "*/";

/** Marker for the rename_tab status-stash injection (extension.js). */
const STATUS_STASH_MARKER = "this.__wtStatus=e.request.wtStatus";
/** Marker for the update_session_state status-stash injection (extension.js). */
const STATE_STASH_MARKER = 'st==="running"?"working"';
/** Command string for renaming a tab by panel id (extension.js). Doubles as the
 *  marker that the commands + getTabs() bridge are present. */
const RENAME_COMMAND = "claude-vscode.editor.renameWorktreeTab";
/** Command string for revealing/focusing a tab by panel id (extension.js). */
const REVEAL_COMMAND = "claude-vscode.editor.revealWorktreeTab";
/** Command string for submitting a prompt into an open tab by panel id (KYM
 *  pass-around: hands the next agent's prompt to a running session). */
const SUBMIT_COMMAND = "claude-vscode.editor.submitPromptToTab";
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
      src.includes(RENAME_COMMAND) &&
      src.includes(SUBMIT_COMMAND) &&
      src.includes(PROMPT_EXT_MARKER)
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
  const stash =
    "}try{this.__wtStatus=e.request.wtStatus||" +
    '(e.request.hasPendingPermissions?"permission":e.request.hasUnseenCompletion?"done":"idle");' +
    'var __wp=globalThis.__wtClaude;if(__wp&&typeof __wp.notify==="function")__wp.notify()}catch(__e){}' +
    'return{type:"rename_tab_response"}';
  return src.replace(anchor, stash);
}

/**
 * Stash live running/idle status from Claude's own `update_session_state` channel
 * (fires on every busy transition — the reliable "working" signal) onto the
 * controller, and poke a repaint. Injected as an IIFE in the handler's
 * comma-return so no block restructuring is needed.
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
    '"update_session_state")return (function(self,st){try{' +
    'self.__wtStatus=st==="running"?"working":st==="waiting_input"?"permission":"idle";' +
    'var __wp=globalThis.__wtClaude;if(__wp&&typeof __wp.notify==="function")__wp.notify()}catch(__e){}})(this,e.request.state),' +
    "this.onSessionStateChanged?.(";
  return src.replace(anchor, iife);
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
  //    resolved exactly (labels are ambiguous: fresh tabs all share a default).
  const bridge =
    "(function(){try{var __wp=globalThis.__wtClaude=globalThis.__wtClaude||{};" +
    "__wp.getTabs=function(){try{var __o=[];var __sm=new Map;" +
    `try{for(const __kv of ${mgr}.sessionPanels)__sm.set(__kv[1],__kv[0])}catch(__e){}` +
    `for(const __c of ${mgr}.allComms){if(__c&&__c.panelTab){` +
    '__o.push({id:__c.__wtId,cwd:__c.cwd,title:__c.panelTab.title,status:__c.__wtStatus||"idle",col:__c.panelTab.viewColumn,' +
    "sessionId:__sm.get(__c.panelTab),active:!!__c.panelTab.active})}}" +
    "return __o}catch(__e){return[]}}}catch(__e){}})();";
  const rename =
    `${subs}.subscriptions.push(${vs}.commands.registerCommand("${RENAME_COMMAND}",async(__id,__nt)=>{` +
    `try{for(const __c of ${mgr}.allComms)if(__c&&__c.__wtId===__id){` +
    `let __sid;for(const __kv of ${mgr}.sessionPanels)if(__kv[1]===__c.panelTab){__sid=__kv[0];break}` +
    "try{if(__sid)await __c.renameSession(__sid,__nt,!1)}catch(__e){}" +
    "try{if(__c.panelTab)__c.panelTab.title=__nt}catch(__e){}return!0}}catch(__e){}return!1})),";
  const reveal =
    `${subs}.subscriptions.push(${vs}.commands.registerCommand("${REVEAL_COMMAND}",(__id)=>{` +
    `try{for(const __c of ${mgr}.allComms)if(__c&&__c.__wtId===__id){if(__c.panelTab&&__c.panelTab.reveal)__c.panelTab.reveal();break}}catch(__e){}})),`;
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
 * pane can show a per-tab status dot. Two edits, both idempotent (gated on
 * WEBVIEW_STATUS_MARKER): widen the `renameTab(...)` sender to forward a 4th arg,
 * and compute that arg at the reactive call site from the active session's
 * pending-permission tool name, busy flag, and unseen-completion flag:
 *   ExitPlanMode → "plan"; AskUserQuestion → "question"; any other pending
 *   request → "permission"; else unseen → "done"; else busy → "working"; else
 *   "idle".
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
    'renameTab(e,t,i,wtS){return this.sendRequest({type:"rename_tab",title:e,hasPendingPermissions:t,hasUnseenCompletion:i,wtStatus:wtS})}'
  );
  out = out.replace(
    callRe,
    "$1var __wr=(n&&n.permissionRequests&&n.permissionRequests.value)||[]," +
      "__wtl=__wr.length?(__wr[0].toolName||(__wr[0].request&&__wr[0].request.toolName)):null," +
      "__wb=(n&&n.busy&&n.busy.value)||!1," +
      '__ws=__wtl==="ExitPlanMode"?"plan":__wtl==="AskUserQuestion"?"question":' +
      '__wr.length?"permission":l?"done":__wb?"working":"idle";' +
      `${react}(()=>${conn}.renameTab(s,a,l,__ws))`
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

  // 1. Composer imperative handle — add wtSubmit next to setInputText.
  const handleAnchor = "setInputText:ne}),[n,Zs,Ve,ne])";
  if (src.split(handleAnchor).length - 1 !== 1) {
    return { src, changed: false, note: "composer handle anchor not found/unique" };
  }
  // 2. Register the window shim at the top of the at-mention effect (ref `a`).
  const regAnchor =
    "let ne=t.atMentionEvents.add((Je)=>{if(e.permissionRequests.value.length>0)";
  if (src.split(regAnchor).length - 1 !== 1) {
    return { src, changed: false, note: "at-mention effect anchor not found/unique" };
  }
  // 3. Dispatcher — handle wt_submit_prompt next to insert_at_mention.
  const dispatchAnchor =
    'case"insert_at_mention":if(this.isVisible.value)this.atMentionEvents.emit(e.request.text);break;';
  if (src.split(dispatchAnchor).length - 1 !== 1) {
    return { src, changed: false, note: "dispatcher anchor not found/unique" };
  }

  let out = src.replace(
    handleAnchor,
    // Set the composer text once (DOM), then submit. Calling Ve(wtx) as well
    // INSERTS a second copy (it's an insert-at-cursor, not a replace), which
    // produced doubled messages like "promptprompt" — so it's intentionally gone.
    "setInputText:ne,wtSubmit:(wtx)=>{try{if(ee.current)ee.current.textContent=wtx;return Je(void 0)}catch(__we){}}}),[n,Zs,Ve,ne])"
  );
  out = out.replace(
    regAnchor,
    "try{window.__wtSubmit=(wtx)=>{try{a.current&&a.current.wtSubmit(wtx)}catch(__we){}}}catch(__we){}" +
      regAnchor
  );
  out = out.replace(
    dispatchAnchor,
    dispatchAnchor +
      // Dedupe by a SET of consumed nonces (not a single "last" nonce): a hop's
      // host-side retry interval keeps resending its own nonce for a while, and
      // several hops overlap — a single last-nonce marker let two nonces ping-pong
      // and resubmit forever. Only submit once the composer is mounted
      // (__wtSubmit) AND this nonce hasn't been submitted before; then remember it.
      'case"wt_submit_prompt":try{if(typeof window!=="undefined"&&window.__wtSubmit){(window.__wtSeen=window.__wtSeen||{});if(!window.__wtSeen[e.request.nonce]){window.__wtSeen[e.request.nonce]=1;window.__wtSubmit(e.request.text)}}}catch(__we){}break;'
  );
  return { src: out, changed: true };
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
    toast("Worktrunk: Claude Code extension is not installed.", "warning");
    return;
  }

  let extSrc: string;
  try {
    extSrc = fs.readFileSync(bundle.extensionJs, "utf8");
  } catch (err) {
    toast(`Worktrunk: can't read the Claude bundle — ${errMessage(err)}`, "error");
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
        toast(`Worktrunk: can't read the Claude bundle — ${errMessage(err)}`, "error");
        return;
      }
    } else {
      toast(
        "Worktrunk: an older patch is installed but its backup is missing, so it can't be cleanly upgraded. Run Unpatch, then Patch.",
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
    extSrc.includes(RENAME_COMMAND) &&
    extSrc.includes(PROMPT_EXT_MARKER);

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
      `Worktrunk: patch aborted (nothing written) — ${errMessage(err)}. Claude may have updated; the patch needs re-deriving.`,
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
    webviewSrc = raw;
  } catch (err) {
    webviewSteps.push({ name: "webview", ok: false, note: `not read (${errMessage(err)})` });
  }

  if (fullyPatched && !webviewChanged) {
    toast("Worktrunk: Claude Code is already fully patched.");
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
    toast(`Worktrunk: failed to write patched bundle — ${errMessage(err)}`, "error");
    return;
  }

  // Surface partial application: the tab-status / rename features silently no-op
  // when their anchors don't match, so tell the user rather than let them wonder.
  const failed = [...extSteps, ...webviewSteps].filter((s) => !s.ok);
  if (failed.length > 0) {
    const which = failed.map((s) => `“${s.name}”`).join(", ");
    await offerRestart(
      `Worktrunk: Claude Code partially patched — ${which} could not be applied to this Claude version ` +
        `(${bundle.version ?? "unknown"}); those features will be unavailable. This usually means Claude Code updated and ` +
        `the patch needs re-deriving — try installing an earlier Claude Code extension version. Restart the extension host to apply what did patch.`
    );
    return;
  }

  await offerRestart(
    "Worktrunk: Claude Code patched — worktree tabs, tab status, and external rename enabled. Restart the extension host to apply."
  );
}

/** Revert both files to their pre-patch backups. */
async function unpatchClaude(): Promise<void> {
  const bundle = claudeBundle();
  if (!bundle) {
    toast("Worktrunk: Claude Code extension is not installed.", "warning");
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
    toast(`Worktrunk: failed to restore the Claude bundle — ${failed}`, "error");
    return;
  }
  if (restored === 0) {
    toast(
      "Worktrunk: no backup found to restore — Claude Code was never patched by this extension (or the backups were removed).",
      "warning"
    );
    return;
  }
  await offerRestart(
    "Worktrunk: Claude Code restored to its unpatched state. Restart the extension host to apply."
  );
}

/**
 * One-time, out-of-the-way nudge: if Claude Code is installed but unpatched,
 * inform the user and offer to patch. Suppressible so it never nags. The
 * durable control lives in Settings (see the `claudeCodePatch` action below).
 */
async function maybeOfferPatchOnStartup(
  context: vscode.ExtensionContext
): Promise<void> {
  if (!isClaudeInstalled() || isClaudePatched()) {
    return;
  }
  const SUPPRESS_KEY = "andreysHelper.suppressPatchPrompt";
  if (context.globalState.get<boolean>(SUPPRESS_KEY)) {
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    "Worktrunk: Claude Code isn't fully patched yet — patching enables worktree-scoped tabs, per-branch tab status, external tab rename, and the auto-include-file fix. You can patch/unpatch anytime under Settings → Andrey's Helper → “Claude Code Patch”.",
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

// --- settings-driven patch/unpatch ----------------------------------------

const PATCH_SECTION = "andreysHelper";
const PATCH_ACTION_KEY = "claudeCodePatch";
const NO_CHANGE = "No change";

/**
 * The `andreysHelper.claudeCodePatch` setting is a one-shot action dropdown
 * ("Patch" / "Unpatch" / "No change"). Selecting Patch or Unpatch runs it, then
 * resets the setting back to "No change" so it reads as an action, not stale
 * state (the real state lives in the Claude bundle). Resetting fires another
 * change event whose value is "No change", which this handler ignores.
 */
function onPatchSettingChanged(
  e: vscode.ConfigurationChangeEvent
): void {
  if (!e.affectsConfiguration(`${PATCH_SECTION}.${PATCH_ACTION_KEY}`)) {
    return;
  }
  const cfg = vscode.workspace.getConfiguration(PATCH_SECTION);
  const action = cfg.get<string>(PATCH_ACTION_KEY, NO_CHANGE);
  if (action === NO_CHANGE) {
    return;
  }
  void (async () => {
    // Reset wherever the value was set, before acting, so it never sticks.
    const insp = cfg.inspect<string>(PATCH_ACTION_KEY);
    if (insp?.globalValue !== undefined && insp.globalValue !== NO_CHANGE) {
      await cfg.update(PATCH_ACTION_KEY, NO_CHANGE, vscode.ConfigurationTarget.Global);
    }
    if (insp?.workspaceValue !== undefined && insp.workspaceValue !== NO_CHANGE) {
      await cfg.update(PATCH_ACTION_KEY, NO_CHANGE, vscode.ConfigurationTarget.Workspace);
    }
    if (action === "Patch") {
      await patchClaude();
    } else if (action === "Unpatch") {
      await unpatchClaude();
    }
  })();
}

/**
 * Wire up all Claude-patch entry points: the first-launch nudge and the
 * Settings action dropdown. Called from activate().
 */
export function registerClaudePatch(context: vscode.ExtensionContext): void {
  void maybeOfferPatchOnStartup(context);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(onPatchSettingChanged)
  );
}
