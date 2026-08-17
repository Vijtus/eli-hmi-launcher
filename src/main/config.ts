// Pure configuration layer: YAML parsing, schema validation, security-policy
// resolution, variable expansion, path resolution, and process-command
// allow-list enforcement.
//
// This module intentionally imports ONLY `yaml` and Node built-ins. It must not
// import `electron`, so it can be exercised by `npm run validate-config`
// (via tsx) and by unit harnesses without spinning up a browser window.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type {
  CatalogSourceStatus,
  CatalogStatus,
  LaunchAccessPolicy,
  LaunchAccessPolicyOverride,
  LaunchTarget,
  LauncherAction,
  LauncherRow,
  LocalMachineConfig,
  ProcessLaunchTarget,
  ProcessTargetOptions,
  SecurityPolicy,
} from "../shared/types";
import { resolveLaunchAccessPolicy } from "./access-policy";

type RawObject = Record<string, unknown>;

export type LaunchContext = {
  appRoot: string;
  configDir: string;
  security: SecurityPolicy;
  local: LocalMachineConfig;
};

export type ConfigItemScope = {
  id: string;
  kind: LaunchTarget["kind"];
  group: "entry" | "quick action" | "more action";
  field?: string;
};

export type ConfiguredRow = LauncherRow & {
  target: LaunchTarget;
  access?: LaunchAccessPolicyOverride;
};
export type ConfiguredAction = LauncherAction & {
  target: LaunchTarget;
  access?: LaunchAccessPolicyOverride;
};

export type ParsedConfig = {
  appName: string;
  rows: LauncherRow[];
  quickActions: LauncherAction[];
  moreActions: LauncherAction[];
  targetsById: Map<string, LaunchTarget>;
  labelsById: Map<string, string>;
  accessPoliciesById: Map<string, LaunchAccessPolicy>;
  context: LaunchContext;
  catalogStatus: CatalogStatus;
};

export type ConfigLoadBase = {
  appRoot: string;
  configDir: string;
  catalogCacheDir?: string;
};

export const DEFAULT_APP_NAME = "L4 Launcher";

// ---------------------------------------------------------------------------
// Small readers / coercers (tolerant, since the config is hand-edited YAML).
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is RawObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  return fallback;
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "yes", "on", "1"].includes(v)) {
      return true;
    }
    if (["false", "no", "off", "0"].includes(v)) {
      return false;
    }
  }
  return fallback;
}

function readOptionalBool(value: unknown, key: string): boolean | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "on", "1"].includes(normalized)) {
      return true;
    }
    if (["false", "no", "off", "0"].includes(normalized)) {
      return false;
    }
  }
  throw new Error(`\`${key}\` must be a boolean.`);
}

function readStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => readStringList(item))
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  const text = readText(value);
  if (!text || text === "--") {
    return [];
  }
  return text
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readArgs(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  const text = readText(value);
  return text ? [text] : undefined;
}

function readEnv(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const stringValue = readText(rawValue);
    if (key && stringValue) {
      env[key] = stringValue;
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function makeGeneratedId(prefix: string, index: number, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug ? `${prefix}-${slug}` : `${prefix}-${index + 1}`;
}

function emptyLocalMachineConfig(): LocalMachineConfig {
  return { phoebus: {}, hosts: {}, hmiApi: {}, monitoring: {} };
}

function readOptionalText(value: unknown): string | undefined {
  const text = readText(value);
  return text ? text : undefined;
}

function readOptionalPort(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null || readText(value) === "") {
    return undefined;
  }
  const port = typeof value === "number" ? value : Number(readText(value));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`\`${key}\` must be an integer from 1 to 65535.`);
  }
  return port;
}

function readOptionalPositiveInteger(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null || readText(value) === "") {
    return undefined;
  }
  const number = typeof value === "number" ? value : Number(readText(value));
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`\`${key}\` must be a positive integer.`);
  }
  return number;
}

function readOptionalEnum<T extends string>(
  value: unknown,
  key: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null || readText(value) === "") {
    return undefined;
  }
  const normalized = readText(value).toLowerCase();
  const match = allowed.find((candidate) => candidate === normalized);
  if (!match) {
    throw new Error(`\`${key}\` must be one of: ${allowed.join(", ")}.`);
  }
  return match;
}

function parseAccessPolicyOverride(
  value: unknown,
  context: string,
): LaunchAccessPolicyOverride | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new Error(`\`${context}\` must be a YAML mapping when provided.`);
  }

  let maxInstances: number | null | undefined;
  if (Object.prototype.hasOwnProperty.call(value, "maxInstances")) {
    if (value["maxInstances"] === null) {
      maxInstances = null;
    } else {
      maxInstances = readOptionalPositiveInteger(
        value["maxInstances"],
        `${context}.maxInstances`,
      );
    }
  }
  const writeModeExclusive = readOptionalBool(
    value["writeModeExclusive"],
    `${context}.writeModeExclusive`,
  );
  const launchMode = readOptionalEnum(
    value["launchMode"],
    `${context}.launchMode`,
    ["read", "write", "unknown"] as const,
  );
  const onAlreadyRunning = readOptionalEnum(
    value["onAlreadyRunning"],
    `${context}.onAlreadyRunning`,
    ["block", "focus", "prompt"] as const,
  );
  const onUnknownState = readOptionalEnum(
    value["onUnknownState"],
    `${context}.onUnknownState`,
    ["block", "allow"] as const,
  );

  const policy: LaunchAccessPolicyOverride = {
    ...(maxInstances !== undefined ? { maxInstances } : {}),
    ...(writeModeExclusive !== undefined ? { writeModeExclusive } : {}),
    ...(launchMode !== undefined ? { launchMode } : {}),
    ...(onAlreadyRunning !== undefined ? { onAlreadyRunning } : {}),
    ...(onUnknownState !== undefined ? { onUnknownState } : {}),
  };
  return Object.keys(policy).length > 0 ? policy : undefined;
}

