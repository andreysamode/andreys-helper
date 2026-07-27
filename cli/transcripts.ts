/**
 * On-disk Claude transcript search + summarization for `ah find-session` and
 * `ah summarize` (PLAN.md §2, §6.3).
 *
 * Transcripts live at `~/.claude/projects/<slug>/<sessionId>.jsonl`, one JSON
 * object per line. We scan recursively, sort most-recent-first by mtime, and
 * parse just enough of each file to (a) fuzzy-match a query and (b) build a short
 * summary. Large files are read head+tail (bounded byte windows) rather than
 * loaded whole, so scanning stays cheap.
 */
import {
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
/** Files at or below this size are read whole (enables exact message counts). */
const FULL_READ_MAX = 1024 * 1024;
/** Cap on how many transcript files a single search will parse. */
const SCAN_CAP = 500;

export interface TranscriptFile {
  path: string;
  mtimeMs: number;
}

export interface TranscriptMeta {
  path: string;
  mtimeMs: number;
  sessionId: string | null;
  /** A `summary` line if the transcript has one (Claude's auto-title). */
  title: string | null;
  /** First user message text (trimmed, may be truncated). */
  firstUserMessage: string;
  cwd: string | null;
}

export interface TranscriptSummary extends TranscriptMeta {
  /** ISO mtime for display. */
  mtime: string;
  /** Last user/assistant message text (trimmed, truncated). */
  lastMessage: string;
  /** Count of user/assistant lines, or null when the file was too big to read whole. */
  messageCount: number | null;
}

export interface SearchHit extends TranscriptMeta {
  mtime: string;
  score: number;
}

/** Recursively list `*.jsonl` transcripts, most-recent-first by mtime. */
export function listTranscriptFiles(root: string): TranscriptFile[] {
  const out: TranscriptFile[] = [];
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          out.push({ path: p, mtimeMs: statSync(p).mtimeMs });
        } catch {
          /* skip unreadable */
        }
      }
    }
  };
  walk(root);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

interface HeadTail {
  head: string;
  tail: string;
  size: number;
}

function readHeadTail(path: string): HeadTail {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const headLen = Math.min(HEAD_BYTES, size);
    const headBuf = Buffer.alloc(headLen);
    if (headLen > 0) readSync(fd, headBuf, 0, headLen, 0);
    let tail = "";
    if (size > HEAD_BYTES) {
      const tailLen = Math.min(TAIL_BYTES, size);
      const tailBuf = Buffer.alloc(tailLen);
      readSync(fd, tailBuf, 0, tailLen, size - tailLen);
      tail = tailBuf.toString("utf8");
    }
    return { head: headBuf.toString("utf8"), tail, size };
  } finally {
    closeSync(fd);
  }
}

/** Split a byte-window into complete JSONL lines, dropping partial edges. */
function completeLines(
  chunk: string,
  truncatedStart: boolean,
  truncatedEnd: boolean,
): string[] {
  let lines = chunk.split("\n");
  if (truncatedStart && lines.length) lines = lines.slice(1);
  if (truncatedEnd && lines.length) lines = lines.slice(0, -1);
  return lines.filter((l) => l.trim().length > 0);
}

/** Flatten a Claude message `content` (string | block[]) into plain text. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object") {
          const blk = b as Record<string, unknown>;
          if (typeof blk.text === "string") return blk.text;
          if (blk.type === "tool_result" && blk.content) {
            return contentToText(blk.content);
          }
        }
        return "";
      })
      .join(" ");
  }
  return "";
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

interface RawEntry {
  type?: string;
  summary?: string;
  sessionId?: string;
  cwd?: string;
  message?: { role?: string; content?: unknown };
}

function parseLine(line: string): RawEntry | null {
  try {
    return JSON.parse(line) as RawEntry;
  } catch {
    return null;
  }
}

/** Parse the head of a transcript into lightweight match/display metadata. */
export function parseTranscriptMeta(file: TranscriptFile): TranscriptMeta {
  const { head, size } = readHeadTail(file.path);
  const headLines = completeLines(head, false, size > head.length);
  let sessionId: string | null = null;
  let title: string | null = null;
  let firstUserMessage = "";
  let cwd: string | null = null;
  for (const line of headLines) {
    const e = parseLine(line);
    if (!e) continue;
    if (!sessionId && typeof e.sessionId === "string") sessionId = e.sessionId;
    if (!cwd && typeof e.cwd === "string") cwd = e.cwd;
    if (!title && e.type === "summary" && typeof e.summary === "string") {
      title = e.summary;
    }
    if (!firstUserMessage && e.type === "user" && e.message) {
      firstUserMessage = truncate(contentToText(e.message.content), 400);
    }
  }
  // Fall back to the filename (Claude names transcripts by session uuid).
  if (!sessionId) {
    const base = basename(file.path).replace(/\.jsonl$/, "");
    if (base) sessionId = base;
  }
  return {
    path: file.path,
    mtimeMs: file.mtimeMs,
    sessionId,
    title,
    firstUserMessage,
    cwd,
  };
}

