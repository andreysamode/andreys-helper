import * as vscode from "vscode";

/**
 * Claude Code pane controls.
 *
 * Three status-bar buttons — C1 / C2 / C3 — each arrange Claude Code into
 * exactly N side-by-side columns, the goal being a consistent multi-agent
 * workspace. The unit is the column (editor group holding a Claude tab):
 *   - Too few columns  → grow: open new sessions, one per new column.
 *   - Too many columns → shrink: drain the rightmost Claude columns into the
 *     first N columns. e.g. C2 from a 3-pane state moves the third session into
 *     column 1 (which then holds two tabs), leaving two panes.
 *
 * Design (chosen tradeoffs):
 *   - Sessions are never closed — shrinking moves their tabs, never destroys
 *     them, so running agents are preserved.
 *   - Growing reuses stacked sessions first: if a column holds more than one
 *     Claude tab, the extra is peeled out into the new column; only when no
 *     spare session exists is a fresh one opened. This makes the layout a
 *     stable round-trip — C3 → C2 → C3 returns to three single-session panes.
 *   - New sessions open in group 1 (Claude's `editor.open` ignores the active
 *     group and always targets its preferred/first group) then get pushed
 *     rightward into the new column.
 *   - Non-Claude editor tabs are left where they are.
 *   - On Cursor, the default agent view/tab is closed first so it doesn't
 *     compete for editor space.
 */

const CLAUDE_EXTENSION_ID = "anthropic.claude-code";

/** "Claude Code: Open in New Tab" — opens a Claude session as a webview editor
 *  (splittable), unlike the sidebar view. Verified against v2.1.170. */
const CLAUDE_OPEN_COMMAND = "claude-vscode.editor.open";

/** Claude's editor webview surfaces as a TabInputWebview whose viewType
 *  contains "claude" (e.g. "mainThreadWebview-claudeVSCodePanel"). Confirm the
 *  exact string with the "Inspect Claude Tabs" command if detection ever fails. */
const CLAUDE_VIEWTYPE = /claude/i;

/** Heuristic for Cursor's built-in agent/chat editor tab. Tunable via the
 *  `andreysHelper.cursorAgentViewTypePattern` setting once the real viewType is
 *  confirmed via "Inspect Claude Tabs". */
const DEFAULT_CURSOR_AGENT_PATTERN =
  "aichat|composer|cursor.*(chat|agent|pane)|(chat|agent).*pane";

/** Brief settle after opening a Claude webview so it registers as a tab before
 *  we move it. Kept small to avoid visible intermediate layout states — every
 *  other step relies on awaiting the command itself, not a fixed delay. */
const OPEN_SETTLE_MS = 60;

/** Focus-group commands indexed by 0-based column position (viewColumn − 1). */
const FOCUS_GROUP = [
  "workbench.action.focusFirstEditorGroup",
  "workbench.action.focusSecondEditorGroup",
  "workbench.action.focusThirdEditorGroup",
  "workbench.action.focusFourthEditorGroup",
  "workbench.action.focusFifthEditorGroup",
  "workbench.action.focusSixthEditorGroup",
  "workbench.action.focusSeventhEditorGroup",
  "workbench.action.focusEighthEditorGroup",
];

/** Move-active-editor-to-group commands indexed by 0-based target column. Only
 *  the first three are needed (C1/C2/C3 never target column > 3). */
const MOVE_TO_GROUP = [
  "workbench.action.moveEditorToFirstGroup",
  "workbench.action.moveEditorToSecondGroup",
  "workbench.action.moveEditorToThirdGroup",
];

export function registerClaudePanes(context: vscode.ExtensionContext): void {
  for (const n of [1, 2, 3] as const) {
    const item = vscode.window.createStatusBarItem(
      `andreysHelper.claude${n}`,
      vscode.StatusBarAlignment.Left,
      // Higher priority renders further left, so C1 | C2 | C3 reads in order.
      1000 - n
    );
    item.text = `C${n}`;
    item.tooltip = `Claude Code: arrange ${n} pane${n > 1 ? "s" : ""}`;
    item.command = `andreys-helper.claudePanes${n}`;
    item.show();
    context.subscriptions.push(item);

    context.subscriptions.push(
      vscode.commands.registerCommand(`andreys-helper.claudePanes${n}`, () =>
        ensureClaudePanes(n)
      )
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "andreys-helper.inspectClaudeTabs",
      inspectTabs
    )
  );
}

/**
 * Arrange Claude into exactly `target` columns — grow by opening sessions, or
 * shrink by draining the rightmost Claude columns into the first `target`.
 */
