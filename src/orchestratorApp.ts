import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { toast } from "./notify";
import { parsePsInstances, ProcInstance } from "./psInstances";

/**
 * Launch/quit the AndreysOrchestrator app ("The Circle") from the Source+ title
 * bar — the leftmost toolbar button toggles it.
 *
 * The app ships INSIDE the extension (`resources/orchestrator/AndreysOrchestrator.app`,
 * placed there by build.sh), so installing the .vsix is the only install step:
 * nobody has to fetch or build the orchestrator separately.
 *
 * It is never launched from the extension's install directory, though. On first
 * use we copy the bundle to
 *
 *     ~/Library/Application Support/andreys-helper/AndreysOrchestrator.app
 *
 * and launch that copy. The staging step is what makes shipping a native app in
 * a .vsix actually work:
 *
 *  • Executable bit — .vsix installation does not reliably preserve unix file
 *    modes, so a bundled `Contents/MacOS/…` can arrive as 0644 and refuse to
 *    launch. We chmod the staged copy.
 *  • Gatekeeper — a .vsix that arrived over the network can carry
 *    `com.apple.quarantine`, and this bundle is only ad-hoc signed
 *    (INTEGRATION.md "Packaging"), so a quarantined copy of it is exactly what
 *    Gatekeeper refuses to launch. `fs.cpSync` propagates xattrs, so the staged
 *    copy is de-quarantined explicitly — of the app WE shipped, at a path we
 *    own, on the user's own press of the button. (Signing + notarizing the
 *    bundle, per INTEGRATION.md, is what retires this step.) The code signature
 *    itself survives the byte-for-byte copy — `codesign --verify` stays valid —
 *    so nothing needs re-signing.
 *  • Extension updates — the install directory is swapped out from under a
 *    running process on update; the staged copy is stable. It is re-staged
 *    whenever the extension version or the bundled binary changes.
 *
 * Set `andreysHelper.orchestrator.appPath` to launch a specific bundle in place
 * instead (skipping staging) — that is the development path, pointed at
 * `orchestrator/build/AndreysOrchestrator.app`.
 */

const APP_NAME = "AndreysOrchestrator";
const APP_BUNDLE = `${APP_NAME}.app`;

/** Context keys the title-bar buttons key off (see package.json `view/title`). */
const KEY_RUNNING = "andreysHelper.orchestratorRunning";
const KEY_AVAILABLE = "andreysHelper.orchestratorAvailable";

/** How often the toolbar button re-checks whether the app is up. */
const POLL_MS = 4000;

/** Directory that holds the staged bundle + its stamp file. */
function stageDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "andreys-helper");
}

function stagedApp(): string {
  return path.join(stageDir(), APP_BUNDLE);
}

function stampFile(): string {
  return path.join(stageDir(), `${APP_NAME}.stamp`);
}

/** The executable inside a .app bundle. */
function exeIn(appPath: string): string {
  return path.join(appPath, "Contents", "MacOS", APP_NAME);
}

/** The `andreysHelper.orchestrator.appPath` override, or undefined. */
function appPathOverride(): string | undefined {
  const raw = vscode.workspace
    .getConfiguration("andreysHelper")
    .get<string>("orchestrator.appPath");
  const trimmed = (raw ?? "").trim();
  return trimmed ? trimmed : undefined;
}

/** The bundle shipped inside this extension, or undefined when absent. */
function bundledApp(context: vscode.ExtensionContext): string | undefined {
  const p = path.join(
    context.extensionUri.fsPath,
    "resources",
    "orchestrator",
    APP_BUNDLE
  );
  return fs.existsSync(exeIn(p)) ? p : undefined;
}

/**
 * Every running AndreysOrchestrator, whatever bundle it was launched from — a
 * dev build started by hand counts, so the button can stop that one too.
 */
async function runningInstances(): Promise<ProcInstance[]> {
  const res = await capture("/bin/ps", ["-axo", "pid=,comm="], 5000);
  return res.code === 0 ? parsePsInstances(res.stdout, APP_NAME) : [];
}