function parsePlatformAccessPolicies(value: unknown): Map<string, LaunchAccessPolicyOverride> {
  if (value === undefined || value === null) {
    return new Map();
  }
  if (!isObject(value)) {
    throw new Error("`access` must be a YAML mapping when provided.");
  }
  const platformsValue = value["platforms"];
  if (platformsValue === undefined || platformsValue === null) {
    return new Map();
  }
  if (!isObject(platformsValue)) {
    throw new Error("`access.platforms` must be a YAML mapping when provided.");
  }
  const policies = new Map<string, LaunchAccessPolicyOverride>();
  for (const [platform, rawPolicy] of Object.entries(platformsValue)) {
    const normalized = platform.trim().toLowerCase();
    if (!normalized) {
      throw new Error("`access.platforms` contains an empty platform name.");
    }
    if (policies.has(normalized)) {
      throw new Error(`Duplicate access platform policy '${platform}' (case-insensitive).`);
    }
    const policy = parseAccessPolicyOverride(
      rawPolicy,
      `access.platforms.${platform}`,
    );
    if (policy) {
      policies.set(normalized, policy);
    }
  }
  return policies;
}

function parseLocalMachineConfig(value: unknown): LocalMachineConfig {
  if (value === undefined || value === null) {
    return emptyLocalMachineConfig();
  }
  if (!isObject(value)) {
    throw new Error("`local` must be a YAML mapping when provided.");
  }

  const phoebusRaw = value["phoebus"];
  if (phoebusRaw !== undefined && !isObject(phoebusRaw)) {
    throw new Error("`local.phoebus` must be a YAML mapping when provided.");
  }
  const phoebus = isObject(phoebusRaw) ? phoebusRaw : {};

  const hostsRaw = value["hosts"];
  if (hostsRaw !== undefined && !isObject(hostsRaw)) {
    throw new Error("`local.hosts` must be a YAML mapping of name to host/IP when provided.");
  }
  const hosts: Record<string, string> = {};
  if (isObject(hostsRaw)) {
    for (const [name, rawHost] of Object.entries(hostsRaw)) {
      const host = readText(rawHost);
      if (!host) {
        throw new Error(`\`local.hosts.${name}\` must be a non-empty string.`);
      }
      hosts[name] = host;
    }
  }

  const hmiApiRaw = value["hmiApi"];
  if (hmiApiRaw !== undefined && !isObject(hmiApiRaw)) {
    throw new Error("`local.hmiApi` must be a YAML mapping when provided.");
  }
  const hmiApi = isObject(hmiApiRaw) ? hmiApiRaw : {};

  const monitoringRaw = value["monitoring"];
  if (monitoringRaw !== undefined && !isObject(monitoringRaw)) {
    throw new Error("`local.monitoring` must be a YAML mapping when provided.");
  }
  const monitoring = isObject(monitoringRaw) ? monitoringRaw : {};

  return {
    ...(readOptionalText(value["workspaceRoot"]) ? { workspaceRoot: readOptionalText(value["workspaceRoot"]) } : {}),
    ...(readOptionalText(value["cssGuiRoot"]) ? { cssGuiRoot: readOptionalText(value["cssGuiRoot"]) } : {}),
    ...(readOptionalText(value["zoneSymbol"]) ? { zoneSymbol: readOptionalText(value["zoneSymbol"]) } : {}),
    phoebus: {
      ...(readOptionalText(phoebus["executable"])
        ? { executable: readOptionalText(phoebus["executable"]) }
        : {}),
      ...(readOptionalPort(phoebus["serverPort"], "local.phoebus.serverPort") !== undefined
        ? { serverPort: readOptionalPort(phoebus["serverPort"], "local.phoebus.serverPort") }
        : {}),
      ...(readOptionalText(phoebus["settingsFile"])
        ? { settingsFile: readOptionalText(phoebus["settingsFile"]) }
        : {}),
      ...(readOptionalText(phoebus["layoutFile"])
        ? { layoutFile: readOptionalText(phoebus["layoutFile"]) }
        : {}),
      ...(readOptionalPositiveInteger(phoebus["startupTimeoutMs"], "local.phoebus.startupTimeoutMs") !==
      undefined
        ? {
            startupTimeoutMs: readOptionalPositiveInteger(
              phoebus["startupTimeoutMs"],
              "local.phoebus.startupTimeoutMs",
            ),
          }
        : {}),
      ...(readOptionalPositiveInteger(
        phoebus["resourceReadyDelayMs"],
        "local.phoebus.resourceReadyDelayMs",
      ) !== undefined
        ? {
            resourceReadyDelayMs: readOptionalPositiveInteger(
              phoebus["resourceReadyDelayMs"],
              "local.phoebus.resourceReadyDelayMs",
            ),
          }
        : {}),
    },
    hosts,
    hmiApi: {
      ...(readOptionalText(hmiApi["baseUrl"]) ? { baseUrl: readOptionalText(hmiApi["baseUrl"]) } : {}),
      ...(readOptionalText(hmiApi["stationId"])
        ? { stationId: readOptionalText(hmiApi["stationId"]) }
        : {}),
      ...(readOptionalText(hmiApi["authTokenEnv"])
        ? { authTokenEnv: readOptionalText(hmiApi["authTokenEnv"]) }
        : {}),
      ...(readOptionalPositiveInteger(
        hmiApi["requestTimeoutMs"],
        "local.hmiApi.requestTimeoutMs",
      ) !== undefined
        ? {
            requestTimeoutMs: readOptionalPositiveInteger(
              hmiApi["requestTimeoutMs"],
              "local.hmiApi.requestTimeoutMs",
            ),
          }
        : {}),
      ...(readOptionalPositiveInteger(
        hmiApi["heartbeatIntervalMs"],
        "local.hmiApi.heartbeatIntervalMs",
      ) !== undefined
        ? {
            heartbeatIntervalMs: readOptionalPositiveInteger(
              hmiApi["heartbeatIntervalMs"],
              "local.hmiApi.heartbeatIntervalMs",
            ),
          }
        : {}),
    },
    monitoring: {
      ...(readOptionalPositiveInteger(
        monitoring["reconcileIntervalMs"],
        "local.monitoring.reconcileIntervalMs",
      ) !== undefined
        ? {
            reconcileIntervalMs: readOptionalPositiveInteger(
              monitoring["reconcileIntervalMs"],
              "local.monitoring.reconcileIntervalMs",
            ),
          }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Variable expansion and path resolution.
// ---------------------------------------------------------------------------

function getVariableMap(context: LaunchContext): Record<string, string | undefined> {
  const variables: Record<string, string | undefined> = {
    APP_ROOT: context.appRoot,
    CONFIG_DIR: context.configDir,
    HOME: process.env["HOME"] ?? "",
    USERPROFILE: process.env["USERPROFILE"] ?? "",
    TEMP: process.env["TEMP"] ?? process.env["TMP"] ?? process.env["TMPDIR"] ?? "",
    TMP: process.env["TMP"] ?? process.env["TEMP"] ?? process.env["TMPDIR"] ?? "",
    TMPDIR: process.env["TMPDIR"] ?? process.env["TEMP"] ?? process.env["TMP"] ?? "",
    "local.workspaceRoot": context.local.workspaceRoot,
    "local.cssGuiRoot": context.local.cssGuiRoot,
    "local.zoneSymbol": context.local.zoneSymbol,
    "local.phoebus.executable": context.local.phoebus.executable,
    "local.phoebus.serverPort": context.local.phoebus.serverPort?.toString(),
    "local.phoebus.settingsFile": context.local.phoebus.settingsFile,
    "local.phoebus.layoutFile": context.local.phoebus.layoutFile,
    "local.phoebus.startupTimeoutMs": context.local.phoebus.startupTimeoutMs?.toString(),
    "local.phoebus.resourceReadyDelayMs": context.local.phoebus.resourceReadyDelayMs?.toString(),
    "local.hmiApi.baseUrl": context.local.hmiApi.baseUrl,
    "local.hmiApi.stationId": context.local.hmiApi.stationId,
    "local.hmiApi.authTokenEnv": context.local.hmiApi.authTokenEnv,
    "local.hmiApi.requestTimeoutMs": context.local.hmiApi.requestTimeoutMs?.toString(),
    "local.hmiApi.heartbeatIntervalMs": context.local.hmiApi.heartbeatIntervalMs?.toString(),
    "local.monitoring.reconcileIntervalMs": context.local.monitoring.reconcileIntervalMs?.toString(),
  };
  for (const [name, value] of Object.entries(context.local.hosts)) {
    variables[`local.hosts.${name}`] = value;
  }
  return variables;
}

function missingLocalSettingMessage(name: string, scope?: ConfigItemScope): string {
  if (!scope) {
    return `\`${name}\` is required because the configuration references it.`;
  }
  const field = scope.field ? ` in \`${scope.field}\`` : "";
  return (
    `\`${name}\` is required because ${scope.group} \`${scope.id}\` ` +
    `uses \`kind: ${scope.kind}\`${field}.`
  );
}

class MissingLocalSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingLocalSettingError";
  }
}

export function expandConfiguredString(
  value: string,
  context: LaunchContext,
  scope?: ConfigItemScope,
): string {
  const variables = getVariableMap(context);
  const expandVariable = (match: string, name: string): string => {
    if (name.startsWith("local.")) {
      const configured = variables[name];
      if (configured === undefined || configured === "") {
        throw new MissingLocalSettingError(missingLocalSettingMessage(name, scope));
      }
      return configured;
    }
    const upperName = name.toUpperCase();
    return variables[name] ?? variables[upperName] ?? process.env[name] ?? process.env[upperName] ?? match;
  };
  let expanded = value;
  // Multiple passes allow a local value such as `${HOME}/workspace` to be
  // referenced from another configured string without leaving nested tokens.
  for (let pass = 0; pass < 10; pass += 1) {
    const next = expanded
      .replace(/\$\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g, expandVariable)
      .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, expandVariable);
    if (next === expanded) {
      return next;
    }
    expanded = next;
  }
  throw new Error(`Variable expansion did not converge for '${value}' (possible reference cycle).`);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.includes("\\") || value.startsWith(".");
}

export function resolveConfiguredPath(
  value: string,
  context: LaunchContext,
  scope?: ConfigItemScope,
): string {
  const expanded = expandConfiguredString(value, context, scope);
  if (!expanded || path.isAbsolute(expanded) || isWindowsAbsolutePath(expanded)) {
    return expanded;
  }
  // A bare command name (no separators) is left as-is so it resolves via PATH.
  if (!looksLikePath(expanded)) {
    return expanded;
  }
  // A relative path is resolved against the config directory (never the CWD),
  // so behaviour does not depend on where the launcher was started from.
  return path.resolve(context.configDir, expanded);
}

// ---------------------------------------------------------------------------
// Target parsing + schema validation.
// ---------------------------------------------------------------------------

function parseProcessOptions(rawValue: unknown): ProcessTargetOptions | undefined {
  if (!isObject(rawValue)) {
    return undefined;
  }
  const command = readText(rawValue["command"]);
  const args = readArgs(rawValue["args"]);
  const cwd = readText(rawValue["cwd"]);
  const env = readEnv(rawValue["env"]);
  const options: ProcessTargetOptions = {};
  if (command) {
    options.command = command;
  }
  if (args) {
    options.args = args;
  }
  if (cwd) {
    options.cwd = cwd;
  }
  if (env) {
    options.env = env;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

function parseTarget(rawValue: unknown, context: string): LaunchTarget {
  if (!isObject(rawValue)) {
    throw new Error(`${context} is missing a target object.`);
  }
  const kind = readText(rawValue["kind"]).toLowerCase();

  if (kind === "web") {
    const url = readText(rawValue["url"]);
    if (!url) {
      throw new Error(`${context} has a web target without url.`);
    }
    return { kind: "web", url };
  }

  if (kind === "process") {
    const command = readText(rawValue["command"]);
    if (!command) {
      throw new Error(`${context} has a process target without command.`);
    }
    const args = readArgs(rawValue["args"]);
    const cwd = readText(rawValue["cwd"]);
    const env = readEnv(rawValue["env"]);
    const windows = parseProcessOptions(rawValue["windows"]);
    const linux = parseProcessOptions(rawValue["linux"]);
    const darwin = parseProcessOptions(rawValue["darwin"]);
    return {
      kind: "process",
      command,
      ...(args ? { args } : {}),
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
      ...(windows ? { windows } : {}),
      ...(linux ? { linux } : {}),
      ...(darwin ? { darwin } : {}),
    };
  }

  if (kind === "labview-dev") {
    const iocName = readText(rawValue["iocName"]);
    const hostName = readText(rawValue["hostName"]);
    const iocType = readText(rawValue["iocType"]);
    const exeName = readText(rawValue["exeName"]);
    const missing = [
      ["iocName", "IOC name", iocName],
      ["hostName", "host name", hostName],
      ["iocType", "IOC type", iocType],
      ["exeName", "EXE name", exeName],
    ].find(([, , value]) => !value);
    if (missing) {
      throw new Error(
        `${context} has a labview-dev target without ${missing[1]} (\`${missing[0]}\`).`,
      );
    }
    return { kind: "labview-dev", iocName, hostName, iocType, exeName };
  }

  if (kind === "labview-epics") {
    const guiName = readText(rawValue["guiName"]);
    const guiType = readText(rawValue["guiType"]);
    const exeName = readText(rawValue["exeName"]);
    const missing = [
      ["guiName", "GUI name", guiName],
      ["guiType", "GUI type", guiType],
      ["exeName", "EXE name", exeName],
    ].find(([, , value]) => !value);
    if (missing) {
      throw new Error(
        `${context} has a labview-epics target without ${missing[1]} (\`${missing[0]}\`).`,
      );
    }
    return { kind: "labview-epics", guiName, guiType, exeName };
  }

  if (kind === "phoebus") {
    const resource = readText(rawValue["resource"]);
    const app = readText(rawValue["app"]);
    const layout = readOptionalBool(rawValue["layout"], `${context}.target.layout`) ?? false;
    if (app && !resource) {
      throw new Error(`${context} has a phoebus target with app but no resource.`);
    }
    return {
      kind: "phoebus",
      ...(resource ? { resource } : {}),
      ...(app ? { app } : {}),
      ...(layout ? { layout: true } : {}),
    };
  }

  if (kind === "folder") {
    const folderPath = readText(rawValue["path"]);
    if (!folderPath) {
      throw new Error(`${context} has a folder target without path.`);
    }
    return { kind: "folder", path: folderPath };
  }

  throw new Error(`${context} has unsupported target kind '${kind || "<empty>"}'.`);
}

function parseRows(value: unknown): ConfiguredRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item, index) => {
    if (!isObject(item)) {
      throw new Error(`Entry ${index + 1} is not an object.`);
    }
    const name = readText(item["name"], readText(item["label"], `Entry ${index + 1}`));
    const id = readText(item["id"], makeGeneratedId("entry", index, name));
    const access = parseAccessPolicyOverride(item["access"], `entries.${id}.access`);
    return {
      id,
      name,
      technology: readStringList(item["technology"] ?? item["type"]),
      section: readStringList(item["section"]),
      platform: readText(item["platform"] ?? item["guiType"], "--"),
      rmc: readText(item["rmc"], "--"),
      note: readText(item["note"], "--"),
      target: parseTarget(item["target"], `Entry '${name}'`),
      ...(access ? { access } : {}),
    };
  });
}

