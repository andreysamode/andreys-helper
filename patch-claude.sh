#!/usr/bin/env bash
#
# Patch the installed Claude Code extension for Andrey's Helper.
#
# Two independent patches, both idempotent and both backing up the original
# (once) alongside the file with a .bak suffix:
#
#   1. webview/index.js — default the "include current selection/file" toggle
#      OFF so an open file is no longer auto-attached to every message (opt-in
#      preserved). This flips the toggle's useState default from true to false;
#      the state's minified identifiers are read from the toggle's render site
#      rather than hard-coded, so it survives re-minification across versions.
#      See: https://github.com/anthropics/claude-code/issues/24726#issuecomment-4343376892
#
#   2. extension.js — add one command so Andrey's Helper can open a Claude tab
#      pinned to a git worktree:
#        claude-vscode.editor.openWorktree(cwd)   (new command)
#      Design notes live in src/claudeTab.ts.
#
# Pinned to the bundle shape of anthropic.claude-code 2.1.187. If Anthropic
# ships a new build with different minified anchors, the extension.js patch
# aborts loudly (exit 1) rather than corrupting the bundle — re-derive the
# anchors and update the STRING pairs below.
#
# Usage:
#   ./patch-claude.sh            patch the current Claude Code build
#   ./patch-claude.sh restore    revert to the pre-patch bundle (.bak) — for A/B
#                                 testing whether the patch causes a problem
#
# The patched bundle logs stage markers to ~/.wt-claude-patch.log (timestamped),
# so if something hangs you can see the last step it reached:
#   tail -f ~/.wt-claude-patch.log
set -euo pipefail

MODE="${1:-patch}"

# --- locate installs -------------------------------------------------------

