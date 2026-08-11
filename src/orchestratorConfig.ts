import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { mergeMoonMode } from "./orchestratorConfigMerge";

/**
 * Mirror the orchestrator preferences the EXTENSION owns into the shared
 * `~/.andreys-helper/config.json` — today just `moonMode`.
 *
 * The setting lives in the editor (`andreysHelper.orchestrator.moonMode`)
 * because that is where the user already configures this extension, but the
 * thing it re-skins is a separate native app. config.json is the file both sides
 * already share (the broker port and token live beside it), so the setting is
 * patched straight into it and the app's `ConfigWatcher` picks the change up
 * live — no relaunch, and it survives the editor being closed.
 *
 * Patched, never rewritten: the app owns every other key in that file (the
 * remembered circle position is saved on every drag), so this reads, sets the
 * one key, and writes the rest back untouched.
 */

const KEY = "andreysHelper.orchestrator.moonMode";

function configPath(): string {
  return path.join(os.homedir(), ".andreys-helper", "config.json");
}

/** The current `andreysHelper.orchestrator.moonMode`. */
function moonModeSetting(): boolean {
  return (
    vscode.workspace.getConfiguration("andreysHelper").get<boolean>("orchestrator.moonMode") ??
    false
  );
}

/**
 * Write the setting through to config.json. Best-effort and silent: this runs on
 * activation and on every settings change, and a HUD preference failing to
 * propagate is not worth a modal.
 *
 * When there is no config.json (the app has never run), a file with just
 * `{"moonMode": …}` is written. The app's `Config` decoder defaults every absent
 * key, so that is a complete config as far as it is concerned, and `Bootstrap`
 * leaves an existing file alone rather than clobbering it with defaults.
 */
export function syncMoonMode(): void {
  const file = configPath();
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    existing = undefined; // no file yet — we create it below
  }

  let next: Record<string, unknown> | undefined;
  try {
    next = mergeMoonMode(existing, moonModeSetting());
  } catch (err) {
    // Corrupt or hand-edited into something that isn't an object. Rewriting it
    // would destroy whatever the user has in there; leave it and say so.
    console.warn(`andreys-helper: not patching ${file}: ${String(err)}`);
    return;
  }
  if (!next) {
    return; // already correct
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Atomic, matching how the app writes it — a half-written config.json is
    // one the app silently falls back to defaults for.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`andreys-helper: failed to write ${file}: ${String(err)}`);
  }
}

/** Sync now, and on every change to the setting. */
export function registerOrchestratorConfig(context: vscode.ExtensionContext): void {
  syncMoonMode();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(KEY)) {
        syncMoonMode();
      }
    })
  );
}
