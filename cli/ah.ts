#!/usr/bin/env node
/**
 * `ah` — the thin manager CLI the orchestrator shells out to (PLAN.md §6.3).
 *
 * This is the runnable binary: it parses argv via {@link dispatch}, prints the
 * result as JSON to stdout (so the orchestrator model can parse it), and exits 0
 * on success. Failures print `{ "error": "…" }` to stdout and exit 1. All the verb
 * logic lives in `cli/dispatch.ts` (imported here) so it stays free of process
 * side-effects and is unit-testable.
 *
 * Bundles to a Node CJS binary (esbuild `--platform=node --format=cjs`); the
 * shebang above is preserved by esbuild so the output is install-to-PATH ready.
 */
import { dispatch, errMsg } from "./dispatch";

async function main(): Promise<void> {
  try {
    const result = await dispatch(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(0);
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: errMsg(err) }) + "\n");
    process.exit(1);
  }
}

void main();
