import { strict as assert } from "node:assert";
import { test } from "node:test";
import { matchWatchPatterns } from "./watchPatterns";

const DEFAULTS = ["**/migrations/*.py", "!**/migrations/__init__.py"];

test("matches nested Django migrations", () => {
  const files = [
    "billing/migrations/0007_add_invoice.py",
    "app/sub/migrations/0042_add_field.py",
    "app/models.py",
    "README.md",
  ];
  assert.deepEqual(matchWatchPatterns(files, DEFAULTS), [
    "billing/migrations/0007_add_invoice.py",
    "app/sub/migrations/0042_add_field.py",
  ]);
});

test("negation excludes __init__.py", () => {
  const files = [
    "billing/migrations/__init__.py",
    "billing/migrations/0001_initial.py",
  ];
  assert.deepEqual(matchWatchPatterns(files, DEFAULTS), [
    "billing/migrations/0001_initial.py",
  ]);
});

test("top-level migrations dir matches ** prefix", () => {
  assert.deepEqual(
    matchWatchPatterns(["migrations/0001_initial.py"], DEFAULTS),
    ["migrations/0001_initial.py"]
  );
});

test("no positive patterns → nothing matches", () => {
  assert.deepEqual(
    matchWatchPatterns(["a/migrations/0001_x.py"], ["!**/skip.py"]),
    []
  );
});

test("watching a specific file", () => {
  const patterns = ["config/settings.py"];
  assert.deepEqual(
    matchWatchPatterns(
      ["config/settings.py", "config/settings_local.py"],
      patterns
    ),
    ["config/settings.py"]
  );
});

test("multiple positive patterns union", () => {
  const patterns = ["**/migrations/*.py", "requirements*.txt"];
  assert.deepEqual(
    matchWatchPatterns(
      ["requirements.txt", "a/migrations/0002_y.py", "src/main.py"],
      patterns
    ),
    ["requirements.txt", "a/migrations/0002_y.py"]
  );
});

test("empty inputs", () => {
  assert.deepEqual(matchWatchPatterns([], DEFAULTS), []);
  assert.deepEqual(matchWatchPatterns(["a/migrations/0001_x.py"], []), []);
});

test("invalid pattern is skipped, not fatal", () => {
  assert.deepEqual(
    matchWatchPatterns(["a/migrations/0001_x.py"], ["", "**/migrations/*.py"]),
    ["a/migrations/0001_x.py"]
  );
});
