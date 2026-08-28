import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { LaunchResult, RuntimeSnapshot } from "../../src/shared/types";
import { readLabviewContractCapture } from "../../scripts/labview-contract-capture";

type DevToolsTarget = {
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
};

type CdpResponse = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

type PendingCall = {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
};

const execFileAsync = promisify(execFile);

function requiredArgument(index: number, label: string): string {
  const value = process.argv[index];
  if (!value) {
    throw new Error(`Missing ${label}.`);
  }
  return path.resolve(value);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForTarget(port: number, timeoutMs = 30_000): Promise<DevToolsTarget> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no DevTools target returned";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = (await response.json()) as DevToolsTarget[];
        const target = targets.find(
          (candidate) =>
            candidate.type === "page" &&
            typeof candidate.webSocketDebuggerUrl === "string" &&
            candidate.webSocketDebuggerUrl.length > 0,
        );
        if (target) {
          return target;
        }
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`Electron DevTools endpoint did not become ready: ${lastError}`);
}

class CdpClient {
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      const message = JSON.parse(event.data) as CdpResponse;
      if (message.id === undefined) {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "CDP command failed."));
      } else {
        pending.resolve(message.result ?? {});
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Electron DevTools connection closed."));
      }
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Could not connect to Electron DevTools.")), {
        once: true,
      });
    });
    return new CdpClient(socket);
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return await promise;
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const exception = response["exceptionDetails"] as { text?: string } | undefined;
    if (exception) {
      throw new Error(exception.text ?? "Electron evaluation failed.");
    }
    const remote = response["result"] as { value?: T; description?: string } | undefined;
    if (!remote || !("value" in remote)) {
      throw new Error(remote?.description ?? "Electron evaluation returned no value.");
    }
    return remote.value as T;
  }

  close(): void {
    this.socket.close();
  }
}

async function waitForRenderer(client: CdpClient): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const ready = await client.evaluate<boolean>(
        "Boolean(window.launcherApi && document.querySelector('#launcher-rows'))",
      );
      if (ready) {
        return;
      }
    } catch {
      // Navigation may replace the execution context while Electron starts.
    }
    await delay(100);
  }
  throw new Error("Electron renderer did not expose launcherApi.");
}

async function waitForRuntime(client: CdpClient): Promise<RuntimeSnapshot> {
  const expected = new Map([
    ["local-phoebus-alarm-layout", "shared"],
    ["labview-contract-developer", "running"],
    ["labview-contract-epics", "running"],
    ["local-phoebus-temperature", "shared"],
    ["local-phoebus-state", "shared"],
    ["local-phoebus-flow", "shared"],
  ]);
  const deadline = Date.now() + 15_000;
  let latest: RuntimeSnapshot | undefined;
  while (Date.now() < deadline) {
    latest = await client.evaluate<RuntimeSnapshot>("window.launcherApi.getRuntimeStates()");
    const byId = new Map(latest.items.map((item) => [item.id, item.status]));
    if ([...expected].every(([id, status]) => byId.get(id) === status)) {
      return latest;
    }
    await delay(100);
  }
  throw new Error(`Launcher runtime states did not converge: ${JSON.stringify(latest)}`);
}

async function readWindowTree(): Promise<string> {
  const result = await execFileAsync("xwininfo", ["-root", "-tree"], {
    encoding: "utf8",
    env: process.env,
  });
  return result.stdout;
}

async function waitForWindowTitles(expectedTitles: string[]): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  let latest = "";
  while (Date.now() < deadline) {
    latest = await readWindowTree();
    if (expectedTitles.every((title) => latest.includes(title))) {
      return latest
        .split("\n")
        .filter((line) => expectedTitles.some((title) => line.includes(title)))
        .map((line) => line.trim());
    }
    await delay(100);
  }
  throw new Error(
    `Phoebus did not expose expected native window title(s) ${expectedTitles.join(", ")}: ${latest}`,
  );
}

async function waitForLabviewCaptures(captureDirectory: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const names = await readdir(captureDirectory);
    const pidNames = names.filter((name) => /^launch-\d+\.pid$/.test(name));
    if (pidNames.length === 2) {
      const captures = await Promise.all(
        pidNames.map(async (name) => {
          const pid = Number(name.slice("launch-".length, -".pid".length));
          return await readLabviewContractCapture(captureDirectory, pid);
        }),
      );
      return captures.sort((left, right) => left.executable.localeCompare(right.executable));
    }
    await delay(50);
  }
  throw new Error("Expected two LabVIEW fixture PID/argv captures.");
}

function decodeNulArgv(data: Uint8Array): string[] {
  const bytes = Buffer.from(data);
  assert.equal(bytes.at(-1), 0, "Phoebus argv audit must end in NUL");
  return bytes.subarray(0, -1).toString("utf8").split("\0");
}

async function readPhoebusAudit(auditDirectory: string): Promise<string[][]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const names = (await readdir(auditDirectory))
      .filter((name) => name.endsWith(".argv"))
      .sort();
    if (names.length === 4) {
      return await Promise.all(
        names.map(async (name) => decodeNulArgv(await readFile(path.join(auditDirectory, name)))),
      );
    }
    await delay(50);
  }
  throw new Error("Expected one Phoebus server argv audit and three resource argv audits.");
}

