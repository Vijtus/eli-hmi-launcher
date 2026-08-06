import assert from "node:assert/strict";
import test from "node:test";
import {
  HmiLifecycleCoordinator,
  HmiLifecycleUnavailableError,
  HmiReservationDeniedError,
  buildHmiLifecycleReports,
  type LifecycleCoordinatorScheduler,
} from "../src/main/hmi-lifecycle-coordinator.ts";
import type {
  HmiApiAdapter,
  HmiApiOperationResult,
  HmiApiQueryResult,
  HmiLifecycleEntryReport,
  HmiReservationRequest,
  HmiReservationResult,
} from "../src/main/hmi-api.ts";
import type { ProcessRegistryRecord } from "../src/main/runtime-registry.ts";
import type { HmiApiHealth, RuntimeSnapshot } from "../src/shared/types.ts";

function snapshot(status: "running" | "stopped" = "running"): RuntimeSnapshot {
  return {
    generatedAt: "2026-08-04T10:00:00.000Z",
    reconcileIntervalMs: 5000,
    items: [
      {
        id: "laser-gui",
        kind: "labview-dev",
        model: "pid",
        status,
        runningInstances: status === "running" ? 1 : 0,
        totalInstances: 1,
        launchedAt: "2026-08-04T09:59:59.000Z",
        lastSeenAt: "2026-08-04T10:00:00.000Z",
        stale: false,
        detail: "fixture",
      },
    ],
  };
}

function processRecord(state: "running" | "stopped" | "unknown" = "running"): ProcessRegistryRecord {
  return {
    instanceId: "laser-gui:321:1722765599000:1",
    entryId: "laser-gui",
    kind: "labview-dev",
    command: "/secret/workspace/Developer.exe",
    args: ["private-host", "IOC", "L4"],
    pid: 321,
    spawnedAt: 1_722_765_599_000,
    registeredAt: 1_722_765_599_100,
    identity: "linux:boot:1",
    lastSeenAt: 1_722_765_600_000,
    state,
    reason: "fixture",
    launchMode: "write",
  };
}

class FakeAdapter implements HmiApiAdapter {
  readonly sessionId = "11111111-1111-4111-8111-111111111111";
  readonly heartbeatIntervalMs = 5000;
  registered: Array<{ report: HmiLifecycleEntryReport; reservationId?: string }> = [];
  heartbeats: HmiLifecycleEntryReport[][] = [];
  deregistered: string[] = [];
  released: string[] = [];
  reservations: HmiReservationRequest[] = [];
  queryResult: HmiApiQueryResult = { status: "ok", entries: [] };
  reservationResult: HmiReservationResult = {
    status: "granted",
    reservationId: "reservation-1",
    expiresAt: "2026-08-04T10:00:10.000Z",
  };
  currentHealth: HmiApiHealth = {
    status: "connected",
    lastSuccessAt: "2026-08-04T10:00:00.000Z",
  };
  registerResult: HmiApiOperationResult = { status: "ok" };
  heartbeatResult: HmiApiOperationResult = { status: "ok" };

  async register(report: HmiLifecycleEntryReport, reservationId?: string): Promise<HmiApiOperationResult> {
    this.registered.push({ report, ...(reservationId ? { reservationId } : {}) });
    return this.registerResult;
  }

  async heartbeat(reports: HmiLifecycleEntryReport[]): Promise<HmiApiOperationResult> {
    this.heartbeats.push(reports);
    return this.heartbeatResult;
  }

  async deregister(entryId: string): Promise<HmiApiOperationResult> {
    this.deregistered.push(entryId);
    return { status: "ok" };
  }

  async query(): Promise<HmiApiQueryResult> {
    return this.queryResult;
  }

  async acquireReservation(request: HmiReservationRequest): Promise<HmiReservationResult> {
    this.reservations.push(request);
    return this.reservationResult;
  }

  async releaseReservation(reservationId: string): Promise<HmiApiOperationResult> {
    this.released.push(reservationId);
    return { status: "ok" };
  }

  health(): HmiApiHealth {
    return { ...this.currentHealth };
  }
}

test("lifecycle reports include process identity keys and modes but omit commands, argv, PID, and environment", () => {
  const reports = buildHmiLifecycleReports(snapshot(), [processRecord()]);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0]?.instances, [
    {
      instanceId: "laser-gui:321:1722765599000:1",
      state: "running",
      launchMode: "write",
      spawnedAt: "2024-08-04T09:59:59.000Z",
      lastSeenAt: "2024-08-04T10:00:00.000Z",
    },
  ]);
  const wire = JSON.stringify(reports);
  assert.doesNotMatch(wire, /Developer\.exe|private-host|"pid"\s*:\s*321|environment/);
});

