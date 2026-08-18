import { randomUUID } from "node:crypto";
import os from "node:os";
import type {
  HmiApiHealth,
  LaunchAccessMode,
  LocalHmiApiConfig,
  RuntimeItemState,
} from "../shared/types";

export const DEFAULT_HMI_API_REQUEST_TIMEOUT_MS = 2_000;
export const DEFAULT_HMI_API_HEARTBEAT_INTERVAL_MS = 5_000;
export const LOCAL_LIFECYCLE_SCHEMA_VERSION = 1;

export type HmiLifecycleInstanceReport = {
  instanceId: string;
  state: "running" | "stopped" | "unknown";
  launchMode: LaunchAccessMode;
  spawnedAt: string;
  lastSeenAt?: string;
};

export type HmiLifecycleEntryReport = {
  entryId: string;
  runtime: RuntimeItemState;
  instances: HmiLifecycleInstanceReport[];
};

export type HmiLifecycleRemoteEntry = {
  sessionId: string;
  stationId: string;
  report: HmiLifecycleEntryReport;
  leaseExpiresAt: string;
};

export type HmiApiOperationStatus =
  | "disabled"
  | "ok"
  | "unavailable"
  | "misconfigured";

export type HmiApiOperationResult = {
  status: HmiApiOperationStatus;
  reason?: string;
  httpStatus?: number;
  acceptedSequence?: number;
  serverTime?: string;
  leaseExpiresAt?: string;
};

export type HmiApiQueryResult = HmiApiOperationResult & {
  entries: HmiLifecycleRemoteEntry[];
};

export type HmiReservationRequest = {
  entryId: string;
  launchMode: LaunchAccessMode;
  maxInstances?: number;
  writeModeExclusive: boolean;
};

export type HmiReservationResult = {
  status:
    | "disabled"
    | "granted"
    | "conflict"
    | "unavailable"
    | "misconfigured";
  reason?: string;
  reservationId?: string;
  expiresAt?: string;
};

export interface HmiApiAdapter {
  readonly sessionId: string;
  readonly heartbeatIntervalMs: number;
  register(
    report: HmiLifecycleEntryReport,
    reservationId?: string,
  ): Promise<HmiApiOperationResult>;
  heartbeat(reports: HmiLifecycleEntryReport[]): Promise<HmiApiOperationResult>;
  deregister(entryId: string): Promise<HmiApiOperationResult>;
  query(entryId?: string): Promise<HmiApiQueryResult>;
  acquireReservation(request: HmiReservationRequest): Promise<HmiReservationResult>;
  releaseReservation(reservationId: string): Promise<HmiApiOperationResult>;
  health(): HmiApiHealth;
}

const DISABLED_REASON =
  "The local lifecycle API is not configured; no request was sent. This does not report site lifecycle registration success.";

function disabledOperation(): HmiApiOperationResult {
  return { status: "disabled", reason: DISABLED_REASON };
}

export class NoopHmiApiAdapter implements HmiApiAdapter {
  readonly sessionId: string;
  readonly heartbeatIntervalMs = DEFAULT_HMI_API_HEARTBEAT_INTERVAL_MS;

  constructor(sessionId: string = randomUUID()) {
    this.sessionId = sessionId;
  }

  async register(
    _report: HmiLifecycleEntryReport,
    _reservationId?: string,
  ): Promise<HmiApiOperationResult> {
    return disabledOperation();
  }

  async heartbeat(_reports: HmiLifecycleEntryReport[]): Promise<HmiApiOperationResult> {
    return disabledOperation();
  }

  async deregister(_entryId: string): Promise<HmiApiOperationResult> {
    return disabledOperation();
  }

  async query(_entryId?: string): Promise<HmiApiQueryResult> {
    return { ...disabledOperation(), entries: [] };
  }

  async acquireReservation(_request: HmiReservationRequest): Promise<HmiReservationResult> {
    return { status: "disabled", reason: DISABLED_REASON };
  }

