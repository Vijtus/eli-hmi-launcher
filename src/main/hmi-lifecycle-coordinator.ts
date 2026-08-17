import type { PolicyInstance } from "./access-policy";
import type {
  HmiApiAdapter,
  HmiApiOperationResult,
  HmiApiQueryResult,
  HmiLifecycleEntryReport,
  HmiReservationRequest,
} from "./hmi-api";
import type { ProcessRegistryRecord } from "./runtime-registry";
import type { HmiApiHealth, RuntimeSnapshot } from "../shared/types";

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;

export type LifecycleCoordinatorScheduler = {
  setInterval(callback: () => void | Promise<void>, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void | Promise<void>, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type HmiLifecycleCoordinatorOptions = {
  getSnapshot: () => RuntimeSnapshot;
  getProcessRecords: () => ProcessRegistryRecord[];
  scheduler?: LifecycleCoordinatorScheduler;
  onHealthChange?: (health: HmiApiHealth) => void;
  onError?: (error: unknown) => void;
  shutdownTimeoutMs?: number;
  random?: () => number;
};

const defaultScheduler: LifecycleCoordinatorScheduler = {
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
  setTimeout(callback, milliseconds) {
    const timer = setTimeout(() => {
      void Promise.resolve(callback()).catch(() => undefined);
    }, milliseconds);
    timer.unref();
    return timer;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export class HmiReservationDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HmiReservationDeniedError";
  }
}

export class HmiLifecycleUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HmiLifecycleUnavailableError";
  }
}

function activeReport(report: HmiLifecycleEntryReport): boolean {
  return report.runtime.status !== "stopped";
}