test("changed running state registers immediately and stopped state deregisters", async () => {
  const adapter = new FakeAdapter();
  let currentSnapshot = snapshot();
  let records = [processRecord()];
  const coordinator = new HmiLifecycleCoordinator(adapter, {
    getSnapshot: () => currentSnapshot,
    getProcessRecords: () => records,
  });

  coordinator.observeSnapshot(currentSnapshot);
  await coordinator.flush();
  assert.equal(adapter.registered.length, 1);
  assert.equal(adapter.registered[0]?.report.entryId, "laser-gui");

  coordinator.observeSnapshot(currentSnapshot);
  await coordinator.flush();
  assert.equal(adapter.registered.length, 1, "an unchanged report is coalesced");

  currentSnapshot = snapshot("stopped");
  records = [processRecord("stopped")];
  coordinator.observeSnapshot(currentSnapshot);
  await coordinator.flush();
  assert.deepEqual(adapter.deregistered, ["laser-gui"]);
});

test("heartbeat is an authoritative active snapshot and uses the adapter interval", async () => {
  const adapter = new FakeAdapter();
  let intervalCallback: (() => void | Promise<void>) | undefined;
  let intervalMs = 0;
  let cleared = false;
  const scheduler: LifecycleCoordinatorScheduler = {
    setInterval(callback, milliseconds) {
      intervalCallback = callback;
      intervalMs = milliseconds;
      return "interval";
    },
    clearInterval(handle) {
      assert.equal(handle, "interval");
      cleared = true;
    },
    setTimeout() {
      return "retry";
    },
    clearTimeout() {},
  };
  const coordinator = new HmiLifecycleCoordinator(adapter, {
    getSnapshot: () => snapshot(),
    getProcessRecords: () => [processRecord()],
    scheduler,
  });

  await coordinator.start();
  assert.equal(intervalMs, 5000);
  assert.ok(intervalCallback);
  await intervalCallback();
  await coordinator.flush();
  assert.equal(adapter.heartbeats.length, 1);
  assert.equal(adapter.heartbeats[0]?.length, 1);
  assert.equal(adapter.heartbeats[0]?.[0]?.entryId, "laser-gui");
  await coordinator.stop();
  assert.equal(cleared, true);
  assert.deepEqual(adapter.deregistered, ["laser-gui"]);
});

test("remote query contributes other sessions' per-instance state to policy", async () => {
  const adapter = new FakeAdapter();
  adapter.queryResult = {
    status: "ok",
    entries: [
      {
        sessionId: "remote-session",
        stationId: "station-b",
        report: buildHmiLifecycleReports(snapshot(), [processRecord()])[0]!,
        leaseExpiresAt: "2026-08-04T10:00:15.000Z",
      },
    ],
  };
  const coordinator = new HmiLifecycleCoordinator(adapter, {
    getSnapshot: () => snapshot(),
    getProcessRecords: () => [processRecord()],
  });
  await coordinator.refresh("laser-gui");
  assert.deepEqual(coordinator.policyInstances("laser-gui"), [
    { state: "running", launchMode: "write" },
  ]);
});

test("configured but unavailable remote state produces fail-closed unknown policy state", async () => {
  const adapter = new FakeAdapter();
  adapter.queryResult = {
    status: "unavailable",
    reason: "connection refused",
    entries: [],
  };
  adapter.currentHealth = { status: "unavailable", reason: "connection refused" };
  const coordinator = new HmiLifecycleCoordinator(adapter, {
    getSnapshot: () => snapshot(),
    getProcessRecords: () => [processRecord()],
  });

  await coordinator.refresh("laser-gui");
  assert.deepEqual(coordinator.policyInstances("laser-gui"), [
    { state: "unknown", launchMode: "unknown" },
  ]);
});

