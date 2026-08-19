import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { parseConfig } from "../src/main/config.ts";
import {
  isSpawnReceiptAlive,
  PhoebusServerManager,
  PhoebusServerProcessStillRunningError,
  PhoebusServerUnreachableError,
  probeTcpPort,
} from "../src/main/phoebus-server.ts";
import {
  assertPhoebusLayoutApplied,
  materializePhoebusTarget,
  PhoebusLayoutStartupError,
  type PhoebusServerPlan,
} from "../src/main/phoebus-targets.ts";
import type { PhoebusLaunchTarget } from "../src/shared/types.ts";

const BASE = { appRoot: "/app", configDir: "/config" };

const SERVER_PLAN: PhoebusServerPlan = {
  command: "/opt/phoebus/phoebus.sh",
  args: ["-server", "4918"],
  port: 4918,
  startupTimeoutMs: 100,
  resourceReadyDelayMs: 0,
};

test("Phoebus target materializes distinct ensure-server and open-resource argv", () => {
  const parsed = parseConfig(
    `
local:
  cssGuiRoot: /srv/css-guis
  phoebus:
    executable: /opt/phoebus/phoebus.sh
    serverPort: 4918
    startupTimeoutMs: 1234
    resourceReadyDelayMs: 4321
entries:
  - id: panel
    name: Panel
    target:
      kind: phoebus
      resource: panels/main.bob
`,
    BASE,
  );
  const target = parsed.targetsById.get("panel") as PhoebusLaunchTarget;
  const plans = materializePhoebusTarget(
    target,
    parsed.context,
    { id: "panel", kind: "phoebus", group: "entry" },
    "linux",
  );

  assert.equal(plans.server.command, "/opt/phoebus/phoebus.sh");
  assert.deepEqual(plans.server.args, ["-server", "4918"]);
  assert.equal(plans.server.port, 4918);
  assert.equal(plans.server.startupTimeoutMs, 1234);
  assert.equal(plans.server.resourceReadyDelayMs, 4321);
  assert.deepEqual(plans.openResource?.args, [
    "-server",
    "4918",
    "-resource",
    "/srv/css-guis/panels/main.bob",
  ]);
});