async function main(): Promise<void> {
  const debugPort = Number(process.argv[2]);
  assert.ok(Number.isInteger(debugPort) && debugPort > 0 && debugPort < 65536);
  const evidenceDirectory = requiredArgument(3, "evidence directory");
  const captureDirectory = requiredArgument(4, "LabVIEW capture directory");
  const phoebusAuditDirectory = requiredArgument(5, "Phoebus audit directory");
  await mkdir(evidenceDirectory, { recursive: true });

  const target = await waitForTarget(debugPort);
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await waitForRenderer(client);
    const config = await client.evaluate<{ rows: Array<{ id: string }> }>(
      "window.launcherApi.getConfig()",
    );
    const rowIds = [
      "labview-contract-developer",
      "labview-contract-epics",
      "local-phoebus-temperature",
      "local-phoebus-state",
      "local-phoebus-flow",
    ];
    assert.deepEqual(config.rows.map((row) => row.id), rowIds);
    // Layout is deliberately first: -layout is a server-startup option and the
    // production launcher must apply it before it reuses that server for BOBs.
    const launchIds = ["local-phoebus-alarm-layout", ...rowIds];
    const expectedPhoebusTitles = new Map<string, string[]>([
      [
        "local-phoebus-alarm-layout",
        ["CSI744_LOCAL Alarm Tree", "CSI744_LOCAL Alarm Area", "CSI744_LOCAL Alarm Table"],
      ],
      ["local-phoebus-temperature", ["Local Temperature"]],
      ["local-phoebus-state", ["Local State"]],
      ["local-phoebus-flow", ["Local Chiller"]],
    ]);

    const launchResults: LaunchResult[] = [];
    const phoebusWindows: Record<string, string[]> = {};
    for (const id of launchIds) {
      const result = await client.evaluate<LaunchResult>(
        `window.launcherApi.launchItem(${JSON.stringify(id)})`,
      );
      assert.equal(result.ok, true, result.ok ? undefined : result.error);
      launchResults.push(result);
      const expectedTitles = expectedPhoebusTitles.get(id);
      if (expectedTitles) {
        phoebusWindows[id] = await waitForWindowTitles(expectedTitles);
      }
    }

    const runtime = await waitForRuntime(client);
    const captures = await waitForLabviewCaptures(captureDirectory);
    const developerCapture = captures.find((capture) => capture.executable.endsWith("Developer Contract.exe"));
    const epicsCapture = captures.find((capture) => capture.executable.endsWith("EPICS Contract.exe"));
    assert.ok(developerCapture);
    assert.ok(epicsCapture);
    assert.deepEqual(developerCapture.args, [
      process.env["ELI_LABVIEW_CONTRACT_HOST"],
      process.env["ELI_LABVIEW_CONTRACT_IOC"],
      process.env["ELI_LABVIEW_CONTRACT_ZONE"],
    ]);
    assert.deepEqual(epicsCapture.args, [
      process.env["ELI_LABVIEW_CONTRACT_ZONE"],
      process.env["ELI_LABVIEW_CONTRACT_GUI"],
    ]);

    const phoebusArgv = await readPhoebusAudit(phoebusAuditDirectory);
    const serverCalls = phoebusArgv.filter((argv) => argv.includes("-settings"));
    const resourceCalls = phoebusArgv.filter((argv) => argv.includes("-resource"));
    assert.equal(serverCalls.length, 1);
    assert.equal(resourceCalls.length, 3);
    assert.ok(serverCalls[0]?.includes("-layout"));
    assert.ok(serverCalls[0]?.at(-1)?.endsWith("local-alarm-layout.memento"));
    assert.deepEqual(
      resourceCalls.map((argv) => path.basename(argv.at(-1) ?? "")).sort(),
      ["flow.bob", "state.bob", "temperature.bob"],
    );

    await client.call("Page.enable");
    const screenshot = await client.call("Page.captureScreenshot", { format: "png" });
    const screenshotData = screenshot["data"];
    assert.equal(typeof screenshotData, "string");
    const screenshotPath = path.join(evidenceDirectory, "launcher.png");
    await writeFile(screenshotPath, Buffer.from(screenshotData as string, "base64"));

    const evidencePath = path.join(evidenceDirectory, "electron.json");
    await writeFile(
      evidencePath,
      `${JSON.stringify(
        {
          result: "passed",
          classification: "local-acceptance",
          runtimeClaim:
            "Electron launched POSIX LabVIEW fixtures and the locked Phoebus runtime; NI LabVIEW and site services were not used.",
          observedAt: new Date().toISOString(),
          devToolsTarget: { title: target.title, url: target.url },
          launchResults,
          runtime,
          labviewCaptures: captures,
          phoebusArgv,
          phoebusWindows,
          screenshotPath,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    process.stdout.write(`${JSON.stringify({ result: "passed", evidencePath, screenshotPath })}\n`);

    // Close the renderer so Electron exercises its normal shutdown path.
    try {
      await client.evaluate<boolean>("window.close(); true");
    } catch {
      // The DevTools connection can close before the evaluation reply arrives.
    }
  } finally {
    client.close();
  }
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  },
);
