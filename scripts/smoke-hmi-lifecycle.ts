import assert from "node:assert/strict";
import { HttpHmiApiAdapter, type HmiLifecycleEntryReport } from "../src/main/hmi-api";

const baseUrl =
  process.env["ELI_HMI_LIFECYCLE_URL"] ??
  "http://127.0.0.1:8765/api/lifecycle/v1";

const report: HmiLifecycleEntryReport = {
  entryId: "lifecycle-smoke-gui",
  runtime: {
    id: "lifecycle-smoke-gui",
    kind: "labview-dev",
    model: "pid",
    status: "running",
    runningInstances: 1,
    totalInstances: 1,
    launchedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    stale: false,
    detail: "Local lifecycle HTTP smoke fixture.",
  },
  instances: [
    {
      instanceId: "lifecycle-smoke-instance",
      state: "running",
      launchMode: "write",
      spawnedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    },
  ],
};

function adapter(stationId: string, sessionId: string): HttpHmiApiAdapter {
  return new HttpHmiApiAdapter(
    {
      baseUrl,
      stationId,
      requestTimeoutMs: 2_000,
      heartbeatIntervalMs: 5_000,
    },
    { sessionId },
  );
}

async function main(): Promise<void> {
  const first = adapter("smoke-station-a", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const second = adapter("smoke-station-b", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  const policy = {
    entryId: report.entryId,
    launchMode: "write" as const,
    maxInstances: 1,
    writeModeExclusive: true,
  };

  const firstReservation = await first.acquireReservation(policy);
  assert.equal(firstReservation.status, "granted");
  assert.ok(firstReservation.reservationId);

  const conflict = await second.acquireReservation(policy);
  assert.equal(conflict.status, "conflict");

  const released = await first.releaseReservation(firstReservation.reservationId);
  assert.equal(released.status, "ok");

  const secondReservation = await second.acquireReservation(policy);
  assert.equal(secondReservation.status, "granted");
  assert.ok(secondReservation.reservationId);

  const registered = await second.register(report, secondReservation.reservationId);
  assert.equal(registered.status, "ok");

  const visible = await first.query(report.entryId);
  assert.equal(visible.status, "ok");
  assert.equal(visible.entries.length, 1);
  assert.equal(visible.entries[0]?.report.instances[0]?.launchMode, "write");

  const deregistered = await second.deregister(report.entryId);
  assert.equal(deregistered.status, "ok");

  process.stdout.write(
    `${JSON.stringify(
      {
        contract: "local-launcher-lifecycle",
        baseUrl,
        firstReservation: firstReservation.status,
        concurrentReservation: conflict.status,
        replacementReservation: secondReservation.status,
        registration: registered.status,
        remoteEntriesObserved: visible.entries.length,
        deregistration: deregistered.status,
      },
      null,
      2,
    )}\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
