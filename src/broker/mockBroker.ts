import { randomUUID } from "crypto";
import WebSocket, { WebSocketServer } from "ws";
import {
  CommandArgs,
  CommandMessage,
  CommandVerb,
  HelloMessage,
  PROTOCOL_VERSION,
  ResultMessage,
  SnapshotMessage,
} from "./protocol";

/**
 * A tiny in-process WebSocket broker for testing the extension client (Workstream
 * W1), and a reusable fake-extension harness for the Swift broker track (W3). It
 * accepts a single client, validates the `hello` token, records snapshots, and
 * lets a test dispatch each command verb and await its `result` ack. Designed to
 * be stopped and restarted on the same port so reconnect can be exercised.
 */
export class MockBroker {
  private wss: WebSocketServer | undefined;
  private socket: WebSocket | undefined;

  /** Every `hello` received (one per (re)connect). */
  readonly hellos: HelloMessage[] = [];
  /** Every `snapshot` received, in order. */
  readonly snapshots: SnapshotMessage[] = [];
  /** Hellos whose token did NOT match — the broker would reject these (§9.3). */
  readonly rejectedHellos: HelloMessage[] = [];

  private readonly pending = new Map<string, (r: ResultMessage) => void>();
  private readonly listeners = new Set<() => void>();

  /** Bound port (assigned on first start; reused across restarts). */
  port = 0;

  constructor(private readonly token: string = "test-token") {}

  /** Start listening. Pass a port to bind explicitly (for restart-on-same-port). */
  start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port });
      this.wss = wss;
      wss.on("error", reject);
      wss.on("listening", () => {
        this.port = (wss.address() as { port: number }).port;
        resolve(this.port);
      });
      wss.on("connection", (ws) => this.onConnection(ws));
    });
  }

  /** Close all sockets + the server. */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.pending.clear();
      const ws = this.socket;
      this.socket = undefined;
      try {
        ws?.terminate();
      } catch {
        /* ignore */
      }
      const wss = this.wss;
      this.wss = undefined;
      if (!wss) {
        resolve();
        return;
      }
      wss.close(() => resolve());
    });
  }

  private onConnection(ws: WebSocket): void {
    this.socket = ws;
    ws.on("message", (data) => this.onMessage(data));
    ws.on("close", () => {
      if (this.socket === ws) {
        this.socket = undefined;
      }
    });
    this.emit();
  }

  private onMessage(data: WebSocket.RawData): void {
    let msg: HelloMessage | SnapshotMessage | ResultMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case "hello":
        if (msg.token === this.token) {
          this.hellos.push(msg);
        } else {
          this.rejectedHellos.push(msg);
        }
        break;
      case "snapshot":
        this.snapshots.push(msg);
        break;
      case "result": {
        const resolve = this.pending.get(msg.cmdId);
        if (resolve) {
          this.pending.delete(msg.cmdId);
          resolve(msg);
        }
        break;
      }
    }
    this.emit();
  }

  /** Dispatch a command to the connected client and await its `result` ack. */
  sendCommand<V extends CommandVerb>(
    verb: V,
    args: CommandArgs[V],
    timeoutMs = 4000
  ): Promise<ResultMessage> {
    const cmdId = randomUUID();
    const command: CommandMessage<V> = {
      v: PROTOCOL_VERSION,
      type: "command",
      cmdId,
      verb,
      args,
    };
    return new Promise<ResultMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmdId);
        reject(new Error(`command "${verb}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(cmdId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      const ws = this.socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        clearTimeout(timer);
        this.pending.delete(cmdId);
        reject(new Error("no client connected"));
        return;
      }
      ws.send(JSON.stringify(command));
    });
  }

  /** Resolve once `predicate(this)` holds (checked after every received message). */
  waitUntil(predicate: (b: MockBroker) => boolean, timeoutMs = 4000): Promise<void> {
    if (predicate(this)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error("waitUntil timed out"));
      }, timeoutMs);
      const check = () => {
        if (predicate(this)) {
          clearTimeout(timer);
          this.listeners.delete(check);
          resolve();
        }
      };
      this.listeners.add(check);
    });
  }

  private emit(): void {
    for (const l of [...this.listeners]) {
      l();
    }
  }
}
