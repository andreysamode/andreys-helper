import type { ClaudeTab } from "../claudeStatus";
import type { WtResult } from "../wt";
import {
  CommandArgs,
  CommandMessage,
  CommandVerb,
  ResultMessage,
} from "./protocol";

/**
 * Command → primitive dispatch for every verb in the PLAN.md §6.2 command table
 * (Workstream W1). Like `client.ts`, this module is PURE: all editor primitives
 * are injected via {@link CommandDeps}, so the verb→primitive mapping can be
 * unit-tested with fakes and never pulls `vscode` into a test bundle. The real
 * deps are assembled in `register.ts`.
 *
 * Addressing (PLAN.md §6.1): the wire protocol keys steer/stop/reveal/rename on a
 * `sessionId` (the persistent Claude session uuid), but a freshly-spawned tab may
 * only have a `tabId`, and the patched Claude commands are keyed on the per-window
 * panel id (`ClaudeTab.id` / `__wtId`) — NOT the session uuid. So every session-
 * addressed verb first resolves the incoming id (which may be either a persistent
 * `sessionId` OR a temp `tabId`) to the target tab's panel id via the live tab
 * list, and calls the primitive with that. This is what lets the broker address a
 * just-spawned tab by `tabId` until its `sessionId` is known (temp-id → sessionId
 * handshake, PLAN.md §9.2).
 */

/** Ack payload shape a dispatched command resolves to (PLAN.md §6.2 `result`). */
export type CommandResult = Pick<ResultMessage, "ok" | "data" | "error">;

/** Editor primitives the dispatcher needs, injected by `register.ts`. */
export interface CommandDeps {
  /** Open a Claude tab pinned to a worktree, optionally submitting a prompt. */
  openWorktreeClaudeTab: (
    worktreePath: string,
    prompt?: string
  ) => Promise<void>;
  /** Live snapshot of open Claude tabs (from `ClaudeStatusService.tabs()`). */
  tabs: () => ClaudeTab[];
  /** Submit a prompt into an open tab by panel id (`submitPromptToTab`). */
  submitPrompt: (tabId: string, text: string) => Promise<boolean>;
  /** Interrupt (Esc-equivalent) an open tab by panel id (`interruptTab`). */
  interrupt: (tabId: string) => Promise<boolean>;
  /** Reveal/focus an open tab by panel id (`revealWorktreeTab`). */
  reveal: (tabId: string) => Promise<void>;
  /** Rename an open tab by panel id (`renameWorktreeTab`). */
  rename: (tabId: string, title: string) => Promise<boolean>;
  /** Run the `wt` CLI headless. */
  runWt: (args: string[]) => Promise<WtResult>;
  /** Extract the JSON payload from noisy `wt` output. */
  extractJson: <T>(out: string) => T | undefined;
  /** Whether a local branch exists in a repo. */
  branchExists: (repoRoot: string, branch: string) => Promise<boolean>;
  /** Whether a remote-tracking branch exists in a repo. */
  remoteBranchExists: (repoRoot: string, branch: string) => Promise<boolean>;
  /** Open a worktree path in a new editor window. */
  openFolderWindow: (worktreePath: string) => Promise<void>;
  /** The window's trunk path, used as the default root for `listWorktrees`. */
  trunkPath: () => string;
  /** Realpath-normalize a path (for matching a fresh tab to its worktree). */
  realPath: (p: string) => string;
  /**
   * Ask the client to publish a fresh snapshot now (used to complete the
   * temp-id → sessionId handshake promptly after a spawn, PLAN.md §9.2).
   */
  requestSnapshot: () => void;
  /** How long to wait for a freshly-spawned tab to appear, in ms. */
  spawnWaitMs?: number;
}

/** Shape returned by `wt switch … --format json`. */
interface WtSwitchResult {
  path?: string;
  branch?: string;
}

/** Shape returned by `wt list --format json`. */
interface WtListEntry {
  branch: string;
  path: string;
  is_main: boolean;
  is_current: boolean;
}

/**
 * Build the command dispatcher bound to the given editor primitives. The returned
 * function is what `BrokerClient` calls for each `command` message; it never
 * throws — every verb resolves to an ok/error {@link CommandResult}.
 */
