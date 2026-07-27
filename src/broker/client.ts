import { randomUUID } from "crypto";
import WebSocket from "ws";
import {
  CommandMessage,
  HelloMessage,
  Host,
  PROTOCOL_VERSION,
  RepoRef,
  ResultMessage,
  SessionInfo,
  SnapshotMessage,
  WindowId,
  WireMessage,
  WorktreeRef,
} from "./protocol";

/**
 * The extension's WebSocket client to the AndreysOrchestrator broker (PLAN.md §5, §6.2,
 * Workstream W1).
 *
 * This class is deliberately PURE — it imports nothing from `vscode` and knows
 * nothing about Claude tabs, git, or the editor. Everything editor-specific is
 * injected via {@link BrokerClientOptions}, so the connection/handshake/reconnect
 * logic can be unit-tested against a mock broker without an editor host (see
 * `client.test.ts`). The vscode wiring lives in `register.ts`.
 *
 * Editor-safety is paramount (PLAN.md §9.4): a missing or closed broker MUST be a
 * silent no-op that keeps retrying with backoff. Nothing here ever throws into the
 * caller — every failure path is swallowed and routed to {@link
 * BrokerClientOptions.log}. `ws` emits an `"error"` event (never an uncaught
 * throw) when a connection is refused, so an offline broker just triggers the
 * reconnect timer.
 */

/** Broker connection parameters, resolved from config + token (PLAN.md §6.4). */
export interface BrokerConnection {
  /** Broker WS port (from `~/.andreys-helper/config.json`). */
  port: number;
  /** Shared secret (from `~/.andreys-helper/token`), sent in `hello` (§9.3). */
  token: string;
}

/** The mutable snapshot payload the client publishes (PLAN.md §6.2 `snapshot`). */
export interface SnapshotPayload {
  worktrees: WorktreeRef[];
  sessions: SessionInfo[];
  /** Whether this window is frontmost/focused (`vscode.window.state.focused`). */
  focused: boolean;
}

/** Everything the pure client needs from the editor, injected by `register.ts`. */
export interface BrokerClientOptions {
  /**
   * Resolve the broker port + token, or `null` when config/token is missing.
   * Called before every (re)connect so a token rotation is picked up. Returning
   * `null` is treated like an offline broker: back off and retry.
   */
  connection: () => BrokerConnection | null;
  /** Editor host this window belongs to (PLAN.md §6.2 `hello`). */
  host: Host;
  /** Current repo identity for `hello`; re-read on every (re)connect. */
  getRepo: () => RepoRef;
  /** Build the current full snapshot (§6.2); called on connect + every change. */
  buildSnapshot: () => SnapshotPayload;
  /** Execute a routed command and resolve its ack payload (PLAN.md §6.2). */
  dispatch: (
    command: CommandMessage
  ) => Promise<Pick<ResultMessage, "ok" | "data" | "error">>;
  /** Optional sink for diagnostics; all failures are swallowed, never surfaced. */
  log?: (message: string, error?: unknown) => void;
  /** Snapshot debounce window in ms (PLAN.md §6.2 "debounce ~150–300ms"). */
  debounceMs?: number;
  /**
   * Hard ceiling on how long a pending change may be deferred by the debounce.
   * See {@link BrokerClient.notifyChange} — without this a busy window can
   * silently stop publishing altogether.
   */
  maxWaitMs?: number;
  /** Reconnect backoff bounds. */
  backoff?: { baseMs: number; maxMs: number };
}

/** Options for a single {@link BrokerClient.notifyChange} call. */
export interface NotifyOptions {
  /**
   * Publish now instead of debouncing. For rare, user-visible edges (window
   * focus) where coalescing buys nothing and a delay is directly perceptible.
   */
  immediate?: boolean;
}

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_MAX_WAIT_MS = 600;
const DEFAULT_BACKOFF = { baseMs: 500, maxMs: 15_000 };

export class BrokerClient {
  /** Stable per-activation window id, re-announced on every reconnect (§6.1). */
  readonly windowId: WindowId = randomUUID();

  private readonly opts: Required<
    Pick<BrokerClientOptions, "debounceMs" | "maxWaitMs" | "backoff">
  > &
    BrokerClientOptions;

  private ws: WebSocket | undefined;
  private started = false;
  private disposed = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the oldest change still waiting behind the debounce arrived. */
  private pendingSince: number | undefined;

  constructor(options: BrokerClientOptions) {
    const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.opts = {
      ...options,
      debounceMs,
      // A max-wait below the debounce would defeat the debounce entirely.
      maxWaitMs: Math.max(options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS, debounceMs),
      backoff: options.backoff ?? DEFAULT_BACKOFF,
    };
  }

