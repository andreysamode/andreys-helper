# Source Control+ pane

A custom Source Control pane (activity bar → **Andrey's Helper**) that **drives
real git and shows real state**, without patching the workbench. VS Code exposes
no way to embed/reparent its own SCM widgets, so this re-renders the parts we
want from freely-available data; behavior is real because actions are just
command invocations / direct git calls.

## What it shows / does

- **Repo rows** — one per open repository/worktree, labeled with the branch
  name; description shows the worktree folder, ahead/behind **vs. the window's
  trunk**, a `⚠ migration` flag, and open-tab count (from `ScmInfoService`).
- **Changed files** under each repo (staged ● + working tree + merge), with a
  status letter. **Click → opens the diff** (`vscode.diff` via git's `toGitUri`;
  untracked files just open).
- **Undo Last Commit** — inline on each repo row; confirmed `git reset --soft
  HEAD~1` (changes stay staged, nothing lost).
- **Stage / Unstage** — inline on file rows (`git add` / `git reset`).
- **Title bar** — Create Pull Request (`pr.create`), View Git Graph
  (`git-graph.view`), Refresh.

## Design

| Concern | Approach |
|---|---|
| Referencing VS Code's SCM UI | Not possible (no API; DOM reparenting is unreliable). Re-render from data instead. |
| Data | Built-in git extension API (`repo.state.*`, `HEAD`, `toGitUri`) + `ScmInfoService` for trunk-relative ahead/behind and migration flag. |
| Actions | Command IDs (`pr.create`, `git-graph.view`) and direct `git` calls (`runGit`). |
| Rendering | A `TreeDataProvider` (`scmMirrorView.ts`): repos → files, inline buttons, context menus. |
| Refresh | `repo.state.onDidChange` + open/close repo events + `ScmInfoService.onDidChange`. |

## Files
- `src/scmParse.ts` — pure parsers (worktree porcelain, ahead/behind, status, tab attribution); unit-tested.
- `src/scmInfo.ts` — `ScmInfoService`: per-worktree trunk-relative stats + migration flag, event-driven.
- `src/scmMirrorView.ts` — the tree pane + its commands.

## Rejected: workbench injection
An earlier approach patched `workbench.html` to inject a client that drew a line
between the branch header and the commit box (SSE bridge from the extension).
Dropped: it modifies the app install, breaks on Cursor updates, and — with the
`custom-ui-style` extension also patching the workbench — is fragile. The pane
delivers the wanted features with zero patching.