# Cursor doesn't remove old extension builds on update, so several
# anthropic.claude-code-<version> dirs can pile up. Cursor loads the highest
# version; the rest are dead weight that also make it ambiguous which bundle a
# patch actually hit. Keep the highest version, delete the others (this is what
# Cursor's own GC eventually does). Node handles the semver comparison; bash
# does the visible rm.
prune_old_versions() {
  local base="$1"
  [ -d "$base" ] || return 0
  local plan
  plan=$(BASE="$base" node -e '
    const fs=require("fs"),path=require("path"),base=process.env.BASE;
    let e=[];try{e=fs.readdirSync(base).filter(d=>d.startsWith("anthropic.claude-code-"))}catch{process.exit(0)}
    if(e.length<=1)process.exit(0);
    const ver=d=>{const m=d.match(/claude-code-(\d+(?:\.\d+)*)/);return m?m[1].split(".").map(Number):[]};
    const cmp=(a,b)=>{for(let i=0;i<Math.max(a.length,b.length);i++){const x=(a[i]||0)-(b[i]||0);if(x)return x}return 0};
    e.sort((a,b)=>cmp(ver(a),ver(b)));
    console.log("KEEP\t"+path.join(base,e[e.length-1]));
    for(const d of e.slice(0,-1))console.log("DEL\t"+path.join(base,d));
  ') || true
  [ -n "$plan" ] || return 0
  while IFS="$(printf '\t')" read -r tag dir; do
    [ -n "$dir" ] || continue
    if [ "$tag" = "KEEP" ]; then
      echo "==> Current version kept: $(basename "$dir")"
    else
      echo "==> Removing stale version: $(basename "$dir")"
      rm -rf "$dir"
    fi
  done <<EOF
$plan
EOF
}

if [ "$MODE" != "restore" ]; then
  prune_old_versions "$HOME/.cursor/extensions"
  prune_old_versions "$HOME/.cursor-server/extensions"
fi

# Back up <file>.bak once (never clobber an existing backup = never lose the
# pristine original across repeated runs).
backup_once() {
  local f="$1"
  if [ ! -f "$f.bak" ]; then
    cp "$f" "$f.bak"
  fi
}

# Print paths to a given leaf (e.g. "extension.js") inside any installed copy of
# the Claude Code extension, across desktop and server installs. Kept free of
# brace expansion / process substitution so it works on macOS's bash 3.2.
find_claude_bundles() {
  local leaf="$1" base
  for base in "$HOME/.cursor/extensions" "$HOME/.cursor-server/extensions"; do
    [ -d "$base" ] || continue
    find "$base" -path "*anthropic.claude-code-*/$leaf" 2>/dev/null || true
  done
}

# --- restore mode: revert to the pre-patch bundle (for A/B testing) --------

if [ "$MODE" = "restore" ]; then
  restored=0
  for leaf in extension.js webview/index.js; do
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      if [ -f "$f.bak" ]; then
        cp "$f.bak" "$f"
        echo "==> restored: $f"
        restored=1
      fi
    done <<EOF
$(find_claude_bundles "$leaf")
EOF
  done
  [ "$restored" -eq 1 ] || echo "!! no .bak files found to restore"
  echo
  echo "Restored pristine bundle. Reload the editor (Developer: Reload Window)."
  echo "Re-run ./patch-claude.sh to re-apply the patch."
  exit 0
fi

# --- patch 1: webview initial-state fix ------------------------------------

patched_webview=0
while IFS= read -r wv; do
  [ -n "$wv" ] || continue
  patched_webview=1
  WV_JS="$wv" node <<'NODE'
const fs = require("fs");
const file = process.env.WV_JS;
let src = fs.readFileSync(file, "utf8");

// The "include current selection/file" toggle is a useState that defaults to
// true — so the open file is auto-attached until the user turns it off. We flip
// that ONE default to false: opt-in preserved, nothing removed.
//
// Everything here is minified and renamed between builds — the state/setter
// letters AND the useState shim name (oe -> ie -> …). So we hard-code nothing:
//   - read state + setter from the toggle's render site
//     (includeSelection:<state>,onToggleIncludeSelection:()=><setter>(), and
//   - read the useState shim's minified name from its definition
//     (<shim>=function(e){return <x>.current.useState(e)}),
// then flip that specific `[<state>,<setter>]=<shim>(!0)` declaration.
const m = src.match(
  /includeSelection:([A-Za-z_$][\w$]*),onToggleIncludeSelection:\(\)=>([A-Za-z_$][\w$]*)\(/
);
if (!m) {
  console.log("!! include-selection toggle not located (bundle reshaped?) — left untouched:");
  console.log("   " + file);
  process.exit(0); // non-fatal: don't block the extension.js patch
}
const state = m[1], setter = m[2];

const shimMatch = src.match(
  /([A-Za-z_$][\w$]*)=function\([\w$]\)\{return [^{}]+\.useState\([\w$]\)\}/
);
if (!shimMatch) {
  console.log("!! useState shim not located (bundle reshaped?) — left untouched:");
  console.log("   " + file);
  process.exit(0);
}
const shim = shimMatch[1];
const on = `[${state},${setter}]=${shim}(!0)`;
const off = `[${state},${setter}]=${shim}(!1)`;

if (src.includes(off) && !src.includes(on)) {
  console.log("==> webview already patched (auto-include off): " + file);
  process.exit(0);
}
const n = src.split(on).length - 1;
if (n === 0) {
  console.log(`!! default-on declaration ${on} not found — re-derive. Left untouched:`);
  console.log("   " + file);
  process.exit(0);
}
if (n > 1) {
  console.error(`!! declaration ${on} not unique (${n}) — aborting to avoid mis-patch.`);
  process.exit(1);
}

if (!fs.existsSync(file + ".bak")) {
  fs.copyFileSync(file, file + ".bak");
}
src = src.replace(on, off);
fs.writeFileSync(file, src);
console.log(`==> webview patched: auto-include off, opt-in preserved (${on} -> ${off})`);
console.log("   " + file);
NODE
done <<EOF
$(find_claude_bundles "webview/index.js")
EOF
[ "$patched_webview" -eq 1 ] || echo "!! no webview/index.js found to patch"

# --- patch 2: extension.js worktree-cwd + tab-prefix -----------------------

patched_ext=0
while IFS= read -r ext; do
  [ -n "$ext" ] || continue
  backup_once "$ext"
  EXT_JS="$ext" node <<'NODE'
const fs = require("fs");
const file = process.env.EXT_JS;
let src = fs.readFileSync(file, "utf8");

// Canonical marker: the new command only exists once patched.
const MARKER = "claude-vscode.editor.openWorktree";
if (src.includes(MARKER)) {
  console.log("==> extension.js already patched: " + file);
  process.exit(0);
}

function fail(msg) {
  console.error("!! extension.js anchor failed: " + msg);
  console.error("   The bundle shape changed (new Claude version?). Aborting without writing.");
  console.error("   Re-derive against: " + file);
  process.exit(1);
}

// Resilient strategy: the minifier renames every local/alias between versions
// (yt->_t, $C->rP, Ks->ts, editor.open params (h,_,b)->(g,b,_), …), so we do
// NOT hard-code them. We anchor on tokens that are stable because they're
// semantically meaningful — command id strings, method names (setupPanel,
// getHtmlForWebview), and the realpathSync(<folders>[0]||<x>.homedir()) shape —
// and capture the volatile identifiers via backreferences, then build exact
// replacements from the captured names.
//
// We avoid touching editor.open / createPanel entirely (their signatures churn
// the most). Instead a new `openWorktree` command stashes {cwd} on a globalThis
// "pending" slot, then invokes the stock editor.open; setupPanel — which runs
// synchronously in the same tick — consumes the slot. A globalThis registry
// (not a module var) bridges the two separate minified module scopes.

const INIT =
  "var __G=globalThis.__wtClaude=globalThis.__wtClaude||{pending:null};" +
  "if(!globalThis.__wtlog){globalThis.__wtlog=function(m){try{require('fs').appendFileSync(require('os').homedir()+'/.wt-claude-patch.log','['+new Date().toISOString()+'] '+m+'\\n')}catch(e){}}}";

// --- extract identifiers from the setupPanel signature + realpath shape ---
// NOTE: identifiers can contain `$` (e.g. the fs alias is `$C` in some builds),
// so every identifier placeholder is [\w$]+, never \w+.
const sp = src.match(
  /setupPanel\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\{let ([\w$]+)=\{isVisible:\(\)=>\1\.visible\};this\.webviews\.add\(\5\);let ([\w$]+)=[\w$]+\.workspace\.workspaceFolders\?\.map\(\([\w$]+\)=>[\w$]+\.uri\.fsPath\)\|\|\[\],([\w$]+)=([\w$]+)\.realpathSync\(\6\[0\]\|\|([\w$]+)\.homedir\(\)\)\.normalize\("NFC"\)/
);
if (!sp) fail("setupPanel signature / realpath shape");
const panel = sp[1], p2 = sp[2], p3 = sp[3], p4 = sp[4];
const folders = sp[6], cwd = sp[7], rp = sp[8], hd = sp[9];

// A. setupPanel entry: init the registry + consume the pending slot.
const spSig = `setupPanel(${panel},${p2},${p3},${p4}){`;
if (src.split(spSig).length - 1 !== 1) fail("setupPanel signature not unique");
src = src.replace(
  spSig,
  spSig + INIT + "var __pend=__G.pending;__G.pending=null;" +
    `globalThis.__wtlog("setupPanel:enter sid="+(${p2}!=null)+" pend="+(!!__pend)+" pendCwd="+(__pend&&__pend.cwd));`
);

// B. cwd computation: honor pending.cwd over the default first-workspace-folder.
const rpExpr = `${cwd}=${rp}.realpathSync(${folders}[0]||${hd}.homedir()).normalize("NFC")`;
if (src.split(rpExpr).length - 1 !== 1) fail("realpath expression not unique");
src = src.replace(
  rpExpr,
  `${cwd}=${rp}.realpathSync((__pend&&__pend.cwd)||${folders}[0]||${hd}.homedir()).normalize("NFC")`
);

// C. register the openWorktree command next to the stock primaryEditor.open
//    registration; capture the subscriptions holder and vscode alias.
const pe = src.match(
  /([\w$]+)\.subscriptions\.push\(([\w$]+)\.commands\.registerCommand\("claude-vscode\.primaryEditor\.open"/
);
if (!pe) fail("primaryEditor.open anchor");
const subs = pe[1], vs = pe[2];
const inject =
  `${subs}.subscriptions.push(${vs}.commands.registerCommand("claude-vscode.editor.openWorktree",(cwd)=>{` +
  `${INIT}globalThis.__wtlog("openWorktree cwd="+cwd);__G.pending={cwd:cwd};return ${vs}.commands.executeCommand("claude-vscode.editor.open")})),`;
src = src.replace(pe[0], inject + pe[0]);

fs.writeFileSync(file, src);
console.log("==> extension.js patched (resilient, capture-based): " + file);
NODE
  patched_ext=1
done <<EOF
$(find_claude_bundles "extension.js")
EOF
[ "$patched_ext" -eq 1 ] || echo "!! no extension.js found to patch"

echo
echo "Done. Reload the editor (Developer: Reload Window) to load the patched extension."
