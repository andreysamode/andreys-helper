/**
 * Config + token loading for the `ah` CLI (PLAN.md §6.4).
 *
 * The CLI reads the broker port + auth token from `~/.andreys-helper/`. All of
 * the location knobs can be overridden by env vars so tests can point the CLI at
 * a temp dir / mock broker without touching the real config:
 *   - AH_HOME             config dir (default `~/.andreys-helper`)
 *   - AH_PORT             broker port override
 *   - AH_TOKEN            auth token override
 *   - AH_CLAUDE_PROJECTS  transcript root (default `~/.claude/projects`)
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG } from "../src/broker/protocol";
import type { Config } from "../src/broker/protocol";

/** Resolve the `~/.andreys-helper` config dir (env-overridable). */
export function ahHome(): string {
  return process.env.AH_HOME || join(homedir(), ".andreys-helper");
}

/** Load `config.json`, falling back to §6.4 defaults for missing keys. */
export function loadConfig(): Config {
  try {
    const raw = readFileSync(join(ahHome(), "config.json"), "utf8");
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<Config>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Load the shared broker token (`~/.andreys-helper/token`, 0600). */
export function loadToken(): string {
  if (process.env.AH_TOKEN) return process.env.AH_TOKEN;
  try {
    return readFileSync(join(ahHome(), "token"), "utf8").trim();
  } catch {
    return "";
  }
}

/** Effective broker port (env override wins over config). */
export function brokerPort(cfg: Config): number {
  return process.env.AH_PORT ? Number(process.env.AH_PORT) : cfg.port;
}

/** Root dir of on-disk Claude transcripts (env-overridable). */
export function claudeProjectsDir(): string {
  return (
    process.env.AH_CLAUDE_PROJECTS || join(homedir(), ".claude", "projects")
  );
}
