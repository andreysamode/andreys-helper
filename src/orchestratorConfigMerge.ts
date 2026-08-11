/**
 * The pure part of mirroring editor settings into the orchestrator's
 * `~/.andreys-helper/config.json` (see `orchestratorConfig.ts` for the I/O and
 * the why). Kept vscode-free so it can be unit-tested.
 */

/**
 * The config object to write, given the raw file contents (undefined when there
 * is no file yet) and the desired `moonMode`.
 *
 * Returns undefined when the file already says what we want. The app rewrites
 * this file on every circle drag and watches it for changes, so a redundant
 * write is not just wasted I/O — it wakes both watchers for nothing.
 *
 * Throws when the contents are not a JSON object: the caller must leave a file
 * it cannot understand alone rather than replace it, since every other key in
 * there belongs to the app.
 */
export function mergeMoonMode(
  existing: string | undefined,
  moonMode: boolean
): Record<string, unknown> | undefined {
  let current: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    const parsed: unknown = JSON.parse(existing);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config.json is not a JSON object");
    }
    current = parsed as Record<string, unknown>;
  }
  if (current.moonMode === moonMode) {
    return undefined;
  }
  return { ...current, moonMode };
}
