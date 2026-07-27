/**
 * Thin WebSocket client the `ah` CLI uses to talk to the app-hosted broker over
 * loopback (PLAN.md §5, §6.2, §6.3).
 *
 * The CLI sends the §6.2 `command` envelope
 *   { v, type:"command", cmdId, verb, args }
 * and awaits the matching §6.2 `result` envelope
 *   { v, type:"result", cmdId, ok, data, error }.
 *
 * Auth: the token (§6.4/§9.3) is sent as the `x-ah-token` request header and
 * mirrored in the URL query string, so the broker can validate it on the WS
 * handshake regardless of which it can read. The `command` envelope itself stays
 * byte-for-byte §6.2.
 */
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "../src/broker/protocol";

export interface BrokerOptions {
  port: number;
  token: string;
  /** Per-call timeout; cold-start verbs (open-window) pass a longer one. */
  timeoutMs?: number;
}

/** Normalized broker reply (mirrors the §6.2 `result` payload). */
export interface CommandResult {
  ok: boolean;
  data: unknown;
  error: string | null;
}

let counter = 0;
function nextCmdId(): string {
  return `ah-${process.pid}-${Date.now()}-${counter++}`;
}

/**
 * Send one command to the broker and resolve with its result. Rejects on
 * connection failure, close-before-reply, or timeout — callers turn a rejection
 * into `{ error }` + nonzero exit.
 */
export function sendCommand(
  opts: BrokerOptions,
  verb: string,
  args: unknown,
): Promise<CommandResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  return new Promise<CommandResult>((resolve, reject) => {
    const cmdId = nextCmdId();
    const url = `ws://127.0.0.1:${opts.port}/?token=${encodeURIComponent(opts.token)}`;
    const ws = new WebSocket(url, { headers: { "x-ah-token": opts.token } });
    let settled = false;

    const timer = setTimeout(() => {
      finish(() =>
        reject(new Error(`broker timeout after ${timeoutMs}ms for verb '${verb}'`)),
      );
    }, timeoutMs);

    function finish(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      fn();
    }

    ws.on("open", () => {
      ws.send(
        JSON.stringify({ v: PROTOCOL_VERSION, type: "command", cmdId, verb, args }),
      );
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      let msg: { type?: string; cmdId?: string; ok?: boolean; data?: unknown; error?: string | null };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg && msg.type === "result" && msg.cmdId === cmdId) {
        finish(() =>
          resolve({
            ok: msg.ok !== false,
            data: msg.data ?? null,
            error: msg.error ?? null,
          }),
        );
      }
    });

    ws.on("error", (err: Error) => finish(() => reject(err)));
    ws.on("close", () => {
      if (!settled) {
        finish(() =>
          reject(new Error(`broker closed connection before replying to '${verb}'`)),
        );
      }
    });
  });
}
