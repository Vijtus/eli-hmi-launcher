import assert from "node:assert/strict";
import test from "node:test";
import {
  HttpHmiApiAdapter,
  NoopHmiApiAdapter,
  type HmiLifecycleEntryReport,
} from "../src/main/hmi-api.ts";

const report: HmiLifecycleEntryReport = {
  entryId: "example",
  runtime: {
    id: "example",
    kind: "process",
    model: "pid",
    status: "running",
    runningInstances: 1,
    totalInstances: 1,
    launchedAt: "2026-07-28T00:00:00.000Z",
    lastSeenAt: "2026-07-28T00:00:00.000Z",
    stale: false,
    detail: "test fixture",
  },
  instances: [
    {
      instanceId: "example:321:1",
      state: "running",
      launchMode: "write",
      spawnedAt: "2026-07-28T00:00:00.000Z",
      lastSeenAt: "2026-07-28T00:00:00.000Z",
    },
  ],
};

test("no-op HMI API adapter reports disabled for every operation", async () => {
  const adapter = new NoopHmiApiAdapter();
  const results = await Promise.all([
    adapter.register(report),
    adapter.heartbeat([report]),
    adapter.deregister(report.entryId),
    adapter.query(report.entryId),
    adapter.acquireReservation({
      entryId: report.entryId,
      launchMode: "write",
      maxInstances: 1,
      writeModeExclusive: true,
    }),
    adapter.releaseReservation("unused"),
  ]);

  for (const result of results) {
    assert.equal(result.status, "disabled");
    assert.match(result.reason ?? "", /local lifecycle API is not configured/);
    assert.match(result.reason ?? "", /no request was sent/);
  }
  assert.equal(adapter.health().status, "disabled");
});

