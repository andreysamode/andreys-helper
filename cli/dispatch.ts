/**
 * `ah` verb dispatch — the library half of the CLI (PLAN.md §6.3).
 *
 * `dispatch(argv)` parses one invocation, runs the matching verb, and returns the
 * result object (or throws). The runnable binary is `cli/ah.ts`, which wraps this
 * with stdout printing + exit codes. Splitting them keeps `dispatch` free of
 * process side-effects so tests can import it directly.
 *
 * Verb → transport map:
 *   windows          broker query `windows`
 *   sessions         broker query `sessions` (+ --repo/--status filter)
 *   resolve-branch   broker `windows` (open windows first) ∪ local git scan of repoScanDirs
 *   find-session     broker `sessions` (live, fuzzy) first, then on-disk transcripts (recent-first)
 *   summarize        on-disk transcript (by path or sessionId); broker `sessions` enriches live status
 *   open-window      broker command `openWindow` (cold-start; long timeout)
 *   create-worktree  broker command `createWorktree` → extension
 *   spawn            broker command `spawnSession` → extension
 *   send             broker command `sendPrompt` → extension
 *   interrupt        broker command `interrupt` → extension (bulk: query sessions, act-all-and-report)
 *   reveal           broker command `reveal` → extension
 *   schedule         broker/daemon command `schedule`
 *   alert            broker/daemon command `alert`
 */
import { existsSync, statSync } from "node:fs";
import { bool, list, parseArgs, str } from "./args";
import { brokerPort, claudeProjectsDir, loadConfig, loadToken } from "./config";
import { sendCommand } from "./brokerClient";
import type { CommandResult } from "./brokerClient";
import { scanReposForBranch } from "./gitScan";
import {
  findTranscriptBySessionId,
  searchTranscripts,
  summarizeTranscript,
} from "./transcripts";

/** Send a broker command using the ambient config/token; throw on `ok:false`. */
async function broker(
  verb: string,
  args: unknown,
  timeoutMs?: number,
): Promise<unknown> {
  const cfg = loadConfig();
  const res: CommandResult = await sendCommand(
    { port: brokerPort(cfg), token: loadToken(), timeoutMs },
    verb,
    args,
  );
  if (!res.ok) throw new Error(res.error ?? `broker rejected '${verb}'`);
  return res.data;
}

/** Best-effort broker command that swallows errors (for the hybrid verbs). */
async function brokerSoft(verb: string, args: unknown): Promise<unknown | null> {
  try {
    return await broker(verb, args);
  } catch {
    return null;
  }
}

interface LiveSession {
  sessionId?: string | null;
  tabId?: string;
  title?: string;
  cwd?: string;
  status?: string;
  repo?: string;
  [k: string]: unknown;
}

interface WindowEntry {
  repo?: { name?: string };
  worktrees?: Array<{ path?: string; branch?: string; name?: string }>;
  [k: string]: unknown;
}

// --- verb handlers ----------------------------------------------------------

async function cmdWindows(): Promise<unknown> {
  return { windows: await broker("windows", {}) };
}

async function cmdSessions(a: ReturnType<typeof parseArgs>): Promise<unknown> {
  const args: Record<string, string> = {};
  const repo = str(a.flags, "repo");
  const status = str(a.flags, "status");
  if (repo) args.repo = repo;
  if (status) args.status = status;
  return { sessions: await broker("sessions", args) };
}

async function cmdResolveBranch(a: ReturnType<typeof parseArgs>): Promise<unknown> {
  const branch = a._[0];
  if (!branch) throw new Error("usage: ah resolve-branch <branch>");
  const matches: Array<{ repo: string; path: string; source: string }> = [];
  const seen = new Set<string>();
  const add = (repo: string, path: string, source: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    matches.push({ repo, path, source });
  };

  // 1. open windows first
  const windows = (await brokerSoft("windows", {})) as WindowEntry[] | null;
  for (const w of windows ?? []) {
    for (const wt of w.worktrees ?? []) {
      if (wt.branch === branch && wt.path) {
        add(w.repo?.name ?? wt.name ?? "", wt.path, "open-window");
      }
    }
  }

  // 2. configured repo-scan dirs
  const cfg = loadConfig();
  for (const m of scanReposForBranch(cfg.repoScanDirs, branch)) {
    add(m.repo, m.path, "scan-dir");
  }

  return { branch, matches, ambiguous: matches.length > 1 };
}