  /** Begin connecting (and keep reconnecting). Safe to call once. */
  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    this.connect();
  }

  /** Tear down the socket and cancel all timers. Idempotent. */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.cancelDebounce();
    this.closeSocket();
  }

  /**
   * Signal that the underlying editor state changed; sends a fresh debounced
   * snapshot if connected. Coalesces bursts (a working→done transition or a git
   * refresh can fire several times) into one send (PLAN.md §6.2).
   *
   * The debounce is bounded by `maxWaitMs`. A plain reset-on-every-call trailing
   * debounce starves: a window whose changes arrive faster than `debounceMs`
   * never reaches the trailing edge and so publishes NOTHING for as long as the
   * churn lasts. A window with a streaming Claude session is exactly that
   * window — and because `focused` rides along on the snapshot, the window the
   * user is actually sitting in was the one least able to tell the broker so,
   * leaving another repo's window styled as upfront.
   */
  notifyChange(options?: NotifyOptions): void {
    if (this.disposed) {
      return;
    }
    if (options?.immediate) {
      this.flush();
      return;
    }
    const now = Date.now();
    if (this.pendingSince === undefined) {
      this.pendingSince = now;
    }
    const waited = now - this.pendingSince;
    if (waited >= this.opts.maxWaitMs) {
      this.flush();
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(
      () => this.flush(),
      Math.min(this.opts.debounceMs, this.opts.maxWaitMs - waited)
    );
  }

  /** Cancel any pending debounce and publish immediately. */
  private flush(): void {
    this.cancelDebounce();
    this.sendSnapshot();
  }

  private cancelDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.pendingSince = undefined;
  }

  /** Whether the socket is currently open. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // --- connection lifecycle --------------------------------------------------

  private connect(): void {
    if (this.disposed) {
      return;
    }
    const conn = this.safe(() => this.opts.connection(), "resolve connection");
    if (!conn) {
      // No config/token yet (or read failed): treat like an offline broker.
      this.scheduleReconnect();
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${conn.port}`);
    } catch (err) {
      // Construction itself never normally throws, but stay bulletproof.
      this.log("broker socket construction failed", err);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.on("open", () => {
      this.attempt = 0;
      this.onOpen(conn);
    });
    socket.on("message", (data) => this.onMessage(data));
    // A refused/broken connection surfaces here (never as an uncaught throw).
    socket.on("error", (err) => this.log("broker socket error", err));
    socket.on("close", () => this.onClose(socket));
  }

  private onOpen(conn: BrokerConnection): void {
    const repo = this.safe(() => this.opts.getRepo(), "get repo") ?? {
      name: "",
      trunkPath: "",
    };
    const hello: HelloMessage = {
      v: PROTOCOL_VERSION,
      type: "hello",
      windowId: this.windowId,
      host: this.opts.host,
      repo,
      token: conn.token,
    };
    this.send(hello);
    // Re-send the full snapshot immediately on (re)connect (PLAN.md §6.2, §8 W1).
    this.sendSnapshot();
  }

  private onClose(socket: WebSocket): void {
    if (this.ws === socket) {
      this.ws = undefined;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) {
      return;
    }
    const { baseMs, maxMs } = this.opts.backoff;
    // Exponential backoff with a small jitter, capped at maxMs.
    const delay = Math.min(maxMs, baseMs * 2 ** this.attempt);
    const jittered = delay / 2 + Math.random() * (delay / 2);
    this.attempt = Math.min(this.attempt + 1, 30);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, jittered);
  }

  private closeSocket(): void {
    const socket = this.ws;
    this.ws = undefined;
    if (!socket) {
      return;
    }
    try {
      socket.removeAllListeners();
      socket.terminate();
    } catch (err) {
      this.log("broker socket close failed", err);
    }
  }

  // --- send/receive ----------------------------------------------------------

  private sendSnapshot(): void {
    if (!this.connected) {
      return;
    }
    const payload = this.safe(() => this.opts.buildSnapshot(), "build snapshot");
    if (!payload) {
      return;
    }
    const snapshot: SnapshotMessage = {
      v: PROTOCOL_VERSION,
      type: "snapshot",
      windowId: this.windowId,
      worktrees: payload.worktrees,
      sessions: payload.sessions,
      focused: payload.focused,
    };
    this.send(snapshot);
  }

  private async onMessage(data: WebSocket.RawData): Promise<void> {
    let msg: WireMessage;
    try {
      msg = JSON.parse(data.toString()) as WireMessage;
    } catch (err) {
      this.log("broker sent unparseable message", err);
      return;
    }
    if (!msg || (msg as { type?: unknown }).type !== "command") {
      return; // ignore anything that isn't a command
    }
    const command = msg as CommandMessage;
    let result: Pick<ResultMessage, "ok" | "data" | "error">;
    try {
      result = await this.opts.dispatch(command);
    } catch (err) {
      // A dispatcher throw must never escape — reply with a failure ack.
      this.log(`command "${command.verb}" threw`, err);
      result = { ok: false, data: null, error: this.errMessage(err) };
    }
    const reply: ResultMessage = {
      v: PROTOCOL_VERSION,
      type: "result",
      cmdId: command.cmdId,
      ok: result.ok,
      data: result.data ?? null,
      error: result.error ?? null,
    };
    this.send(reply);
  }

  private send(message: WireMessage): void {
    if (!this.connected || !this.ws) {
      return;
    }
    try {
      this.ws.send(JSON.stringify(message));
    } catch (err) {
      this.log(`failed to send "${message.type}"`, err);
    }
  }

  // --- helpers ---------------------------------------------------------------

  /** Run `fn`, returning `undefined` (never throwing) on failure. */
  private safe<T>(fn: () => T, what: string): T | undefined {
    try {
      return fn();
    } catch (err) {
      this.log(`failed to ${what}`, err);
      return undefined;
    }
  }

  private log(message: string, error?: unknown): void {
    try {
      this.opts.log?.(message, error);
    } catch {
      // Even the logger must not be able to disrupt the editor.
    }
  }

  private errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
