import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { BrokerClient } from "./broker/client";
import { CommandDeps, createCommandDispatcher } from "./broker/commands";
import { MockBroker } from "./broker/mockBroker";
import { COMMAND_VERBS } from "./broker/protocol";
import { extractJson } from "./wt";

/**
 * Smoke test for the extension broker client (PLAN.md §8 W1). Exercises the full
 * round trip against an in-process mock broker: the `hello` handshake + token,
 * streaming snapshots, every command verb executing and acking, and surviving a
 * broker restart (reconnect).
 *
 * Lives at the top level of `src/` so `npm test`'s `src/*.test.ts` glob picks it
 * up; the broker modules under test live in `src/broker/`.
 */

const TOKEN = "test-token";

/** A fake open Claude tab, for the dispatcher's session→tab resolution. */
interface FakeTab {
  id: string;
  cwd: string;
  title: string;
  status: string;
  sessionId?: string;
  col?: number;
  active?: boolean;
}

/** Records calls so the test can assert the verb→primitive mapping fired. */
interface Calls {
  opened: Array<{ path: string; prompt?: string }>;
  submitted: Array<{ tabId: string; text: string }>;
  interrupted: string[];
  revealed: string[];
  renamed: Array<{ tabId: string; title: string }>;
  openedWindows: string[];
  snapshotsRequested: number;
}