async function cmdFindSession(a: ReturnType<typeof parseArgs>): Promise<unknown> {
  const query = a._.join(" ").trim();
  if (!query) throw new Error("usage: ah find-session <query>");
  const q = query.toLowerCase();

  // live sessions first
  const live = ((await brokerSoft("sessions", {})) as LiveSession[] | null) ?? [];
  const liveHits = live
    .map((s) => {
      const hay = [s.title, s.cwd, s.repo, s.status].filter(Boolean).join(" ").toLowerCase();
      return { session: s, match: hay.includes(q) || subsequence(q, hay) };
    })
    .filter((x) => x.match)
    .map((x) => ({ source: "live" as const, ...x.session }));

  // then on-disk transcripts, recent-first
  const transcriptHits = searchTranscripts(claudeProjectsDir(), query, 20).map((h) => ({
    source: "transcript" as const,
    ...h,
  }));

  return { query, results: [...liveHits, ...transcriptHits] };
}

function subsequence(q: string, t: string): boolean {
  let ti = 0;
  for (const c of q) {
    const f = t.indexOf(c, ti);
    if (f < 0) return false;
    ti = f + 1;
  }
  return q.length > 0;
}

async function cmdSummarize(a: ReturnType<typeof parseArgs>): Promise<unknown> {
  const target = a._[0];
  if (!target) throw new Error("usage: ah summarize <sessionId|transcriptPath>");

  // explicit transcript path
  if (
    (target.includes("/") || target.endsWith(".jsonl")) &&
    existsSync(target) &&
    statSync(target).isFile()
  ) {
    return {
      summary: summarizeTranscript({
        path: target,
        mtimeMs: statSync(target).mtimeMs,
      }),
    };
  }

  // otherwise a sessionId: enrich with live status (best-effort), summarize from disk
  const live = ((await brokerSoft("sessions", {})) as LiveSession[] | null) ?? [];
  const liveMatch = live.find((s) => s.sessionId === target);
  const file = findTranscriptBySessionId(claudeProjectsDir(), target);
  if (!file) {
    if (liveMatch) {
      return { summary: { sessionId: target, live: liveMatch, note: "no on-disk transcript found" } };
    }
    throw new Error(`no live session or transcript found for '${target}'`);
  }
  return {
    summary: { ...summarizeTranscript(file), live: liveMatch ?? null },
  };
}

async function cmdOpenWindow(a: ReturnType<typeof parseArgs>): Promise<unknown> {
  const repoPath = a._[0];
  if (!repoPath) throw new Error("usage: ah open-window <repoPath>");
  // cold-start can take a while (launch editor + await extension hello)
  return broker("openWindow", { repoPath }, 30000);
}

async function cmdCreateWorktree(a: ReturnType<typeof parseArgs>): Promise<unknown> {
  const [repoRoot, branch] = a._;
  if (!repoRoot || !branch) {
    throw new Error("usage: ah create-worktree <repoRoot> <branch> [--full] [--open tab|window]");
  }
  const open = str(a.flags, "open") === "window" ? "window" : "tab";
  return broker("createWorktree", {
    repoRoot,
    branch,
    full: bool(a.flags, "full"),
    open,
  });
}

async function cmdSpawn(a: ReturnType<typeof parseArgs>): Promise<unknown> {
  const [target, worktreePath] = a._;
  if (!target || !worktreePath) {
    throw new Error("usage: ah spawn <windowId|repo> <worktreePath> --prompt <text> [--attach <path>…]");
  }
  const prompt = str(a.flags, "prompt");
  if (!prompt) throw new Error("ah spawn requires --prompt <text>");
  return broker("spawnSession", {
    target,
    worktreePath,
    prompt,
    attachments: list(a.flags, "attach"),
  });
}

