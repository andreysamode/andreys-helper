/**
 * Tiny in-process mock broker for testing the `ah` CLI (PLAN.md §8 W6 "Mock").
 *
 * Speaks the §6.2 command/result envelope over a loopback WebSocket. It validates
 * the `x-ah-token` handshake header, records every command it receives, and
 * answers `windows`/`sessions` from canned data. Any other verb echoes its
 * `{ verb, args }` back as `data` so command-routing verbs (spawn/reveal/…) can be
 * asserted. Per-verb handlers can override the defaults.
 */
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { PROTOCOL_VERSION } from "../src/broker/protocol";

export interface MockReply {
  ok?: boolean;
  data?: unknown;
  error?: string | null;
}

export interface MockBrokerOptions {
  token: string;
  /** Canned `windows` result. */
  windows?: unknown[];
  /** Canned `sessions` (extra `repo` field allowed for filtering). */
  sessions?: Array<Record<string, unknown>>;
  /** Per-verb overrides. Return a MockReply (or plain data). */
  handlers?: Record<string, (args: Record<string, unknown>) => MockReply | unknown>;
}

export interface MockBroker {
  port: number;
  /** Commands received, in order. */
  commands: Array<{ verb: string; args: Record<string, unknown> }>;
  close: () => Promise<void>;
}

function tokenFromRequest(req: IncomingMessage): string {
  const header = req.headers["x-ah-token"];
  if (typeof header === "string") return header;
  try {
    const url = new URL(req.url ?? "", "ws://127.0.0.1");
    return url.searchParams.get("token") ?? "";
  } catch {
    return "";
  }
}

function route(
  verb: string,
  args: Record<string, unknown>,
  opts: MockBrokerOptions,
): MockReply {
  const handler = opts.handlers?.[verb];
  if (handler) {
    const r = handler(args);
    if (r && typeof r === "object" && ("ok" in r || "data" in r || "error" in r)) {
      return r as MockReply;
    }
    return { ok: true, data: r };
  }
  if (verb === "windows") return { ok: true, data: opts.windows ?? [] };
  if (verb === "sessions") {
    let s = opts.sessions ?? [];
    if (typeof args.repo === "string") s = s.filter((x) => x.repo === args.repo);
    if (typeof args.status === "string") s = s.filter((x) => x.status === args.status);
    return { ok: true, data: s };
  }
  // Default: echo the routed command so callers can assert what was dispatched.
  return { ok: true, data: { verb, args } };
}

export function startMockBroker(opts: MockBrokerOptions): Promise<MockBroker> {
  const commands: MockBroker["commands"] = [];
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    if (opts.token && tokenFromRequest(req) !== opts.token) {
      ws.close(1008, "unauthorized");
      return;
    }
    ws.on("message", (raw) => {
      let msg: { type?: string; cmdId?: string; verb?: string; args?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== "command" || typeof msg.verb !== "string") return;
      const args = (msg.args as Record<string, unknown>) ?? {};
      commands.push({ verb: msg.verb, args });
      const reply = route(msg.verb, args, opts);
      ws.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "result",
          cmdId: msg.cmdId,
          ok: reply.ok !== false,
          data: reply.data ?? null,
          error: reply.error ?? null,
        }),
      );
    });
  });

  return new Promise<MockBroker>((resolve) => {
    wss.on("listening", () => {
      const addr = wss.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        commands,
        close: () =>
          new Promise<void>((res) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => res());
          }),
      });
    });
  });
}
