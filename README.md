# Andrey's Cursor/VSCode Helper

A small set of quality-of-life helpers for working with **git worktrees** and
**Claude Code** in Cursor and VSCode. Today it does two things; the feature list
is expected to grow over time.

---

## 1. Worktree controls

Manage [`worktrunk`](https://worktrunk.dev) worktrees right from the Source
Control ("Changes") panel — no terminal, no typing commands.

Look for the **tree button** in the Source Control title bar (next to the other
icons):

<img src="media/tree-dark.svg" alt="tree icon" width="28" height="28" />

**How to use it:**

- **On the main repo row** — click the tree button to create a **New Worktree**.
  You'll be asked for a branch name and whether you want:
  - **Basic** — just create the worktree and open it.
  - **Full** — also copy over your gitignored files (build caches, `node_modules`,
    etc.) so the new worktree is ready to go without a cold start.

- **On a worktree row** — click the tree button to get a menu:
  - **Open in Cursor / VS Code** — open that worktree in a new window.
  - **New Worktree** — same as above.
  - **Remove Worktree** — delete that worktree (with a confirmation prompt).

The new worktree always opens in whichever app you're running — Cursor or VSCode.

---

## 2. Claude Code panes

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

Grab the packaged `.vsix` and install it:

```sh
cursor --install-extension andreys-helper-<version>.vsix
# or
code --install-extension andreys-helper-<version>.vsix
```

> **Requirement:** the worktree controls need the [`worktrunk`](https://worktrunk.dev)
> (`wt`) CLI installed. The Claude Code panes need the Claude Code extension.

---

More features coming. 🌳