async function cmdSend(a: ReturnType<typeof parseArgs>): Promise<unknown> {
  const sessionId = a._[0];
  const text = str(a.flags, "text");
  if (!sessionId || !text) {
    throw new Error("usage: ah send <sessionId> --text <text> [--attach <path>…]");
  }
  return broker("sendPrompt", {
    sessionId,
    text,
    attachments: list(a.flags, "attach"),
  });
}

async function cmdInterrupt(a: ReturnType<typeof parseArgs>): Promise<unknown> {
  // bulk: --all or --repo R → act on every matching session and report each
  const all = bool(a.flags, "all");
  const repo = str(a.flags, "repo");
  if (all || repo) {
    const args: Record<string, string> = {};
    if (repo) args.repo = repo;
    const sessions = ((await broker("sessions", args)) as LiveSession[]) ?? [];
    const targets = sessions.filter((s) => typeof s.sessionId === "string");
    const results: Array<{ sessionId: string; ok: boolean; error: string | null }> = [];
    for (const s of targets) {
      const sessionId = s.sessionId as string;
      try {
        await broker("interrupt", { sessionId });
        results.push({ sessionId, ok: true, error: null });
      } catch (err) {
        results.push({ sessionId, ok: false, error: errMsg(err) });
      }
    }
    return { scope: all ? "all" : `repo:${repo}`, count: results.length, results };
  }
  const sessionId = a._[0];
  if (!sessionId) {
    throw new Error("usage: ah interrupt <sessionId | --repo R | --all>");
  }
  return broker("interrupt", { sessionId });
}

async function cmdReveal(a: ReturnType<typeof parseArgs>): Promise<unknown> {
  const sessionId = a._[0];
  if (!sessionId) throw new Error("usage: ah reveal <sessionId>");
  return broker("reveal", { sessionId });
}

async function cmdSchedule(a: ReturnType<typeof parseArgs>): Promise<unknown> {
  const spec = a._.join(" ").trim();
  if (!spec) throw new Error("usage: ah schedule <spec>");
  return broker("schedule", { spec });
}

async function cmdAlert(a: ReturnType<typeof parseArgs>): Promise<unknown> {
  const text = a._.join(" ").trim();
  if (!text) throw new Error("usage: ah alert <text>");
  return broker("alert", { text });
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse + run one CLI invocation. Returns the result object to print; throws on
 * usage/broker errors. Exposed for tests (main() wraps it with print + exit).
 */
export async function dispatch(argv: string[]): Promise<unknown> {
  const [verb, ...rest] = argv;
  const a = parseArgs(rest, ["attach"]);
  switch (verb) {
    case "windows":
      return cmdWindows();
    case "sessions":
      return cmdSessions(a);
    case "resolve-branch":
      return cmdResolveBranch(a);
    case "find-session":
      return cmdFindSession(a);
    case "summarize":
      return cmdSummarize(a);
    case "open-window":
      return cmdOpenWindow(a);
    case "create-worktree":
      return cmdCreateWorktree(a);
    case "spawn":
      return cmdSpawn(a);
    case "send":
      return cmdSend(a);
    case "interrupt":
      return cmdInterrupt(a);
    case "reveal":
      return cmdReveal(a);
    case "schedule":
      return cmdSchedule(a);
    case "alert":
      return cmdAlert(a);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return { verbs: VERBS };
    default:
      throw new Error(`unknown verb '${verb}' (try: ${VERBS.join(", ")})`);
  }
}

export const VERBS = [
  "windows",
  "sessions",
  "resolve-branch",
  "find-session",
  "summarize",
  "open-window",
  "create-worktree",
  "spawn",
  "send",
  "interrupt",
  "reveal",
  "schedule",
  "alert",
];

