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

interface Bundle {
  root: string;
  extensionJs: string;
  webviewJs: string;
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
  };
}

/** True when the active Claude bundle carries our extension.js patch. */
function isClaudePatched(): boolean {
  const bundle = claudeBundle();
  if (!bundle) {
    return false;
  }
  try {
    return fs.readFileSync(bundle.extensionJs, "utf8").includes(MARKER);
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
 * Return extension.js source with the openWorktree patch applied. Throws with a
 * human-readable reason if an anchor can't be found (bundle reshaped) so the
 * caller aborts without writing a corrupted file. Idempotent: returns the input
 * unchanged when the marker is already present.
 */
function patchExtensionJs(src: string): string {
  if (src.includes(MARKER)) {
    return src;
  }

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
  const inject =
    `${subs}.subscriptions.push(${vs}.commands.registerCommand("claude-vscode.editor.openWorktree",(cwd)=>{` +
    `${INIT}globalThis.__wtlog("openWorktree cwd="+cwd);__G.pending={cwd:cwd};return ${vs}.commands.executeCommand("claude-vscode.editor.open")})),`;
  return src.replace(pe[0], inject + pe[0]);
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

  if (extSrc.includes(MARKER)) {
    toast("Worktrunk: Claude Code is already patched.");
    return;
  }

  // extension.js — abort the whole operation if anchors are missing.
  let patchedExt: string;
  try {
    patchedExt = patchExtensionJs(extSrc);
  } catch (err) {
    toast(
      `Worktrunk: patch aborted (nothing written) — ${errMessage(err)}. Claude may have updated; the patch needs re-deriving.`,
      "error"
    );
    return;
  }

  // webview — best-effort; a miss here is non-fatal.
  let webviewNote: string | undefined;
  let webviewSrc: string | undefined;
  let webviewChanged = false;
  try {
    const raw = fs.readFileSync(bundle.webviewJs, "utf8");
    const res = patchWebviewJs(raw);
    webviewSrc = res.src;
    webviewChanged = res.changed;
    webviewNote = res.note;
  } catch (err) {
    webviewNote = `not read (${errMessage(err)})`;
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

  const webviewMsg = webviewChanged
    ? " Auto-include-file default set to off."
    : ` (auto-include-file fix skipped: ${webviewNote ?? "unknown"}).`;
  await offerRestart(
    `Worktrunk: Claude Code patched — worktree tabs enabled.${webviewMsg} Restart the extension host to apply.`
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
    "Worktrunk: Claude Code isn't patched yet — patching enables worktree-scoped tabs and the auto-include-file fix. You can patch/unpatch anytime under Settings → Andrey's Helper → “Claude Code Patch”.",
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