/**
 * Make sure a launchable, non-quarantined copy of `src` exists in the stage dir
 * and return its path. Re-copies when the stamp (extension version + the source
 * binary's size/mtime) doesn't match, so an extension update rolls the app
 * forward. Only ever called with no instance running.
 */
async function ensureStaged(src: string, version: string): Promise<string> {
  const dst = stagedApp();
  const srcStat = fs.statSync(exeIn(src));
  const want = `${version}\n${srcStat.size}:${srcStat.mtimeMs}`;

  let have: string | undefined;
  try {
    have = fs.readFileSync(stampFile(), "utf8");
  } catch {
    have = undefined; // never staged, or the stamp was removed
  }
  if (have === want && fs.existsSync(exeIn(dst))) {
    // Cheap belt-and-braces: a previous stage could have been interrupted after
    // the copy but before the chmod.
    makeExecutable(dst);
    return dst;
  }

  fs.mkdirSync(stageDir(), { recursive: true });
  fs.rmSync(dst, { recursive: true, force: true });
  // The stamp is written last, so an interrupted stage re-stages next time
  // rather than leaving a half-copied bundle behind a matching stamp.
  fs.rmSync(stampFile(), { force: true });
  fs.cpSync(src, dst, { recursive: true });
  makeExecutable(dst);
  await capture("/usr/bin/xattr", ["-dr", "com.apple.quarantine", dst], 15000);
  fs.writeFileSync(stampFile(), want, "utf8");
  return dst;
}

/** Restore the +x bit the .vsix may have dropped, on the binary and `ah`. */
function makeExecutable(appPath: string): void {
  for (const rel of [
    ["Contents", "MacOS", APP_NAME],
    ["Contents", "Resources", "ah"],
  ]) {
    const p = path.join(appPath, ...rel);
    try {
      fs.chmodSync(p, 0o755);
    } catch {
      // `ah` is optional; a missing main binary surfaces at launch instead.
    }
  }
}

/**
 * Launch a bundle. `open` first — LaunchServices refuses to start a second copy
 * of a bundle that is already running, which keeps the toggle honest even if the
 * running check raced. Direct exec is the fallback: it needs no LaunchServices
 * registration, and an `.app` launched this way still resolves its own bundle
 * (that is how `swift run` behaves), so the app is fully functional either way.
 */
async function launch(appPath: string): Promise<void> {
  const opened = await capture("/usr/bin/open", [appPath], 15000);
  if (opened.code === 0) {
    return;
  }
  const execErr = await exec(exeIn(appPath));
  if (!execErr) {
    return;
  }
  const detail = [
    `open ${appPath}`,
    opened.stderr.trim() || `exit: ${opened.code}`,
    "",
    `exec ${exeIn(appPath)}`,
    execErr,
  ].join("\n");
  throw Object.assign(new Error("could not launch the orchestrator"), { detail });
}

/** Spawn a detached executable; resolves undefined on success, else the error. */
function exec(binary: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(binary, [], { detached: true, stdio: "ignore" });
    child.on("error", (err) => resolve(err.message));
    // No spawn error by now means exec succeeded and the app outlives us.
    setTimeout(() => {
      child.unref();
      resolve(undefined);
    }, 300);
  });
}

/** SIGTERM, then SIGKILL anything still alive 2s later. */
async function quit(instances: ProcInstance[]): Promise<void> {
  signal(instances, "SIGTERM");
  for (let i = 0; i < 10; i++) {
    await delay(200);
    if (!instances.some(({ pid }) => alive(pid))) {
      return;
    }
  }
  // A HUD that won't take a SIGTERM still has to be closable from the button.
  signal(instances.filter(({ pid }) => alive(pid)), "SIGKILL");
}

function signal(instances: ProcInstance[], sig: NodeJS.Signals): void {
  for (const { pid } of instances) {
    try {
      process.kill(pid, sig);
    } catch {
      // Already gone.
    }
  }
}

/** Is this pid still around? `kill(pid, 0)` throws ESRCH when it isn't. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Owns the toolbar button's state: polls for the app, mirrors it into the
 * `andreysHelper.orchestratorRunning` context key (which swaps the outline icon
 * for the filled one), and runs the toggle.
 */
