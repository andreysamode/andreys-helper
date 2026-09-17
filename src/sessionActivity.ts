import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * "Does this session have a subagent that hasn't finished?" — read from the session's
 * own subagent transcripts on disk.
 *
 * WHY THIS EXISTS. A `run_in_background` Agent task is the one kind of work that
 * NOTHING else here can see:
 *
 *  - the webview clears `subagentTasks` when the main turn returns, so the tab reads
 *    idle for the whole wait. The patch's `__wtBgTasks` mirror covers the gap, but
 *    prunes an entry after 10 minutes to protect against a missed completion — and
 *    background reviewers routinely run longer than that (measured on the run that
 *    exposed this, from dispatch to each transcript's last write: 17.5, 20.3, 20.9 and
 *    22.0 minutes — all four well past the prune);
 *  - the process tree can't see them either, because a background subagent runs
 *    INSIDE the CLI process — verified: a session waiting on four of them has no
 *    nested `claude` child, only its idle MCP servers. `backgroundWork.ts` therefore
 *    reports nothing, and its shell signature only flickers when a subagent happens
 *    to be running a Bash tool.
 *
 * What IS unambiguous is the transcript. The CLI writes each subagent's turns to
 * `~/.claude/projects/<slug>/<sessionId>/subagents/agent-<taskId>.jsonl` as they
 * happen, and a FINISHED subagent's file ends with its closing assistant message —
 * `stop_reason: "end_turn"` (verified on four completed reviewers; each file's last
 * write lands within ~3 s of its task-completion notification). A file that ends any
 * other way — mid tool call, awaiting a tool result — belongs to a subagent that is
 * still going.
 *
 * That makes this a STATE signal, not a recency heuristic: "an unfinished subagent
 * exists" is true from the moment the main loop goes quiet, so nothing has to guess
 * whether a gap between writes means finished or thinking. Recency is used only as a
 * backstop, by the caller, for a subagent that was killed mid-run and will never
 * write its closing message.
 *
 * Only subagent transcripts are consulted, never the session's own `.jsonl`: that
 * file is also appended for user actions and main-loop turns, both of which show up
 * as a non-idle tab anyway, so reading it could only add false positives.
 */

/** Re-stat no more often than this; `tabs()` can be called many times a second. */
const RECHECK_MS = 1000;
/**
 * How long a FAILED project-dir lookup is trusted before trying again. A found dir is
 * cached for good (a session's project doesn't move), but a miss must expire: the dir
 * appears when Claude first writes for that session, which can be after we look.
 */
const PROJECT_RETRY_MS = 30_000;
/**
 * Soft bound on how many transcripts one probe looks at. A long session accumulates
 * one file per subagent it ever ran, and a session with hundreds of them is not worth
 * a proportionally longer loop on the repaint path.
 */
const MAX_FILES = 256;
/**
 * How much of a transcript's end is read to classify it. Entries are one JSON object
 * per line and a single line can be large (a whole tool result), so this reads enough
 * to contain the last few of them and works from the last COMPLETE line it finds.
 */
const TAIL_BYTES = 64 * 1024;

export interface FileVerdict {
  /** Identity of the bytes this verdict was computed from. */
  mtimeMs: number;
  size: number;
  /** Whether the file ends with a subagent's closing assistant message. */
  finished: boolean;
}

interface SessionProbe {
  /** Newest mtime among transcripts that are NOT finished; undefined if none. */
  unfinishedWriteAt: number | undefined;
  /** When we last looked. */
  checkedAt: number;
}

interface ProjectDir {
  /** Claude's project dir for a worktree, or null when we couldn't find one. */
  dir: string | null;
  /** When we resolved it — only a null is ever re-resolved. */
  at: number;
}

/**
 * Claude's project-directory name for a worktree: the absolute path with every `/`
 * turned into `-` (`/Users/a/dev/x` → `-Users-a-dev-x`). Verified against all 71
 * project dirs on this machine. It is only ever a FIRST GUESS — a path containing
 * characters this rule doesn't cover falls back to a scan — so it can be wrong
 * without costing correctness.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/**
 * Whether a subagent transcript's last complete entry is its closing message.
 *
 * Anything we cannot read or parse counts as UNFINISHED. The caller pairs this with a
 * staleness bound, so the cost of that choice is a spinner that lingers for a while
 * on a file we can't understand — whereas the opposite default would report a session
 * finished while its agents are demonstrably still writing, which is the bug this
 * whole module exists to fix.
 */
export function tailIsFinished(tail: string): boolean {
  const nl = tail.lastIndexOf("\n");
  // Work from the last COMPLETE line: a fixed-size tail read usually starts
  // mid-entry, and the final line may itself be a partial write in flight.
  const upToLastComplete = nl === -1 ? tail : tail.slice(0, nl);
  const lines = upToLastComplete.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || !line.startsWith("{")) {
      continue;
    }
    let entry: { type?: unknown; message?: { stop_reason?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      // A truncated first line is expected; anything else means we are looking at
      // something we don't understand, and "unfinished" is the safe read.
      return false;
    }
    return entry.type === "assistant" && entry.message?.stop_reason === "end_turn";
  }
  return false;
}