test("Phoebus settings are present only on the server-creating argv across three opens", () => {
  const parsed = parseConfig(
    `
local:
  cssGuiRoot: 'C:\\CSS GUIs'
  phoebus:
    executable: 'C:\\Phoebus\\phoebus.bat'
    serverPort: 4918
    settingsFile: 'C:\\CSS GUIs\\site settings.properties'
entries:
  - { id: one, name: One, target: { kind: phoebus, resource: 'alarms/One Panel.bob' } }
  - { id: two, name: Two, target: { kind: phoebus, resource: 'alarms/Two Panel.bob' } }
  - { id: three, name: Three, target: { kind: phoebus, resource: 'alarms/Three Panel.bob' } }
`,
    BASE,
  );
  const plans = ["one", "two", "three"].map((id) =>
    materializePhoebusTarget(
      parsed.targetsById.get(id) as PhoebusLaunchTarget,
      parsed.context,
      { id, kind: "phoebus", group: "entry" },
      "win32",
    ),
  );
  const invokedArgv = [plans[0].server.args ?? [], ...plans.map((plan) => plan.openResource?.args ?? [])];
  assert.equal(invokedArgv.flat().filter((arg) => arg === "-settings").length, 1);
  assert.deepEqual(plans[0].server.args, [
    "-server",
    "4918",
    "-settings",
    "C:\\CSS GUIs\\site settings.properties",
  ]);
  for (const plan of plans) {
    assert.equal(plan.openResource?.args?.includes("-settings"), false);
    assert.equal(plan.openResource?.args?.some((arg) => /[\"']/.test(arg)), false);
  }
  assert.deepEqual(plans[0].openResource?.args, [
    "-server",
    "4918",
    "-resource",
    "C:\\CSS GUIs\\alarms\\One Panel.bob",
  ]);
});

test("Phoebus alarm layout is a startup-only argv option sourced from local config", () => {
  const parsed = parseConfig(
    `
local:
  phoebus:
    executable: 'C:\\Phoebus\\phoebus.bat'
    serverPort: 4918
    layoutFile: 'C:\\CSS GUIs\\alarm layout.memento'
entries:
  - id: alarm-layout
    name: Alarm layout
    target: { kind: phoebus, layout: true }
`,
    BASE,
  );
  const plans = materializePhoebusTarget(
    parsed.targetsById.get("alarm-layout") as PhoebusLaunchTarget,
    parsed.context,
    { id: "alarm-layout", kind: "phoebus", group: "entry" },
    "win32",
  );

  assert.equal(plans.layoutRequested, true);
  assert.deepEqual(plans.server.args, [
    "-server",
    "4918",
    "-layout",
    "C:\\CSS GUIs\\alarm layout.memento",
  ]);
  assert.equal(plans.openResource, undefined);
  assert.equal(plans.server.args?.some((arg) => /[\"']/.test(arg)), false);
});

test("Phoebus layout requires the configured memento path and names the entry", () => {
  assert.throws(
    () =>
      parseConfig(
        `
local:
  phoebus:
    executable: /opt/phoebus/phoebus.sh
    serverPort: 4918
entries:
  - id: missing-layout
    name: Missing layout
    target: { kind: phoebus, layout: true }
`,
        BASE,
      ),
    (error: unknown) => {
      assert.match(String(error), /`local\.phoebus\.layoutFile` is required/);
      assert.match(String(error), /entry `missing-layout`/);
      return true;
    },
  );
});

test("Phoebus layout field rejects non-boolean values", () => {
  assert.throws(
    () =>
      parseConfig(
        `
entries:
  - id: bad-layout
    name: Bad layout
    target: { kind: phoebus, layout: alarm.memento }
`,
        BASE,
      ),
    /target\.layout.*boolean/,
  );
});

test("Phoebus layout refuses reuse because the startup flag cannot be applied", () => {
  assert.doesNotThrow(() => assertPhoebusLayoutApplied(true, "started", 4918));
  assert.throws(
    () => assertPhoebusLayoutApplied(true, "reused-owned", 4918),
    (error: unknown) => {
      assert.ok(error instanceof PhoebusLayoutStartupError);
      assert.match(error.message, /startup-only/);
      assert.match(error.message, /127\.0\.0\.1:4918/);
      assert.match(error.message, /reused-owned/);
      return true;
    },
  );
  assert.doesNotThrow(() => assertPhoebusLayoutApplied(false, "reused-external", 4918));
});

test("Phoebus resources support HTTP(S), filesystem roots, and configured app query names", () => {
  const parsed = parseConfig(
    `
local:
  cssGuiRoot: /srv/css
  phoebus:
    executable: /opt/phoebus/phoebus.sh
    serverPort: 4918
entries:
  - id: local-panel
    name: Local panel
    target: { kind: phoebus, resource: panels/main.bob, app: '<app-name-from-list>' }
  - id: remote-panel
    name: Remote panel
    target: { kind: phoebus, resource: 'https://panels.invalid/main.bob?mode=operator', app: '<app-name-from-list>' }
`,
    BASE,
  );

  const local = materializePhoebusTarget(
    parsed.targetsById.get("local-panel") as PhoebusLaunchTarget,
    parsed.context,
    undefined,
    "linux",
  );
  const remote = materializePhoebusTarget(
    parsed.targetsById.get("remote-panel") as PhoebusLaunchTarget,
    parsed.context,
    undefined,
    "linux",
  );
  assert.equal(
    local.openResource?.args?.at(-1),
    "file:///srv/css/panels/main.bob?app=%3Capp-name-from-list%3E",
  );
  assert.equal(
    remote.openResource?.args?.at(-1),
    "https://panels.invalid/main.bob?mode=operator&app=%3Capp-name-from-list%3E",
  );
});

test("Phoebus app selectors use file URIs for Windows filesystem resources", () => {
  const parsed = parseConfig(
    `
local:
  cssGuiRoot: 'C:\\CSS GUIs'
  phoebus: { executable: 'C:\\Phoebus\\phoebus.bat', serverPort: 4918 }
entries:
  - id: local-panel
    name: Local panel
    target: { kind: phoebus, resource: 'panels\\Main Panel.bob', app: display_runtime }
`,
    BASE,
  );

  const plans = materializePhoebusTarget(
    parsed.targetsById.get("local-panel") as PhoebusLaunchTarget,
    parsed.context,
    undefined,
    "win32",
  );
  assert.equal(
    plans.openResource?.args?.at(-1),
    "file:///C:/CSS%20GUIs/panels/Main%20Panel.bob?app=display_runtime",
  );
});

test("relative Phoebus resources require cssGuiRoot and name the entry", () => {
  assert.throws(
    () =>
      parseConfig(
        `
local:
  phoebus:
    executable: /opt/phoebus/phoebus.sh
    serverPort: 4918
entries:
  - id: missing-css-root
    name: Missing CSS root
    target: { kind: phoebus, resource: panels/main.bob }
`,
        BASE,
      ),
    (error: unknown) => {
      assert.match(String(error), /`local\.cssGuiRoot` is required/);
      assert.match(String(error), /entry `missing-css-root`/);
      return true;
    },
  );
});

test("absolute and HTTP Phoebus resources do not require cssGuiRoot", () => {
  assert.doesNotThrow(() =>
    parseConfig(
      `
local:
  phoebus: { executable: /opt/phoebus/phoebus.sh, serverPort: 4918 }
entries:
  - { id: absolute, name: Absolute, target: { kind: phoebus, resource: /srv/panels/main.bob } }
  - { id: http, name: HTTP, target: { kind: phoebus, resource: https://panels.invalid/main.bob } }
`,
      BASE,
    ),
  );
});

test("Phoebus rejects unsupported URI schemes and app-without-resource at load", () => {
  assert.throws(
    () =>
      parseConfig(
        `
local:
  phoebus: { executable: /opt/phoebus/phoebus.sh, serverPort: 4918 }
entries:
  - { id: ftp, name: FTP, target: { kind: phoebus, resource: ftp://host/panel.bob } }
`,
        BASE,
      ),
    /Phoebus resource URI must use HTTP\(S\)/,
  );
  assert.throws(
    () =>
      parseConfig(
        `
local:
  phoebus: { executable: /opt/phoebus/phoebus.sh, serverPort: 4918 }
entries:
  - { id: app-only, name: App only, target: { kind: phoebus, app: display } }
`,
        BASE,
      ),
    /phoebus target with app but no resource/,
  );
});

test("Phoebus target requires executable and port with the launcher item id", () => {
  assert.throws(
    () =>
      parseConfig(
        `
local:
  phoebus:
    serverPort: 4918
entries:
  - id: missing-executable
    name: Missing executable
    target: { kind: phoebus }
`,
        BASE,
      ),
    (error: unknown) => {
      assert.match(String(error), /`local\.phoebus\.executable` is required/);
      assert.match(String(error), /entry `missing-executable`/);
      return true;
    },
  );

  assert.throws(
    () =>
      parseConfig(
        `
local:
  phoebus:
    executable: /opt/phoebus/phoebus.sh
entries:
  - id: missing-port
    name: Missing port
    target: { kind: phoebus }
`,
        BASE,
      ),
    (error: unknown) => {
      assert.match(String(error), /`local\.phoebus\.serverPort` is required/);
      assert.match(String(error), /entry `missing-port`/);
      return true;
    },
  );
});

test("TCP liveness probe detects a real listener and its closure", async (t) => {
  const server = net.createServer();
  t.after(() => server.close());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  assert.equal(await probeTcpPort(address.port), true);
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  assert.equal(await probeTcpPort(address.port), false);
});

test("two concurrent launches create only one Phoebus server process", async () => {
  let listenerOpen = false;
  let startCount = 0;
  let releaseStart: (() => void) | undefined;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const manager = new PhoebusServerManager({
    probePort: async () => listenerOpen,
    isProcessAlive: async () => true,
    sleep: async () => undefined,
    probeIntervalMs: 1,
  });
  const startServer = async () => {
    startCount += 1;
    await startGate;
    listenerOpen = true;
    return { pid: 1001, spawnedAt: 10 };
  };

  const first = manager.ensureServer(SERVER_PLAN, startServer);
  const second = manager.ensureServer(SERVER_PLAN, startServer);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(startCount, 1);
  releaseStart?.();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.state, "started");
  assert.equal(secondResult.state, "started");
  assert.equal(startCount, 1);
});

test("a newly started server waits for its resource handler, while reuse does not", async () => {
  let listenerOpen = false;
  const sleeps: number[] = [];
  const manager = new PhoebusServerManager({
    probePort: async () => listenerOpen,
    isProcessAlive: async () => true,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });
  const plan = { ...SERVER_PLAN, resourceReadyDelayMs: 8000 };

  const first = await manager.ensureServer(plan, async () => {
    listenerOpen = true;
    return { pid: 1501, spawnedAt: 10 };
  });
  assert.equal(first.state, "started");
  assert.deepEqual(sleeps, [8000]);

  const second = await manager.ensureServer(plan, async () => {
    throw new Error("reused server must not be started");
  });
  assert.equal(second.state, "reused-owned");
  assert.deepEqual(sleeps, [8000]);
});

test("external server reuse waits because another launcher may still be starting JavaFX", async () => {
  const sleeps: number[] = [];
  const manager = new PhoebusServerManager({
    probePort: async () => true,
    isProcessAlive: async () => true,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });

  const result = await manager.ensureServer(
    { ...SERVER_PLAN, resourceReadyDelayMs: 8000 },
    async () => {
      throw new Error("external listener must not be started again");
    },
  );

  assert.equal(result.state, "reused-external");
  assert.deepEqual(sleeps, [8000]);
});

test("a dead owned Phoebus server is recreated on the next launch", async () => {
  let listenerOpen = false;
  let processAlive = false;
  let startCount = 0;
  const manager = new PhoebusServerManager({
    probePort: async () => listenerOpen,
    isProcessAlive: async () => processAlive,
    sleep: async () => undefined,
    probeIntervalMs: 1,
  });
  const startServer = async () => {
    startCount += 1;
    processAlive = true;
    listenerOpen = true;
    return { pid: 2000 + startCount, spawnedAt: startCount };
  };

  assert.equal((await manager.ensureServer(SERVER_PLAN, startServer)).state, "started");
  listenerOpen = false;
  processAlive = false;
  assert.equal((await manager.ensureServer(SERVER_PLAN, startServer)).state, "started");
  assert.equal(startCount, 2);
});

test("an owned live process with no listener blocks a duplicate server start", async () => {
  let listenerOpen = false;
  let processAlive = false;
  let now = 0;
  let startCount = 0;
  const manager = new PhoebusServerManager({
    probePort: async () => listenerOpen,
    isProcessAlive: async () => processAlive,
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    probeIntervalMs: 1,
  });
  const plan = { ...SERVER_PLAN, startupTimeoutMs: 2 };
  const startServer = async () => {
    startCount += 1;
    processAlive = true;
    return { pid: 3001, spawnedAt: 1 };
  };

  await assert.rejects(
    manager.ensureServer(plan, startServer),
    PhoebusServerUnreachableError,
  );
  await assert.rejects(
    manager.ensureServer(plan, startServer),
    PhoebusServerProcessStillRunningError,
  );
  assert.equal(startCount, 1);
});

test("liveness treats a matching start identity as the same live process", async () => {
  const alive = await isSpawnReceiptAlive(
    { pid: 4242, spawnedAt: 1, startIdentity: "linux:boot:777" },
    async () => ({ alive: true, identity: "linux:boot:777" }),
  );
  assert.equal(alive, true);
});

test("liveness treats a recycled PID with a new identity as not our process", async () => {
  const alive = await isSpawnReceiptAlive(
    { pid: 4242, spawnedAt: 1, startIdentity: "linux:boot:777" },
    async () => ({ alive: true, identity: "linux:boot:999" }),
  );
  assert.equal(alive, false);
});

test("liveness reports a vanished PID as not alive", async () => {
  const alive = await isSpawnReceiptAlive(
    { pid: 4242, spawnedAt: 1, startIdentity: "linux:boot:777" },
    async () => ({ alive: false, reason: "process does not exist" }),
  );
  assert.equal(alive, false);
});

test("liveness falls back to existence when a start identity is unavailable", async () => {
  const withoutReceiptIdentity = await isSpawnReceiptAlive(
    { pid: 4242, spawnedAt: 1 },
    async () => ({ alive: true, identity: "linux:boot:777" }),
  );
  assert.equal(withoutReceiptIdentity, true);
  const withoutLiveIdentity = await isSpawnReceiptAlive(
    { pid: 4242, spawnedAt: 1, startIdentity: "linux:boot:777" },
    async () => ({ alive: true }),
  );
  assert.equal(withoutLiveIdentity, true);
});

test("a recycled owned PID is treated as foreign and a fresh Phoebus server is started", async () => {
  let listenerOpen = false;
  let nextPid = 6000;
  const identityByPid = new Map<number, string>();
  const manager = new PhoebusServerManager({
    probePort: async () => listenerOpen,
    inspectProcess: async (pid) => {
      const identity = identityByPid.get(pid);
      return identity === undefined
        ? { alive: false, reason: "process does not exist" }
        : { alive: true, identity };
    },
    sleep: async () => undefined,
    probeIntervalMs: 1,
  });
  const startServer = async () => {
    const pid = (nextPid += 1);
    identityByPid.set(pid, `linux:boot:${pid}`);
    listenerOpen = true;
    return { pid, spawnedAt: pid };
  };

  const first = await manager.ensureServer(SERVER_PLAN, startServer);
  assert.equal(first.state, "started");
  const ownedPid = first.receipt?.pid ?? 0;

  // The listener drops and an unrelated process reuses the same PID number.
  listenerOpen = false;
  identityByPid.set(ownedPid, "linux:boot:unrelated");

  const second = await manager.ensureServer(SERVER_PLAN, startServer);
  assert.equal(second.state, "started");
  assert.notEqual(second.receipt?.pid, ownedPid);
});

test("an owned live server keeps blocking a duplicate when its identity still matches", async () => {
  let listenerOpen = false;
  let now = 0;
  const identityByPid = new Map<number, string>();
  const manager = new PhoebusServerManager({
    probePort: async () => listenerOpen,
    inspectProcess: async (pid) => {
      const identity = identityByPid.get(pid);
      return identity === undefined
        ? { alive: false, reason: "process does not exist" }
        : { alive: true, identity };
    },
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    probeIntervalMs: 1,
  });
  const plan = { ...SERVER_PLAN, startupTimeoutMs: 2 };
  const startServer = async () => {
    identityByPid.set(7001, "linux:boot:7001");
    return { pid: 7001, spawnedAt: 1 };
  };

  await assert.rejects(manager.ensureServer(plan, startServer), PhoebusServerUnreachableError);
  await assert.rejects(
    manager.ensureServer(plan, startServer),
    PhoebusServerProcessStillRunningError,
  );
});
