import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "../src/main/config.ts";
import {
  attachLaunchDiagnostics,
  LaunchDiagnosticError,
} from "../src/main/launch-diagnostics.ts";
import { initLogger, logLaunch } from "../src/main/logger.ts";
import { launchMaterializedProcess } from "../src/main/native-launcher.ts";
import {
  PhoebusServerManager,
  PhoebusServerUnreachableError,
} from "../src/main/phoebus-server.ts";
import { materializePhoebusTarget } from "../src/main/phoebus-targets.ts";
import type { PhoebusLaunchTarget, ProcessLaunchTarget } from "../src/shared/types.ts";

const BASE = { appRoot: "/tmp/app", configDir: "/tmp/cfg" };

test("missing Phoebus executable reports its path and resolved server argv", async () => {
  const missing = path.join(os.tmpdir(), `missing-phoebus-${process.pid}-${Date.now()}`, "phoebus.sh");
  const parsed = parseConfig(
    `
local:
  phoebus:
    executable: '${missing}'
    serverPort: 4918
entries:
  - id: missing-phoebus
    name: Missing Phoebus
    target: { kind: phoebus }
`,
    BASE,
  );
  const target = parsed.targetsById.get("missing-phoebus") as PhoebusLaunchTarget;
  const plans = materializePhoebusTarget(target, parsed.context, {
    id: "missing-phoebus",
    kind: "phoebus",
    group: "entry",
  });

  await assert.rejects(
    launchMaterializedProcess(plans.server, parsed.context),
    (error: unknown) => {
      assert.ok(error instanceof LaunchDiagnosticError);
      assert.match(error.message, /Configured command does not exist/);
      assert.match(error.message, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(error.resolvedCommand, missing);
      assert.deepEqual(error.resolvedArgs, ["-server", "4918"]);
      assert.doesNotMatch(error.message, /unreachable at 127\.0\.0\.1/);
      return true;
    },
  );
});

test("Phoebus listener timeout is distinct from an executable-path failure", async () => {
  let now = 0;
  const manager = new PhoebusServerManager({
    probePort: async () => false,
    isProcessAlive: async () => true,
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    probeIntervalMs: 1,
  });
  const plan = {
    command: "/opt/phoebus/phoebus.sh",
    args: ["-server", "4918"],
    port: 4918,
    startupTimeoutMs: 2,
    resourceReadyDelayMs: 0,
  };

  let failure: unknown;
  try {
    await manager.ensureServer(plan, async () => ({ pid: 4100, spawnedAt: 1 }));
  } catch (error) {
    failure = attachLaunchDiagnostics(error, plan);
  }

  assert.ok(failure instanceof LaunchDiagnosticError);
  assert.ok(failure.originalError instanceof PhoebusServerUnreachableError);
  assert.match(failure.message, /Phoebus server is unreachable at 127\.0\.0\.1:4918/);
  assert.doesNotMatch(failure.message, /Configured command does not exist/);
  assert.deepEqual(failure.resolvedArgs, ["-server", "4918"]);
});

test("failure log includes id, resolved argv, and reason without target environment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eli-launch-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, "launcher.log.jsonl");
  initLogger(logPath);

  const target: ProcessLaunchTarget = {
    kind: "process",
    command: "/configured/wrapper",
    args: ["--configured"],
    env: { API_TOKEN: "do-not-log-this-secret" },
  };
  logLaunch({
    id: "failed-entry",
    label: "Failed entry",
    target,
    resolvedCommand: "/resolved/wrapper",
    resolvedArgs: ["--mode", "operator", "--token", "do-not-log-this-secret"],
    ok: false,
    error: "Configured command does not exist: /resolved/wrapper",
    durationMs: 12,
  });

  const text = await readFile(logPath, "utf8");
  const record = JSON.parse(text.trim()) as Record<string, unknown>;
  assert.equal(record["id"], "failed-entry");
  assert.equal(record["command"], "/resolved/wrapper");
  assert.deepEqual(record["args"], ["--mode", "operator", "--token", "[REDACTED]"]);
  assert.equal(record["error"], "Configured command does not exist: /resolved/wrapper");
  assert.equal(record["ok"], false);
  assert.equal("env" in record, false);
  assert.doesNotMatch(text, /do-not-log-this-secret|API_TOKEN/);
});