  async releaseReservation(_reservationId: string): Promise<HmiApiOperationResult> {
    return disabledOperation();
  }

  health(): HmiApiHealth {
    return { status: "disabled", reason: DISABLED_REASON };
  }
}

type CommonRequest = {
  schemaVersion: typeof LOCAL_LIFECYCLE_SCHEMA_VERSION;
  stationId: string;
  operationId: string;
  sequence: number;
};

type HttpAdapterDependencies = {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  operationId?: () => string;
  now?: () => number;
};

type JsonResponse = {
  status: number;
  body?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRemoteEntry(value: unknown): value is HmiLifecycleRemoteEntry {
  if (!isObject(value) || !isObject(value["report"])) {
    return false;
  }
  const report = value["report"];
  if (!isObject(report["runtime"]) || !Array.isArray(report["instances"])) {
    return false;
  }
  const runtime = report["runtime"];
  if (
    typeof value["sessionId"] !== "string" ||
    typeof value["stationId"] !== "string" ||
    typeof value["leaseExpiresAt"] !== "string" ||
    typeof report["entryId"] !== "string" ||
    runtime["id"] !== report["entryId"] ||
    typeof runtime["status"] !== "string" ||
    typeof runtime["stale"] !== "boolean"
  ) {
    return false;
  }
  return report["instances"].every(
    (instance) =>
      isObject(instance) &&
      typeof instance["instanceId"] === "string" &&
      ["running", "stopped", "unknown"].includes(String(instance["state"])) &&
      ["read", "write", "unknown"].includes(String(instance["launchMode"])) &&
      typeof instance["spawnedAt"] === "string",
  );
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function parseBaseUrl(value: string, allowInsecureTransport = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("`local.hmiApi.baseUrl` must be an absolute HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("`local.hmiApi.baseUrl` must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("`local.hmiApi.baseUrl` must not contain credentials; use authTokenEnv.");
  }
  if (url.search) {
    throw new Error("`local.hmiApi.baseUrl` must not contain a query string.");
  }
  if (url.hash) {
    throw new Error("`local.hmiApi.baseUrl` must not contain a fragment.");
  }
  // Plain HTTP to a non-loopback host is refused unless the config explicitly
  // opts in. The opt-in is set automatically when the config repo's `hmi-server`
  // key gives a bare `host:port`, which reads as a trusted site LAN; setting
  // `local.hmiApi.allowInsecureTransport: false` forces the strict rule back on.
  if (!isLoopbackHost(url.hostname) && url.protocol !== "https:" && !allowInsecureTransport) {
    throw new Error(
      "A non-loopback `local.hmiApi.baseUrl` must use HTTPS, or set " +
        "`local.hmiApi.allowInsecureTransport: true` for a trusted site network. " +
        "Remedy: give `hmi-server` a full `https://…` URL in the config repo, or accept plain " +
        "HTTP explicitly.",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function responseReason(body: unknown, fallback: string): string {
  if (!isObject(body)) {
    return fallback;
  }
  const detail = body["detail"];
  if (typeof detail === "string" && detail.trim()) {
    return detail;
  }
  if (isObject(detail)) {
    const message = optionalString(detail["message"]);
    if (message) {
      return message;
    }
  }
  return optionalString(body["message"]) ?? fallback;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export class HttpHmiApiAdapter implements HmiApiAdapter {
  readonly sessionId: string;
  readonly heartbeatIntervalMs: number;

  private readonly baseUrl: URL;
  private readonly stationId: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly nextOperationId: () => string;
  private readonly now: () => number;
  private readonly pendingOperations = new Map<string, CommonRequest>();
  private sequence = 0;
  private currentHealth: HmiApiHealth = {
    status: "unavailable",
    reason: "The configured local lifecycle API has not been contacted yet.",
  };

  constructor(config: Required<Pick<LocalHmiApiConfig, "baseUrl">> & LocalHmiApiConfig, dependencies: HttpAdapterDependencies = {}) {
    this.baseUrl = parseBaseUrl(config.baseUrl, config.allowInsecureTransport === true);
    this.stationId = config.stationId?.trim() || os.hostname();
    this.timeoutMs = config.requestTimeoutMs ?? DEFAULT_HMI_API_REQUEST_TIMEOUT_MS;
    this.heartbeatIntervalMs =
      config.heartbeatIntervalMs ?? DEFAULT_HMI_API_HEARTBEAT_INTERVAL_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("`local.hmiApi.requestTimeoutMs` must be a positive integer.");
    }
    if (!Number.isInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs < 1) {
      throw new Error("`local.hmiApi.heartbeatIntervalMs` must be a positive integer.");
    }

    const env = dependencies.env ?? process.env;
    const tokenEnv = config.authTokenEnv?.trim();
    const remote = !isLoopbackHost(this.baseUrl.hostname);
    const insecure = config.allowInsecureTransport === true;

    // A bearer token must never leave the machine in cleartext. This holds even
    // with the insecure-transport opt-in: that opt-in exists for a service with
    // no credential to protect, not as a way to weaken one that has.
    if (tokenEnv && this.baseUrl.protocol === "http:" && !isLoopbackHost(this.baseUrl.hostname)) {
      throw new Error(
        "`local.hmiApi.authTokenEnv` cannot be used with a plain-HTTP, non-loopback " +
          "`local.hmiApi.baseUrl`: the token would be sent in cleartext. " +
          "Remedy: use an `https://` URL, or remove `authTokenEnv` if the service needs no token.",
      );
    }
    // A remote API normally has to authenticate. The opt-in also covers a site
    // service that has no auth at all, which is what a bare `host:port` implies.
    if (remote && !tokenEnv && !insecure) {
      throw new Error("A remote lifecycle API requires `local.hmiApi.authTokenEnv`.");
    }
    if (tokenEnv) {
      const value = env[tokenEnv];
      if (!value) {
        throw new Error(
          `Lifecycle API token environment variable '${tokenEnv}' is not set or is empty.`,
        );
      }
      this.token = value;
    }

    this.fetchImplementation = dependencies.fetch ?? fetch;
    this.sessionId = dependencies.sessionId ?? randomUUID();
    this.nextOperationId = dependencies.operationId ?? (() => randomUUID());
    this.now = dependencies.now ?? Date.now;
  }

  async register(
    report: HmiLifecycleEntryReport,
    reservationId?: string,
  ): Promise<HmiApiOperationResult> {
    const operationKey = `register:${report.entryId}:${JSON.stringify({ report, reservationId })}`;
    const body = {
      ...this.operationFor(operationKey, `register:${report.entryId}:`),
      report,
      ...(reservationId ? { reservationId } : {}),
    };
    const response = await this.request(
      "PUT",
      `/sessions/${encodeURIComponent(this.sessionId)}/entries/${encodeURIComponent(report.entryId)}`,
      body,
    );
    const result = this.operationResult(response, "register lifecycle state");
    this.finishOperation(operationKey, result.status);
    return result;
  }

  async heartbeat(reports: HmiLifecycleEntryReport[]): Promise<HmiApiOperationResult> {
    const operationKey = `heartbeat:${JSON.stringify(reports)}`;
    const response = await this.request(
      "POST",
      `/sessions/${encodeURIComponent(this.sessionId)}/heartbeat`,
      { ...this.operationFor(operationKey, "heartbeat:"), reports },
    );
    const result = this.operationResult(response, "send lifecycle heartbeat");
    this.finishOperation(operationKey, result.status);
    return result;
  }

  async deregister(entryId: string): Promise<HmiApiOperationResult> {
    for (const key of this.pendingOperations.keys()) {
      if (key.startsWith(`register:${entryId}:`)) {
        this.pendingOperations.delete(key);
      }
    }
    const operationKey = `deregister:${entryId}`;
    const operation = this.operationFor(operationKey, `deregister:${entryId}`);
    const query = new URLSearchParams({
      sequence: String(operation.sequence),
      operationId: operation.operationId,
      stationId: operation.stationId,
      schemaVersion: String(operation.schemaVersion),
    });
    const response = await this.request(
      "DELETE",
      `/sessions/${encodeURIComponent(this.sessionId)}/entries/${encodeURIComponent(entryId)}?${query}`,
    );
    const result = this.operationResult(response, "deregister lifecycle state");
    this.finishOperation(operationKey, result.status);
    return result;
  }

  async query(entryId?: string): Promise<HmiApiQueryResult> {
    const query = new URLSearchParams({ excludeSessionId: this.sessionId });
    if (entryId) {
      query.set("entryId", entryId);
    }
    const response = await this.request("GET", `/entries?${query}`);
    const operation = this.operationResult(response, "query lifecycle state");
    if (operation.status !== "ok" || !isObject(response.body)) {
      return { ...operation, entries: [] };
    }
    const rawEntries = response.body["entries"];
    if (!Array.isArray(rawEntries) || !rawEntries.every(isRemoteEntry)) {
      const reason = "Lifecycle query response does not match the local version-1 entry schema.";
      this.currentHealth = {
        status: "misconfigured",
        reason,
        ...(this.currentHealth.lastSuccessAt
          ? { lastSuccessAt: this.currentHealth.lastSuccessAt }
          : {}),
      };
      return { status: "misconfigured", reason, entries: [] };
    }
    const entries = rawEntries.filter((entry) => entry.sessionId !== this.sessionId);
    return { ...operation, entries };
  }

  async acquireReservation(request: HmiReservationRequest): Promise<HmiReservationResult> {
    const operationKey = `reservation:${request.entryId}:${JSON.stringify(request)}`;
    const response = await this.request("POST", "/reservations", {
      ...this.operationFor(operationKey, `reservation:${request.entryId}:`),
      sessionId: this.sessionId,
      entryId: request.entryId,
      launchMode: request.launchMode,
      maxInstances: request.maxInstances ?? null,
      writeModeExclusive: request.writeModeExclusive,
    });
    if (response.status === 409) {
      this.pendingOperations.delete(operationKey);
      return {
        status: "conflict",
        reason: responseReason(response.body, "The lifecycle service refused the launch reservation."),
      };
    }
    const operation = this.operationResult(response, "acquire launch reservation");
    if (operation.status !== "ok" || !isObject(response.body)) {
      const status = operation.status === "ok" ? "misconfigured" : operation.status;
      this.finishOperation(operationKey, status);
      return { status, ...(operation.reason ? { reason: operation.reason } : {}) };
    }
    const reservationId = optionalString(response.body["reservationId"]);
    const expiresAt = optionalString(response.body["expiresAt"]);
    if (!reservationId || !expiresAt) {
      const reason = "Lifecycle reservation response omitted reservationId or expiresAt.";
      this.currentHealth = { status: "misconfigured", reason };
      this.pendingOperations.delete(operationKey);
      return { status: "misconfigured", reason };
    }
    this.pendingOperations.delete(operationKey);
    return { status: "granted", reservationId, expiresAt };
  }

  async releaseReservation(reservationId: string): Promise<HmiApiOperationResult> {
    const operationKey = `release:${reservationId}`;
    const operation = this.operationFor(operationKey, operationKey);
    const query = new URLSearchParams({ operationId: operation.operationId });
    const response = await this.request(
      "DELETE",
      `/reservations/${encodeURIComponent(reservationId)}?${query}`,
    );
    const result = this.operationResult(response, "release launch reservation");
    this.finishOperation(operationKey, result.status);
    return result;
  }

  health(): HmiApiHealth {
    return { ...this.currentHealth };
  }

  private commonRequest(): CommonRequest {
    return {
      schemaVersion: LOCAL_LIFECYCLE_SCHEMA_VERSION,
      stationId: this.stationId,
      operationId: this.nextOperationId(),
      sequence: ++this.sequence,
    };
  }

  private operationFor(key: string, supersedePrefix: string): CommonRequest {
    const existing = this.pendingOperations.get(key);
    if (existing) {
      return existing;
    }
    for (const pendingKey of this.pendingOperations.keys()) {
      if (pendingKey.startsWith(supersedePrefix)) {
        this.pendingOperations.delete(pendingKey);
      }
    }
    const operation = this.commonRequest();
    this.pendingOperations.set(key, operation);
    return operation;
  }

  private finishOperation(key: string, status: HmiApiOperationStatus): void {
    if (status !== "unavailable") {
      this.pendingOperations.delete(key);
    }
  }

  private async request(method: string, relativeUrl: string, body?: unknown): Promise<JsonResponse> {
    const url = new URL(relativeUrl.replace(/^\/+/, ""), `${this.baseUrl.toString()}/`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
      }
      if (this.token) {
        headers["authorization"] = `Bearer ${this.token}`;
      }
      const response = await this.fetchImplementation(url, {
        method,
        headers,
        signal: controller.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      let parsed: unknown;
      const text = await response.text();
      if (text) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = undefined;
        }
      }
      return { status: response.status, ...(parsed !== undefined ? { body: parsed } : {}) };
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? `Lifecycle API request timed out after ${this.timeoutMs} ms.`
          : `Lifecycle API request failed: ${error instanceof Error ? error.message : String(error)}`;
      this.currentHealth = {
        status: "unavailable",
        reason: message,
        ...(this.currentHealth.lastSuccessAt
          ? { lastSuccessAt: this.currentHealth.lastSuccessAt }
          : {}),
      };
      return { status: 0, body: { message } };
    } finally {
      clearTimeout(timer);
    }
  }

  private operationResult(response: JsonResponse, action: string): HmiApiOperationResult {
    if (response.status >= 200 && response.status < 300) {
      const body = isObject(response.body) ? response.body : {};
      const serverTime = optionalString(body["serverTime"]);
      const lastSuccessAt = serverTime ?? new Date(this.now()).toISOString();
      this.currentHealth = { status: "connected", lastSuccessAt };
      return {
        status: "ok",
        ...(optionalNumber(body["acceptedSequence"]) !== undefined
          ? { acceptedSequence: optionalNumber(body["acceptedSequence"]) }
          : {}),
        ...(serverTime ? { serverTime } : {}),
        ...(optionalString(body["leaseExpiresAt"])
          ? { leaseExpiresAt: optionalString(body["leaseExpiresAt"]) }
          : {}),
      };
    }

    const fallback = response.status === 0
      ? `Unable to ${action}: lifecycle service is unavailable.`
      : `Unable to ${action}: lifecycle service returned HTTP ${response.status}.`;
    const reason = responseReason(response.body, fallback);
    const status = response.status === 0 || isRetryableStatus(response.status)
      ? "unavailable"
      : "misconfigured";
    this.currentHealth = { status, reason, ...(this.currentHealth.lastSuccessAt ? { lastSuccessAt: this.currentHealth.lastSuccessAt } : {}) };
    return {
      status,
      reason,
      ...(response.status > 0 ? { httpStatus: response.status } : {}),
    };
  }
}

export function createHmiApiAdapter(
  config: LocalHmiApiConfig,
  dependencies: HttpAdapterDependencies = {},
): HmiApiAdapter {
  if (!config.baseUrl?.trim()) {
    return new NoopHmiApiAdapter(dependencies.sessionId);
  }
  return new HttpHmiApiAdapter(
    { ...config, baseUrl: config.baseUrl },
    dependencies,
  );
}