class OrchestratorApp implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private running: boolean | undefined;
  private busy = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  start(): void {
    void this.refreshAvailability();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
    this.context.subscriptions.push(
      // The app can also be quit from its own ⌘Q / Settings window — re-check on
      // focus so the button isn't stale when the user comes back to the editor.
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) {
          void this.refresh();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("andreysHelper.orchestrator.appPath")) {
          void this.refreshAvailability();
        }
      })
    );
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Toggle: quit every running instance, or launch one if none is running. */
  async toggle(): Promise<void> {
    if (this.busy) {
      return; // a launch/quit is already in flight
    }
    this.busy = true;
    try {
      // Always decide from live state, never from the (polled) button state, so
      // a stale icon can't launch a second copy or "stop" nothing.
      const instances = await runningInstances();
      if (instances.length) {
        await quit(instances);
        toast("Andrey's Helper: orchestrator stopped.");
      } else {
        await this.launchApp();
        // `open` returns once LaunchServices has started the app, which is a
        // moment before it shows up in `ps` — wait for the process rather than
        // claiming a launch we haven't seen.
        const up = await settled(async () => (await runningInstances()).length > 0, 5000);
        if (up) {
          toast("Andrey's Helper: orchestrator started.");
        } else {
          toast(
            "Andrey's Helper: launched the orchestrator but no process appeared.",
            "warning"
          );
        }
      }
    } catch (err) {
      const detail = (err as { detail?: unknown })?.detail;
      toast(
        `Andrey's Helper: ${err instanceof Error ? err.message : String(err)}`,
        "error",
        2000,
        typeof detail === "string" ? detail : undefined
      );
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  private async launchApp(): Promise<void> {
    const override = appPathOverride();
    if (override) {
      if (!fs.existsSync(exeIn(override))) {
        throw new Error(
          `andreysHelper.orchestrator.appPath does not point at an ${APP_BUNDLE} bundle (${override})`
        );
      }
      // Launched in place: a bundle the user pointed us at is theirs to manage.
      await launch(override);
      return;
    }

    const bundled = bundledApp(this.context);
    if (!bundled) {
      throw new Error(
        `this build ships no ${APP_BUNDLE} — set andreysHelper.orchestrator.appPath, or package the extension with ./build.sh`
      );
    }
    const version: string = this.context.extension.packageJSON.version;
    await launch(await ensureStaged(bundled, version));
  }

  /** Poll once and push the result into the context key (only on a change). */
  private async refresh(): Promise<void> {
    const running = (await runningInstances()).length > 0;
    if (running === this.running) {
      return;
    }
    this.running = running;
    await vscode.commands.executeCommand("setContext", KEY_RUNNING, running);
  }

  /** Hide the launch button entirely when there is nothing to launch. */
  private async refreshAvailability(): Promise<void> {
    const available =
      process.platform === "darwin" &&
      (!!appPathOverride() || !!bundledApp(this.context));
    await vscode.commands.executeCommand("setContext", KEY_AVAILABLE, available);
  }
}

/**
 * Register the Source+ title-bar toggle. Two commands share one implementation
 * so the icon can reflect state (the `view/title` when-clauses pick exactly one
 * of them); both re-check the live state before acting.
 */
export function registerOrchestratorApp(context: vscode.ExtensionContext): void {
  const app = new OrchestratorApp(context);
  context.subscriptions.push(
    app,
    vscode.commands.registerCommand("andreysHelper.orchestrator.start", () =>
      app.toggle()
    ),
    vscode.commands.registerCommand("andreysHelper.orchestrator.stop", () =>
      app.toggle()
    )
  );
  app.start();
}

// MARK: - small helpers

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `pred` every 250ms until it holds or `timeoutMs` runs out. */
async function settled(pred: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(250);
  }
}

/** Run a command and collect its output; code -1 for a timeout/spawn failure. */
function capture(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (code: number) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill();
      done(-1);
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => done(-1));
    child.on("close", (code) => done(code ?? -1));
  });
}