test("HTTP adapter sends the versioned local contract without process commands or environment", async () => {
  const calls: Array<{ url: string; init: RequestInit; body?: Record<string, unknown> }> = [];
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const body = typeof init.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : undefined;
    calls.push({ url: String(input), init, ...(body ? { body } : {}) });
    return new Response(
      JSON.stringify({
        acceptedSequence: body?.["sequence"] ?? 1,
        serverTime: "2026-08-04T10:00:00.000Z",
        leaseTtlSeconds: 15,
        leaseExpiresAt: "2026-08-04T10:00:15.000Z",
        entryCount: 1,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const adapter = new HttpHmiApiAdapter(
    {
      baseUrl: "http://127.0.0.1:8765/api/lifecycle/v1/",
      stationId: "station A",
      authTokenEnv: "LOCAL_TOKEN",
      requestTimeoutMs: 2000,
      heartbeatIntervalMs: 5000,
    },
    {
      fetch: fakeFetch,
      env: { LOCAL_TOKEN: "do-not-log-this" },
      sessionId: "11111111-1111-4111-8111-111111111111",
      operationId: (() => {
        let operation = 0;
        return () => `22222222-2222-4222-8222-${String(++operation).padStart(12, "0")}`;
      })(),
    },
  );

  const result = await adapter.register(report, "reservation-1");
  assert.equal(result.status, "ok");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    "http://127.0.0.1:8765/api/lifecycle/v1/sessions/11111111-1111-4111-8111-111111111111/entries/example",
  );
  assert.equal(calls[0]?.init.method, "PUT");
  assert.equal((calls[0]?.init.headers as Record<string, string>)["authorization"], "Bearer do-not-log-this");
  assert.deepEqual(calls[0]?.body?.["report"], report);
  assert.equal(calls[0]?.body?.["reservationId"], "reservation-1");
  assert.equal(calls[0]?.body?.["schemaVersion"], 1);
  assert.equal(calls[0]?.body?.["stationId"], "station A");
  assert.equal(calls[0]?.body?.["sequence"], 1);
  const serialized = JSON.stringify(calls[0]?.body);
  assert.doesNotMatch(serialized, /command|args|environment|do-not-log-this/);
  assert.equal(adapter.health().status, "connected");
  assert.equal(adapter.health().lastSuccessAt, "2026-08-04T10:00:00.000Z");
});

test("query excludes the adapter's own session and returns remote per-instance modes", async () => {
  let requestedUrl = "";
  const adapter = new HttpHmiApiAdapter(
    {
      baseUrl: "http://127.0.0.1:8765/api/lifecycle/v1",
      stationId: "station-a",
      requestTimeoutMs: 2000,
      heartbeatIntervalMs: 5000,
    },
    {
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      fetch: async (input) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            serverTime: "2026-08-04T10:00:00.000Z",
            entries: [
              {
                sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                stationId: "station-b",
                report,
                leaseExpiresAt: "2026-08-04T10:00:15.000Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  );

  const result = await adapter.query("example");
  assert.equal(result.status, "ok");
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.report.instances[0]?.launchMode, "write");
  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get("entryId"), "example");
  assert.equal(url.searchParams.get("excludeSessionId"), adapter.sessionId);
});

test("reservation conflict is a typed result instead of a transport success", async () => {
  const adapter = new HttpHmiApiAdapter(
    {
      baseUrl: "http://127.0.0.1:8765/api/lifecycle/v1",
      stationId: "station-a",
      requestTimeoutMs: 2000,
      heartbeatIntervalMs: 5000,
    },
    {
      fetch: async () =>
        new Response(
          JSON.stringify({
            detail: {
              code: "instance-limit",
              message: "Entry already has one live instance.",
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    },
  );

  const result = await adapter.acquireReservation({
    entryId: "example",
    launchMode: "write",
    maxInstances: 1,
    writeModeExclusive: true,
  });
  assert.equal(result.status, "conflict");
  assert.match(result.reason ?? "", /one live instance/);
});

test("configured lifecycle URLs reject credentials, query strings, fragments, and insecure remote HTTP", () => {
  const invalid = [
    "http://user:secret@127.0.0.1:8765/api/lifecycle/v1",
    "http://127.0.0.1:8765/api/lifecycle/v1?token=secret",
    "http://127.0.0.1:8765/api/lifecycle/v1#fragment",
    "http://192.0.2.10:8765/api/lifecycle/v1",
  ];
  for (const baseUrl of invalid) {
    assert.throws(
      () =>
        new HttpHmiApiAdapter({
          baseUrl,
          stationId: "station-a",
          authTokenEnv: "TOKEN",
          requestTimeoutMs: 2000,
          heartbeatIntervalMs: 5000,
        }),
      /credentials|query|fragment|HTTPS/,
    );
  }
});

test("remote HTTPS requires a configured, populated token environment variable", () => {
  assert.throws(
    () =>
      new HttpHmiApiAdapter(
        {
          baseUrl: "https://lifecycle.example.test/api/lifecycle/v1",
          stationId: "station-a",
          requestTimeoutMs: 2000,
          heartbeatIntervalMs: 5000,
        },
        { env: {} },
      ),
    /authTokenEnv/,
  );
  assert.throws(
    () =>
      new HttpHmiApiAdapter(
        {
          baseUrl: "https://lifecycle.example.test/api/lifecycle/v1",
          stationId: "station-a",
          authTokenEnv: "MISSING_TOKEN",
          requestTimeoutMs: 2000,
          heartbeatIntervalMs: 5000,
        },
        { env: {} },
      ),
    /MISSING_TOKEN.*not set/,
  );
});

test("a transient retry reuses the same operation id and sequence", async () => {
  const attempts: Array<Record<string, unknown>> = [];
  let fail = true;
  const adapter = new HttpHmiApiAdapter(
    {
      baseUrl: "http://127.0.0.1:8765/api/lifecycle/v1",
      stationId: "station-a",
      requestTimeoutMs: 2000,
      heartbeatIntervalMs: 5000,
    },
    {
      operationId: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      fetch: async (_input, init) => {
        attempts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (fail) {
          fail = false;
          throw new Error("temporary refusal");
        }
        return new Response(
          JSON.stringify({
            acceptedSequence: 1,
            serverTime: "2026-08-04T10:00:00.000Z",
            leaseExpiresAt: "2026-08-04T10:00:15.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  );

  assert.equal((await adapter.register(report)).status, "unavailable");
  assert.equal((await adapter.register(report)).status, "ok");
  assert.equal(attempts[0]?.["operationId"], attempts[1]?.["operationId"]);
  assert.equal(attempts[0]?.["sequence"], attempts[1]?.["sequence"]);
});

test("a malformed lifecycle query is fail-closed as misconfigured", async () => {
  const adapter = new HttpHmiApiAdapter(
    {
      baseUrl: "http://127.0.0.1:8765/api/lifecycle/v1",
      stationId: "station-a",
      requestTimeoutMs: 2000,
      heartbeatIntervalMs: 5000,
    },
    {
      fetch: async () =>
        new Response(
          JSON.stringify({
            serverTime: "2026-08-04T10:00:00.000Z",
            entries: [{ sessionId: "remote", stationId: "station-b" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    },
  );

  const result = await adapter.query("laser-gui");
  assert.equal(result.status, "misconfigured");
  assert.deepEqual(result.entries, []);
  assert.equal(adapter.health().status, "misconfigured");
  assert.match(adapter.health().reason ?? "", /version-1 entry schema/);
});
