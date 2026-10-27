/**
 * The matcher behind the per-worktree "Open File…" picker — a stand-in for the
 * one Quick Open (⌘P) uses, which VS Code does not expose to extensions.
 *
 * A plain QuickPick is NOT the same thing. Its built-in filter is a single
 * contiguous-ish fuzzy pass over the label; type "mirror scm" and it finds
 * nothing, because no label contains that sequence. ⌘P splits the query on
 * whitespace and requires EVERY term to hit somewhere in the item (in any
 * order), then ranks by how good the hits were. That's what this reproduces:
 *
 *   - whitespace splits the query into terms, ANDed, order-independent;
 *   - a term with no "/" is matched against the file name first and the full
 *     path only as a fallback, so "view" ranks `fooView.ts` above `view/a.ts`;
 *   - a term with a "/" is matched against the full relative path;
 *   - matching is subsequence-fuzzy, scored so that contiguous runs, word
 *     starts (`/ - _ . ` and camelCase humps) and exact case beat scattered
 *     hits, and whole-word/prefix/exact matches beat everything;
 *   - a trailing `:line` or `:line:col` is peeled off as a cursor target, the
 *     way ⌘P treats it, instead of being matched as text.
 *
 * Pure — no `vscode` import — so `filePickMatch.test.ts` can exercise the
 * ranking directly under `node --test`.
 */

/** Character codes after which the next character starts a new "word". */
const BOUNDARY_AFTER_CODES = new Set([
  47 /* / */, 92 /* \\ */, 45 /* - */, 95 /* _ */, 46 /* . */, 32 /* space */, 64 /* @ */, 43 /* + */,
]);

// Per-character scores inside a fuzzy run.
const CHAR_BASE = 1;
const CONTIGUOUS_BONUS = 8;
const BOUNDARY_BONUS = 10;
const FIRST_CHAR_BONUS = 12;
const GAP_PENALTY = 3;

// Whole-match bonuses, large enough to dominate per-character scoring.
const EXACT_BONUS = 400;
const PREFIX_BONUS = 200;
const SUBSTRING_BONUS = 80;
const SUBSTRING_BOUNDARY_BONUS = 60;
/** Matching the file name beats matching some directory above it. */
const BASENAME_BONUS = 50;
/** Gitignored files are listed, but lose a tie to a tracked one — build output
 *  and stray .DS_Stores shouldn't elbow ahead of source. Small enough that a
 *  genuinely better match on an ignored file (".env.local") still wins. */
const IGNORED_PENALTY = 30;

export interface FileQuery {
  /** Whitespace-separated terms, all of which must match. Empty = match all. */
  terms: string[];
  /** 1-based line from a trailing `:line`, if the query carried one. */
  line?: number;
  /** 1-based column from a trailing `:line:col`. */
  col?: number;
}

/**
 * Split a raw picker query the way ⌘P does: a trailing `:line[:col]` is a
 * cursor target rather than text to match, and the rest splits on whitespace.
 * The suffix is only honored when something precedes it, so a bare ":12" stays
 * a search term (there is no file to go to line 12 of).
 */
export function parseFileQuery(raw: string): FileQuery {
  let text = raw.trim();
  let line: number | undefined;
  let col: number | undefined;
  // Lazy prefix: on "a.ts:42:7" a greedy one swallows ":42" and reads 7 as the
  // line. Shortest-prefix-first makes 42 the line and 7 the column.
  const m = /^(.*?\S)\s*:(\d+)(?::(\d+))?$/.exec(text);
  if (m) {
    text = m[1];
    line = Number(m[2]);
    col = m[3] ? Number(m[3]) : undefined;
  }
  return { terms: text.split(/\s+/).filter(Boolean), line, col };
}

/** A candidate path, with the per-file work hoisted out of the keystroke path. */
export interface FileCandidate {
  /** Worktree-relative path, as git reported it. */
  rel: string;
  /** File name. */
  base: string;
  /** Parent directory, "" at the worktree root. */
  dir: string;
  /** Matched by a gitignore rule — listed, but ranked below tracked files. */
  ignored: boolean;
  relLower: string;
  baseLower: string;
}

export function toCandidate(rel: string, ignored = false): FileCandidate {
  const cut = rel.lastIndexOf("/");
  const base = cut === -1 ? rel : rel.slice(cut + 1);
  return {
    rel,
    base,
    dir: cut === -1 ? "" : rel.slice(0, cut),
    ignored,
    relLower: rel.toLowerCase(),
    baseLower: base.toLowerCase(),
  };
}

