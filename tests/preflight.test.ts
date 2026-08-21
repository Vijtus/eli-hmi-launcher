import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "../src/main/config.ts";
import { preflightConfig } from "../src/main/preflight.ts";

function workspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "eli-preflight-"));
}

function executable(root: string, name: string): string {
  const full = path.join(root, name);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") {
    chmodSync(full, 0o755);
  }
  return full;
}

async function check(yaml: string, root: string) {
  const parsed = parseConfig(yaml, { appRoot: root, configDir: root });
  const findings = await preflightConfig(parsed);
  return new Map(findings.map((finding) => [finding.id, finding]));
}

test("a command that exists and is allowed reports ready", async () => {
  const root = workspace();
  try {
    const command = executable(root, "bin/real.sh");
    const findings = await check(
      `security:\n  allowedCommandRoots: [${JSON.stringify(root)}]\nentries:\n` +
        `  - id: ok\n    name: Works\n    target: { kind: process, command: ${JSON.stringify(command)} }\n`,
      root,
    );
    assert.equal(findings.get("ok")?.status, "ready");
    assert.equal(findings.get("ok")?.resolvedCommand, command);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The whole point on a real machine: say which programs simply are not here.
test("a command that is not installed reports missing, not an error", async () => {
  const root = workspace();
  try {
    const absent = path.join(root, "bin", "absent.exe");
    const findings = await check(
      `security:\n  allowedCommandRoots: [${JSON.stringify(root)}]\nentries:\n` +
        `  - id: gone\n    name: Missing\n    target: { kind: process, command: ${JSON.stringify(absent)} }\n`,
      root,
    );
    assert.equal(findings.get("gone")?.status, "missing");
    assert.match(findings.get("gone")?.detail ?? "", /does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A policy refusal must not be reported as a missing file, or someone goes
// hunting for a program that was never the problem.
test("a command outside the allow-list reports denied, distinct from missing", async () => {
  const root = workspace();
  const other = workspace();
  try {
    const command = executable(other, "outside.sh");
    const findings = await check(
      `security:\n  allowedCommandRoots: [${JSON.stringify(root)}]\n  allowBareCommands: false\nentries:\n` +
        `  - id: outside\n    name: Outside\n    target: { kind: process, command: ${JSON.stringify(command)} }\n`,
      root,
    );
    assert.equal(findings.get("outside")?.status, "denied");
    assert.equal(findings.get("outside")?.resolvedCommand, command);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

// A missing local.* setting never reaches preflight: parseConfig rejects the
// whole file, the launcher shows its configuration-error window, and the field
// report records that failure instead of a per-entry finding. Pinned here so the
// division of responsibility stays visible.
test("a missing local setting is rejected at parse time, before preflight runs", () => {
  const root = workspace();
  try {
    assert.throws(
      () =>
        parseConfig(
          "entries:\n" +
            "  - id: lv\n    name: LabVIEW\n    target:\n      kind: labview-dev\n" +
            "      iocName: Cam\n      hostName: RMC00-001\n      iocType: Cam\n      exeName: CMD.exe\n",
          { appRoot: root, configDir: root },
        ),
      /local\.workspaceRoot` is required/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// What preflight does own: an entry that parses but resolves to something the
// machine cannot run.
test("a labview entry whose workspace is configured but absent reports missing", async () => {
  const root = workspace();
  try {
    const workspaceRoot = path.join(root, "not-here");
    const findings = await check(
      // Mirrors what host/<machine>.yaml supplies on a real deployment: the
      // workspace root and zone symbol come from the config repo, not from the
      // machine the config happens to be validated on.
      `local:\n  workspaceRoot: ${JSON.stringify(workspaceRoot)}\n  zoneSymbol: TESTZ\n` +
        `security:\n  allowedCommandRoots: [${JSON.stringify(root)}]\nentries:\n` +
        "  - id: lv\n    name: LabVIEW\n    target:\n      kind: labview-dev\n" +
        "      iocName: Cam\n      hostName: RMC00-001\n      iocType: Cam\n      exeName: CMD.exe\n",
      root,
    );
    assert.equal(findings.get("lv")?.status, "missing");
    assert.match(findings.get("lv")?.resolvedCommand ?? "", /CMD\.exe$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a web target is reported without any network traffic", async () => {
  const root = workspace();
  try {
    const findings = await check(
      "entries:\n  - id: web\n    name: Web\n    target: { kind: web, url: 'https://panels.invalid/x' }\n",
      root,
    );
    assert.equal(findings.get("web")?.status, "ready");
    assert.match(findings.get("web")?.detail ?? "", /panels\.invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight never throws, it reports", async () => {
  const root = workspace();
  try {
    const findings = await check(
      `security:\n  allowedCommandRoots: [${JSON.stringify(root)}]\nentries:\n` +
        `  - id: a\n    name: A\n    target: { kind: process, command: ${JSON.stringify(path.join(root, "nope"))} }\n` +
        "  - id: b\n    name: B\n    target: { kind: folder, path: '/definitely/not/here' }\n",
      root,
    );
    assert.equal(findings.size, 2);
    assert.equal(findings.get("a")?.status, "missing");
    assert.equal(findings.get("b")?.status, "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
