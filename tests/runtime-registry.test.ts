import assert from "node:assert/strict";
import test from "node:test";
import { inspectProcess, type ProcessObservation } from "../src/main/process-inspector.ts";
import {
  RuntimeRegistry,
  type RegistryScheduler,
} from "../src/main/runtime-registry.ts";

function receipt(pid = 321, spawnedAt = 1_000) {
  return { pid, spawnedAt };
}

test("runtime registry detects PID reuse by comparing process start identity", async () => {
  let observation: ProcessObservation = { alive: true, identity: "start-A" };
  let now = 2_000;
  const registry = new RuntimeRegistry({
    clock: { now: () => now },
    inspectProcess: async () => observation,
  });

  await registry.registerProcess({
    entryId: "developer-gui",
    kind: "labview-dev",
    command: "C:\\ELI\\GUI Application\\Developer.exe",
    args: ["host;literal", "IOC-1", "L4"],
    receipt: receipt(),
    launchMode: "write",
  });
  assert.equal(registry.getState("developer-gui")?.status, "running");

  observation = { alive: true, identity: "start-B" };
  now = 3_000;
  await registry.reconcile();

  const state = registry.getState("developer-gui");
  assert.equal(state?.status, "stopped");
  assert.equal(state?.runningInstances, 0);
  assert.match(state?.detail ?? "", /PID 321 was reused/);
  const [record] = registry.getProcessRecords("developer-gui");
  assert.deepEqual(record?.args, ["host;literal", "IOC-1", "L4"]);
  assert.equal(record?.identity, "start-A");
  assert.equal(record?.launchMode, "write");
});

test("runtime registry periodic reconciliation uses the configured interval and a fake clock", async () => {
  let now = 5_000;
  let alive = true;
  let scheduled: (() => void | Promise<void>) | undefined;
  let scheduledEvery: number | undefined;
  let cleared = false;
  const scheduler: RegistryScheduler = {
    setInterval(callback, milliseconds) {
      scheduled = callback;
      scheduledEvery = milliseconds;
      return "timer";
    },
    clearInterval(handle) {
      assert.equal(handle, "timer");
      cleared = true;
    },
  };
  const registry = new RuntimeRegistry({
    reconcileIntervalMs: 1_234,
    clock: { now: () => now },
    scheduler,
    inspectProcess: async () =>
      alive
        ? { alive: true, identity: "stable-start" }
        : { alive: false, reason: "fake process exited" },
  });

  await registry.registerProcess({
    entryId: "epics-gui",
    kind: "labview-epics",
    command: "/tmp/GUI Application/Epics",
    args: ["L4", "GUI"],
    receipt: receipt(654, 4_000),
  });
  registry.start();
  assert.equal(scheduledEvery, 1_234);

  alive = false;
  now = 6_234;
  assert.ok(scheduled);
  await scheduled();
  assert.equal(registry.getState("epics-gui")?.status, "stopped");
  assert.match(registry.getState("epics-gui")?.detail ?? "", /fake process exited/);

  registry.stop();
  assert.equal(cleared, true);
});

test("runtime registry refuses to call a PID-only observation running", async () => {
  const registry = new RuntimeRegistry({
    inspectProcess: async () => ({ alive: true, reason: "start identity unavailable" }),
  });
  await registry.registerProcess({
    entryId: "untrusted-pid",
    kind: "process",
    command: "/tmp/wrapper",
    args: [],
    receipt: receipt(777, 10),
  });

  const state = registry.getState("untrusted-pid");
  assert.equal(state?.status, "unknown");
  assert.equal(state?.runningInstances, 0);
  assert.match(state?.detail ?? "", /PID-only liveness is not trusted/);
});

test("browser handoffs and Phoebus use explicit non-PID observation models", async () => {
  let phoebusOpen = true;
  const registry = new RuntimeRegistry({
    probePhoebusPort: async (port) => {
      assert.equal(port, 4918);
      return phoebusOpen;
    },
  });

  registry.recordHandoff("browser-hmi", "web");
  registry.recordPhoebus({
    entryId: "phoebus-panel",
    port: 4918,
    ownership: "reused-external",
    resource: "/srv/css/main.bob",
  });

  const browser = registry.getState("browser-hmi");
  assert.equal(browser?.model, "external-handoff");
  assert.equal(browser?.status, "handed-off");
  assert.match(browser?.detail ?? "", /browser process and tab are not owned/);

  const phoebus = registry.getState("phoebus-panel");
  assert.equal(phoebus?.model, "phoebus-port");
  assert.equal(phoebus?.status, "shared");
  assert.equal(phoebus?.runningInstances, 0);
  assert.match(phoebus?.detail ?? "", /individual panel presence is not observable/);

  phoebusOpen = false;
  await registry.reconcile();
  assert.equal(registry.getState("phoebus-panel")?.status, "stopped");
});

test("a delayed scheduler marks registry state stale until reconciliation catches up", async () => {
  let now = 1_000;
  const scheduler: RegistryScheduler = {
    setInterval() {
      return "timer";
    },
    clearInterval() {},
  };
  const registry = new RuntimeRegistry({
    reconcileIntervalMs: 100,
    clock: { now: () => now },
    scheduler,
    inspectProcess: async () => ({ alive: true, identity: "stable" }),
  });
  await registry.registerProcess({
    entryId: "stale-gui",
    kind: "process",
    command: "/tmp/gui",
    args: [],
    receipt: receipt(888, 900),
  });
  registry.start();
  now = 1_201;
  assert.equal(registry.getState("stale-gui")?.stale, true);

  await registry.reconcile();
  assert.equal(registry.getState("stale-gui")?.stale, false);
});

test("Linux process inspection returns a stable start identity for the current process", async (t) => {
  if (process.platform !== "linux") {
    t.skip("Linux /proc identity test");
    return;
  }
  const first = await inspectProcess(process.pid);
  const second = await inspectProcess(process.pid);
  assert.equal(first.alive, true);
  assert.match(first.identity ?? "", /^linux:[^:]+:\d+$/);
  assert.equal(second.identity, first.identity);
});