function isBoundary(target: string, i: number): boolean {
  if (i === 0) {
    return true;
  }
  const prev = target.charCodeAt(i - 1);
  if (BOUNDARY_AFTER_CODES.has(prev)) {
    return true;
  }
  // camelCase hump: a lowercase letter or digit followed by an uppercase one.
  const here = target.charCodeAt(i);
  const prevIsLowerish = (prev >= 97 && prev <= 122) || (prev >= 48 && prev <= 57);
  return prevIsLowerish && here >= 65 && here <= 90;
}

/** Per-character score for a hit at `j`, before any run/gap adjustment. */
function charScoreAt(target: string, j: number): number {
  if (!isBoundary(target, j)) {
    return CHAR_BASE;
  }
  return CHAR_BASE + (j === 0 ? FIRST_CHAR_BONUS : BOUNDARY_BONUS);
}

/** A later first hit is mildly worse than an early one — but only mildly, so a
 *  deep path isn't punished for its depth. */
function startPenalty(j: number): number {
  return Math.min(j, 20) * 0.2;
}

/**
 * Score for the query sitting contiguously at `at`. Worth special-casing: an
 * unbroken run is what most real queries produce, and it is the shape the DP
 * below would land on anyway, so computing it directly keeps the DP off the
 * hot path for the common case.
 */
function runScore(target: string, at: number, m: number): number {
  let score = charScoreAt(target, at) - startPenalty(at);
  for (let k = 1; k < m; k++) {
    score += charScoreAt(target, at + k) + CONTIGUOUS_BONUS;
  }
  return score;
}

// Row buffers for the DP, reused across calls and grown as needed. The matcher
// is single-threaded and re-entered tens of thousands of times per keystroke;
// allocating four typed arrays per call dominated the profile.
let bufA = new Float64Array(256);
let bufB = new Float64Array(256);
let bufC = new Float64Array(256);
let bufD = new Float64Array(256);
function ensureBuffers(n: number): void {
  if (bufA.length >= n) {
    return;
  }
  const size = 1 << (32 - Math.clz32(n - 1));
  bufA = new Float64Array(size);
  bufB = new Float64Array(size);
  bufC = new Float64Array(size);
  bufD = new Float64Array(size);
}

/**
 * Best score for `query` as a subsequence of `target`, 0 when it isn't one.
 *
 * A left-to-right greedy walk is wrong here — it takes the first "c" it sees
 * and misses a far better contiguous run later ("scm" in "src/scmView.ts"
 * would burn its "c" on "src"). So this is a small dynamic program: dp[j] is
 * the best score for the current query character matched at target[j], carried
 * forward over a running max of the previous row so it stays O(len × len) with
 * one array per row. Gaps cost a flat penalty rather than a distance-scaled
 * one, which is what keeps that running max valid.
 */
export function fuzzyScore(target: string, targetLower: string, queryLower: string): number {
  const n = target.length;
  const m = queryLower.length;
  if (m === 0 || m > n) {
    return 0;
  }

  // Whole-match shapes, and the contiguous short-circuit. A substring hit is
  // both the usual case and the cheapest to score, so it is handled before the
  // DP is ever set up.
  let bonus = 0;
  let best = -Infinity;
  if (targetLower === queryLower) {
    bonus = EXACT_BONUS;
  } else if (targetLower.startsWith(queryLower)) {
    bonus = PREFIX_BONUS;
  }
  for (let at = targetLower.indexOf(queryLower); at !== -1; at = targetLower.indexOf(queryLower, at + 1)) {
    let here = runScore(target, at, m);
    if (at > 0 && bonus === 0) {
      here += SUBSTRING_BONUS + (isBoundary(target, at) ? SUBSTRING_BOUNDARY_BONUS : 0);
    }
    best = Math.max(best, here);
  }
  if (best > -Infinity) {
    const score = best + bonus;
    return score > 0 ? score : 0;
  }

  // Not contiguous anywhere. Cheap subsequence reject before the DP — most
  // candidates die here on a typical query.
  let probe = 0;
  for (let q = 0; q < m; q++) {
    probe = targetLower.indexOf(queryLower[q], probe);
    if (probe === -1) {
      return 0;
    }
    probe++;
  }

  ensureBuffers(n);
  // Swapped each pass: the previous row, its running max (for the gapped
  // transition), the row being filled, and that row's running max.
  let prev = bufA;
  let prevMax = bufB;
  let cur = bufC;
  let curMax = bufD;
  let rowBest = -Infinity;

  for (let q = 0; q < m; q++) {
    const qc = queryLower.charCodeAt(q);
    rowBest = -Infinity;
    for (let j = 0; j < n; j++) {
      let cell = -Infinity;
      if (targetLower.charCodeAt(j) === qc) {
        const cs = charScoreAt(target, j);
        if (q === 0) {
          cell = cs - startPenalty(j);
        } else {
          const contiguous = j >= 1 && prev[j - 1] > -Infinity ? prev[j - 1] + cs + CONTIGUOUS_BONUS : -Infinity;
          const gapped = j >= 2 && prevMax[j - 2] > -Infinity ? prevMax[j - 2] + cs - GAP_PENALTY : -Infinity;
          cell = contiguous > gapped ? contiguous : gapped;
        }
      }
      cur[j] = cell;
      if (cell > rowBest) {
        rowBest = cell;
      }
      curMax[j] = rowBest;
    }
    if (rowBest === -Infinity) {
      return 0;
    }
    const t = prev;
    prev = cur;
    cur = t;
    const tm = prevMax;
    prevMax = curMax;
    curMax = tm;
  }

  return rowBest > 0 ? rowBest : 0;
}