async function ensureClaudePanes(target: number): Promise<void> {
  const ext = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
  if (!ext) {
    void vscode.window.showWarningMessage(
      "Andrey's Helper: Claude Code extension is not installed."
    );
    return;
  }
  if (!ext.isActive) {
    await ext.activate();
  }

  const all = await vscode.commands.getCommands(true);
  if (!all.includes(CLAUDE_OPEN_COMMAND)) {
    void vscode.window.showErrorMessage(
      `Andrey's Helper: Claude Code command "${CLAUDE_OPEN_COMMAND}" not found — the extension's API may have changed.`
    );
    return;
  }

  const closedAgent = await closeCursorAgent(all);

  const current = countClaudeGroups();
  if (target > current) {
    await growClaudePanes(current, target);
  } else if (target < current) {
    await shrinkClaudePanes(target);
  }

  // Only tidy empty groups when we actually removed an agent — otherwise this
  // adds visible focus churn on every press for no reason.
  if (closedAgent) {
    await closeEmptyGroups();
  }
  await vscode.commands.executeCommand("workbench.action.evenEditorWidths");
}

/**
 * Grow to `target` Claude columns, adding one column at a time on the right.
 * For each new column we obtain a Claude tab — preferring to peel one from a
 * column that holds more than one (redistributing existing sessions) and only
 * opening a fresh session when none is spare — then push it into the new column.
 *
 * Assumes the Claude columns occupy the leftmost groups (columns 1..N), which
 * holds for layouts built by these buttons.
 */
async function growClaudePanes(current: number, target: number): Promise<void> {
  let cols = current;
  for (let guard = 0; cols < target && guard < 100; guard++) {
    const newColumn = cols + 1; // the column we're about to create, at the right

    const stacked = leftmostStackedClaudeGroup();
    const focusStacked = stacked ? FOCUS_GROUP[stacked.viewColumn - 1] : undefined;

    let sourceColumn: number;
    if (stacked && focusStacked) {
      // Reuse a spare session: focus the stacked column (its Claude tab becomes
      // active) so the move below peels it out.
      await vscode.commands.executeCommand(focusStacked);
      sourceColumn = stacked.viewColumn;
    } else {
      // No spare to redistribute — open a fresh session (lands in group 1).
      await vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup");
      await vscode.commands.executeCommand(CLAUDE_OPEN_COMMAND);
      await delay(OPEN_SETTLE_MS); // let the new webview register as a tab
      sourceColumn = 1;
    }

    // Push the active tab right until it forms the new rightmost column.
    for (let move = 0; move < newColumn - sourceColumn; move++) {
      await vscode.commands.executeCommand("workbench.action.moveEditorToRightGroup");
    }
    cols = newColumn;
  }
}

/** Leftmost editor group holding more than one Claude tab — the source of a
 *  spare session to redistribute when growing. */
function leftmostStackedClaudeGroup(): vscode.TabGroup | undefined {
  return vscode.window.tabGroups.all
    .filter((group) => group.tabs.filter(isClaudeTab).length > 1)
    .sort((a, b) => a.viewColumn - b.viewColumn)[0];
}

/**
 * Shrink to `target` Claude columns by repeatedly draining the rightmost Claude
 * column into the first `target` columns (round-robin). Moving a group's last
 * editor out makes VSCode auto-close the empty group, collapsing the column.
 * Sessions are moved, never closed. The guard bounds the loop in case a move
 * can't reduce the count (e.g. an unaddressable group beyond column 8).
 */
async function shrinkClaudePanes(target: number): Promise<void> {
  for (let guard = 0, moved = 0; guard < 100; guard++) {
    const claudeGroups = vscode.window.tabGroups.all
      .filter((group) => group.tabs.some(isClaudeTab))
      .sort((a, b) => a.viewColumn - b.viewColumn);
    if (claudeGroups.length <= target) {
      break;
    }

    const src = claudeGroups[claudeGroups.length - 1]; // rightmost Claude column
    const focusCmd = FOCUS_GROUP[src.viewColumn - 1];
    const moveCmd = MOVE_TO_GROUP[moved % target];
    if (!focusCmd || !moveCmd) {
      break; // beyond the addressable group range — bail rather than spin
    }

    // Focus the source column (its Claude tab becomes active) and move that tab
    // into one of the first `target` columns.
    await vscode.commands.executeCommand(focusCmd);
    await vscode.commands.executeCommand(moveCmd);
    moved++;
  }
}

/** Number of editor groups that hold at least one Claude tab — the column count
 *  that the C1/C2/C3 buttons grow or shrink toward. */
function countClaudeGroups(): number {
  let count = 0;
  for (const group of vscode.window.tabGroups.all) {
    if (group.tabs.some(isClaudeTab)) {
      count++;
    }
  }
  return count;
}

function isClaudeTab(tab: vscode.Tab): boolean {
  const input = tab.input;
  return (
    input instanceof vscode.TabInputWebview && CLAUDE_VIEWTYPE.test(input.viewType)
  );
}

