import { Minimatch } from "minimatch";

/**
 * Pure matcher for the Incoming Change Watch feature: which of the incoming
 * repo-relative file paths match the user's watch patterns?
 *
 * Semantics (minimatch, dot: true so dotfiles aren't silently skipped):
 *  - positive patterns select; a file is a candidate if ANY positive matches
 *  - "!"-prefixed patterns exclude; a candidate is dropped if ANY negation matches
 *  - empty/invalid patterns are ignored rather than failing the whole scan
 *
 * Paths are expected repo-relative with "/" separators (as git emits them).
 * Order of the input files is preserved.
 */
export function matchWatchPatterns(
  files: string[],
  patterns: string[]
): string[] {
  const positive: Minimatch[] = [];
  const negative: Minimatch[] = [];
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const source = negated ? raw.slice(1) : raw;
    if (!source.trim()) {
      continue;
    }
    try {
      const mm = new Minimatch(source, { dot: true });
      (negated ? negative : positive).push(mm);
    } catch {
      // Ignore malformed patterns; the rest of the list still applies.
    }
  }
  if (positive.length === 0) {
    return [];
  }
  return files.filter(
    (f) =>
      positive.some((mm) => mm.match(f)) && !negative.some((mm) => mm.match(f))
  );
}
