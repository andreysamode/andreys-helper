import * as vscode from "vscode";
import { execFile } from "child_process";

/**
 * Process-tree background-work monitor — the herdr mechanism, adapted to our
 * (webview, not PTY) environment, with per-tab precision.
 *
 * Why this exists: the Claude patch derives a tab's status from webview / host
 * lifecycle signals (busy, subagentTasks, update_session_state edges). Those go
 * quiet the moment the MAIN agent loop returns a result — but a `run_in_background`
 * shell (a dev server, a test run, a build) keeps running under the CLI, invisible
 * to the webview (applyWebviewStatus admits this). The tab then flips to the "done"
 * check while work is still happening. herdr solved the same problem by watching the
 * OS process tree of each pane; it owns the PTY, so the pane→process mapping is
 * unambiguous. We have no PTY, but we DO run in the same extension host that is the
 * parent of every `claude` agent process, so we can walk the same tree — and the
 * env-tag patch (WT_TAB_ID) gives us herdr's unambiguous tab→process mapping.
 *
 * Topology (Cursor 2.1.x, macOS), verified:
 *   extension-host (our process.pid)
 *     └─ native-binary/claude            (one per tab; env carries WT_TAB_ID=<tab id>)
 *         ├─ /bin/bash -c source …/shell-snapshots/snapshot-…   (Bash tool — fg OR bg)
 *         └─ node …/mcp-or-plugin/start.mjs                      (persistent server)
 * A `run_in_background` shell stays a CHILD of its claude process (it does NOT
 * reparent to init). Persistent MCP/plugin servers are children too, but they don't
 * carry the `shell-snapshots/snapshot-` signature that every Claude Bash invocation
 * does — so matching that signature isolates real tool/background work from idle
 * servers.
 *
 * Tab attribution is EXACT: the patch stamps `WT_TAB_ID=<panel __wtId>` into each
 * agent's environment (applyEnvTag), and a tab's `ClaudeTab.id` IS that __wtId. We
 * read WT_TAB_ID back from the agent process (once per long-lived agent, cached) and
 * key everything by it — so two sessions sharing one worktree are told apart. WT_TAB_ID
 * is per-host unique (a per-host seq), so we still only consider agents parented by
 * OUR extension host, which also scopes the walk to this window's tabs.
 *
 * The signal is only ever used to UPGRADE a tab from done/idle to working (see
 * ClaudeStatusService.tabs) — never to downgrade — so a foreground tool shell during
 * an active turn (when the webview already says "working") changes nothing. It
 * matters only when the webview has gone quiet but a shell is still alive.
 */

/** Command-substring that identifies the claude agent process (one per tab). */
const CLAUDE_PROC_MATCH = "native-binary/claude";
/**
 * Descendant signatures that mean the agent still has real work in flight, even
 * after the main loop went quiet. Two kinds:
 *  - a Claude Bash tool invocation (`shell-snapshots/snapshot-`) — a foreground or
 *    `run_in_background` shell (dev server, test run, build);
 *  - a NESTED agent process (`native-binary/claude` under the main agent) — a
 *    background Task subagent, which spawns its own claude process and stays alive
 *    while it works, even when it never runs a shell itself. Idle MCP/plugin servers
 *    are `node …/start.mjs` and match neither, so they don't trip the signal.
 *
 * A match also ENDS the descent (see collectWorkPids): the matched process is the
 * job, and it is the one whose age the promotion ceiling is measured on — a nested
 * subagent is aged by its own process, not by whichever shell it happens to be
 * running at the moment we look.
 */
const WORK_SIGNATURES = ["shell-snapshots/snapshot-", "native-binary/claude"];
/** Poll cadence — matches the existing status poll (1.5s) so repaints coalesce. */
const POLL_MS = 1500;
/**
 * Release grace: keep a tab "working" this long after its last live shell vanishes,
 * so the gap between two sequential background commands (or a shell exec/replace
 * blip) doesn't fl\ash the completion check. herdr's AgentDetectionPresence uses the
 * same miss-confirmation idea to debounce Working→Idle. MUST exceed POLL_MS with
 * margin, else a continuously-alive shell (re-stamped once per poll) would flicker
 * "quiet" in the gap between two polls.
 */