/**
 * Best-effort close of Cursor's agent surface. Cursor renders its agent as an
 * editor tab whose input type the stable API doesn't model (so `tab.input` is
 * undefined) — confirmed via "Inspect Tabs". Claude tabs are always
 * TabInputWebview, so closing non-webview, undefined-input editor tabs kills the
 * agent without touching Claude. We close it directly rather than calling
 * `workbench.action.toggleAgents`, which would re-open it when already closed.
 *
 * Then, as fallbacks for other Cursor layouts: close any agent-looking webview
 * tab, optionally close the auxiliary side bar, and run user-configured close
 * commands. All gated on `andreysHelper.closeCursorAgent`.
 *
 * Returns whether an agent editor tab was actually closed, so the caller can
 * skip follow-up cleanup (and its visible churn) when there was nothing to do.
 */
async function closeCursorAgent(registeredCommands: readonly string[]): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration("andreysHelper");
  if (!cfg.get<boolean>("closeCursorAgent", true)) {
    return false;
  }

  const closeAgentTabs = cfg.get<boolean>("closeAgentEditorTabs", true);
  const pattern = safeRegExp(
    cfg.get<string>("cursorAgentViewTypePattern", DEFAULT_CURSOR_AGENT_PATTERN)
  );

  const toClose: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputWebview) {
        if (!CLAUDE_VIEWTYPE.test(input.viewType) && pattern?.test(input.viewType)) {
          toClose.push(tab); // a Cursor agent rendered as a webview editor
        }
      } else if (closeAgentTabs && input === undefined) {
        toClose.push(tab); // Cursor agent editor (input type not exposed by the API)
      }
    }
  }

  // Nothing agent-like is open — do nothing at all (no side bar toggling, no
  // command churn), so an ordinary press stays smooth.
  if (toClose.length === 0) {
    return false;
  }

  let closed = false;
  try {
    await vscode.window.tabGroups.close(toClose, /* preserveFocus */ true);
    closed = true;
  } catch {
    /* best effort */
  }

  if (
    cfg.get<boolean>("closeAuxiliaryBar", false) &&
    registeredCommands.includes("workbench.action.closeAuxiliaryBar")
  ) {
    try {
      await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    } catch {
      /* best effort */
    }
  }

  for (const command of cfg.get<string[]>("cursorAgentCloseCommands", [])) {
    if (registeredCommands.includes(command)) {
      try {
        await vscode.commands.executeCommand(command);
      } catch {
        /* best effort */
      }
    }
  }

  return closed;
}

/**
 * Close leftover empty editor groups (e.g. the slot Cursor's agent vacates) so
 * the column count is exactly what the C buttons arranged. Recomputes each pass
 * since closing a group renumbers the rest; bails if a pass makes no progress.
 */
async function closeEmptyGroups(): Promise<void> {
  let previousCount = -1;
  for (let guard = 0; guard < 10; guard++) {
    const groups = vscode.window.tabGroups.all;
    if (groups.length === previousCount) {
      break; // a pass didn't reduce the count — stop rather than spin
    }
    const empty = groups.find((group) => group.tabs.length === 0);
    if (!empty) {
      break;
    }
    const focusCmd = FOCUS_GROUP[empty.viewColumn - 1];
    if (!focusCmd) {
      break;
    }
    previousCount = groups.length;
    await vscode.commands.executeCommand(focusCmd);
    await vscode.commands.executeCommand("workbench.action.closeEditorsAndGroup");
  }
}

/**
 * Debug helper: dump every open tab's input (with webview viewTypes) plus all
 * registered commands matching chat/agent/composer/cursor, into a scratch doc.
 * Use it to confirm Claude's real viewType and find Cursor's agent-close command.
 */
async function inspectTabs(): Promise<void> {
  const lines: string[] = ["# Open editor tabs", ""];
  for (const group of vscode.window.tabGroups.all) {
    lines.push(`## Group (viewColumn ${group.viewColumn})`);
    for (const tab of group.tabs) {
      const active = tab.isActive ? " [active]" : "";
      lines.push(`- ${tab.label}${active} — ${describeInput(tab.input)}`);
    }
    lines.push("");
  }

  const agentish = (await vscode.commands.getCommands(true))
    .filter((c) => /chat|agent|composer|aichat|cursor/i.test(c))
    .sort();
  lines.push(
    "# Commands matching chat|agent|composer|aichat|cursor",
    "",
    ...agentish.map((c) => `- ${c}`)
  );

  const doc = await vscode.workspace.openTextDocument({
    content: lines.join("\n"),
    language: "markdown",
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

function describeInput(input: unknown): string {
  if (input instanceof vscode.TabInputWebview) {
    return `webview viewType="${input.viewType}"`;
  }
  if (input instanceof vscode.TabInputCustom) {
    return `custom viewType="${input.viewType}" ${input.uri.toString()}`;
  }
  if (input instanceof vscode.TabInputText) {
    return `text ${input.uri.toString()}`;
  }
  if (input === undefined || input === null) {
    return "unknown";
  }
  return (input as object).constructor?.name ?? "unknown";
}

function safeRegExp(source: string): RegExp | undefined {
  try {
    return new RegExp(source, "i");
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