/** Read the last {@link TAIL_BYTES} of a file as UTF-8; "" when unreadable. */
function readTail(file: string, size: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.allocUnsafe(len);
    const read = fs.readSync(fd, buf, 0, len, Math.max(0, size - len));
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // nothing to do
      }
    }
  }
}

/**
 * The project dir holding `<sessionId>.jsonl`. Locating a session by its own
 * transcript (rather than by its subagents dir) works whether or not it has ever run
 * a subagent, which is what makes this a usable fallback for a cwd whose slug we
 * derived wrongly.
 */
function findProjectBySession(root: string, sessionId: string): string | null {
  let projects: string[];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const p of projects) {
    const dir = path.join(root, p);
    if (fs.existsSync(path.join(dir, `${sessionId}.jsonl`))) {
      return dir;
    }
  }
  return null;
}

/**
 * Newest mtime among the transcripts in `dir` that haven't closed out, or undefined
 * when every one of them has (or the dir can't be read).
 *
 * `verdicts` is the caller's per-file memo, keyed by path and validated against
 * (mtime, size): a transcript whose bytes haven't moved is not re-read, so steady
 * state costs one `stat` per file rather than a tail read.
 */
export function newestUnfinishedWrite(
  dir: string,
  verdicts: Map<string, FileVerdict>
): number | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  let newest: number | undefined;
  let seen = 0;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    if (++seen > MAX_FILES) {
      break;
    }
    const file = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue; // raced with a rotation/delete
    }
    if (newest !== undefined && stat.mtimeMs <= newest) {
      // Can't beat what we already have, so its verdict can't change the answer.
      continue;
    }
    const cached = verdicts.get(file);
    const finished =
      cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
        ? cached.finished
        : tailIsFinished(readTail(file, stat.size));
    verdicts.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, finished });
    if (!finished) {
      newest = stat.mtimeMs;
    }
  }
  return newest;
}

export class SessionActivityProbe {
  private readonly sessions = new Map<string, SessionProbe>();
  /** worktree cwd → Claude's project dir for it. */
  private readonly projects = new Map<string, ProjectDir>();
  /** file path → verdict for the exact bytes it had when we classified it. */
  private readonly verdicts = new Map<string, FileVerdict>();

  /**
   * Newest write to a subagent transcript of this session that hasn't finished, or
   * undefined when every subagent has closed out (or the session never ran one).
   *
   * Synchronous by design — it sits on the same repaint path as `tabs()` — but the
   * whole answer is memoized for {@link RECHECK_MS}, each file's verdict is memoized
   * against its (mtime, size) so steady state costs one `stat` per file, and the
   * caller only asks about tabs that read idle.
   */
  unfinishedSubagentWriteAt(
    sessionId: string | undefined,
    cwd: string | undefined,
    now: number
  ): number | undefined {
    if (!sessionId || !cwd) {
      return undefined;
    }
    const hit = this.sessions.get(sessionId);
    if (hit && now - hit.checkedAt < RECHECK_MS) {
      return hit.unfinishedWriteAt;
    }
    // Deliberately re-checked every pass, not cached like the project dir: a session
    // that has never run a subagent has no such dir, and gets one the moment it does.
    const project = this.projectDir(cwd, sessionId, now);
    const dir = project === null ? null : path.join(project, sessionId, "subagents");
    const unfinishedWriteAt =
      dir !== null && fs.existsSync(dir) ? newestUnfinishedWrite(dir, this.verdicts) : undefined;
    this.sessions.set(sessionId, { unfinishedWriteAt, checkedAt: now });
    return unfinishedWriteAt;
  }

  /** Drop cache entries for sessions that are no longer open. */
  prune(liveSessionIds: Set<string>): void {
    for (const id of [...this.sessions.keys()]) {
      if (!liveSessionIds.has(id)) {
        this.sessions.delete(id);
      }
    }
    // Per-file verdicts are keyed by path, which carries the session id.
    for (const file of [...this.verdicts.keys()]) {
      if (![...liveSessionIds].some((id) => file.includes(id))) {
        this.verdicts.delete(file);
      }
    }
  }

  /**
   * Claude's project dir for a worktree: the slug rule first, then — because that rule
   * is inferred from observation rather than documented — a scan for the dir holding
   * this session's own transcript. The scan is the expensive path, so it is what the
   * caching is for: a hit is kept for good, and a miss is retried only every
   * {@link PROJECT_RETRY_MS} rather than on every poll.
   */
  private projectDir(cwd: string, sessionId: string, now: number): string | null {
    const hit = this.projects.get(cwd);
    if (hit && (hit.dir !== null || now - hit.at < PROJECT_RETRY_MS)) {
      return hit.dir;
    }
    const root = path.join(os.homedir(), ".claude", "projects");
    const direct = path.join(root, projectSlug(cwd));
    const dir = fs.existsSync(direct) ? direct : findProjectBySession(root, sessionId);
    this.projects.set(cwd, { dir, at: now });
    return dir;
  }
}