/**
 * Fuzzy relevance score of `query` against `text`. Returns 0 for no match, a
 * positive number otherwise: substring matches score highest (earlier = better),
 * then subsequence matches. An empty query matches everything with a tiny
 * baseline so recency ordering dominates.
 */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0.001;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 2 + 1 / (1 + idx);
  // subsequence
  let ti = 0;
  let matched = 0;
  for (const c of q) {
    const found = t.indexOf(c, ti);
    if (found < 0) return 0;
    ti = found + 1;
    matched++;
  }
  return 1 + matched / (t.length + 1);
}

/**
 * Search transcripts for `query`, most-recent-first. Files are already sorted by
 * mtime desc; we keep only matches and preserve that recency order (recency is
 * the primary key, per §2 "most-recent-first"), attaching the fuzzy score.
 */
export function searchTranscripts(
  root: string,
  query: string,
  limit = 20,
): SearchHit[] {
  const files = listTranscriptFiles(root).slice(0, SCAN_CAP);
  const hits: SearchHit[] = [];
  for (const f of files) {
    const meta = parseTranscriptMeta(f);
    const hay = [meta.title, meta.firstUserMessage, meta.cwd]
      .filter(Boolean)
      .join("\n");
    const score = fuzzyScore(query, hay);
    if (query && score <= 0) continue;
    hits.push({ ...meta, mtime: new Date(f.mtimeMs).toISOString(), score });
    if (hits.length >= limit) break; // files are recency-sorted, so this is the recent-first top-N
  }
  return hits;
}

/** Locate a transcript by session id (filename first, then parsed metadata). */
export function findTranscriptBySessionId(
  root: string,
  sessionId: string,
): TranscriptFile | null {
  const files = listTranscriptFiles(root);
  const byName = files.find(
    (f) => basename(f.path) === `${sessionId}.jsonl`,
  );
  if (byName) return byName;
  for (const f of files.slice(0, SCAN_CAP)) {
    if (parseTranscriptMeta(f).sessionId === sessionId) return f;
  }
  return null;
}

/** Build a short summary of one transcript (§6.3 `summarize`). */
export function summarizeTranscript(file: TranscriptFile): TranscriptSummary {
  const size = statSync(file.path).size;
  let headLines: string[];
  let tailLines: string[];
  let messageCount: number | null = null;

  if (size <= FULL_READ_MAX) {
    const all = readFileSync(file.path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    headLines = all;
    tailLines = all;
    messageCount = all.filter((l) => {
      const e = parseLine(l);
      return e?.type === "user" || e?.type === "assistant";
    }).length;
  } else {
    const { head, tail } = readHeadTail(file.path);
    headLines = completeLines(head, false, true);
    tailLines = completeLines(tail, true, false);
  }

  let sessionId: string | null = null;
  let title: string | null = null;
  let firstUserMessage = "";
  let cwd: string | null = null;
  for (const line of headLines) {
    const e = parseLine(line);
    if (!e) continue;
    if (!sessionId && typeof e.sessionId === "string") sessionId = e.sessionId;
    if (!cwd && typeof e.cwd === "string") cwd = e.cwd;
    if (!title && e.type === "summary" && typeof e.summary === "string") {
      title = e.summary;
    }
    if (!firstUserMessage && e.type === "user" && e.message) {
      firstUserMessage = truncate(contentToText(e.message.content), 400);
    }
  }

  let lastMessage = "";
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const e = parseLine(tailLines[i]);
    if (e && (e.type === "user" || e.type === "assistant") && e.message) {
      const text = truncate(contentToText(e.message.content), 400);
      if (text) {
        lastMessage = text;
        break;
      }
    }
  }

  if (!sessionId) {
    const base = basename(file.path).replace(/\.jsonl$/, "");
    if (base) sessionId = base;
  }

  return {
    path: file.path,
    mtimeMs: file.mtimeMs,
    mtime: new Date(file.mtimeMs).toISOString(),
    sessionId,
    title,
    firstUserMessage,
    cwd,
    lastMessage,
    messageCount,
  };
}
