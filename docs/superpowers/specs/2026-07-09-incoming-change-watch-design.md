# Incoming Change Watch — Design

**Date:** 2026-07-09
**Status:** Implemented (2026-07-09)
**Component of:** Andrey's Helper / Worktrunk VSCode+Cursor extension

## Problem

When `main` (or any branch's upstream) advances, some incoming commits contain
files the developer cares about knowing *before* they Sync — the motivating case
is Django migrations, which live scattered across many `*/migrations/*.py`
directories. Today you only discover an incoming migration after pulling. The
user wants an **ahead-of-time** signal, driven off patterns they configure, that
surfaces on the extension's existing Source Control palm-tree icon and lets them
see exactly which files are coming in.

## Goal

Watch each open repo/worktree for incoming commits (what Sync would pull). If any
incoming file matches configured glob patterns, turn the SCM palm-tree icon red.
Clicking the red icon lists the matched files grouped by repo; selecting one opens
its incoming diff. Migrations is only the default pattern — the mechanism is a
generic, user-editable watch list.

## Non-goals

- No standing polling timer. Detection is event-driven.
- No badge overlay on the built-in git **Sync** button — VSCode does not allow it.
- No per-repo-row red state — `scm/title` `when`-clauses are window-global (see
  Constraints). We turn the limitation into a feature by grouping the list by repo.
- No auto-running of migrations or any git mutation on the user's behalf.

## VSCode constraints that shape the design

1. **`scm/title` icons are static and their `when`-clauses are window-global.**
   The existing code already notes this ([extension.ts](../../../src/extension.ts)).
   We cannot attach a dynamic numeric badge to a menu icon, and we cannot vary the
   icon per repo row. The only lever is: contribute a second menu entry with a red
   icon, shown via a boolean context key. When that key is true, *every* repo row
   shows red.
2. **No public glob matcher in the `vscode` API.** We bundle `minimatch` via the
   existing esbuild pipeline.
3. **The built-in git extension already tracks ahead/behind.** `repository.state.HEAD`
   exposes `{ name, upstream, ahead, behind }`, and `repository.state.onDidChange`
   fires whenever that updates (including after autofetch, pull, checkout, commit).
   We ride this instead of polling with our own `rev-list`.
4. **File contents at a ref without checkout** are available through the git API's
   `toGitUri(uri, ref)`, which yields a URI the diff editor can resolve.

## Architecture

New module `src/incomingWatch.ts` exporting `registerIncomingWatch(context)`,
called from `activate()` in [extension.ts](../../../src/extension.ts). Small
additions to [git.ts](../../../src/git.ts). One new asset `media/tree-alert.svg`.
New settings and menu/command contributions in [package.json](../../../package.json).

### 1. Watch engine (event-driven, no timer)

Triggers that cause a **recompute** for a repo:

- **Startup** — on `registerIncomingWatch`, walk `gitApi.repositories` and compute
  each. Subscribe to `gitApi.onDidOpenRepository` so worktrees opened later are
  computed too, and `onDidCloseRepository` to drop their state.
- **Git state change** — subscribe to each repo's `state.onDidChange`. Recompute
  when the branch, the `behind` count, or the resolved upstream SHA changes since
  the last look. This fires for free on autofetch, pull, merge, checkout, commit.
- **Focus-fetch (throttled)** — subscribe to `vscode.window.onDidChangeWindowState`.
  On regaining focus, if the last fetch for a repo is older than
  `focusFetchThrottleSeconds`, run one `git fetch` for that repo, then recompute.
  This is the "I'm back and about to Sync — make it fresh" refresh. Gated by
  `fetchOnFocus`.

Guard: the whole engine is inert when `andreysHelper.watchIncoming.enabled` is
false. Config changes (`workspace.onDidChangeConfiguration`) re-read settings and
recompute all repos.

### 2. Compute step (per repo)

1. Read `repo.state.HEAD`. If there is no `upstream` or `behind === 0`, the repo
   has no incoming commits → clear its matches and return.
2. Resolve the upstream ref/SHA. If the upstream SHA is unchanged since the last
   successful compute for this repo, reuse the cached match list (no git call).
3. Otherwise run `git -C <root> diff --name-only HEAD...@{upstream}` (three-dot:
   changes on the upstream side since the merge base = exactly the incoming set).
4. Match the returned repo-relative paths against the configured patterns
   (`matchWatchPatterns`, below). Store `{ branch, upstreamSha, matches }` in the
   per-repo `Map`.

### 3. State + surface

- In-memory `Map<repoRoot, { branch: string; upstreamSha: string; matches: string[] }>`.
- After any recompute, set the global context key:
  `vscode.commands.executeCommand('setContext', 'andreysHelper.incomingWatchHit', anyMatches)`
  where `anyMatches` = some repo has a non-empty `matches`.
- **Icon swap** — two `scm/title` menu entries in `package.json`:
  - normal palm-tree icon → command `wt.worktreeMenu`,
    `when: scmProvider == git && !andreysHelper.incomingWatchHit`
  - red palm-tree icon (`media/tree-alert.svg`) → command
    `andreysHelper.showIncomingWatch`,
    `when: scmProvider == git && andreysHelper.incomingWatchHit`

  So in the normal state the icon behaves exactly as today (worktree menu); in the
  hit state it opens the incoming-watch list.

### 4. List command (`andreysHelper.showIncomingWatch`)

- Builds a `QuickPick` titled **"The updates change the following files:"**.
- Items are every matched file across all repos with matches, grouped by repo:
  a `QuickPickItemKind.Separator` per repo labeled `⟨branch⟩ — ⟨repo folder name⟩`,
  followed by one item per matched repo-relative path.
- Because the red state is window-global, listing *all* repos' matches (not just
  the clicked row's) is the intended behavior — one click answers "what's coming
  in anywhere in this window."
- A trailing item **"Worktree actions…"** invokes `wt.worktreeMenu` so worktree
  controls remain reachable while the icon is red.
- Selecting a file item opens `vscode.diff(left, right, title)` where
  `left = gitApi.toGitUri(fileUri, 'HEAD')` and
  `right = gitApi.toGitUri(fileUri, <upstreamSha>)`. Added files resolve to an
  empty left side and display as an addition. `fileUri` is the absolute path under
  the owning repo root.

### 5. Pure matcher (unit-tested)

```
matchWatchPatterns(files: string[], patterns: string[]): string[]
```

- Positive patterns select; `!`-prefixed patterns exclude (minimatch semantics).
- A file is included if it matches at least one positive pattern and no negation.
- Paths are repo-relative with `/` separators (git already emits these).
- This is the only logic worth isolating; it gets a unit test.

## Settings (`package.json` → `contributes.configuration`)

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `andreysHelper.watchIncoming.enabled` | boolean | `true` | Master switch for the whole feature. |
| `andreysHelper.watchIncoming.patterns` | string[] | `["**/migrations/*.py", "!**/migrations/__init__.py"]` | Globs matched against incoming repo-relative paths; `!`-prefix negates. |
| `andreysHelper.watchIncoming.fetchOnFocus` | boolean | `true` | Run one throttled `git fetch` when the window regains focus. |
| `andreysHelper.watchIncoming.focusFetchThrottleSeconds` | number | `60` | Minimum seconds between focus-triggered fetches per repo. |

## git.ts additions

- Export the existing private `runGit(repoRoot, args)` so `incomingWatch.ts`
  can run `rev-parse` and `diff --name-only` without duplicating spawn/timeout
  logic. (Implemented as a plain `export` on the existing function rather than a
  new `runGitCapture` wrapper.)
- `toGitUri` is accessed directly off the git API object in `incomingWatch.ts`
  (no `git.ts` wrapper needed). The focus fetch uses the git API's
  `repository.fetch()` (reuses the user's auth/remotes) instead of spawning git.

## Implementation notes (deviations/refinements)

- `state.onDidChange` fires on every working-tree change, so recomputes are
  gated by a cheap signature (`branch|behind|upstream|patterns`) before any git
  call, and the diff only reruns when the upstream SHA actually moved.
- `andreysHelper.showIncomingWatch` forwards the clicked row's `SourceControl`
  to `wt.worktreeMenu` via the trailing "Worktree actions…" item, so per-row
  menu behavior is preserved while the icon is red.

## Data flow

```
activate()
  └─ registerIncomingWatch(context)
       ├─ getGitApi() → repositories, onDidOpenRepository/onDidCloseRepository
       ├─ per repo: state.onDidChange ──┐
       ├─ window.onDidChangeWindowState ┤→ recompute(repo)
       └─ startup walk ─────────────────┘
recompute(repo):
  state.HEAD.{upstream,behind} → (fetch-on-focus?) → git diff --name-only HEAD...@{upstream}
    → matchWatchPatterns → Map[repo] = {branch,upstreamSha,matches}
    → setContext incomingWatchHit = anyMatches
red icon click → andreysHelper.showIncomingWatch
  → QuickPick(grouped matches) → select → vscode.diff(toGitUri HEAD, toGitUri upstreamSha)
```

## Error handling

- All git calls go through the existing never-reject `runGit` (resolves `{code:-1}`
  on spawn error/timeout). On failure to compute a repo, leave its previous match
  state untouched and skip — never throw into VSCode event handlers.
- Missing upstream, detached HEAD, or no remote → treat as "no incoming", clear
  matches for that repo.
- `toGitUri` unavailable (older git ext) → fall back to opening the working-tree
  file read-only; log once via `toast` at info level. (Edge; not expected.)

## Testing

- **Unit**: `matchWatchPatterns` — positive globs, negation, no-match, nested
  `migrations` dirs, `__init__.py` exclusion. Add a minimal test runner (none
  exists yet); keep it to this pure function.
- **Manual**: against a repo whose `origin/<branch>` has an incoming migration —
  verify the icon turns red, the list groups correctly, the diff opens, and the
  icon clears after pulling. Verify startup-already-behind and focus-fetch paths.

## Files touched

- `src/incomingWatch.ts` (new) — engine, state, list command.
- `src/git.ts` — `runGitCapture`, `toGitUri` accessor.
- `src/extension.ts` — call `registerIncomingWatch(context)`.
- `package.json` — settings, second `scm/title` entry, `showIncomingWatch` command,
  `minimatch` dependency, esbuild allowScripts if needed.
- `media/tree-alert.svg` (new) — red palm tree.
- test file for `matchWatchPatterns` + minimal runner.