function makeDeps(): { deps: CommandDeps; calls: Calls; tabs: FakeTab[] } {
  const tabs: FakeTab[] = [
    {
      id: "wt1",
      cwd: "/repo/wt/feat",
      title: "Claude",
      status: "working",
      sessionId: "sess-uuid-1",
      col: 1,
      active: true,
    },
  ];
  const calls: Calls = {
    opened: [],
    submitted: [],
    interrupted: [],
    revealed: [],
    renamed: [],
    openedWindows: [],
    snapshotsRequested: 0,
  };
  const deps: CommandDeps = {
    openWorktreeClaudeTab: async (path, prompt) => {
      calls.opened.push({ path, prompt });
      // Simulate a fresh tab appearing (no sessionId yet — handshake pending).
      tabs.push({ id: "wt-new", cwd: path, title: "Claude", status: "working" });
    },
    tabs: () => tabs as unknown as ReturnType<CommandDeps["tabs"]>,
    submitPrompt: async (tabId, text) => {
      calls.submitted.push({ tabId, text });
      return true;
    },
    interrupt: async (tabId) => {
      calls.interrupted.push(tabId);
      return true;
    },
    reveal: async (tabId) => {
      calls.revealed.push(tabId);
    },
    rename: async (tabId, title) => {
      calls.renamed.push({ tabId, title });
      return true;
    },
    runWt: async (args) => {
      if (args.includes("switch")) {
        return {
          code: 0,
          stdout: '{"action":"created","branch":"feat-x","path":"/repo/wt/feat-x"}',
          stderr: "",
        };
      }
      if (args.includes("list")) {
        return {
          code: 0,
          stdout:
            '[{"branch":"main","path":"/repo","is_main":true,"is_current":true}]',
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    extractJson: (out) => extractJson(out),
    branchExists: async () => false,
    remoteBranchExists: async () => false,
    openFolderWindow: async (path) => {
      calls.openedWindows.push(path);
    },
    trunkPath: () => "/repo",
    realPath: (p) => p,
    requestSnapshot: () => {
      calls.snapshotsRequested++;
    },
    spawnWaitMs: 1000,
  };
  return { deps, calls, tabs };
}

let broker: MockBroker;
let client: BrokerClient;
let calls: Calls;

before(async () => {
  broker = new MockBroker(TOKEN);
  const port = await broker.start();
  const built = makeDeps();
  calls = built.calls;
  client = new BrokerClient({
    connection: () => ({ port, token: TOKEN }),
    host: "vscode",
    getRepo: () => ({ name: "repo", trunkPath: "/repo" }),
    buildSnapshot: () => ({
      worktrees: [
        {
          path: "/repo",
          name: "repo",
          branch: "main",
          ahead: 0,
          behind: 0,
          isTrunk: true,
        },
      ],
      sessions: [
        {
          tabId: "wt1",
          sessionId: "sess-uuid-1",
          cwd: "/repo/wt/feat",
          title: "Claude",
          status: "working",
          seen: false,
          col: 1,
          active: true,
        },
      ],
      focused: true,
    }),
    dispatch: createCommandDispatcher(built.deps),
    debounceMs: 20,
    backoff: { baseMs: 40, maxMs: 200 },
  });
  client.start();
});

after(async () => {
  client.dispose();
  await broker.stop();
});

test("hello handshake carries windowId, host, repo, and the correct token", async () => {
  await broker.waitUntil((b) => b.hellos.length >= 1);
  const hello = broker.hellos[0];
  assert.equal(hello.type, "hello");
  assert.equal(hello.token, TOKEN);
  assert.equal(hello.host, "vscode");
  assert.equal(hello.windowId, client.windowId);
  assert.equal(hello.repo.name, "repo");
  assert.equal(hello.repo.trunkPath, "/repo");
  assert.equal(broker.rejectedHellos.length, 0);
});

test("a full snapshot is published on connect", async () => {
  await broker.waitUntil((b) => b.snapshots.length >= 1);
  const snap = broker.snapshots[0];
  assert.equal(snap.type, "snapshot");
  assert.equal(snap.windowId, client.windowId);
  assert.equal(snap.worktrees.length, 1);
  assert.equal(snap.worktrees[0].isTrunk, true);
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0].sessionId, "sess-uuid-1");
});

test("every command verb executes and acks (PLAN.md §6.2 table)", async () => {
  // spawnSession → returns a tabId immediately (temp-id → sessionId handshake).
  const spawn = await broker.sendCommand("spawnSession", {
    worktreePath: "/repo/wt/new",
    prompt: "do the thing",
  });
  assert.equal(spawn.ok, true, spawn.error ?? "");
  assert.equal((spawn.data as { tabId: string }).tabId, "wt-new");
  assert.equal((spawn.data as { sessionId: string | null }).sessionId, null);
  assert.deepEqual(calls.opened[0], { path: "/repo/wt/new", prompt: "do the thing" });
  assert.ok(calls.snapshotsRequested >= 1, "spawn should request a fresh snapshot");

  // sendPrompt → resolves the persistent sessionId to its tab's panel id.
  const send = await broker.sendCommand("sendPrompt", {
    sessionId: "sess-uuid-1",
    text: "hi",
  });
  assert.equal(send.ok, true, send.error ?? "");
  assert.deepEqual(calls.submitted[0], { tabId: "wt1", text: "hi" });

  // interrupt
  const intr = await broker.sendCommand("interrupt", { sessionId: "sess-uuid-1" });
  assert.equal(intr.ok, true, intr.error ?? "");
  assert.deepEqual(calls.interrupted, ["wt1"]);

  // reveal
  const rev = await broker.sendCommand("reveal", { sessionId: "sess-uuid-1" });
  assert.equal(rev.ok, true, rev.error ?? "");
  assert.deepEqual(calls.revealed, ["wt1"]);

  // rename
  const ren = await broker.sendCommand("rename", {
    sessionId: "sess-uuid-1",
    title: "renamed",
  });
  assert.equal(ren.ok, true, ren.error ?? "");
  assert.deepEqual(calls.renamed[0], { tabId: "wt1", title: "renamed" });

  // createWorktree
  const cw = await broker.sendCommand("createWorktree", {
    repoRoot: "/repo",
    branch: "feat-x",
    open: "window",
  });
  assert.equal(cw.ok, true, cw.error ?? "");
  assert.equal((cw.data as { path: string }).path, "/repo/wt/feat-x");
  assert.deepEqual(calls.openedWindows, ["/repo/wt/feat-x"]);

  // listWorktrees
  const list = await broker.sendCommand("listWorktrees", {});
  assert.equal(list.ok, true, list.error ?? "");
  const wts = (list.data as { worktrees: unknown[] }).worktrees;
  assert.equal(wts.length, 1);

  // Sanity: we exercised every verb in the protocol table.
  assert.equal(COMMAND_VERBS.length, 7);
});

test("addressing a not-yet-open session acks with an error, never throws", async () => {
  const res = await broker.sendCommand("sendPrompt", {
    sessionId: "does-not-exist",
    text: "x",
  });
  assert.equal(res.ok, false);
  assert.ok(res.error && res.error.includes("no open session"));
});

test("survives a broker restart (reconnect + re-hello + re-snapshot)", async () => {
  const helloCountBefore = broker.hellos.length;
  const port = broker.port;

  // Kill the broker; the client must silently back off and retry.
  await broker.stop();
  // Give the client a moment to notice the drop.
  await new Promise((r) => setTimeout(r, 100));

  // Restart on the SAME port; the client should reconnect on its own.
  await broker.start(port);
  await broker.waitUntil((b) => b.hellos.length > helloCountBefore, 6000);
  await broker.waitUntil((b) => b.snapshots.length >= 1, 6000);

  const reHello = broker.hellos[broker.hellos.length - 1];
  assert.equal(reHello.windowId, client.windowId, "same windowId re-announced");
  assert.equal(reHello.token, TOKEN);

  // Commands work again after reconnect.
  const res = await broker.sendCommand("reveal", { sessionId: "sess-uuid-1" });
  assert.equal(res.ok, true, res.error ?? "");
});

/**
 * Regression: the snapshot debounce must be bounded.
 *
 * `notifyChange` used to reset a trailing timer on every call, so a window whose
 * state changed faster than `debounceMs` never reached the trailing edge and
 * published NOTHING for as long as the churn lasted. A window running a
 * streaming Claude session is exactly that window, and since `focused` rides
 * along on the snapshot, the window the user was actually sitting in was the one
 * least able to tell the broker so — leaving another repo's window styled as
 * upfront in the orchestrator.
 */
test("a window changing faster than the debounce still publishes", async () => {
  const starveBroker = new MockBroker(TOKEN);
  const port = await starveBroker.start();
  let focused = false;
  const starveClient = new BrokerClient({
    connection: () => ({ port, token: TOKEN }),
    host: "vscode",
    getRepo: () => ({ name: "repo", trunkPath: "/repo" }),
    buildSnapshot: () => ({ worktrees: [], sessions: [], focused }),
    dispatch: async () => ({ ok: true, data: null, error: null }),
    debounceMs: 50,
    maxWaitMs: 200,
    backoff: { baseMs: 40, maxMs: 200 },
  });
  try {
    starveClient.start();
    await starveBroker.waitUntil((b) => b.snapshots.length >= 1);
    const before = starveBroker.snapshots.length;

    // Churn every 20ms for 600ms — well inside the 50ms debounce every time.
    const stop = Date.now() + 600;
    while (Date.now() < stop) {
      starveClient.notifyChange();
      await new Promise((r) => setTimeout(r, 20));
    }
    const during = starveBroker.snapshots.length - before;
    assert.ok(
      during >= 2,
      `expected the 200ms max-wait to force publishes during churn, got ${during}`
    );

    // A focus change is published immediately, not merged into the churn.
    focused = true;
    const beforeFocus = starveBroker.snapshots.length;
    starveClient.notifyChange({ immediate: true });
    await starveBroker.waitUntil(
      (b) => b.snapshots.length > beforeFocus && b.snapshots[b.snapshots.length - 1].focused,
      500
    );
    assert.equal(
      starveBroker.snapshots[starveBroker.snapshots.length - 1].focused,
      true
    );
  } finally {
    starveClient.dispose();
    await starveBroker.stop();
  }
});
