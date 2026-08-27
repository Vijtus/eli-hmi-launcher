import net from "node:net";
import type { SpawnReceipt } from "./process";
import type { PhoebusServerPlan } from "./phoebus";
import { inspectProcess, type ProcessInspector } from "../runtime/process";

const DEFAULT_PROBE_TIMEOUT_MS = 250;
const DEFAULT_PROBE_INTERVAL_MS = 100;

export type PhoebusServerState = "started" | "reused-owned" | "reused-external";

export type PhoebusEnsureResult = {
  state: PhoebusServerState;
  port: number;
  receipt?: SpawnReceipt;
};

export class PhoebusServerUnreachableError extends Error {
  constructor(port: number, timeoutMs: number, pid?: number) {
    const processDetail = pid === undefined ? "" : ` Process ${pid} was accepted by the OS,`;
    super(
      `Phoebus server is unreachable at 127.0.0.1:${port} after ${timeoutMs} ms.` +
        `${processDetail} but the TCP listener did not appear.`,
    );
    this.name = "PhoebusServerUnreachableError";
  }
}

export class PhoebusServerProcessStillRunningError extends Error {
  constructor(port: number, pid: number) {
    super(
      `Phoebus process ${pid} is still running, but server port 127.0.0.1:${port} is unreachable. ` +
        "Refusing to start a second server process.",
    );
    this.name = "PhoebusServerProcessStillRunningError";
  }
}

export type PhoebusServerManagerDependencies = {
  probePort: (port: number) => Promise<boolean>;
  inspectProcess: ProcessInspector;
  isProcessAlive: (receipt: SpawnReceipt) => Promise<boolean>;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  probeIntervalMs: number;
};

export type StartPhoebusServer = (plan: PhoebusServerPlan) => Promise<SpawnReceipt>;

export async function probeTcpPort(
  port: number,
  host = "127.0.0.1",
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (isOpen: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(isOpen);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

export async function isSpawnReceiptAlive(
  receipt: SpawnReceipt,
  inspect: ProcessInspector = inspectProcess,
): Promise<boolean> {
  const observation = await inspect(receipt.pid);
  if (!observation.alive) {
    return false;
  }
  // When both the receipt and the live process carry a start identity, a
  // mismatch means the PID was recycled by an unrelated process and the owned
  // server is gone. If either side lacks an identity, fall back to liveness
  // alone so an indeterminate reading never wrongly refuses a needed server.
  if (receipt.startIdentity !== undefined && observation.identity !== undefined) {
    return observation.identity === receipt.startIdentity;
  }
  return true;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class PhoebusServerManager {
  private readonly dependencies: PhoebusServerManagerDependencies;
  private readonly pendingByPort = new Map<number, Promise<PhoebusEnsureResult>>();
  private readonly ownedByPort = new Map<number, SpawnReceipt>();

  constructor(dependencies: Partial<PhoebusServerManagerDependencies> = {}) {
    const inspect = dependencies.inspectProcess ?? inspectProcess;
    this.dependencies = {
      probePort: dependencies.probePort ?? ((port) => probeTcpPort(port)),
      inspectProcess: inspect,
      isProcessAlive:
        dependencies.isProcessAlive ?? ((receipt) => isSpawnReceiptAlive(receipt, inspect)),
      sleep: dependencies.sleep ?? defaultSleep,
      now: dependencies.now ?? Date.now,
      probeIntervalMs: dependencies.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS,
    };
  }

  private async identifyReceipt(receipt: SpawnReceipt): Promise<SpawnReceipt> {
    if (receipt.startIdentity !== undefined) {
      return receipt;
    }
    const observation = await this.dependencies.inspectProcess(receipt.pid);
    return observation.identity === undefined
      ? receipt
      : { ...receipt, startIdentity: observation.identity };
  }

  async ensureServer(
    plan: PhoebusServerPlan,
    startServer: StartPhoebusServer,
  ): Promise<PhoebusEnsureResult> {
    const pending = this.pendingByPort.get(plan.port);
    if (pending) {
      return await pending;
    }

    const operation = this.ensureServerExclusive(plan, startServer);
    this.pendingByPort.set(plan.port, operation);
    try {
      return await operation;
    } finally {
      if (this.pendingByPort.get(plan.port) === operation) {
        this.pendingByPort.delete(plan.port);
      }
    }
  }

  private async ensureServerExclusive(
    plan: PhoebusServerPlan,
    startServer: StartPhoebusServer,
  ): Promise<PhoebusEnsureResult> {
    const listenerOpen = await this.dependencies.probePort(plan.port);
    const owned = this.ownedByPort.get(plan.port);

    if (listenerOpen) {
      if (owned && (await this.dependencies.isProcessAlive(owned))) {
        return { state: "reused-owned", port: plan.port, receipt: owned };
      }
      if (owned) {
        this.ownedByPort.delete(plan.port);
      }
      // A listener owned by another launcher can be in the same measured gap
      // as one we just started: TCP is accepting connections while JavaFX has
      // not installed the resource handler yet. This manager cannot know the
      // other process's start time, so a configured readiness delay is applied
      // conservatively on external reuse as well. Reuse of this manager's own
      // server is already past its creator-side delay and returns immediately.
      if (plan.resourceReadyDelayMs > 0) {
        await this.dependencies.sleep(plan.resourceReadyDelayMs);
      }
      return { state: "reused-external", port: plan.port };
    }

    if (owned) {
      if (await this.dependencies.isProcessAlive(owned)) {
        throw new PhoebusServerProcessStillRunningError(plan.port, owned.pid);
      }
      this.ownedByPort.delete(plan.port);
    }

    const receipt = await this.identifyReceipt(await startServer(plan));
    this.ownedByPort.set(plan.port, receipt);

    const deadline = this.dependencies.now() + plan.startupTimeoutMs;
    while (true) {
      if (await this.dependencies.probePort(plan.port)) {
        if (plan.resourceReadyDelayMs > 0) {
          await this.dependencies.sleep(plan.resourceReadyDelayMs);
        }
        return { state: "started", port: plan.port, receipt };
      }
      const remaining = deadline - this.dependencies.now();
      if (remaining <= 0) {
        throw new PhoebusServerUnreachableError(
          plan.port,
          plan.startupTimeoutMs,
          receipt.pid,
        );
      }
      await this.dependencies.sleep(Math.min(this.dependencies.probeIntervalMs, remaining));
    }
  }
}
