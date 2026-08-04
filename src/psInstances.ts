/**
 * Pure parser for `ps -axo pid=,comm=` output — kept free of `vscode` so it is
 * unit-testable (see psInstances.test.ts). Used to answer "is the orchestrator
 * app running, and from which bundle?" (src/orchestratorApp.ts).
 *
 * `comm` is the running image's full path, which is why we match on it rather
 * than with `pgrep`: a process is only a match when the executable it is running
 * IS the one we are looking for, never because it mentions the name in its
 * arguments. (`ps -o ucomm=` would be wrong here — it truncates at 16 chars, so
 * "AndreysOrchestrator" arrives as "AndreysOrchestra".)
 */

/** A live process running a named executable. */
export interface ProcInstance {
  pid: number;
  /** Absolute path of the running executable. */
  exePath: string;
}

/** Every process in `stdout` whose executable's basename is exactly `name`. */
export function parsePsInstances(stdout: string, name: string): ProcInstance[] {
  const out: ProcInstance[] = [];
  for (const line of stdout.split("\n")) {
    // "  1234 /Applications/Foo.app/Contents/MacOS/Foo". A path is required:
    // kernel threads and any header line have no leading-slash comm.
    const m = /^\s*(\d+)\s+(\/\S.*?)\s*$/.exec(line);
    if (!m) {
      continue;
    }
    // basename by hand rather than path.basename: a comm path is always POSIX,
    // and this keeps the module free of node built-ins.
    const exePath = m[2];
    const base = exePath.slice(exePath.lastIndexOf("/") + 1);
    if (base === name) {
      out.push({ pid: Number(m[1]), exePath });
    }
  }
  return out;
}