/**
 * Score one term against one file. A term containing a separator is a path
 * query and is judged on the full relative path; a bare term is judged on the
 * file name, falling back to the path so that typing a folder still works.
 */
function scoreTerm(c: FileCandidate, termLower: string): number {
  if (termLower.includes("/")) {
    return fuzzyScore(c.rel, c.relLower, termLower);
  }
  const onBase = fuzzyScore(c.base, c.baseLower, termLower);
  if (onBase > 0) {
    return onBase + BASENAME_BONUS;
  }
  return fuzzyScore(c.rel, c.relLower, termLower);
}

interface FileMatch {
  candidate: FileCandidate;
  score: number;
}

/** Total order over matches: best score first, then the shorter path — between
 *  two equally good hits the shallower, tighter-named file is nearly always the
 *  one meant — then path order, so results never reshuffle between keystrokes
 *  that score the same. Negative when `a` ranks ahead of `b`. */
function compareMatches(a: FileMatch, b: FileMatch): number {
  return (
    b.score - a.score ||
    a.candidate.rel.length - b.candidate.rel.length ||
    (a.candidate.rel < b.candidate.rel ? -1 : a.candidate.rel > b.candidate.rel ? 1 : 0)
  );
}

/**
 * Bounded top-K, as a heap whose ROOT is the worst element kept.
 *
 * Sorting every match instead would be the obvious thing, and it is what this
 * used to do — but a one-or-two character query matches almost everything, so
 * on a large worktree that is a 50k-element sort on every keystroke. Against a
 * fixed cap, each extra match costs one comparison with the root and nothing
 * more.
 */
function heapOffer(heap: FileMatch[], item: FileMatch, cap: number): void {
  if (heap.length < cap) {
    heap.push(item);
    for (let i = heap.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (compareMatches(heap[i], heap[parent]) <= 0) {
        break;
      }
      const t = heap[i];
      heap[i] = heap[parent];
      heap[parent] = t;
      i = parent;
    }
    return;
  }
  if (compareMatches(item, heap[0]) >= 0) {
    return; // No better than the worst we are keeping.
  }
  heap[0] = item;
  for (let i = 0; ; ) {
    const l = 2 * i + 1;
    const r = l + 1;
    let worst = i;
    if (l < heap.length && compareMatches(heap[l], heap[worst]) > 0) {
      worst = l;
    }
    if (r < heap.length && compareMatches(heap[r], heap[worst]) > 0) {
      worst = r;
    }
    if (worst === i) {
      return;
    }
    const t = heap[i];
    heap[i] = heap[worst];
    heap[worst] = t;
    i = worst;
  }
}

/**
 * Rank candidates against a parsed query. Every term must match (⌘P's AND),
 * order between terms is irrelevant, and scores sum so a file that matches
 * both terms well outranks one that scrapes by on each.
 *
 * `limit` bounds what comes back, not what's considered — the full set is
 * always scored, so the top results are the true top results and the cap only
 * stops the picker from rendering thousands of rows per keystroke.
 */
export function rankFiles(candidates: FileCandidate[], query: FileQuery, limit: number): FileCandidate[] {
  if (query.terms.length === 0) {
    return candidates.slice(0, limit);
  }
  const terms = query.terms.map((t) => t.replace(/\\/g, "/").toLowerCase());
  const heap: FileMatch[] = [];
  for (const candidate of candidates) {
    let total = 0;
    for (const term of terms) {
      const s = scoreTerm(candidate, term);
      if (s === 0) {
        total = 0;
        break;
      }
      total += s;
    }
    if (total > 0) {
      // Floored rather than subtracted outright: the penalty settles ties, it
      // must never drop a matching file out of the results altogether.
      const score = candidate.ignored ? Math.max(1, total - IGNORED_PENALTY) : total;
      heapOffer(heap, { candidate, score }, limit);
    }
  }
  return heap.sort(compareMatches).map((m) => m.candidate);
}