function parseActions(value: unknown, groupName: string): ConfiguredAction[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item, index) => {
    if (!isObject(item)) {
      throw new Error(`${groupName} action ${index + 1} is not an object.`);
    }
    const label = readText(item["label"], `${groupName} ${index + 1}`);
    const id = readText(item["id"], makeGeneratedId(groupName.toLowerCase(), index, label));
    const access = parseAccessPolicyOverride(
      item["access"],
      `${groupName.toLowerCase()}Actions.${id}.access`,
    );
    return {
      id,
      label,
      target: parseTarget(item["target"], `${groupName} action '${label}'`),
      ...(access ? { access } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// External catalog sources.
// ---------------------------------------------------------------------------

type CatalogSourceDeclaration = {
  id: string;
  path: string;
};

type CatalogRowsSource = {
  id: string;
  rows: ConfiguredRow[];
};

type LoadedCatalog = {
  sources: CatalogRowsSource[];
  statuses: CatalogSourceStatus[];
  warnings: string[];
};

function parseYamlMapping(text: string, label: string): RawObject {
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (error) {
    throw new Error(`${label} YAML failed to parse: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed)) {
    throw new Error(`${label} is empty or not a YAML mapping.`);
  }
  return parsed;
}

function parseCatalogSourceDeclarations(value: unknown): CatalogSourceDeclaration[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!isObject(value)) {
    throw new Error("`catalog` must be a YAML mapping when provided.");
  }
  const sources = value["sources"];
  if (sources === undefined || sources === null) {
    return [];
  }
  if (!Array.isArray(sources)) {
    throw new Error("`catalog.sources` must be a YAML list.");
  }

  const ids = new Set<string>();
  return sources.map((item, index) => {
    if (!isObject(item)) {
      throw new Error(`Catalog source ${index + 1} is not an object.`);
    }
    const id = readText(item["id"]);
    const sourcePath = readText(item["path"]);
    if (!id) {
      throw new Error(`Catalog source ${index + 1} is missing required \`id\`.`);
    }
    if (!sourcePath) {
      throw new Error(`Catalog source \`${id}\` is missing required \`path\`.`);
    }
    if (ids.has(id)) {
      throw new Error(`Duplicate catalog source id '${id}'.`);
    }
    ids.add(id);
    return { id, path: sourcePath };
  });
}

function assertRowsUniqueWithinSource(rows: ConfiguredRow[], sourceId: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) {
      throw new Error(`Catalog source '${sourceId}' contains duplicate entry id '${row.id}'.`);
    }
    seen.add(row.id);
  }
}