export function createCommandDispatcher(
  deps: CommandDeps
): (command: CommandMessage) => Promise<CommandResult> {
  return async (command: CommandMessage): Promise<CommandResult> => {
    try {
      switch (command.verb) {
        case "spawnSession":
          return await spawnSession(deps, command.args as CommandArgs["spawnSession"]);
        case "sendPrompt":
          return await sendPrompt(deps, command.args as CommandArgs["sendPrompt"]);
        case "interrupt":
          return await interrupt(deps, command.args as CommandArgs["interrupt"]);
        case "reveal":
          return await reveal(deps, command.args as CommandArgs["reveal"]);
        case "createWorktree":
          return await createWorktree(deps, command.args as CommandArgs["createWorktree"]);
        case "rename":
          return await rename(deps, command.args as CommandArgs["rename"]);
        case "listWorktrees":
          return await listWorktrees(deps);
        default:
          return err(`unknown verb "${(command as { verb: string }).verb}"`);
      }
    } catch (e) {
      return err(errMessage(e));
    }
  };
}

// --- verb implementations ----------------------------------------------------

/**
 * spawnSession: open a Claude tab pinned to a worktree (submitting the prompt via
 * the patched bundle's pending-prompt stash), then wait for the new tab to appear
 * and return its `tabId` immediately (PLAN.md §6.2). The `sessionId` is null until
 * Claude assigns it; a follow-up snapshot (triggered here + by the status service's
 * change event) re-keys the tab once known — the temp-id → sessionId handshake
 * (PLAN.md §6.1, §9.2).
 */
async function spawnSession(
  deps: CommandDeps,
  args: CommandArgs["spawnSession"]
): Promise<CommandResult> {
  const worktreePath = args?.worktreePath;
  if (!worktreePath) {
    return err("spawnSession requires a worktreePath");
  }
  const target = deps.realPath(worktreePath);
  const before = new Set(deps.tabs().map((t) => t.id));

  await deps.openWorktreeClaudeTab(worktreePath, args.prompt);

  // Poll for the newly created tab (its cwd matches the worktree and it wasn't
  // open before). Mirrors KYM's bind-new-session logic in board.ts.
  const waitMs = deps.spawnWaitMs ?? 8000;
  const tab = await waitFor(waitMs, 200, () =>
    deps
      .tabs()
      .find((t) => !before.has(t.id) && deps.realPath(t.cwd) === target)
  );

  // Nudge a fresh snapshot so the broker sees the new tab (and, shortly after,
  // its sessionId) without waiting on the debounce/poll cadence.
  deps.requestSnapshot();

  if (!tab) {
    // The tab may still be opening on an unpatched/slow bundle; report best-effort.
    return ok({ tabId: null, sessionId: null, worktreePath: target });
  }
  return ok({
    tabId: tab.id,
    sessionId: tab.sessionId ?? null,
    worktreePath: target,
  });
}

/** sendPrompt: submit text into an open session by its uuid/tabId (`submitPrompt`). */
async function sendPrompt(
  deps: CommandDeps,
  args: CommandArgs["sendPrompt"]
): Promise<CommandResult> {
  const tabId = resolveTabId(deps, args?.sessionId);
  if (!tabId) {
    return err(`no open session for "${args?.sessionId}"`);
  }
  if (!args.text) {
    return err("sendPrompt requires text");
  }
  const sent = await deps.submitPrompt(tabId, args.text);
  return sent ? ok({ tabId }) : err("submitPrompt failed (unpatched bundle?)");
}

/** interrupt: Esc-equivalent abort of a running session (`interruptTab`). */
async function interrupt(
  deps: CommandDeps,
  args: CommandArgs["interrupt"]
): Promise<CommandResult> {
  const tabId = resolveTabId(deps, args?.sessionId);
  if (!tabId) {
    return err(`no open session for "${args?.sessionId}"`);
  }
  const done = await deps.interrupt(tabId);
  return done ? ok({ tabId }) : err("interrupt failed (unpatched bundle?)");
}

/** reveal: focus a session's tab (also marks its completion seen) (`reveal`). */
async function reveal(
  deps: CommandDeps,
  args: CommandArgs["reveal"]
): Promise<CommandResult> {
  const tabId = resolveTabId(deps, args?.sessionId);
  if (!tabId) {
    return err(`no open session for "${args?.sessionId}"`);
  }
  await deps.reveal(tabId);
  return ok({ tabId });
}

/** rename: set a session tab's title (`rename`). */
async function rename(
  deps: CommandDeps,
  args: CommandArgs["rename"]
): Promise<CommandResult> {
  const tabId = resolveTabId(deps, args?.sessionId);
  if (!tabId) {
    return err(`no open session for "${args?.sessionId}"`);
  }
  if (!args.title) {
    return err("rename requires a title");
  }
  const renamed = await deps.rename(tabId, args.title);
  return renamed ? ok({ tabId }) : err("rename failed (unpatched bundle?)");
}

