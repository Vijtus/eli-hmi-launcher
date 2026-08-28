import type {
  LaunchAccessMode,
  LaunchTarget,
  RuntimeItemState,
  RuntimeSnapshot,
  RuntimeStatus,
} from "../../shared/types";
import type { SpawnReceipt } from "../launch/process";
import {
  inspectProcess,
  inspectProcesses,
  type ProcessInspector,
  type ProcessObservation,
} from "./process";
import { probeTcpPort } from "../launch/phoebus-server";

export const DEFAULT_RUNTIME_RECONCILE_INTERVAL_MS = 5_000;

export type RegistryClock = {
  now(): number;
};

export type RegistryScheduler = {
  setInterval(callback: () => void | Promise<void>, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
};

export type ProcessRegistryState = "running" | "stopped" | "unknown";

export type ProcessRegistryRecord = {
  instanceId: string;
  entryId: string;
  kind: LaunchTarget["kind"];
  command: string;
  args: string[];
  pid: number;
  spawnedAt: number;
  registeredAt: number;
  identity?: string;
  lastSeenAt?: number;
  state: ProcessRegistryState;
  reason: string;
  launchMode: LaunchAccessMode;
};

type PhoebusRegistryRecord = {
  entryId: string;
  port: number;
  launchedAt: number;
  lastSeenAt?: number;
  state: "shared" | "stopped";
  ownership: "started" | "reused-owned" | "reused-external";
  resource?: string;
};

type HandoffRegistryRecord = {
  entryId: string;
  kind: "web" | "folder" | "process";
  launchedAt: number;
  detail: string;
};

export type RegisterProcessInput = {
  entryId: string;
  kind: "process" | "labview-dev" | "labview-epics";
  command: string;
  args: string[];
  receipt: SpawnReceipt;
  launchMode?: LaunchAccessMode;
};

export type RegisterPhoebusInput = {
  entryId: string;
  port: number;
  ownership: PhoebusRegistryRecord["ownership"];
  resource?: string;
};

export type RuntimeRegistryOptions = {
  reconcileIntervalMs?: number;
  inspectProcess?: ProcessInspector;
  /** Batch inspector. Injectable alongside inspectProcess so tests can drive both. */
  inspectProcesses?: (pids: number[]) => Promise<Map<number, ProcessObservation>>;
  probePhoebusPort?: (port: number) => Promise<boolean>;
  clock?: RegistryClock;
  scheduler?: RegistryScheduler;
  onChange?: (snapshot: RuntimeSnapshot) => void;
  onError?: (error: unknown) => void;
};

const defaultScheduler: RegistryScheduler = {
  setInterval(callback, milliseconds) {
    const timer = setInterval(() => {
      void Promise.resolve(callback()).catch(() => undefined);
    }, milliseconds);
    timer.unref();
    return timer;
  },
  clearInterval(handle) {
    clearInterval(handle as NodeJS.Timeout);
  },
};

function iso(milliseconds: number | undefined): string | undefined {
  return milliseconds === undefined ? undefined : new Date(milliseconds).toISOString();
}

function maxDefined(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? Math.max(...present) : undefined;
}

export class RuntimeRegistry {
  readonly reconcileIntervalMs: number;

  private readonly inspect: ProcessInspector;
  private readonly inspectMany: (pids: number[]) => Promise<Map<number, ProcessObservation>>;
  private readonly probePort: (port: number) => Promise<boolean>;
  private readonly clock: RegistryClock;
  private readonly scheduler: RegistryScheduler;
  private readonly onChange?: (snapshot: RuntimeSnapshot) => void;
  private readonly onError?: (error: unknown) => void;
  private readonly processesByEntry = new Map<string, ProcessRegistryRecord[]>();
  private readonly phoebusByEntry = new Map<string, PhoebusRegistryRecord>();
  private readonly handoffsByEntry = new Map<string, HandoffRegistryRecord>();
  private intervalHandle: unknown;
  private sequence = 0;
  private lastReconciledAt: number;
  private reconcilePending?: Promise<void>;

  constructor(options: RuntimeRegistryOptions = {}) {
    this.reconcileIntervalMs =
      options.reconcileIntervalMs ?? DEFAULT_RUNTIME_RECONCILE_INTERVAL_MS;
    if (!Number.isInteger(this.reconcileIntervalMs) || this.reconcileIntervalMs < 1) {
      throw new Error("Runtime reconciliation interval must be a positive integer.");
    }
    this.inspect = options.inspectProcess ?? inspectProcess;
    // When only a single-process inspector is injected, fan out to it so a test
    // that stubs one behaviour does not silently bypass the other.
    this.inspectMany =
      options.inspectProcesses ??
      (options.inspectProcess
        ? async (pids) =>
            new Map(await Promise.all(pids.map(async (pid) => [pid, await this.inspect(pid)] as const)))
        : (pids) => inspectProcesses(pids));
    this.probePort = options.probePhoebusPort ?? ((port) => probeTcpPort(port));
    this.clock = options.clock ?? { now: Date.now };
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onChange = options.onChange;
    this.onError = options.onError;
    this.lastReconciledAt = this.clock.now();
  }

  start(): void {
    if (this.intervalHandle !== undefined) {
      return;
    }
    this.lastReconciledAt = this.clock.now();
    this.intervalHandle = this.scheduler.setInterval(async () => {
      try {
        await this.reconcile();
      } catch (error) {
        this.onError?.(error);
      }
    }, this.reconcileIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle === undefined) {
      return;
    }
    this.scheduler.clearInterval(this.intervalHandle);
    this.intervalHandle = undefined;
  }

  async registerProcess(input: RegisterProcessInput): Promise<ProcessRegistryRecord> {
    this.phoebusByEntry.delete(input.entryId);
    this.handoffsByEntry.delete(input.entryId);
    const now = this.clock.now();
    const observation = await this.safeInspect(input.receipt.pid);
    const hasTrustedIdentity = observation.alive && observation.identity !== undefined;
    const record: ProcessRegistryRecord = {
      instanceId: `${input.entryId}:${input.receipt.pid}:${input.receipt.spawnedAt}:${++this.sequence}`,
      entryId: input.entryId,
      kind: input.kind,
      command: input.command,
      args: [...input.args],
      pid: input.receipt.pid,
      spawnedAt: input.receipt.spawnedAt,
      registeredAt: now,
      ...(observation.identity ? { identity: observation.identity } : {}),
      ...(hasTrustedIdentity ? { lastSeenAt: now } : {}),
      state: hasTrustedIdentity ? "running" : observation.alive ? "unknown" : "stopped",
      reason: observation.alive
        ? observation.identity
          ? "PID and process start identity match the launched process."
          : "PID exists, but start identity is unavailable; PID-only liveness is not trusted."
        : observation.reason ?? "Process exited before it could be registered.",
      launchMode: input.launchMode ?? "unknown",
    };
    const records = this.processesByEntry.get(input.entryId) ?? [];
    records.push(record);
    this.processesByEntry.set(input.entryId, records);
    this.emitChange();
    return { ...record, args: [...record.args] };
  }

  recordPhoebus(input: RegisterPhoebusInput): void {
    this.processesByEntry.delete(input.entryId);
    this.handoffsByEntry.delete(input.entryId);
    const now = this.clock.now();
    this.phoebusByEntry.set(input.entryId, {
      entryId: input.entryId,
      port: input.port,
      launchedAt: now,
      lastSeenAt: now,
      state: "shared",
      ownership: input.ownership,
      ...(input.resource ? { resource: input.resource } : {}),
    });
    this.emitChange();
  }

  recordHandoff(
    entryId: string,
    kind: HandoffRegistryRecord["kind"],
    detail?: string,
  ): void {
    this.processesByEntry.delete(entryId);
    this.phoebusByEntry.delete(entryId);
    this.handoffsByEntry.set(entryId, {
      entryId,
      kind,
      launchedAt: this.clock.now(),
      detail:
        detail ??
        (kind === "web"
          ? "Opened by the default browser; the browser process and tab are not owned by the launcher."
          : kind === "folder"
            ? "Opened by the operating-system file manager; no child process is owned by the launcher."
            : "The launcher process exited after handing off; the downstream GUI identity is not observable."),
    });
    this.emitChange();
  }

  async reconcile(): Promise<void> {
    if (this.reconcilePending) {
      return await this.reconcilePending;
    }
    const pending = this.reconcileExclusive();
    this.reconcilePending = pending;
    try {
      await pending;
    } finally {
      if (this.reconcilePending === pending) {
        this.reconcilePending = undefined;
      }
    }
  }

  private async reconcileExclusive(): Promise<void> {
    const now = this.clock.now();

    // One inspection covering every tracked process. Asking per-process meant a
    // subprocess per launched GUI on every cycle, which is exactly the load
    // that made the answers time out and the rows read `unknown`.
    const live: number[] = [];
    for (const records of this.processesByEntry.values()) {
      for (const record of records) {
        if (record.state !== "stopped") {
          live.push(record.pid);
        }
      }
    }
    const observations = await this.safeInspectMany(live);

    for (const records of this.processesByEntry.values()) {
      for (const record of records) {
        if (record.state === "stopped") {
          continue;
        }
        const observation = observations.get(record.pid) ?? (await this.safeInspect(record.pid));
        if (!observation.alive) {
          record.state = "stopped";
          record.reason = observation.reason ?? "Process is no longer running.";
          continue;
        }
        if (!record.identity) {
          record.state = "unknown";
          record.reason =
            "Initial process start identity was unavailable; a later PID match cannot exclude PID reuse.";
          continue;
        }
        if (!observation.identity) {
          record.state = "unknown";
          record.reason =
            observation.reason ?? "Process exists, but its current start identity is unavailable.";
          continue;
        }
        if (observation.identity !== record.identity) {
          record.state = "stopped";
          record.reason =
            `PID ${record.pid} was reused by a different process (start identity changed).`;
          continue;
        }
        record.state = "running";
        record.lastSeenAt = now;
        record.reason = "PID and process start identity match the launched process.";
      }
    }

    const portResults = new Map<number, boolean>();
    for (const record of this.phoebusByEntry.values()) {
      let open = portResults.get(record.port);
      if (open === undefined) {
        try {
          open = await this.probePort(record.port);
        } catch {
          open = false;
        }
        portResults.set(record.port, open);
      }
      record.state = open ? "shared" : "stopped";
      if (open) {
        record.lastSeenAt = now;
      }
    }

    this.lastReconciledAt = now;
    this.emitChange();
  }

  getProcessRecords(entryId?: string): ProcessRegistryRecord[] {
    const records = entryId
      ? this.processesByEntry.get(entryId) ?? []
      : [...this.processesByEntry.values()].flat();
    return records.map((record) => ({ ...record, args: [...record.args] }));
  }

  getState(entryId: string): RuntimeItemState | undefined {
    return this.snapshot().items.find((item) => item.id === entryId);
  }

  snapshot(): RuntimeSnapshot {
    const now = this.clock.now();
    const stale =
      this.intervalHandle !== undefined &&
      now - this.lastReconciledAt > this.reconcileIntervalMs * 2;
    const items: RuntimeItemState[] = [];

    for (const [entryId, records] of this.processesByEntry) {
      const running = records.filter((record) => record.state === "running");
      const unknown = records.filter((record) => record.state === "unknown");
      const status: RuntimeStatus =
        running.length > 0 ? "running" : unknown.length > 0 ? "unknown" : "stopped";
      const latest = records.reduce((left, right) =>
        left.spawnedAt >= right.spawnedAt ? left : right,
      );
      const detail =
        status === "running"
          ? `${running.length} launcher-owned process instance(s) match PID and start identity.`
          : status === "unknown"
            ? unknown.map((record) => record.reason).join(" ")
            : records.map((record) => record.reason).join(" ");
      items.push({
        id: entryId,
        kind: latest.kind,
        model: "pid",
        status,
        runningInstances: running.length,
        totalInstances: records.length,
        launchedAt: new Date(Math.max(...records.map((record) => record.spawnedAt))).toISOString(),
        ...(maxDefined(records.map((record) => record.lastSeenAt)) !== undefined
          ? { lastSeenAt: iso(maxDefined(records.map((record) => record.lastSeenAt))) }
          : {}),
        stale,
        detail,
      });
    }

    for (const record of this.phoebusByEntry.values()) {
      items.push({
        id: record.entryId,
        kind: "phoebus",
        model: "phoebus-port",
        status: record.state,
        runningInstances: 0,
        totalInstances: 1,
        launchedAt: new Date(record.launchedAt).toISOString(),
        ...(iso(record.lastSeenAt) ? { lastSeenAt: iso(record.lastSeenAt) } : {}),
        stale,
        detail:
          record.state === "shared"
            ? `Phoebus server port 127.0.0.1:${record.port} is reachable (${record.ownership}); individual panel presence is not observable.`
            : `Phoebus server port 127.0.0.1:${record.port} is not reachable; individual panel presence was never independently observable.`,
      });
    }

    for (const record of this.handoffsByEntry.values()) {
      items.push({
        id: record.entryId,
        kind: record.kind,
        model: "external-handoff",
        status: "handed-off",
        runningInstances: 0,
        totalInstances: 1,
        launchedAt: new Date(record.launchedAt).toISOString(),
        stale: false,
        detail: record.detail,
      });
    }

    items.sort((left, right) => left.id.localeCompare(right.id));
    return {
      generatedAt: new Date(now).toISOString(),
      reconcileIntervalMs: this.reconcileIntervalMs,
      items,
    };
  }

  private async safeInspectMany(pids: number[]): Promise<Map<number, ProcessObservation>> {
    if (pids.length === 0) {
      return new Map();
    }
    try {
      return await this.inspectMany(pids);
    } catch (error) {
      this.onError?.(error);
      // An inspection failure must never be mistaken for "everything stopped";
      // returning nothing makes each record fall back to its own check.
      return new Map();
    }
  }

  private async safeInspect(pid: number): Promise<ProcessObservation> {
    try {
      return await this.inspect(pid);
    } catch (error) {
      return {
        alive: true,
        reason: `Process inspection failed; PID-only liveness is not trusted: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private emitChange(): void {
    this.onChange?.(this.snapshot());
  }
}
