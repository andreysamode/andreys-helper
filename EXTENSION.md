# Worktrunk (wt) Worktree Controls — VSCode/Cursor Extension

> Self-contained build plan / handoff doc. Written to be picked up in a fresh session with
> no prior context. Goal: a VSCode + Cursor extension that adds worktree controls to the
> Source Control ("Changes") panel, driving the `worktrunk` (`wt`) CLI.

## Context

Andrey runs a `wt` (worktrunk) worktree workflow. He wants the Source Control panel to grow
two actions so he stops typing `wt` commands by hand:

- **New Worktree**: prompt for a branch name, offer **Basic** vs **Full**.
  - Add `-c` (create new branch) when the branch does **not** exist (omit it to switch to an
    existing branch).
  - **Full** additionally copies gitignored files (build caches/deps) into the new worktree.
  - Then open the new worktree in a new editor window.
- **Remove Worktree** on worktree rows → `wt remove` for that worktree.

Hard requirement: **no visible terminals, no commands shown in the integrated shell.** Run
everything headless via `child_process` and open folders with the VSCode API.

His reference one-liner (the *interactive-shell* form) is:
`wt switch <branch> -c -x "wt step copy-ignored; cursor ."`
The extension does **not** replicate this literally — it decomposes it (see Execution model).

## Decided design (confirmed with the user)

- **UI: Option A — `scm/title` inline buttons.** Buttons live in the SCM repo title bar
  (where the GitLens icons sit), not as big CTA buttons.
- **`-c` logic:** add `-c` only when the branch does **not** exist.
- **Execution:** headless `child_process`, decomposed flow, host-aware folder open. No terminal.
- **Host detection:** detect Cursor vs VSCode and adjust the editor binary (`cursor`/`code`)
  for any constructed command; folder-open uses the host-aware `vscode.openFolder` API.

## Why the UI must be Option A (VSCode SCM API constraints)

The "Changes" panel is the **built-in Git extension's** `SourceControl`. A third-party
extension cannot inject into another extension's widgets.

- The big CTA button ("Sync Changes" / "Commit") is `SourceControl.actionButton`, owned by
  whichever extension *created* the SourceControl (Git). **Not injectable** — you'd only get
  one by registering your own SourceControl (a separate panel section, rejected).
- `scm/title` menu **is** contributable by third parties → inline icon buttons in the repo
  title bar with `…` overflow. Target git with `when: scmProvider == git`.
- **Per-row visibility limitation:** `scm/title` when-clauses use *window-global* context
  keys, so you **cannot** show "New Worktree" only on the main row and "Remove" only on
  worktree rows. Both commands appear on every git repo row → **command logic guards
  correctness** (Remove no-ops with a message on the primary worktree; New Worktree is
  harmless from any row since `wt switch -c` bases off the default branch).

Each worktree shows as its **own repo row** in the SCM view (confirmed: `core…`, plus
`andrey/pro-2355-…` and `PRO-2375-…` worktree rows). The Remove command receives that row's
`SourceControl`, whose `rootUri` is the worktree directory.

## `wt` reference (verified against v0.38.0 at `/opt/homebrew/bin/wt`)