test("reservation grant is committed with the next report and conflict blocks before spawn", async () => {
  const adapter = new FakeAdapter();
  const coordinator = new HmiLifecycleCoordinator(adapter, {
    getSnapshot: () => snapshot(),
    getProcessRecords: () => [processRecord()],
  });
  const request: HmiReservationRequest = {
    entryId: "laser-gui",
    launchMode: "write",
    maxInstances: 1,
    writeModeExclusive: true,
  };
  const reservation = await coordinator.acquireReservation(request);
  assert.equal(reservation, "reservation-1");
  coordinator.observeSnapshot(snapshot());
  await coordinator.flush();
  assert.equal(adapter.registered[0]?.reservationId, "reservation-1");

  adapter.reservationResult = { status: "conflict", reason: "another writer exists" };
  await assert.rejects(
    coordinator.acquireReservation(request),
    (error: unknown) => error instanceof HmiReservationDeniedError && /another writer/.test(error.message),
  );

  adapter.reservationResult = { status: "unavailable", reason: "timed out" };
  await assert.rejects(
    coordinator.acquireReservation(request),
    (error: unknown) => error instanceof HmiLifecycleUnavailableError && /timed out/.test(error.message),
  );
});

test("failed launch releases its pending reservation", async () => {
  const adapter = new FakeAdapter();
  const coordinator = new HmiLifecycleCoordinator(adapter, {
    getSnapshot: () => snapshot(),
    getProcessRecords: () => [processRecord()],
  });
  await coordinator.acquireReservation({
    entryId: "laser-gui",
    launchMode: "write",
    maxInstances: 1,
    writeModeExclusive: true,
  });
  await coordinator.releasePendingReservation("laser-gui");
  assert.deepEqual(adapter.released, ["reservation-1"]);
});

test("transient retries are coalesced with bounded jitter and configuration errors probe slowly", async () => {
  const adapter = new FakeAdapter();
  const scheduled: number[] = [];
  let retryCallback: (() => void | Promise<void>) | undefined;
  const scheduler: LifecycleCoordinatorScheduler = {
    setInterval() {
      return "interval";
    },
    clearInterval() {},
    setTimeout(callback, milliseconds) {
      retryCallback = callback;
      scheduled.push(milliseconds);
      return `retry-${scheduled.length}`;
    },
    clearTimeout() {},
  };
  adapter.currentHealth = { status: "unavailable", reason: "refused" };
  adapter.queryResult = { status: "unavailable", reason: "refused", entries: [] };
  const coordinator = new HmiLifecycleCoordinator(adapter, {
    getSnapshot: () => snapshot(),
    getProcessRecords: () => [processRecord()],
    scheduler,
    random: () => 0,
  });
  await coordinator.refresh();
  await coordinator.refresh();
  assert.deepEqual(scheduled, [900], "only one 1-second retry with -10% jitter is pending");

  assert.ok(retryCallback);
  adapter.currentHealth = { status: "misconfigured", reason: "bad schema" };
  adapter.queryResult = { status: "misconfigured", reason: "bad schema", entries: [] };
  await retryCallback();
  assert.equal(scheduled.at(-1), 27_000, "misconfiguration uses a 30-second probe with jitter");
});

test("state mutations are serialized so sequence-numbered requests cannot overtake", async () => {
  const adapter = new FakeAdapter();
  const order: string[] = [];
  let releaseRegister: (() => void) | undefined;
  const registerMayFinish = new Promise<void>((resolve) => {
    releaseRegister = resolve;
  });
  adapter.register = async () => {
    order.push("register-start");
    await registerMayFinish;
    order.push("register-end");
    return { status: "ok" };
  };
  adapter.heartbeat = async () => {
    order.push("heartbeat");
    return { status: "ok" };
  };
  const coordinator = new HmiLifecycleCoordinator(adapter, {
    getSnapshot: () => snapshot(),
    getProcessRecords: () => [processRecord()],
  });

  coordinator.observeSnapshot(snapshot());
  const heartbeat = coordinator.heartbeat();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["register-start"]);
  assert.ok(releaseRegister);
  releaseRegister();
  await heartbeat;
  assert.deepEqual(order, ["register-start", "register-end", "heartbeat"]);
});

test("a 409 state mutation refreshes then sends one authoritative heartbeat", async () => {
  const adapter = new FakeAdapter();
  adapter.registerResult = {
    status: "misconfigured",
    reason: "stale sequence",
    httpStatus: 409,
  };
  const coordinator = new HmiLifecycleCoordinator(adapter, {
    getSnapshot: () => snapshot(),
    getProcessRecords: () => [processRecord()],
  });

  coordinator.observeSnapshot(snapshot());
  await coordinator.flush();
  assert.equal(adapter.registered.length, 1);
  assert.equal(adapter.heartbeats.length, 1);
  assert.equal(adapter.heartbeats[0]?.[0]?.entryId, "laser-gui");
});