function parseCatalogDocument(text: string, sourceId: string, context: LaunchContext): ConfiguredRow[] {
  const parsed = parseYamlMapping(text, `Catalog source '${sourceId}'`);
  const rows = parseRows(parsed["entries"] ?? parsed["rows"]);
  assertRowsUniqueWithinSource(rows, sourceId);
  for (const row of rows) {
    validateTargetReferences(row.target, context, {
      id: row.id,
      kind: row.target.kind,
      group: "entry",
    });
  }
  return rows;
}

function catalogCachePath(cacheDir: string, source: CatalogSourceDeclaration, resolvedPath: string): string {
  const safeId = source.id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "catalog";
  const digest = createHash("sha256").update(`${source.id}\0${resolvedPath}`).digest("hex").slice(0, 12);
  return path.join(cacheDir, `${safeId}-${digest}.yaml`);
}

function writeCatalogCache(cachePath: string, text: string): void {
  mkdirSync(path.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, cachePath);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Ignore cleanup failure; the original cache error is more useful.
    }
    throw error;
  }
}

function fileTimestamp(filePath: string): string | undefined {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function loadCatalogSources(
  declarations: CatalogSourceDeclaration[],
  context: LaunchContext,
  cacheDir: string,
): LoadedCatalog {
  const loaded: LoadedCatalog = { sources: [], statuses: [], warnings: [] };

  for (const source of declarations) {
    const resolvedPath = resolveConfiguredPath(source.path, context);
    const cachePath = catalogCachePath(cacheDir, source, resolvedPath);
    try {
      const text = readFileSync(resolvedPath, "utf8");
      const rows = parseCatalogDocument(text, source.id, context);
      loaded.sources.push({ id: source.id, rows });
      const status: CatalogSourceStatus = {
        id: source.id,
        path: resolvedPath,
        state: "fresh",
        stale: false,
        entryCount: rows.length,
        cachePath,
        ...(fileTimestamp(resolvedPath) ? { loadedAt: fileTimestamp(resolvedPath) } : {}),
      };
      try {
        writeCatalogCache(cachePath, text);
      } catch (error) {
        const message =
          `Catalog source '${source.id}' loaded from '${resolvedPath}', but its cache could not be updated: ` +
          `${error instanceof Error ? error.message : String(error)}`;
        loaded.warnings.push(message);
        status.message = message;
      }
      loaded.statuses.push(status);
      continue;
    } catch (sourceError) {
      if (sourceError instanceof MissingLocalSettingError) {
        throw sourceError;
      }

      try {
        const cachedText = readFileSync(cachePath, "utf8");
        const rows = parseCatalogDocument(cachedText, source.id, context);
        const message =
          `Catalog source '${source.id}' at '${resolvedPath}' is unavailable or invalid; ` +
          `using cached data from '${cachePath}'. Cause: ` +
          `${sourceError instanceof Error ? sourceError.message : String(sourceError)}`;
        loaded.sources.push({ id: source.id, rows });
        loaded.statuses.push({
          id: source.id,
          path: resolvedPath,
          state: "cached",
          stale: true,
          entryCount: rows.length,
          message,
          cachePath,
          ...(fileTimestamp(cachePath) ? { loadedAt: fileTimestamp(cachePath) } : {}),
        });
        loaded.warnings.push(message);
        continue;
      } catch (cacheError) {
        if (cacheError instanceof MissingLocalSettingError) {
          throw cacheError;
        }
        const message =
          `Catalog source '${source.id}' at '${resolvedPath}' could not be loaded and no usable cache exists. ` +
          `Source error: ${sourceError instanceof Error ? sourceError.message : String(sourceError)}. ` +
          `Cache error: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}.`;
        loaded.statuses.push({
          id: source.id,
          path: resolvedPath,
          state: "unavailable",
          stale: true,
          entryCount: 0,
          message,
          cachePath,
        });
        loaded.warnings.push(message);
      }
    }
  }

  return loaded;
}

function mergeCatalogRows(sources: CatalogRowsSource[], warnings: string[]): ConfiguredRow[] {
  const merged = new Map<string, { row: ConfiguredRow; sourceId: string }>();
  for (const source of sources) {
    assertRowsUniqueWithinSource(source.rows, source.id);
    for (const row of source.rows) {
      const previous = merged.get(row.id);
      if (previous) {
        warnings.push(
          `Catalog entry id '${row.id}' from source '${source.id}' overrides source ` +
            `'${previous.sourceId}' because later configured sources take precedence.`,
        );
        // Delete first so the winning row is ordered where the later source put it.
        merged.delete(row.id);
      }
      merged.set(row.id, { row, sourceId: source.id });
    }
  }
  return [...merged.values()].map(({ row }) => row);
}

// ---------------------------------------------------------------------------
// Security policy.
// ---------------------------------------------------------------------------

function parseSecurityPolicy(
  value: unknown,
  base: { appRoot: string; configDir: string },
  local: LocalMachineConfig,
): SecurityPolicy {
  const raw = isObject(value) ? value : {};
  const ctxForRoots: LaunchContext = {
    appRoot: base.appRoot,
    configDir: base.configDir,
    security: { allowedCommandRoots: [], allowBareCommands: true, allowInsecureConfigPermissions: false },
    local,
  };

  const roots = Array.isArray(raw["allowedCommandRoots"])
    ? (raw["allowedCommandRoots"] as unknown[])
        .map((entry) => readText(entry))
        .filter((entry) => entry.length > 0)
        .map((entry) => {
          const expanded = expandConfiguredString(entry, ctxForRoots);
          const abs = path.isAbsolute(expanded) || isWindowsAbsolutePath(expanded)
            ? expanded
            : path.resolve(base.configDir, expanded);
          return path.normalize(abs);
        })
    : [];

  return {
    allowedCommandRoots: roots,
    allowBareCommands: readBool(raw["allowBareCommands"], true),
    allowInsecureConfigPermissions: readBool(raw["allowInsecureConfigPermissions"], false),
  };
}

function normalizeForCompare(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.replace(/\//g, "\\").toLowerCase() : normalized;
}

// Enforced at LAUNCH time (authoritative, uses the exact command that will be
// spawned on the current platform). Throws on violation.
export function assertCommandAllowed(resolvedCommand: string, policy: SecurityPolicy): void {
  const hasSeparator = resolvedCommand.includes("/") || resolvedCommand.includes("\\");

  if (!hasSeparator) {
    if (!policy.allowBareCommands) {
      throw new Error(
        `Process command '${resolvedCommand}' is a bare name resolved through the OS PATH, ` +
          `which is disabled by security.allowBareCommands=false. ` +
          `Use an absolute path to a wrapper inside an allowed command root.`,
      );
    }
    return;
  }

  const absolute = path.isAbsolute(resolvedCommand) || isWindowsAbsolutePath(resolvedCommand)
    ? resolvedCommand
    : path.resolve(resolvedCommand);

  if (policy.allowedCommandRoots.length === 0) {
    return; // No allow-list configured (a startup warning is emitted separately).
  }

  // Resolve symlinks where the file exists so a symlink cannot escape a root.
  let candidate = absolute;
  try {
    if (existsSync(absolute)) {
      candidate = realpathSync(absolute);
    }
  } catch {
    candidate = absolute;
  }

  const normalizedCandidate = normalizeForCompare(candidate);
  const allowed = policy.allowedCommandRoots.some((root) => {
    let rootResolved = root;
    try {
      if (existsSync(root)) {
        rootResolved = realpathSync(root);
      }
    } catch {
      rootResolved = root;
    }
    const normalizedRoot = normalizeForCompare(rootResolved);
    const withSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
    return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(withSep);
  });

  if (!allowed) {
    throw new Error(
      `Process command '${candidate}' is not inside any allowed command root ` +
        `(${policy.allowedCommandRoots.join(", ") || "<none configured>"}). ` +
        `Add its directory to security.allowedCommandRoots or move the wrapper into an allowed root.`,
    );
  }
}

// Enforced at LOAD time. Refuses a world-writable config file on POSIX systems
// unless explicitly allowed. No-op on Windows (POSIX mode bits are not meaningful).
export function assertConfigFilePermissions(configPath: string, policy: SecurityPolicy): void {
  if (os.platform() === "win32" || policy.allowInsecureConfigPermissions) {
    return;
  }
  let mode: number;
  try {
    mode = statSync(configPath).mode;
  } catch {
    return;
  }
  // 0o002 = writable by "other".
  if ((mode & 0o002) !== 0) {
    throw new Error(
      `Config file '${configPath}' is world-writable (mode ${(mode & 0o777).toString(8)}). ` +
        `Any user could rewrite it to launch arbitrary commands. ` +
        `Run: chmod o-w '${configPath}' (or set security.allowInsecureConfigPermissions: true to override).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Web URL validation (not platform-specific, so validated eagerly at load).
// ---------------------------------------------------------------------------

export function assertWebUrlAllowed(url: string, context: LaunchContext, scope?: ConfigItemScope): URL {
  const expanded = expandConfiguredString(url, context, scope ? { ...scope, field: "target.url" } : undefined);
  let parsed: URL;
  try {
    parsed = new URL(expanded);
  } catch {
    throw new Error(`Web target has a malformed URL: '${expanded}'.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Only HTTP(S) URLs are allowed for web targets (got '${parsed.protocol}//' in '${expanded}').`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Process-target materialisation (OS override merge + expansion).
// ---------------------------------------------------------------------------

function currentProcessOverride(target: ProcessLaunchTarget): ProcessTargetOptions | undefined {
  if (process.platform === "win32") {
    return target.windows;
  }
  if (process.platform === "linux") {
    return target.linux;
  }
  if (process.platform === "darwin") {
    return target.darwin;
  }
  return undefined;
}

export type MaterializedProcess = { command: string; args?: string[]; cwd?: string; env?: Record<string, string> };

export function materializeProcessTarget(
  target: ProcessLaunchTarget,
  context: LaunchContext,
  scope?: ConfigItemScope,
): MaterializedProcess {
  const override = currentProcessOverride(target);
  const merged = {
    command: override?.command ?? target.command,
    args: override?.args ?? target.args,
    cwd: override?.cwd ?? target.cwd,
    env: { ...(target.env ?? {}), ...(override?.env ?? {}) },
  };
  const env = Object.fromEntries(
    Object.entries(merged.env).map(([key, value]) => [
      key,
      expandConfiguredString(value, context, scope ? { ...scope, field: `target.env.${key}` } : undefined),
    ]),
  );
  return {
    command: resolveConfiguredPath(
      merged.command,
      context,
      scope ? { ...scope, field: "target.command" } : undefined,
    ),
    ...(merged.args
      ? {
          args: merged.args.map((item, index) =>
            expandConfiguredString(
              item,
              context,
              scope ? { ...scope, field: `target.args[${index}]` } : undefined,
            ),
          ),
        }
      : {}),
    ...(merged.cwd
      ? {
          cwd: resolveConfiguredPath(
            merged.cwd,
            context,
            scope ? { ...scope, field: "target.cwd" } : undefined,
          ),
        }
      : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

function validateProcessOptionsReferences(
  options: ProcessTargetOptions | undefined,
  context: LaunchContext,
  scope: ConfigItemScope,
  prefix: string,
): void {
  if (!options) {
    return;
  }
  if (options.command !== undefined) {
    expandConfiguredString(options.command, context, { ...scope, field: `${prefix}.command` });
  }
  options.args?.forEach((arg, index) => {
    expandConfiguredString(arg, context, { ...scope, field: `${prefix}.args[${index}]` });
  });
  if (options.cwd !== undefined) {
    expandConfiguredString(options.cwd, context, { ...scope, field: `${prefix}.cwd` });
  }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    expandConfiguredString(value, context, { ...scope, field: `${prefix}.env.${name}` });
  }
}

function validateTargetReferences(target: LaunchTarget, context: LaunchContext, scope: ConfigItemScope): void {
  if (target.kind === "web") {
    assertWebUrlAllowed(target.url, context, scope);
    return;
  }
  if (target.kind === "folder") {
    expandConfiguredString(target.path, context, { ...scope, field: "target.path" });
    return;
  }
  if (target.kind === "labview-dev") {
    expandConfiguredString("${local.workspaceRoot}", context, {
      ...scope,
      field: "local.workspaceRoot",
    });
    expandConfiguredString("${local.zoneSymbol}", context, {
      ...scope,
      field: "local.zoneSymbol",
    });
    expandConfiguredString(target.iocName, context, { ...scope, field: "target.iocName" });
    expandConfiguredString(target.hostName, context, { ...scope, field: "target.hostName" });
    expandConfiguredString(target.iocType, context, { ...scope, field: "target.iocType" });
    expandConfiguredString(target.exeName, context, { ...scope, field: "target.exeName" });
    return;
  }
  if (target.kind === "labview-epics") {
    expandConfiguredString("${local.workspaceRoot}", context, {
      ...scope,
      field: "local.workspaceRoot",
    });
    expandConfiguredString("${local.zoneSymbol}", context, {
      ...scope,
      field: "local.zoneSymbol",
    });
    expandConfiguredString(target.guiName, context, { ...scope, field: "target.guiName" });
    expandConfiguredString(target.guiType, context, { ...scope, field: "target.guiType" });
    expandConfiguredString(target.exeName, context, { ...scope, field: "target.exeName" });
    return;
  }
  if (target.kind === "phoebus") {
    expandConfiguredString("${local.phoebus.executable}", context, {
      ...scope,
      field: "local.phoebus.executable",
    });
    expandConfiguredString("${local.phoebus.serverPort}", context, {
      ...scope,
      field: "local.phoebus.serverPort",
    });
    if (context.local.phoebus.settingsFile !== undefined) {
      expandConfiguredString(context.local.phoebus.settingsFile, context, {
        ...scope,
        field: "local.phoebus.settingsFile",
      });
    }
    if (target.layout) {
      expandConfiguredString("${local.phoebus.layoutFile}", context, {
        ...scope,
        field: "local.phoebus.layoutFile",
      });
    }
    if (target.resource !== undefined) {
      const expandedResource = expandConfiguredString(target.resource, context, {
        ...scope,
        field: "target.resource",
      });
      const hasScheme =
        /^[A-Za-z][A-Za-z0-9+.-]*:/.test(expandedResource) &&
        !/^[A-Za-z]:[\\/]/.test(expandedResource);
      if (hasScheme) {
        let uri: URL;
        try {
          uri = new URL(expandedResource);
        } catch {
          throw new Error(`Phoebus resource has a malformed URI: '${expandedResource}'.`);
        }
        if (!["http:", "https:"].includes(uri.protocol)) {
          throw new Error(
            `Phoebus resource URI must use HTTP(S); got '${uri.protocol}' in '${expandedResource}'.`,
          );
        }
      } else if (!path.isAbsolute(expandedResource) && !isWindowsAbsolutePath(expandedResource)) {
        expandConfiguredString("${local.cssGuiRoot}", context, {
          ...scope,
          field: "local.cssGuiRoot",
        });
      }
    }
    if (target.app !== undefined) {
      expandConfiguredString(target.app, context, { ...scope, field: "target.app" });
    }
    return;
  }
  validateProcessOptionsReferences(target, context, scope, "target");
  validateProcessOptionsReferences(target.windows, context, scope, "target.windows");
  validateProcessOptionsReferences(target.linux, context, scope, "target.linux");
  validateProcessOptionsReferences(target.darwin, context, scope, "target.darwin");
}

// ---------------------------------------------------------------------------
// Top-level parse + validate.
// ---------------------------------------------------------------------------

function createLaunchContext(parsed: RawObject, base: ConfigLoadBase): LaunchContext {
  const local = parseLocalMachineConfig(parsed["local"]);
  const security = parseSecurityPolicy(parsed["security"], base, local);
  return { appRoot: base.appRoot, configDir: base.configDir, security, local };
}

function parseConfigObject(
  parsed: RawObject,
  base: ConfigLoadBase,
  loadedCatalog: LoadedCatalog,
): ParsedConfig {
  const context = createLaunchContext(parsed, base);

  const inlineRows = parseRows(parsed["entries"] ?? parsed["rows"]);
  assertRowsUniqueWithinSource(inlineRows, "inline");
  const warnings = [...loadedCatalog.warnings];
  const rowsWithTargets = mergeCatalogRows(
    [{ id: "inline", rows: inlineRows }, ...loadedCatalog.sources],
    warnings,
  );
  const quickActionsWithTargets = parseActions(parsed["quickActions"], "Quick");
  const moreActionsWithTargets = parseActions(parsed["moreActions"], "More");
  const platformAccessPolicies = parsePlatformAccessPolicies(parsed["access"]);

  const targetsById = new Map<string, LaunchTarget>();
  const labelsById = new Map<string, string>();
  const accessPoliciesById = new Map<string, LaunchAccessPolicy>();

  const register = (
    id: string,
    label: string,
    target: LaunchTarget,
    group: ConfigItemScope["group"],
    platform: string | undefined,
    itemAccess: LaunchAccessPolicyOverride | undefined,
  ): void => {
    if (targetsById.has(id)) {
      throw new Error(`Duplicate launcher id '${id}'. Every row and action id must be unique.`);
    }
    // Validate every configured string, including inactive OS overrides, so a
    // missing local key is reported at startup with the owning item id.
    validateTargetReferences(target, context, { id, kind: target.kind, group });
    targetsById.set(id, target);
    labelsById.set(id, label);
    accessPoliciesById.set(
      id,
      resolveLaunchAccessPolicy({
        targetKind: target.kind,
        platform,
        platformOverride: platform
          ? platformAccessPolicies.get(platform.trim().toLowerCase())
          : undefined,
        itemOverride: itemAccess,
      }),
    );
  };

  for (const row of rowsWithTargets) {
    register(row.id, row.name, row.target, "entry", row.platform, row.access);
  }
  for (const action of quickActionsWithTargets) {
    register(action.id, action.label, action.target, "quick action", undefined, action.access);
  }
  for (const action of moreActionsWithTargets) {
    register(action.id, action.label, action.target, "more action", undefined, action.access);
  }

  const inlineStatus: CatalogSourceStatus = {
    id: "inline",
    state: "inline",
    stale: false,
    entryCount: inlineRows.length,
  };
  const sources = [inlineStatus, ...loadedCatalog.statuses];

  return {
    appName: readText(parsed["appName"], DEFAULT_APP_NAME),
    rows: rowsWithTargets.map(({ target: _t, access: _access, ...row }) => row),
    quickActions: quickActionsWithTargets.map(({ target: _t, access: _access, ...a }) => a),
    moreActions: moreActionsWithTargets.map(({ target: _t, access: _access, ...a }) => a),
    targetsById,
    labelsById,
    accessPoliciesById,
    context,
    catalogStatus: {
      stale: sources.some((source) => source.stale),
      sources,
      warnings,
    },
  };
}

export function parseConfig(rawYamlText: string, base: ConfigLoadBase): ParsedConfig {
  const parsed = parseYamlMapping(rawYamlText, "Config");
  const context = createLaunchContext(parsed, base);
  const declarations = parseCatalogSourceDeclarations(parsed["catalog"]);
  const cacheDir = base.catalogCacheDir ?? path.join(os.tmpdir(), "eli-hmi-launcher-catalog-cache");
  const loadedCatalog = loadCatalogSources(declarations, context, cacheDir);
  return parseConfigObject(parsed, base, loadedCatalog);
}

// Convenience wrapper used by main and by the validate-config script.
export function loadConfigFromFile(configPath: string, base: ConfigLoadBase): ParsedConfig {
  const text = readFileSync(configPath, "utf8");
  const result = parseConfig(text, { ...base, configDir: path.dirname(configPath) });
  assertConfigFilePermissions(configPath, result.context.security);
  return result;
}
