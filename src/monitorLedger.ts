import * as fs from "fs";
import { StringDecoder } from "string_decoder";

/**
 * Which `Monitor` tool watches a session still has armed — read from the session's
 * own transcript (`<project>/<sessionId>.jsonl`).
 *
 * WHY THIS EXISTS. The process-tree promotion (bgPromote.ts) caps a live shell at 10
 * minutes, because a shell on its own can't say whether it will ever exit. A Monitor
 * can: the agent DECLARES its bound up front (`timeout_ms`) and the CLI kills it at that
 * deadline. Observed 2026-11-17: a session launched a ~15-min test gate detached, armed
 * a 30-min Monitor on its log, and said "I'll report when it finishes". The Monitor's
 * `tail -f` was alive under the tab's agent the whole time, but it was older than the
 * 10-min ceiling, so the Source+ box showed the completion check mid-gate.
 *
 * Both ends of a Monitor are in the transcript:
 *  - start: an assistant `tool_use` named `Monitor` with `input.timeout_ms` (default
 *    300 000, capped at 1 800 000 by the tool) — or `persistent: true`, an open-ended
 *    watcher that, like a dev server, must NOT hold a spinner;
 *  - end: a `<task-notification>` carrying `<tool-use-id>` and `<status>` ("stream
 *    ended", expiry, kill). Per-event notifications carry only `<task-id>`, never the
 *    tool-use id, so they don't close anything.
 * The deadline bounds the promotion even when the end notice is missed.
 */

/** Monitor's documented default and cap for `timeout_ms`. */
export const MONITOR_DEFAULT_TIMEOUT_MS = 300_000;
export const MONITOR_MAX_TIMEOUT_MS = 1_800_000;

/**
 * How much of an existing transcript the FIRST read covers. Transcripts reach hundreds
 * of MB and this runs on the repaint path; a Monitor lives at most 30 minutes, so only
 * the recent end can hold one. A Monitor declared further back than this is missed —
 * the tab then falls back to the plain 10-min shell ceiling, a bounded misreport.
 */
const INITIAL_TAIL_BYTES = 16 * 1024 * 1024;
/** Read appended bytes in chunks of this size. */
const CHUNK_BYTES = 1024 * 1024;

const TOOL_USE_ID = /<tool-use-id>([^<]+)<\/tool-use-id>/g;

/**
 * Feed one transcript line into the open-monitor map (tool-use id → deadline, epoch ms).
 * Cheap substring checks gate the JSON parse, so ordinary lines cost almost nothing.
 */
export function applyTranscriptLine(line: string, open: Map<string, number>): void {
  if (line.includes('"name":"Monitor"')) {
    let entry: {
      type?: unknown;
      timestamp?: unknown;
      message?: { content?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) {
      return;
    }
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(at)) {
      return;
    }
    for (const item of entry.message!.content as Array<Record<string, unknown>>) {
      if (item?.type !== "tool_use" || item.name !== "Monitor" || typeof item.id !== "string") {
        continue;
      }
      const input = (item.input ?? {}) as { timeout_ms?: unknown; persistent?: unknown };
      if (input.persistent === true) {
        continue; // open-ended watcher — not work anyone is waiting on
      }
      const requested =
        typeof input.timeout_ms === "number" && input.timeout_ms > 0
          ? input.timeout_ms
          : MONITOR_DEFAULT_TIMEOUT_MS;
      open.set(item.id, at + Math.min(requested, MONITOR_MAX_TIMEOUT_MS));
    }
    return;
  }
  // A terminal notice is copied into several entries (queue ops, attachments);
  // closing is idempotent, so any of them will do.
  if (line.includes("<task-notification>") && line.includes("<status>")) {
    for (const m of line.matchAll(TOOL_USE_ID)) {
      open.delete(m[1]);
    }
  }
}

/** Incremental reader over one session transcript. */
export class MonitorLedger {
  private offset = -1;
  private partial = "";
  /** Persists across reads so a multibyte char split at a chunk/append boundary survives. */
  private decoder = new StringDecoder("utf8");
  private readonly open = new Map<string, number>();

  constructor(private readonly file: string) {}

  /** Latest deadline among armed Monitors that haven't expired, or undefined. */
  openDeadline(now: number): number | undefined {
    this.catchUp();
    let latest: number | undefined;
    for (const [id, deadline] of this.open) {
      if (deadline <= now) {
        this.open.delete(id);
      } else if (latest === undefined || deadline > latest) {
        latest = deadline;
      }
    }
    return latest;
  }

  private catchUp(): void {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size < this.offset) {
      // Rewritten/truncated — start over.
      this.offset = -1;
      this.partial = "";
      this.decoder = new StringDecoder("utf8");
      this.open.clear();
    }
    let skipFirstLine = false;
    if (this.offset < 0) {
      this.offset = Math.max(0, size - INITIAL_TAIL_BYTES);
      skipFirstLine = this.offset > 0; // a mid-file start lands mid-line
    }
    if (size === this.offset) {
      return;
    }
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.file, "r");
      const buf = Buffer.allocUnsafe(CHUNK_BYTES);
      const decoder = this.decoder;
      while (this.offset < size) {
        const read = fs.readSync(fd, buf, 0, Math.min(CHUNK_BYTES, size - this.offset), this.offset);
        if (read <= 0) {
          break;
        }
        this.offset += read;
        let text = this.partial + decoder.write(buf.subarray(0, read));
        if (skipFirstLine) {
          const nl = text.indexOf("\n");
          if (nl === -1) {
            this.partial = "";
            continue;
          }
          text = text.slice(nl + 1);
          skipFirstLine = false;
        }
        const lines = text.split("\n");
        this.partial = lines.pop() ?? "";
        for (const line of lines) {
          applyTranscriptLine(line, this.open);
        }
      }
    } catch {
      // best-effort; keep whatever we have
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
}
