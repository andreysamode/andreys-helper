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
const PATCH_VERSION = "wtpatch-v16";
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
  // Webview-computed status lands in its OWN field (__wtWeb) so the live
  // session-state stash (__wtLive) can't clobber a just-latched "done" on the
  // busy→idle edge. getTabs() resolves the two.
  const stash =
    "}try{this.__wtWeb=e.request.wtStatus||" +
    '(e.request.hasPendingPermissions?"permission":e.request.hasUnseenCompletion?"done":"idle");' +
    // Release the reliable extension-side completion latch ONLY on an explicit
    // interaction signal (wtSeen) — a real key/click inside the tab. Never on a
    // plain status send, so merely focusing/revealing the tab keeps the check.
    'if(e.request.wtSeen){this.__wtDoneLive=!1;}' +
    // Interrupt (Escape) is not a completion: arm suppression so the abort's
    // running→idle is swallowed, and clear any check showing. Only while a run is
    // active (__wtPrevLive), so an Escape on an idle tab can't poison the next
    // completion. Redundant with the extension-side interrupt_claude hook — either
    // path arms the same window, so it works even if the webview signal is missed.
    'if(e.request.wtInterrupt){this.__wtDoneLive=!1;if(this.__wtPrevLive==="running")this.__wtNoDoneTs=Date.now();}' +
    // Live background-work flag (a running subagent) from the webview — makes the
    // tab read as "working" even when the main loop is idle (see getTabs resolver).
    'this.__wtBg=!!e.request.wtBg;' +
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
 * ALSO latches a focus-independent completion flag (`__wtDoneLive`) on the
 * running→idle falling edge. This is the authoritative "done" signal: the webview
 * can't be trusted to report completion when its tab is focused or visible in a
 * split (its reactive latch only reliably fires while hidden), but this channel
 * fires the same way regardless of which tab has focus. Cleared when a new run
 * starts (running) and, on interaction, by the rename_tab stash. A running→
 * waiting_input edge is an attention state, not a completion, so it's excluded.
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
    'if(self.__wtSid&&sid&&sid!==self.__wtSid){self.__wtNoDoneTs=Date.now();self.__wtDoneLive=!1;}if(sid)self.__wtSid=sid;' +
    'var __ps=self.__wtPrevLive;self.__wtPrevLive=st;' +
    'self.__wtLive=st==="running"?"working":st==="waiting_input"?"permission":"idle";' +
    // Suppression is a single timestamp (__wtNoDoneTs), set by an interrupt or a
    // session swap and consumed by the FIRST running→idle falling edge after it
    // (the abort, or the fresh-session init). Consuming on the first edge — not a
    // boolean cleared on every "running" send — is what makes this robust: a run
    // can re-emit "running" mid-turn without wiping the pending suppression, and a
    // real completion after the suppressed edge latches normally. The window is
    // only a staleness guard.
    'if(st==="running"){self.__wtDoneLive=!1;}else if(__ps==="running"&&st!=="waiting_input"){if(self.__wtNoDoneTs&&Date.now()-self.__wtNoDoneTs<1.5e4){self.__wtNoDoneTs=0;}else{self.__wtDoneLive=!0;}}' +
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
    'case"interrupt_claude":try{if(this.__wtPrevLive==="running"){this.__wtNoDoneTs=Date.now()/*int*/;this.__wtDoneLive=!1;' +
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
  //    resolved exactly (labels are ambiguous: fresh tabs all share a default).
  const bridge =
    "(function(){try{var __wp=globalThis.__wtClaude=globalThis.__wtClaude||{};" +
    "__wp.getTabs=function(){try{var __o=[];var __sm=new Map;" +
    `try{for(const __kv of ${mgr}.sessionPanels)__sm.set(__kv[1],__kv[0])}catch(__e){}` +
    `for(const __c of ${mgr}.allComms){if(__c&&__c.panelTab){` +
    '__o.push({id:__c.__wtId,cwd:__c.cwd,title:__c.panelTab.title,status:(function(__w,__l,__d,__bg){' +
    // __l (update_session_state) and __d (its running→idle latch) are extension-
    // side and focus-independent — trust them for working/done. __w (webview) only
    // refines the attention flavor (plan vs question) and is ignored for "working"
    // once the reliable signals say idle/done (it can go stale while hidden).
    'if(__l==="working"||(__w==="working"&&__l!=="idle"&&!__d))return "working";' +
    'if(__w==="plan"||__w==="question")return __w;' +
    'if(__w==="permission"||__l==="permission")return "permission";' +
    // A live subagent (__bg) means the tab is still working even though the main
    // loop went idle — show the spinner, not the completion check. Ranked after the
    // attention states (which need the user) but before done/idle.
    'if(__bg)return "working";' +
    // "Done" is owned solely by the extension-side latch (__d/__wtDoneLive) — the
    // webview no longer reports done, so its status can't desync from the check.
    'if(__d)return "done";' +
    'return __l||__w||"idle"})(__c.__wtWeb,__c.__wtLive,__c.__wtDoneLive,__c.__wtBg),col:__c.panelTab.viewColumn,' +
    "sessionId:__sm.get(__c.panelTab),active:!!__c.panelTab.active})}}" +
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
    `try{for(const __c of ${mgr}.allComms)if(__c&&__c.__wtId===__id){if(__c.panelTab&&__c.panelTab.reveal)__c.panelTab.reveal();__c.__wtDoneLive=!1;var __wp=globalThis.__wtClaude;if(__wp&&typeof __wp.notify==="function")__wp.notify();break}}catch(__e){}})),`;
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
    'renameTab(e,t,i,wtS,wtSe,wtI,wtBg){return this.sendRequest({type:"rename_tab",title:e,hasPendingPermissions:t,hasUnseenCompletion:i,wtStatus:wtS,wtSeen:wtSe,wtInterrupt:wtI,wtBg:wtBg})}'
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
      `window.__wtSend=function(seen,intr){var __r=(n&&n.permissionRequests&&n.permissionRequests.value)||[],__t=__r.length?(__r[0].toolName||(__r[0].request&&__r[0].request.toolName)):null,__b=(n&&n.busy&&n.busy.value)||!1,__sa=(n&&n.subagentTasks&&n.subagentTasks.value&&n.subagentTasks.value.size)||0;try{if(n&&n.__wtBgTasks){var __bn=Date.now();n.__wtBgTasks.forEach(function(ts,id){if(__bn-ts>6e5)n.__wtBgTasks.delete(id);else __sa++})}}catch(__e){}var __s=__t==="ExitPlanMode"?"plan":__t==="AskUserQuestion"?"question":__r.length?"permission":__b?"working":"idle";return ${conn}.renameTab(s,a,l,__s,!!seen,!!intr,__sa>0)};` +
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
    // Returns TRUE only when the composer DOM ref is mounted and the submit was
    // invoked; FALSE when it isn't (e.g. the ref is transiently null while React
    // remounts the composer between hops). The dispatcher uses this to keep the
    // host retries alive until the submit actually lands (see below).
    "setInputText:ne,wtSubmit:(wtx)=>{try{if(!ee.current)return!1;ee.current.textContent=wtx;Je(void 0);return!0}catch(__we){return!1}}}),[n,Zs,Ve,ne])"
  );
  out = out.replace(
    regAnchor,
    "try{window.__wtSubmit=(wtx)=>{try{return a.current?a.current.wtSubmit(wtx):!1}catch(__we){return!1}}}catch(__we){}" +
      regAnchor
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
