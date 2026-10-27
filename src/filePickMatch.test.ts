import { strict as assert } from "node:assert";
import { test } from "node:test";
import { FileCandidate, parseFileQuery, rankFiles, toCandidate } from "./filePickMatch";

const FILES = [
  "src/scmMirrorView.ts",
  "src/scmParse.ts",
  "src/scmInfo.ts",
  "src/scmInfo.test.ts",
  "src/claudePanes.ts",
  "src/claudeTab.ts",
  "src/git.ts",
  "src/kym/mirrorHelpers.ts",
  "media/view.css",
  "orchestrator/Sources/App/MoonView.swift",
  "README.md",
  "package.json",
];

const CANDIDATES: FileCandidate[] = FILES.map((f) => toCandidate(f));

function rank(q: string, limit = 50): string[] {
  return rankFiles(CANDIDATES, parseFileQuery(q), limit).map((c) => c.rel);
}

test("parseFileQuery: splits on whitespace into ANDable terms", () => {
  assert.deepEqual(parseFileQuery("scm mirror").terms, ["scm", "mirror"]);
  assert.deepEqual(parseFileQuery("   scm   mirror  ").terms, ["scm", "mirror"]);
  assert.deepEqual(parseFileQuery("").terms, []);
});

test("parseFileQuery: peels a trailing :line and :line:col", () => {
  assert.deepEqual(parseFileQuery("git.ts:42"), { terms: ["git.ts"], line: 42, col: undefined });
  assert.deepEqual(parseFileQuery("git.ts:42:7"), { terms: ["git.ts"], line: 42, col: 7 });
  // Nothing before the colon: it's a search term, there is no file to jump in.
  assert.deepEqual(parseFileQuery(":42").terms, [":42"]);
});

test("empty query returns everything up to the limit, in given order", () => {
  assert.deepEqual(rank("", 3), FILES.slice(0, 3));
});

test("two space-separated terms AND together regardless of order", () => {
  // The whole point of the rewrite: a plain QuickPick finds nothing for these.
  assert.equal(rank("scm mirror")[0], "src/scmMirrorView.ts");
  assert.equal(rank("mirror scm")[0], "src/scmMirrorView.ts");
  assert.equal(rank("view mirror")[0], "src/scmMirrorView.ts");
});

test("a term that matches nothing eliminates the file even if the other matches", () => {
  assert.deepEqual(rank("scm zzzz"), []);
  assert.ok(rank("scm").length > 1);
});

test("terms may match in different places — one in the folder, one in the name", () => {
  assert.equal(rank("kym mirror")[0], "src/kym/mirrorHelpers.ts");
  assert.equal(rank("media view")[0], "media/view.css");
});

test("subsequence matching, not substring", () => {
  assert.equal(rank("smv")[0], "src/scmMirrorView.ts");
  assert.equal(rank("cpanes")[0], "src/claudePanes.ts");
});

test("file name matches outrank same-strength directory matches", () => {
  // "view" is a whole word in media/view.css's name and a camel hump mid-name
  // in scmMirrorView.ts; the exact-name match must come first.
  assert.equal(rank("view")[0], "media/view.css");
});

test("exact and prefix matches win over scattered ones", () => {
  assert.equal(rank("git.ts")[0], "src/git.ts");
  assert.equal(rank("README")[0], "README.md");
  assert.equal(rank("package")[0], "package.json");
});

test("a term containing a slash is matched against the full path", () => {
  assert.equal(rank("src/scmp")[0], "src/scmParse.ts");
  assert.equal(rank("sources/moon")[0], "orchestrator/Sources/App/MoonView.swift");
  assert.deepEqual(rank("media/git"), []);
});

test("matching is case-insensitive in both directions", () => {
  assert.equal(rank("SCMMIRROR")[0], "src/scmMirrorView.ts");
  assert.equal(rank("moonview")[0], "orchestrator/Sources/App/MoonView.swift");
});

test("the :line suffix is not matched as text", () => {
  assert.equal(rank("scmMirrorView:120")[0], "src/scmMirrorView.ts");
});

test("shorter paths break score ties", () => {
  const got = rank("scminfo");
  assert.deepEqual(got.slice(0, 2), ["src/scmInfo.ts", "src/scmInfo.test.ts"]);
});

test("limit caps the result list but not what was considered", () => {
  assert.equal(rank("s", 2).length, 2);
  // Still the globally best match, not merely the first two files that matched.
  assert.equal(rank("scmmirrorview", 1)[0], "src/scmMirrorView.ts");
});

test("ranking is stable — same query, same order", () => {
  assert.deepEqual(rank("s"), rank("s"));
});

test("paths with spaces and unicode are candidates like any other", () => {
  const odd = ["my docs/Résumé final.md", "a.md"].map((f) => toCandidate(f));
  assert.deepEqual(
    rankFiles(odd, parseFileQuery("docs résumé"), 10).map((c) => c.rel),
    ["my docs/Résumé final.md"]
  );
});

test("the bounded top-K returns the true global best, not the first K matched", () => {
  // The exact match is seeded LAST, so a cap that merely kept the first few
  // matches it walked past would miss it.
  const many = Array.from({ length: 5000 }, (_, i) => `pkg${i}/deep/nest/alpha${i}.ts`);
  many.push("alpha.ts");
  const pool = many.map((f) => toCandidate(f));
  const got = rankFiles(pool, parseFileQuery("alpha"), 3).map((c) => c.rel);
  assert.equal(got[0], "alpha.ts");
  assert.equal(got.length, 3);
});

test("top-K order matches a full sort of the same matches", () => {
  const pool = Array.from({ length: 800 }, (_, i) => `a${i}/b${i % 7}/scmView${i}.ts`).map((f) => toCandidate(f));
  const q = parseFileQuery("scm view");
  const capped = rankFiles(pool, q, 10).map((c) => c.rel);
  const full = rankFiles(pool, q, pool.length).slice(0, 10).map((c) => c.rel);
  assert.deepEqual(capped, full);
});

test("gitignored files are listed, but lose a tie to a tracked file", () => {
  const pool = [toCandidate("src/config.ts"), toCandidate("src/config.local.ts", true)];
  assert.equal(rankFiles(pool, parseFileQuery("config"), 5)[0].rel, "src/config.ts");
  // ...and are still findable on their own terms.
  assert.deepEqual(
    rankFiles(pool, parseFileQuery("local"), 5).map((c) => c.rel),
    ["src/config.local.ts"]
  );
});

test("the ignored penalty never drops a weakly-matching file out of the results", () => {
  const pool = [toCandidate(".env.local", true)];
  assert.deepEqual(
    rankFiles(pool, parseFileQuery("envlocal"), 5).map((c) => c.rel),
    [".env.local"]
  );
  assert.deepEqual(
    rankFiles(pool, parseFileQuery("el"), 5).map((c) => c.rel),
    [".env.local"]
  );
});
