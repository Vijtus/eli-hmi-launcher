import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/main/config.ts";

const BASE = { appRoot: "/tmp/app", configDir: "/tmp/cfg" };

test("semicolon strings and YAML lists parse to the same multi-values", () => {
  const parsed = parseConfig(
    `
entries:
  - id: a
    name: A
    technology: "L4b; L4c"
    section: [L4b, L4c]
    target: { kind: web, url: "https://example.local/a" }
`,
    BASE,
  );
  assert.deepEqual(parsed.rows[0].technology, ["L4b", "L4c"]);
  assert.deepEqual(parsed.rows[0].section, ["L4b", "L4c"]);
});

test("duplicate ids across entries and actions are rejected at load", () => {
  assert.throws(
    () =>
      parseConfig(
        `
entries:
  - id: dup
    name: Row
    target: { kind: web, url: "https://example.local/row" }
quickActions:
  - id: dup
    label: Action
    target: { kind: web, url: "https://example.local/action" }
`,
        BASE,
      ),
    /Duplicate launcher id 'dup'/,
  );
});

test("non-HTTP(S) web URLs are rejected at load", () => {
  assert.throws(
    () =>
      parseConfig(
        `
entries:
  - id: bad
    name: Bad
    target: { kind: web, url: "file:///etc/passwd" }
`,
        BASE,
      ),
    /Only HTTP\(S\) URLs are allowed/,
  );
});

test("unsupported target kinds are rejected with the entry name", () => {
  assert.throws(
    () =>
      parseConfig(
        `
entries:
  - id: bad
    name: Bad Kind
    target: { kind: shortcut, command: /opt/x }
`,
        BASE,
      ),
    /Entry 'Bad Kind' has unsupported target kind 'shortcut'/,
  );
});

test("a process target without a command is rejected", () => {
  assert.throws(
    () =>
      parseConfig(
        `
entries:
  - id: bad
    name: No Command
    target: { kind: process }
`,
        BASE,
      ),
    /process target without command/,
  );
});