function resultSucceeded(result: HmiApiOperationResult): boolean {
  return result.status === "ok" || result.status === "disabled";
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

export function buildHmiLifecycleReports(
  snapshot: RuntimeSnapshot,
  records: ProcessRegistryRecord[],
): HmiLifecycleEntryReport[] {
  const recordsByEntry = new Map<string, ProcessRegistryRecord[]>();
  for (const record of records) {
    const current = recordsByEntry.get(record.entryId) ?? [];
    current.push(record);
    recordsByEntry.set(record.entryId, current);
  }

  return snapshot.items.map((runtime) => ({
    entryId: runtime.id,
    runtime: { ...runtime },
    instances: (recordsByEntry.get(runtime.id) ?? []).map((record) => ({
      instanceId: record.instanceId,
      state: record.state,
      launchMode: record.launchMode,
      spawnedAt: iso(record.spawnedAt),
      ...(record.lastSeenAt !== undefined ? { lastSeenAt: iso(record.lastSeenAt) } : {}),
    })),
  }));
}

export class HmiLifecycleCoordinator {
  private readonly adapter: HmiApiAdapter;
  private readonly getSnapshot: () => RuntimeSnapshot;
  private readonly getProcessRecords: () => ProcessRegistryRecord[];
  private readonly scheduler: LifecycleCoordinatorScheduler;
  private readonly onHealthChange?: (health: HmiApiHealth) => void;
  private readonly onError?: (error: unknown) => void;
  private readonly shutdownTimeoutMs: number;
  private readonly random: () => number;
  private readonly published = new Map<string, string>();
  private readonly remoteEntries = new Map<string, HmiLifecycleEntryReport[]>();
  private readonly pendingReservations = new Map<string, string>();
  private pending: Promise<void> = Promise.resolve();
  private latestSnapshot?: RuntimeSnapshot;
  private heartbeatHandle?: unknown;
  private retryHandle?: unknown;
  private retryIndex = 0;
  private lastQueryStatus: HmiApiQueryResult["status"] | "not-queried" = "not-queried";

  constructor(adapter: HmiApiAdapter, options: HmiLifecycleCoordinatorOptions) {
    this.adapter = adapter;
    this.getSnapshot = options.getSnapshot;
    this.getProcessRecords = options.getProcessRecords;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onHealthChange = options.onHealthChange;
    this.onError = options.onError;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.random = options.random ?? Math.random;
  }

  async start(): Promise<void> {
    if (this.heartbeatHandle !== undefined) {
      return;
    }
    await this.refresh();
    this.heartbeatHandle = this.scheduler.setInterval(
      () => this.heartbeat(),
      this.adapter.heartbeatIntervalMs,
    );
  }

  async stop(): Promise<void> {
    if (this.heartbeatHandle !== undefined) {
      this.scheduler.clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = undefined;
    }
    if (this.retryHandle !== undefined) {
      this.scheduler.clearTimeout(this.retryHandle);
      this.retryHandle = undefined;
    }
    await this.flush();
    for (const entryId of [...this.pendingReservations.keys()]) {
      await this.releasePendingReservation(entryId);
    }
    const reports = this.currentReports().filter(activeReport);
    if (reports.length === 0) {
      return;
    }
    const deregister = (async () => {
      for (const report of reports) {
        await this.adapter.deregister(report.entryId);
      }
    })();
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, this.shutdownTimeoutMs);
      timeout.unref();
    });
    await Promise.race([deregister, deadline]);
    if (timeout) {
      clearTimeout(timeout);
    }
    this.emitHealth();
  }

  observeSnapshot(snapshot: RuntimeSnapshot): void {
    this.latestSnapshot = snapshot;
    this.enqueue(async () => this.synchronize(snapshot));
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  async heartbeat(): Promise<void> {
    await this.runSerialized(() => this.heartbeatExclusive());
  }

  private async heartbeatExclusive(): Promise<void> {
    const reports = this.currentReports().filter(activeReport);
    const result = await this.adapter.heartbeat(reports);
    this.emitHealth();
    if (resultSucceeded(result)) {
      for (const report of reports) {
        this.published.set(report.entryId, JSON.stringify(report));
        this.pendingReservations.delete(report.entryId);
      }
      this.resetRetry();
    } else {
      this.scheduleRetry();
    }
  }

  async refresh(entryId?: string): Promise<void> {
    const result = await this.adapter.query(entryId);
    this.lastQueryStatus = result.status;
    if (result.status === "ok") {
      if (entryId) {
        this.remoteEntries.delete(entryId);
      } else {
        this.remoteEntries.clear();
      }
      for (const entry of result.entries) {
        const current = this.remoteEntries.get(entry.report.entryId) ?? [];
        current.push(entry.report);
        this.remoteEntries.set(entry.report.entryId, current);
      }
      this.resetRetry();
    } else if (result.status !== "disabled") {
      this.scheduleRetry();
    }
    this.emitHealth();
  }

  policyInstances(entryId: string): PolicyInstance[] {
    const health = this.adapter.health();
    if (health.status === "disabled") {
      return [];
    }
    if (
      this.lastQueryStatus !== "ok" ||
      health.status === "unavailable" ||
      health.status === "misconfigured"
    ) {
      return [{ state: "unknown", launchMode: "unknown" }];
    }

    const instances: PolicyInstance[] = [];
    for (const report of this.remoteEntries.get(entryId) ?? []) {
      const unobservable =
        report.runtime.stale ||
        report.runtime.status === "unknown" ||
        report.runtime.status === "shared" ||
        report.runtime.status === "handed-off" ||
        (report.runtime.status === "running" && report.instances.length === 0);
      if (unobservable) {
        instances.push({ state: "unknown", launchMode: "unknown" });
      }
      for (const instance of report.instances) {
        instances.push({ state: instance.state, launchMode: instance.launchMode });
      }
    }
    return instances;
  }

  async acquireReservation(request: HmiReservationRequest): Promise<string | undefined> {
    const result = await this.runSerialized(() => this.adapter.acquireReservation(request));
    this.emitHealth();
    if (result.status === "disabled") {
      return undefined;
    }
    if (result.status === "granted" && result.reservationId) {
      this.pendingReservations.set(request.entryId, result.reservationId);
      return result.reservationId;
    }
    if (result.status === "conflict") {
      throw new HmiReservationDeniedError(
        result.reason ?? `Lifecycle reservation for '${request.entryId}' was refused.`,
      );
    }
    throw new HmiLifecycleUnavailableError(
      result.reason ??
        `Lifecycle reservation for '${request.entryId}' could not be acquired; constrained launch is fail-closed.`,
    );
  }

  async releasePendingReservation(entryId: string): Promise<void> {
    await this.runSerialized(() => this.releasePendingReservationExclusive(entryId));
  }

  private async releasePendingReservationExclusive(entryId: string): Promise<void> {
    const reservationId = this.pendingReservations.get(entryId);
    if (!reservationId) {
      return;
    }
    this.pendingReservations.delete(entryId);
    const result = await this.adapter.releaseReservation(reservationId);
    this.emitHealth();
    if (!resultSucceeded(result)) {
      this.scheduleRetry();
    }
  }

  health(): HmiApiHealth {
    return this.adapter.health();
  }

  private currentReports(): HmiLifecycleEntryReport[] {
    return buildHmiLifecycleReports(this.getSnapshot(), this.getProcessRecords());
  }

  private enqueue(operation: () => Promise<void>): void {
    void this.runSerialized(operation);
  }

  private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.catch(() => undefined).then(operation);
    this.pending = result.then(
      () => undefined,
      (error: unknown) => {
        this.onError?.(error);
        this.scheduleRetry();
      },
    );
    return result;
  }

  private async synchronize(snapshot: RuntimeSnapshot): Promise<void> {
    const reports = buildHmiLifecycleReports(snapshot, this.getProcessRecords());
    const currentIds = new Set(reports.map((report) => report.entryId));
    for (const report of reports) {
      const digest = JSON.stringify(report);
      const reservationId = this.pendingReservations.get(report.entryId);
      if (!activeReport(report)) {
        if (this.published.has(report.entryId) || reservationId) {
          const result = await this.adapter.deregister(report.entryId);
          this.emitHealth();
          if (resultSucceeded(result)) {
            this.published.delete(report.entryId);
            if (reservationId) {
              await this.releasePendingReservationExclusive(report.entryId);
            }
          } else if (
            result.httpStatus === 409 &&
            await this.recoverConflictWithHeartbeat()
          ) {
            return;
          } else {
            this.scheduleRetry();
          }
        }
        continue;
      }
      if (this.published.get(report.entryId) === digest && !reservationId) {
        continue;
      }
      const result = await this.adapter.register(report, reservationId);
      this.emitHealth();
      if (resultSucceeded(result)) {
        this.published.set(report.entryId, digest);
        if (reservationId) {
          this.pendingReservations.delete(report.entryId);
        }
        this.resetRetry();
      } else if (
        result.httpStatus === 409 &&
        await this.recoverConflictWithHeartbeat()
      ) {
        return;
      } else {
        this.scheduleRetry();
      }
    }

    for (const entryId of [...this.published.keys()]) {
      if (currentIds.has(entryId)) {
        continue;
      }
      const result = await this.adapter.deregister(entryId);
      this.emitHealth();
      if (resultSucceeded(result)) {
        this.published.delete(entryId);
      } else if (
        result.httpStatus === 409 &&
        await this.recoverConflictWithHeartbeat()
      ) {
        return;
      } else {
        this.scheduleRetry();
      }
    }
  }

  private async recoverConflictWithHeartbeat(): Promise<boolean> {
    await this.refresh();
    const reports = this.currentReports().filter(activeReport);
    const result = await this.adapter.heartbeat(reports);
    this.emitHealth();
    if (!resultSucceeded(result)) {
      return false;
    }
    this.published.clear();
    for (const report of reports) {
      this.published.set(report.entryId, JSON.stringify(report));
      this.pendingReservations.delete(report.entryId);
    }
    this.resetRetry();
    return true;
  }

  private scheduleRetry(): void {
    if (this.adapter.health().status === "disabled" || this.retryHandle !== undefined) {
      return;
    }
    const health = this.adapter.health();
    const baseDelay = health.status === "misconfigured"
      ? 30_000
      : RETRY_DELAYS_MS[Math.min(this.retryIndex, RETRY_DELAYS_MS.length - 1)]!;
    const delay = Math.round(baseDelay * (0.9 + this.random() * 0.2));
    if (health.status !== "misconfigured") {
      this.retryIndex = Math.min(this.retryIndex + 1, RETRY_DELAYS_MS.length - 1);
    }
    this.retryHandle = this.scheduler.setTimeout(async () => {
      this.retryHandle = undefined;
      try {
        await this.refresh();
        if (this.latestSnapshot) {
          this.observeSnapshot(this.latestSnapshot);
        } else {
          await this.heartbeat();
        }
      } catch (error) {
        this.onError?.(error);
        this.scheduleRetry();
      }
    }, delay);
  }

  private resetRetry(): void {
    this.retryIndex = 0;
    if (this.retryHandle !== undefined) {
      this.scheduler.clearTimeout(this.retryHandle);
      this.retryHandle = undefined;
    }
  }

  private emitHealth(): void {
    this.onHealthChange?.(this.adapter.health());
  }
}