const RELEASE_GRACE_MS = 3000;

interface Proc {
  pid: number;
  ppid: number;
  cmd: string;
}

/** What the poller knows about one tab's live background work. */
interface TabWork {
  /** Poll time at which this tab last had a live work process. */
  at: number;
  /**
   * When the YOUNGEST of those processes was first observed, epoch ms — what the
   * promotion ceiling ages the shell by (see bgPromote.stepBgPromotion).
   *
   * `0` when it was already there on our FIRST poll: its true start is unknown and
   * no younger than this monitor, so it can never read as fresh work. That is the
   * conservative direction on purpose — a dev server left over from before a window
   * reload must not be mistaken for a job the turn just launched. The cost is that a
   * genuine background build straddling a reload stops holding the spinner, which is
   * a bounded misreport; the alternative is a spinner with no way out.
   */
  startedAt: number;
}

export class BackgroundWorkMonitor implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires when the set of tabs with live background work changes. */
  readonly onDidChange = this._onDidChange.event;

  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  /** tab id (WT_TAB_ID / __wtId) → its agent's live background work, as last polled. */
  private lastActive = new Map<string, TabWork>();
  /**
   * Work-process pid → when we first saw it (0 = it predates our first poll).
   *
   * Age has to be observed rather than read off the process table: macOS `ps` has no
   * `etimes`, and `lstart` is a locale-formatted, space-bearing field that would have
   * to be parsed out of the same line as the command. Polling every 1.5 s dates every
   * process that starts while we are watching, exactly, and the one case it cannot
   * date — a process that predates us — is precisely the one we want to treat as old.
   */
  private firstSeen = new Map<number, number>();
  /** Whether a poll has completed, i.e. whether firstSeen can date a new pid. */
  private polledOnce = false;
  /** agent pid → WT_TAB_ID, cached for the process's lifetime (env read is dear). */
  private tabIdCache = new Map<number, string | undefined>();
  /** Serialized set of currently-working tab ids, to detect edges for onDidChange. */
  private lastSerialized = "";

  start(): void {
    if (this.timer) {
      return;
    }
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this._onDidChange.dispose();
  }

  /**
   * When this tab's youngest live background work process was first observed, or
   * undefined when it has none (within the release grace window).
   *
   * The AGE, not just the presence, is what the caller needs: a shell that has been
   * alive far longer than any plausible turn cannot be work the turn is waiting on.
   * Reporting the timestamp rather than a verdict keeps the monitor truthful and the
   * policy in one place — see stepBgPromotion.
   *
   * Synchronous and cheap: reads the cache the poller maintains.
   */
  shellWorkStartedAt(tabId: string | undefined): number | undefined {
    if (!tabId) {
      return undefined;
    }
    const work = this.lastActive.get(tabId);
    if (work === undefined || Date.now() - work.at >= RELEASE_GRACE_MS) {
      return undefined;
    }
    return work.startedAt;
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const procs = await psSnapshot();
      if (!procs) {
        return;
      }
      const byPid = new Map<number, Proc>();
      const children = new Map<number, number[]>();
      for (const p of procs) {
        byPid.set(p.pid, p);
        const kids = children.get(p.ppid);
        if (kids) {
          kids.push(p.pid);
        } else {
          children.set(p.ppid, [p.pid]);
        }
      }

      // Our window's claude agents = claude procs whose parent is THIS host.
      const self = process.pid;
      const claudePids = (children.get(self) ?? []).filter((pid) =>
        byPid.get(pid)?.cmd.includes(CLAUDE_PROC_MATCH)
      );

      // Drop tab-id-cache entries for agents that have exited.
      for (const pid of [...this.tabIdCache.keys()]) {
        if (!byPid.has(pid)) {
          this.tabIdCache.delete(pid);
        }
      }

      const now = Date.now();
      const activeTabs = new Set<string>();
      const liveWorkPids = new Set<number>();
      for (const claudePid of claudePids) {
        const workPids = collectWorkPids(claudePid, children, byPid);
        if (workPids.length === 0) {
          continue;
        }
        // Date each process the first time it shows up, and carry the YOUNGEST of
        // them for the tab: one fresh background build is live work even when an
        // ancient dev server is sitting alongside it in the same tree.
        let youngest = 0;
        for (const pid of workPids) {
          liveWorkPids.add(pid);
          let seen = this.firstSeen.get(pid);
          if (seen === undefined) {
            seen = this.polledOnce ? now : 0;
            this.firstSeen.set(pid, seen);
          }
          if (seen > youngest) {
            youngest = seen;
          }
        }
        const tabId = await this.tabIdFor(claudePid);
        if (tabId) {
          activeTabs.add(tabId);
          this.lastActive.set(tabId, { at: now, startedAt: youngest });
        }
      }
      this.polledOnce = true;

      // Forget processes that have exited — both to bound the map and so a RECYCLED
      // pid is dated afresh instead of inheriting the dead process's age.
      for (const pid of [...this.firstSeen.keys()]) {
        if (!liveWorkPids.has(pid)) {
          this.firstSeen.delete(pid);
        }
      }
      // Prune long-stale entries so the map can't grow unbounded across sessions.
      for (const [id, work] of [...this.lastActive]) {
        if (now - work.at > RELEASE_GRACE_MS * 4) {
          this.lastActive.delete(id);
        }
      }

      const serialized = [...activeTabs].sort().join("\n");
      if (serialized !== this.lastSerialized) {
        this.lastSerialized = serialized;
        this._onDidChange.fire();
      }
    } catch {
      // best-effort; a failed poll just leaves the last snapshot in place
    } finally {
      this.polling = false;
    }
  }

  /** Resolve (and cache) an agent's owning tab id from its WT_TAB_ID env var. */
  private async tabIdFor(pid: number): Promise<string | undefined> {
    if (this.tabIdCache.has(pid)) {
      return this.tabIdCache.get(pid);
    }
    const id = await readTabIdEnv(pid);
    this.tabIdCache.set(pid, id);
    return id;
  }
}

