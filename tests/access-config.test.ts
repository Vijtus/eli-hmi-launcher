import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/main/config/load.ts";

const BASE = { appRoot: "/tmp/app", configDir: "/tmp/cfg" };

function parseAccess(yaml: string, id = "gui") {
  const parsed = parseConfig(yaml, BASE);
  const policy = parsed.accessPoliciesById.get(id);
  assert.ok(policy, `expected access policy for ${id}`);
  return policy;
}

test("platform policy is case-insensitive and item policy has final precedence", () => {
  const policy = parseAccess(`
access:
  platforms:
    LABVIEW:
      maxInstances: 2
      onAlreadyRunning: prompt
      onUnknownState: allow
entries:
  - id: gui
    name: GUI
    platform: LabView
    access:
      maxInstances: 3
      launchMode: read
      onUnknownState: block
    target:
      kind: process
      command: /tmp/gui
`);

  assert.deepEqual(policy, {
    maxInstances: 3,
    writeModeExclusive: true,
    launchMode: "read",
    onAlreadyRunning: "prompt",
    onUnknownState: "block",
  });
});

test("typed LabVIEW actions receive restrictive defaults without a platform column", () => {
  const policy = parseAccess(
    `
local:
  workspaceRoot: C:\\ELI Workspace
  zoneSymbol: L4
quickActions:
  - id: gui
    label: Developer GUI
    target:
      kind: labview-dev
      iocName: IOC-1
      hostName: host-1
      iocType: Laser
      exeName: GUI.exe
`,
  );
  assert.equal(policy.maxInstances, 1);
  assert.equal(policy.writeModeExclusive, true);
  assert.equal(policy.launchMode, "unknown");
  assert.equal(policy.onUnknownState, "block");
});

test("maxInstances null explicitly clears the restrictive LabVIEW default", () => {
  const policy = parseAccess(`
local:
  workspaceRoot: C:\\ELI Workspace
  zoneSymbol: L4
entries:
  - id: gui
    name: GUI
    platform: LabVIEW
    access:
      maxInstances: null
      writeModeExclusive: true
      launchMode: write
    target:
      kind: labview-epics
      guiName: Laser GUI
      guiType: Laser
      exeName: GUI.exe
`);
  assert.equal(policy.maxInstances, undefined);
  assert.equal(policy.writeModeExclusive, true);
  assert.equal(policy.launchMode, "write");
});

test("invalid access values fail at load with the precise item key", () => {
  assert.throws(
    () =>
      parseConfig(
        `
entries:
  - id: bad
    name: Bad
    access:
      maxInstances: 0
    target: { kind: process, command: /tmp/bad }
`,
        BASE,
      ),
    /`entries\.bad\.access\.maxInstances` must be a positive integer/,
  );

  assert.throws(
    () =>
      parseConfig(
        `
entries:
  - id: bad
    name: Bad
    access:
      onAlreadyRunning: silently-ignore
    target: { kind: process, command: /tmp/bad }
`,
        BASE,
      ),
    /`entries\.bad\.access\.onAlreadyRunning` must be one of: block, focus, prompt/,
  );
});

test("access policy remains internal and is not exposed as renderer-owned enforcement state", () => {
  const parsed = parseConfig(
    `
entries:
  - id: gui
    name: GUI
    platform: LabVIEW
    target: { kind: process, command: /tmp/gui }
`,
    BASE,
  );
  assert.equal("access" in parsed.rows[0], false);
  assert.equal(parsed.accessPoliciesById.get("gui")?.maxInstances, 1);
});
