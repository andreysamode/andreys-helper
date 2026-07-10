# Andrey's Cursor/VSCode Helper

A small set of quality-of-life helpers for working with **git worktrees** and
**Claude Code** in Cursor and VSCode. The feature list is expected to grow over
time.

---

## 1. Worktree controls

Manage [`worktrunk`](https://worktrunk.dev) worktrees right from the Source
Control ("Changes") panel — no terminal, no typing commands.

Look for the **tree button** in the Source Control title bar (next to the other
icons):

<img src="media/tree.png" alt="tree icon" width="28" height="28" />

**How to use it:**

- **On the main repo row** — click the tree button to create a **New Worktree**.
  You'll be asked for a branch name and whether you want:
  - **Basic** — just create the worktree and open it.
  - **Full** — also copy over your gitignored files (build caches, `node_modules`,
    etc.) so the new worktree is ready to go without a cold start.

- **On a worktree row** — click the tree button to get a menu:
  - **New Tab** — open a Claude tab in *this* window, scoped to that worktree.
  - **New Window** — open that worktree in a new Cursor / VS Code window.
  - **New Worktree** — same as above.
  - **Remove Worktree** — delete that worktree (with a confirmation prompt).

The new worktree always opens in whichever app you're running — Cursor or VSCode.

---

## 2. Incoming change watch

Keeps an eye on **incoming commits** — the changes a **Sync** would pull down —
and flags you when they touch files you care about (Django migrations, by
default), *before* you pull them.

When an open repo or worktree has incoming changes matching your watch patterns,
the tree button in the Source Control title bar turns **red** (an alert variant
of the same tree icon).

**How to use it:**

- Click the red button on that row to open the usual worktree menu — now with a
  **"Watched files have changed"** section listing the incoming files for *that*
  worktree.
- Select a file to open its **incoming diff** (your current version vs. what's
  coming in) — no checkout required.

Detection is event-driven (on fetch / pull / checkout / commit) and, by default,
does one throttled `git fetch` per repo when the window regains focus so the
indicator is fresh before you Sync.

> **Settings** (search `andreysHelper.watchIncoming` in Settings):
> - **`patterns`** — glob patterns matched against incoming file paths; prefix
>   with `!` to exclude. Defaults to Django migrations
>   (`**/migrations/*.py`, `!**/migrations/__init__.py`).
> - **`enabled`** — turn the watch on/off (default on).
> - **`fetchOnFocus`** / **`focusFetchThrottleSeconds`** — control the
>   fetch-on-focus refresh (default on, 60s between fetches per repo).

---

## 3. Claude Code panes

Three buttons in the **status bar** (bottom-left) — **C1**, **C2**, **C3** —
arrange your Claude Code sessions into 1, 2, or 3 side-by-side columns with one
click.

**How to use it:**

- Click **C2** to get two side-by-side Claude panes, **C3** for three, and so on.
- Adding panes opens new sessions as needed; removing panes just tucks sessions
  together — **your running agents are never closed.**
- On Cursor, the built-in agent panel is tidied out of the way first so Claude
  gets the space.

> Settings under **Andrey's Helper** (search `andreysHelper` in Settings) let you
> fine-tune the Cursor agent-tidying behavior, if needed.

---

## Installing

Download the latest
**[`andreys-helper.vsix`](https://github.com/andreysamode/andreys-helper/releases/latest/download/andreys-helper.vsix)**,
then install it:

```sh
cursor --install-extension andreys-helper.vsix
# or
code --install-extension andreys-helper.vsix
```

Or download and install in one go:

```sh
curl -L -o andreys-helper.vsix \
  https://github.com/andreysamode/andreys-helper/releases/latest/download/andreys-helper.vsix
cursor --install-extension andreys-helper.vsix
```

> **Requirement:** the worktree controls need the [`worktrunk`](https://worktrunk.dev)
> (`wt`) CLI installed. The Claude Code panes need the Claude Code extension.