/**
 * DFS a claude agent's descendants for live work — Bash tool shells and nested
 * subagent processes (see WORK_SIGNATURES). Returns every match, because the caller
 * needs the youngest one's age and not merely whether any exists.
 *
 * A matched process is not descended into: it IS the job, and its own children
 * (the command the shell is running, a subagent's shells) are parts of it rather
 * than separate work with their own ages.
 */
function collectWorkPids(
  root: number,
  children: Map<number, number[]>,
  byPid: Map<number, Proc>
): number[] {
  const found: number[] = [];
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const pid = stack.pop()!;
    const cmd = byPid.get(pid)?.cmd ?? "";
    if (WORK_SIGNATURES.some((sig) => cmd.includes(sig))) {
      found.push(pid);
      continue;
    }
    const kids = children.get(pid);
    if (kids) {
      stack.push(...kids);
    }
  }
  return found;
}

/** One system-wide process snapshot: pid, ppid, full command. */
function psSnapshot(): Promise<Proc[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-Ao", "pid=,ppid=,command="],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(undefined);
          return;
        }
        const out: Proc[] = [];
        for (const line of stdout.split("\n")) {
          const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
          if (m) {
            out.push({ pid: +m[1], ppid: +m[2], cmd: m[3] });
          }
        }
        resolve(out);
      }
    );
  });
}

/**
 * Read the WT_TAB_ID env var (stamped by the env-tag patch) from a process, mapping
 * an agent to its owning tab. macOS: `ps -Ewww` prints the full environment after
 * the command; Linux: `/proc/<pid>/environ` is NUL-separated. Returns undefined for
 * an unpatched/older agent (no WT_TAB_ID) — the caller then reports no signal for it
 * rather than guessing, so nothing is ever mis-attributed.
 */
function readTabIdEnv(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    return new Promise((resolve) => {
      execFile("cat", [`/proc/${pid}/environ`], { maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) {
          resolve(undefined);
          return;
        }
        const hit = stdout.split("\0").find((kv) => kv.startsWith("WT_TAB_ID="));
        resolve(hit ? hit.slice("WT_TAB_ID=".length) : undefined);
      });
    });
  }
  return new Promise((resolve) => {
    execFile("ps", ["-Ewww", "-p", String(pid)], { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) {
        resolve(undefined);
        return;
      }
      const m = stdout.match(/WT_TAB_ID=(\S+)/);
      resolve(m ? m[1] : undefined);
    });
  });
}