- Global `-C <path>`: working dir for any command → **no `cd` needed**.
- `wt switch [BRANCH] [-c] [-b <base>] [--no-cd]`
  - `-c, --create` creates a new branch; `-b <base>` base branch (defaults to default branch).
  - `--no-cd` skips the post-switch directory change (we don't need it; VSCode opens the folder).
  - `-x <cmd>` is `exec`-based ("full terminal control"), for interactive TTY tools — **avoid**.
- `wt step copy-ignored [--from <branch>] [--to <branch>] [--dry-run] [--force]`
  - `--from` defaults to the main worktree, `--to` defaults to current. Non-interactive.
- `wt remove [BRANCHES] -y --format json [-f] [--no-delete-branch] [-D]`
  - `-y` skips approval prompts; `--format json` gives a parseable result; defaults to current
    worktree.
- `wt list` — shows all worktrees and paths (used to resolve a new worktree's path).
- The shell `cd` after switch is a **shell function** (`eval "$(wt config shell init …)"`), so
  a child_process running the binary never inherits it — irrelevant for the extension.

## Execution model (headless, no terminal)

**New Worktree:**
1. `wt -C <repoRoot> switch <branch> [-c] --no-cd`  (include `-c` only if branch absent)
2. Resolve new worktree path (parse `wt list`, or use the observed location pattern
   `~/worktrees/<repo>/<branch-with-slashes→dashes>` — prefer parsing `wt list` to be safe).
3. If **Full**: `wt -C <newPath> step copy-ignored`  (copies from main → new)
4. `vscode.openFolder(Uri.file(newPath), { forceNewWindow: true })` — host-aware, opens in the
   running app (Cursor or VSCode); **no `cursor`/`code` binary dependency.**

**Remove Worktree:**
- `wt -C <rowRootUri.fsPath> remove -y --format json` (after a confirm modal). Guard against
  the primary worktree.

**Host detection (Cursor vs VSCode):** `vscode.env.uriScheme` → `"cursor"` vs `"vscode"`
(`vscode.env.appName` fallback: `"Cursor"` vs `"Visual Studio Code"`). Map to `cursor` / `code`.
Used only where a literal editor command is constructed/surfaced; the default folder-open path
is `vscode.openFolder` and needs no binary.

## STEP 0 — Live validation (do this FIRST, before writing extension code)

"Base decisions on tests, not guesses." Create a throwaway worktree, exercise the headless
flow via a plain non-interactive process, then clean up. Confirm:

- `wt` is found & runs from a non-interactive child process (macOS extension-host **PATH** risk
  — GUI apps don't inherit shell PATH; mitigation: resolve the absolute binary path, or spawn
  via login shell `$SHELL -lic '…'`).
- `wt switch -c --no-cd` completes without hanging on prompts/hooks.
- Reliable new-worktree path resolution (parse `wt list`).
- `wt step copy-ignored` works headless (try `--dry-run` first).
- `wt -C <path> remove -y --format json` cleans up.

Bake the results into the `runWt()` helper (esp. PATH handling).

## Implementation

Scaffold a standard VSCode extension (TypeScript + esbuild). Works in Cursor too (same
extension host / API).

### File layout
- `package.json` — contributions (commands, `scm/title` menus, activation, icon).
- `src/extension.ts` — `activate()`, command registration, host detection helper.
- `src/wt.ts` — `runWt(args, cwd)` child_process runner + path resolution helpers.
- `src/git.ts` — thin wrapper over the built-in `vscode.git` API.
- `media/tree.svg` — copy of `~/Desktop/tree.svg` (the command icon). See icon note below.

### `package.json` contributions (sketch)
```jsonc
"activationEvents": ["onStartupFinished"],
"contributes": {
  "commands": [
    { "command": "wt.newWorktree",    "title": "New Worktree",    "category": "Worktrunk", "icon": "media/tree.svg" },
    { "command": "wt.removeWorktree", "title": "Remove Worktree", "category": "Worktrunk", "icon": "$(trash)" }
  ],
  "menus": {
    "scm/title": [
      { "command": "wt.newWorktree",    "group": "navigation", "when": "scmProvider == git" },
      { "command": "wt.removeWorktree", "group": "navigation", "when": "scmProvider == git" }
    ]
  }
}
```

### Commands
1. **`wt.newWorktree`** — `window.showInputBox` for branch name → `window.showQuickPick`
   Basic vs Full. Detect branch existence via the git API (or `git branch --list`) → include
   `-c` only when absent. Run the New Worktree flow under `window.withProgress`. Surface
   failures via `window.showErrorMessage`.
2. **`wt.removeWorktree`** — receives the `SourceControl` arg → `rootUri.fsPath` is the worktree
   dir. Guard: if it's the primary/main worktree, show a message and stop. Confirm modal →
   `wt -C <path> remove -y --format json`.

### Helpers
3. **`runWt(args, cwd)`** — single child_process wrapper with resolved `wt` path + env (login-
   shell spawn if Step 0 shows PATH gaps); returns `{ stdout, stderr, code }`.
4. **`getEditorBinary()`** — returns `cursor`/`code` from `vscode.env.uriScheme`/`appName`.
5. **Git integration** — `vscode.extensions.getExtension('vscode.git').exports.getAPI(1)` to
   read repositories, HEAD/branch, and detect existing branches.

### Icon note (important)
`~/Desktop/tree.svg` is a Phosphor icon using `fill="currentColor"`. Unlike codicons, an SVG
with `currentColor` in an `scm/title` command icon does **not** auto-adapt to the theme — it
can render black in dark themes. Options:
- Provide themed variants: `"icon": { "light": "media/tree-dark.svg", "dark": "media/tree-light.svg" }`
  (set explicit `fill` colors in each), **or**
- Use a built-in codicon instead (e.g. `"$(git-branch)"` / `"$(repo-forked)"`) for automatic
  theming and skip the custom SVG.
Decide during build; the custom tree.svg is fine if themed variants are supplied.

## Verification

- **Step 0 results** documented (empirical basis for `runWt()`).
- Launch the Extension Development Host (F5) with a `wt`-managed repo open:
  - On a git repo row, click **New Worktree** → enter a branch → **Basic** → confirm a worktree
    is created (`wt list`) and a new window opens at it; **no visible terminal**.
  - Repeat with **Full** → confirm gitignored files copied into the new worktree.
  - On a worktree row, click **Remove Worktree** → confirm modal → worktree removed
    (`wt list`); confirm Remove on the main row is blocked.
  - Confirm it works in **both** Cursor and VSCode (host detection + `openFolder`).
- Clean up any test worktrees with `wt remove -y`.

## Open decisions for the build session
- Custom tree.svg (themed variants) vs a codicon for the New Worktree button.
- Whether to also offer a `-b <base>` picker (base branch) in the New Worktree flow, or always
  default to the default branch.
- Confirmation UX for Remove (modal vs none).
