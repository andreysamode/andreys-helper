import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "./dispatch";
import { startMockBroker } from "./mockBroker";
import type { MockBroker, MockBrokerOptions } from "./mockBroker";

const TOKEN = "test-token";

// Isolated config dir so `loadConfig` doesn't read the real ~/.andreys-helper,
// and repoScanDirs points at an empty dir so resolve-branch's git scan is inert.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "ah-cfg-"));
const EMPTY_SCAN = mkdtempSync(join(tmpdir(), "ah-scan-"));
writeFileSync(
  join(CONFIG_DIR, "config.json"),
  JSON.stringify({ repoScanDirs: [EMPTY_SCAN] }),
);

// Fixture transcript dir for find-session / summarize.
const PROJECTS_DIR = mkdtempSync(join(tmpdir(), "ah-proj-"));
const TRANSCRIPT_PATH = join(PROJECTS_DIR, "sess-broker.jsonl");
writeFileSync(
  TRANSCRIPT_PATH,
  [
    { type: "summary", summary: "Broker client work" },
    {
      type: "user",
      sessionId: "sess-broker",
      cwd: "/dev/core",
      message: { role: "user", content: "fix the broker reconnect logic" },
    },
    {
      type: "assistant",
      sessionId: "sess-broker",
      message: { role: "assistant", content: [{ type: "text", text: "reconnect fixed" }] },
    },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n") + "\n",
);
utimesSync(TRANSCRIPT_PATH, 1_700_000_000, 1_700_000_000);

process.env.AH_HOME = CONFIG_DIR;
process.env.AH_TOKEN = TOKEN;
process.env.AH_CLAUDE_PROJECTS = PROJECTS_DIR;

const WINDOWS = [
  {
    windowId: "w1",
    host: "cursor",
    repo: { name: "core", trunkPath: "/dev/core" },
    worktrees: [
      { path: "/dev/core", name: "core", branch: "main", isTrunk: true },
      { path: "/dev/core/wt/feature-x", name: "feature-x", branch: "feature-x", isTrunk: false },
    ],
  },
];

const SESSIONS = [
  { tabId: "t1", sessionId: "sess-1", cwd: "/dev/core", title: "Fix broker reconnect", status: "working", repo: "core" },
  { tabId: "t2", sessionId: "sess-2", cwd: "/dev/app", title: "Kanban board", status: "idle", repo: "app" },
];

/** Start a mock broker and point AH_PORT at it for the duration of `fn`. */
async function withBroker(
  opts: Partial<MockBrokerOptions>,
  fn: (b: MockBroker) => Promise<void>,
): Promise<void> {
  const b = await startMockBroker({
    token: TOKEN,
    windows: WINDOWS,
    sessions: SESSIONS,
    ...opts,
  });
  process.env.AH_PORT = String(b.port);
  try {
    await fn(b);
  } finally {
    await b.close();
  }
}

test("windows: returns broker window registry", async () => {
  await withBroker({}, async () => {
    const r = (await dispatch(["windows"])) as { windows: unknown[] };
    assert.equal(r.windows.length, 1);
    assert.equal((r.windows[0] as { windowId: string }).windowId, "w1");
  });
});

test("sessions: --repo filter routes to broker and filters", async () => {
  await withBroker({}, async (b) => {
    const r = (await dispatch(["sessions", "--repo", "core"])) as { sessions: unknown[] };
    assert.equal(r.sessions.length, 1);
    assert.equal((r.sessions[0] as { sessionId: string }).sessionId, "sess-1");
    assert.equal(b.commands.at(-1)?.verb, "sessions");
    assert.deepEqual(b.commands.at(-1)?.args, { repo: "core" });
  });
});

test("resolve-branch: matches open-window worktree, not ambiguous", async () => {
  await withBroker({}, async () => {
    const r = (await dispatch(["resolve-branch", "feature-x"])) as {
      matches: Array<{ repo: string; path: string; source: string }>;
      ambiguous: boolean;
    };
    assert.equal(r.matches.length, 1);
    assert.deepEqual(r.matches[0], {
      repo: "core",
      path: "/dev/core/wt/feature-x",
      source: "open-window",
    });
    assert.equal(r.ambiguous, false);
  });
});

test("find-session: live sessions first, then transcripts", async () => {
  await withBroker({}, async () => {
    const r = (await dispatch(["find-session", "broker"])) as {
      results: Array<{ source: string; sessionId?: string | null }>;
    };
    assert.ok(r.results.length >= 2);
    assert.equal(r.results[0].source, "live");
    assert.equal(r.results[0].sessionId, "sess-1");
    assert.ok(r.results.some((x) => x.source === "transcript" && x.sessionId === "sess-broker"));
  });
});

test("summarize: on-disk transcript by path", async () => {
  await withBroker({}, async () => {
    const r = (await dispatch(["summarize", TRANSCRIPT_PATH])) as {
      summary: { firstUserMessage: string; title: string | null; messageCount: number | null };
    };
    assert.match(r.summary.firstUserMessage, /fix the broker reconnect/);
    assert.equal(r.summary.title, "Broker client work");
    assert.equal(r.summary.messageCount, 2);
  });
});

test("summarize: by sessionId enriches with live status", async () => {
  await withBroker(
    { sessions: [{ tabId: "t", sessionId: "sess-broker", cwd: "/dev/core", title: "x", status: "done" }] },
    async () => {
      const r = (await dispatch(["summarize", "sess-broker"])) as {
        summary: { sessionId: string; live: { status: string } | null };
      };
      assert.equal(r.summary.sessionId, "sess-broker");
      assert.equal(r.summary.live?.status, "done");
    },
  );
});

test("open-window: cold-start command routed", async () => {
  await withBroker({}, async () => {
    const r = (await dispatch(["open-window", "/dev/core"])) as {
      verb: string;
      args: { repoPath: string };
    };
    assert.equal(r.verb, "openWindow");
    assert.equal(r.args.repoPath, "/dev/core");
  });
});

test("create-worktree: maps flags to createWorktree args", async () => {
  await withBroker({}, async () => {
    const r = (await dispatch([
      "create-worktree",
      "/dev/core",
      "feat",
      "--full",
      "--open",
      "window",
    ])) as { verb: string; args: Record<string, unknown> };
    assert.equal(r.verb, "createWorktree");
    assert.deepEqual(r.args, {
      repoRoot: "/dev/core",
      branch: "feat",
      full: true,
      open: "window",
    });
  });
});

test("spawn: maps to spawnSession with attachments", async () => {
  await withBroker({}, async () => {
    const r = (await dispatch([
      "spawn",
      "core",
      "/dev/core/wt",
      "--prompt",
      "do the thing",
      "--attach",
      "a.png",
      "--attach",
      "b.png",
    ])) as { verb: string; args: Record<string, unknown> };
    assert.equal(r.verb, "spawnSession");
    assert.deepEqual(r.args, {
      target: "core",
      worktreePath: "/dev/core/wt",
      prompt: "do the thing",
      attachments: ["a.png", "b.png"],
    });
  });
});

test("send: maps to sendPrompt", async () => {
  await withBroker({}, async () => {
    const r = (await dispatch(["send", "sess-1", "--text", "hello there"])) as {
      verb: string;
      args: Record<string, unknown>;
    };
    assert.equal(r.verb, "sendPrompt");
    assert.equal(r.args.sessionId, "sess-1");
    assert.equal(r.args.text, "hello there");
  });
});

test("interrupt: single session", async () => {
  await withBroker({}, async () => {
    const r = (await dispatch(["interrupt", "sess-1"])) as {
      verb: string;
      args: { sessionId: string };
    };
    assert.equal(r.verb, "interrupt");
    assert.equal(r.args.sessionId, "sess-1");
  });
});

test("interrupt --all: acts on every session and reports each", async () => {
  await withBroker({}, async (b) => {
    const r = (await dispatch(["interrupt", "--all"])) as {
      scope: string;
      count: number;
      results: Array<{ sessionId: string; ok: boolean }>;
    };
    assert.equal(r.scope, "all");
    assert.equal(r.count, 2);
    assert.deepEqual(r.results.map((x) => x.sessionId).sort(), ["sess-1", "sess-2"]);
    assert.ok(r.results.every((x) => x.ok));
    const interrupts = b.commands.filter((c) => c.verb === "interrupt");
    assert.equal(interrupts.length, 2);
  });
});

test("interrupt --repo R: acts only on that repo's sessions", async () => {
  await withBroker({}, async () => {
    const r = (await dispatch(["interrupt", "--repo", "core"])) as {
      scope: string;
      count: number;
      results: Array<{ sessionId: string }>;
    };
    assert.equal(r.scope, "repo:core");
    assert.equal(r.count, 1);
    assert.equal(r.results[0].sessionId, "sess-1");
  });
});

test("reveal / schedule / alert route to their verbs", async () => {
  await withBroker({}, async () => {
    const reveal = (await dispatch(["reveal", "sess-1"])) as { verb: string; args: { sessionId: string } };
    assert.equal(reveal.verb, "reveal");
    assert.equal(reveal.args.sessionId, "sess-1");

    const schedule = (await dispatch(["schedule", "in", "10m", "alert", "done"])) as {
      verb: string;
      args: { spec: string };
    };
    assert.equal(schedule.verb, "schedule");
    assert.equal(schedule.args.spec, "in 10m alert done");

    const alert = (await dispatch(["alert", "build", "finished"])) as {
      verb: string;
      args: { text: string };
    };
    assert.equal(alert.verb, "alert");
    assert.equal(alert.args.text, "build finished");
  });
});

test("unauthorized token is rejected", async () => {
  await withBroker({ token: "different-token" }, async () => {
    await assert.rejects(dispatch(["windows"]));
  });
});

test("unknown verb errors", async () => {
  await assert.rejects(dispatch(["bogus"]), /unknown verb/);
});
