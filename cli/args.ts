/**
 * Dependency-light argv parser for the `ah` CLI.
 *
 * Supports `--flag value`, boolean `--flag` (when followed by another flag or
 * nothing), and repeatable flags (e.g. `--attach a --attach b` → string[]).
 * Everything else is a positional collected into `_`.
 */
export interface ParsedArgs {
  /** Positional arguments, in order. */
  _: string[];
  /** Named flags. Repeatable flags collect into a string[]. */
  flags: Record<string, string | boolean | string[]>;
}

export function parseArgs(argv: string[], repeatable: string[] = []): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const isBool = next === undefined || next.startsWith("--");
      if (isBool) {
        flags[key] = true;
      } else if (repeatable.includes(key)) {
        const existing = flags[key];
        if (Array.isArray(existing)) existing.push(next);
        else flags[key] = [next];
        i++;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { _: positional, flags };
}

/** Read a flag as a string (undefined if absent or boolean). */
export function str(flags: ParsedArgs["flags"], key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

/** Read a flag as a boolean. */
export function bool(flags: ParsedArgs["flags"], key: string): boolean {
  return flags[key] === true || typeof flags[key] === "string";
}

/** Read a repeatable flag as a string[] (empty if absent). */
export function list(flags: ParsedArgs["flags"], key: string): string[] {
  const v = flags[key];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [v];
  return [];
}