/**
 * createWorktree: the headless `wt switch` flow from `extension.ts#newWorktree`
 * (no UI). Creates the branch only when it exists neither locally nor on a remote,
 * optionally copies gitignored files (`full`), then opens the worktree as a Claude
 * tab or a new window (PLAN.md §6.2).
 */
async function createWorktree(
  deps: CommandDeps,
  args: CommandArgs["createWorktree"]
): Promise<CommandResult> {
  const repoRoot = args?.repoRoot;
  const branch = args?.branch?.trim();
  if (!repoRoot || !branch) {
    return err("createWorktree requires repoRoot and branch");
  }

  const needCreate =
    !(await deps.branchExists(repoRoot, branch)) &&
    !(await deps.remoteBranchExists(repoRoot, branch));

  const switchArgs = ["-C", repoRoot, "switch", branch, "--no-cd", "--format", "json"];
  if (needCreate) {
    switchArgs.splice(4, 0, "-c"); // after the branch name
  }
  const sw = await deps.runWt(switchArgs);
  if (sw.code !== 0) {
    return err(firstLine(sw.stderr || sw.stdout) || `wt switch exited ${sw.code}`);
  }
  const parsed = deps.extractJson<WtSwitchResult>(sw.stdout);
  let newPath = parsed?.path;
  if (!newPath) {
    // Fallback: resolve the branch's path from `wt list`.
    const listed = await deps.runWt(["-C", repoRoot, "list", "--format", "json"]);
    newPath = deps
      .extractJson<WtListEntry[]>(listed.stdout)
      ?.find((e) => e.branch === branch)?.path;
  }
  if (!newPath) {
    return err("could not resolve the new worktree path");
  }

  if (args.full) {
    const copy = await deps.runWt(["-C", newPath, "step", "copy-ignored"]);
    // Non-fatal: the worktree exists even if copy-ignored failed.
    if (copy.code !== 0) {
      // fall through and still open it
    }
  }

  if (args.open === "window") {
    await deps.openFolderWindow(newPath);
  } else {
    await deps.openWorktreeClaudeTab(newPath);
  }
  deps.requestSnapshot();
  return ok({ path: newPath, branch, opened: args.open });
}

/** listWorktrees: `wt list --format json` under the window's trunk (PLAN.md §6.2). */
async function listWorktrees(deps: CommandDeps): Promise<CommandResult> {
  const root = deps.trunkPath();
  if (!root) {
    return err("no trunk path known for this window yet");
  }
  const listed = await deps.runWt(["-C", root, "list", "--format", "json"]);
  if (listed.code !== 0) {
    return err(firstLine(listed.stderr || listed.stdout) || `wt list exited ${listed.code}`);
  }
  const entries = deps.extractJson<WtListEntry[]>(listed.stdout) ?? [];
  return ok({ worktrees: entries });
}

// --- helpers -----------------------------------------------------------------

/**
 * Resolve a wire id (either a persistent `sessionId` OR a temp `tabId`) to the
 * target tab's panel id (`ClaudeTab.id`), which is what the patched commands key
 * on. Matches a live tab by `sessionId` first, then by `id` (covering a just-
 * spawned tab addressed by tabId before its uuid exists). Returns `undefined`
 * when no live tab matches.
 */
function resolveTabId(deps: CommandDeps, id: string | undefined): string | undefined {
  if (!id) {
    return undefined;
  }
  const tabs = deps.tabs();
  const bySession = tabs.find((t) => t.sessionId === id);
  if (bySession) {
    return bySession.id;
  }
  const byTab = tabs.find((t) => t.id === id);
  return byTab?.id;
}

/** Poll `probe` every `stepMs` up to `totalMs`; resolve with the first truthy
 *  result, or `undefined` on timeout. */
async function waitFor<T>(
  totalMs: number,
  stepMs: number,
  probe: () => T | undefined
): Promise<T | undefined> {
  const deadline = Date.now() + totalMs;
  for (;;) {
    const hit = probe();
    if (hit) {
      return hit;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await delay(stepMs);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ok(data: unknown): CommandResult {
  return { ok: true, data, error: null };
}

function err(message: string): CommandResult {
  return { ok: false, data: null, error: message };
}

function firstLine(s: string): string {
  return (s || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[0] ?? "";
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Whether a verb string is a known command verb (for callers that pre-validate). */
export function isCommandVerb(verb: string): verb is CommandVerb {
  return (
    verb === "spawnSession" ||
    verb === "sendPrompt" ||
    verb === "interrupt" ||
    verb === "reveal" ||
    verb === "createWorktree" ||
    verb === "rename" ||
    verb === "listWorktrees"
  );
}
