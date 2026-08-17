import assert from "node:assert/strict";
import test from "node:test";
import { materializeProcessTarget, parseConfig } from "../src/main/config.ts";
import type { ProcessLaunchTarget } from "../src/shared/types.ts";

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

test("local machine settings may be absent when no launcher item uses them", () => {
  const parsed = parseConfig(
    `
entries:
  - id: web-only
    name: Web only
    target: { kind: web, url: "https://example.local/" }
`,
    BASE,
  );
  assert.deepEqual(parsed.context.local, { phoebus: {}, hosts: {}, hmiApi: {}, monitoring: {} });
});

test("undefined local references fail at load with the key and entry id", () => {
  assert.throws(
    () =>
      parseConfig(
        `
entries:
  - id: needs-workspace
    name: Needs workspace
    target:
      kind: process
      command: "${"${local.workspaceRoot}"}/Common/start.exe"
`,
        BASE,
      ),
    (error: unknown) => {
      assert.match(String(error), /`local\.workspaceRoot` is required/);
      assert.match(String(error), /entry `needs-workspace`/);
      assert.match(String(error), /`target\.command`/);
      return true;
    },
  );
});

test("local values participate in configured-string expansion", () => {
  const parsed = parseConfig(
    `
local:
  workspaceRoot: /srv/eli workspace
  hosts:
    mockIoc: 127.0.0.1
entries:
  - id: expanded
    name: Expanded
    target:
      kind: process
      command: "${"${local.workspaceRoot}"}/Common/start.exe"
      args: ["${"${local.hosts.mockIoc}"}"]
`,
    BASE,
  );
  const target = parsed.targetsById.get("expanded") as ProcessLaunchTarget;
  const materialized = materializeProcessTarget(target, parsed.context);
  assert.equal(materialized.command, "/srv/eli workspace/Common/start.exe");
  assert.deepEqual(materialized.args, ["127.0.0.1"]);
});

test("local Phoebus port validation names the offending key", () => {
  assert.throws(
    () => parseConfig("local:\n  phoebus:\n    serverPort: 70000\n", BASE),
    /`local\.phoebus\.serverPort` must be an integer from 1 to 65535/,
  );
});

test("local runtime reconciliation interval must be a positive integer", () => {
  assert.throws(
    () => parseConfig("local:\n  monitoring:\n    reconcileIntervalMs: 0\n", BASE),
    /`local\.monitoring\.reconcileIntervalMs` must be a positive integer/,
  );
});

test("local lifecycle API settings are parsed and available for expansion", () => {
  const parsed = parseConfig(
    `
local:
  hmiApi:
    baseUrl: http://127.0.0.1:8765/api/lifecycle/v1
    stationId: launcher-test
    authTokenEnv: TEST_LIFECYCLE_TOKEN
    requestTimeoutMs: 2345
    heartbeatIntervalMs: 6789
entries:
  - id: api-path
    name: API path
    target:
      kind: process
      command: /tmp/launcher
      args: ["${"${local.hmiApi.stationId}"}"]
`,
    BASE,
  );

  assert.deepEqual(parsed.context.local.hmiApi, {
    baseUrl: "http://127.0.0.1:8765/api/lifecycle/v1",
    stationId: "launcher-test",
    authTokenEnv: "TEST_LIFECYCLE_TOKEN",
    requestTimeoutMs: 2345,
    heartbeatIntervalMs: 6789,
  });
  const target = parsed.targetsById.get("api-path") as ProcessLaunchTarget;
  assert.deepEqual(materializeProcessTarget(target, parsed.context).args, ["launcher-test"]);
});

test("local lifecycle API durations must be positive integers", () => {
  for (const key of ["requestTimeoutMs", "heartbeatIntervalMs"] as const) {
    assert.throws(
      () => parseConfig(`local:\n  hmiApi:\n    ${key}: 0\n`, BASE),
      new RegExp(`local\\.hmiApi\\.${key}.*positive integer`),
    );
  }
});
