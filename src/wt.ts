import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";

/**
 * child_process wrapper around the `wt` (worktrunk) CLI plus path-resolution
 * helpers. Everything here runs headless — no terminal, no TTY.
 *
 * Empirical basis (STEP 0, verified against wt 0.38.0 on macOS):
 *  - `wt` is found at /opt/homebrew/bin/wt (Homebrew symlink). GUI apps on macOS
 *    do NOT inherit the shell PATH, so we resolve the absolute binary path at
 *    activation and fall back to a login-shell lookup.
 *  - With stdin closed (stdio 'ignore'), wt never blocks on prompts/hooks.
 *  - `wt switch <b> -c --no-cd --format json` prints a single-line JSON object
 *    ({"action":"created","path":"…",…}) interleaved with progress text.
 *  - `wt remove -y --format json` prints a JSON array on stdout; status/warning
 *    lines (incl. the harmless "Cannot change directory" shell-integration note)
 *    go to stderr.
 *  - `wt step copy-ignored` is non-interactive and exits 0.
 */

export interface WtResult {
  stdout: string;
  stderr: string;
  code: number;
}

let cachedWtPath: string | undefined;

const BIN_CANDIDATES = [
  "/opt/homebrew/bin/wt",
  "/usr/local/bin/wt",
  `${os.homedir()}/.local/bin/wt`,
  "/usr/bin/wt",
];

/** Extra dirs prepended to PATH so wt (and the git it shells out to) resolve. */
const EXTRA_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  `${os.homedir()}/.local/bin`,
];

function augmentedPath(): string {
  const current = (process.env.PATH || "").split(":");
  const seen = new Set<string>();
  return [...EXTRA_PATH, ...current]
    .filter((p) => p && !seen.has(p) && (seen.add(p), true))
    .join(":");
}

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: augmentedPath() };
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the absolute path to the `wt` binary. Tries known install locations,
 * then a login-shell `command -v wt`, then falls back to the bare name.
 */
export async function resolveWtPath(): Promise<string> {
  if (cachedWtPath) {
    return cachedWtPath;
  }
  for (const candidate of BIN_CANDIDATES) {
    if (await isExecutable(candidate)) {
      cachedWtPath = candidate;
      return candidate;
    }
  }
  // Login-shell fallback: works even when the GUI app launched without PATH.
  const shell = process.env.SHELL || "/bin/bash";
  const resolved = await new Promise<string | undefined>((resolve) => {
    const child = spawn(shell, ["-lic", "command -v wt"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(undefined));
    child.on("close", () => {
      const line = out.trim().split("\n").pop()?.trim();
      resolve(line && line.startsWith("/") ? line : undefined);
    });
  });
  cachedWtPath = resolved ?? "wt";
  return cachedWtPath;
}

/**
 * Run `wt` with the given args under `cwd`. stdin is closed so prompts never
 * hang. Resolves (never rejects on a non-zero exit) with captured streams +
 * exit code; rejects only when the process fails to spawn.
 */
export async function runWt(args: string[], cwd?: string): Promise<WtResult> {
  const bin = await resolveWtPath();
  return new Promise<WtResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

/**
 * Extract a JSON value (object or array) from wt output. wt interleaves
 * progress/ANSI text with the JSON payload, so we first look for a single line
 * that parses cleanly (switch's one-line object), then fall back to the span
 * from the first opening bracket to the last matching close (remove's
 * multi-line array).
 */
export function extractJson<T = unknown>(out: string): T | undefined {
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (
      (line.startsWith("{") && line.endsWith("}")) ||
      (line.startsWith("[") && line.endsWith("]"))
    ) {
      try {
        return JSON.parse(line) as T;
      } catch {
        /* keep scanning */
      }
    }
  }
  const firstObj = out.indexOf("{");
  const firstArr = out.indexOf("[");
  let start = -1;
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    start = firstArr;
  } else {
    start = firstObj;
  }
  if (start !== -1) {
    const close = out[start] === "[" ? "]" : "}";
    const end = out.lastIndexOf(close);
    if (end > start) {
      try {
        return JSON.parse(out.slice(start, end + 1)) as T;
      } catch {
        /* fall through */
      }
    }
  }
  return undefined;
}

/** Shape of `wt switch … --format json`. */
export interface WtSwitchResult {
  action: string;
  branch: string;
  path: string;
  created_branch?: boolean;
  base_branch?: string;
}

/** One entry of `wt list --format json`. */
export interface WtListEntry {
  branch: string;
  path: string;
  is_main: boolean;
  is_current: boolean;
}
