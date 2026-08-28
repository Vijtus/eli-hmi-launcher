import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type {
  LaunchAccessPolicyOverride,
  LaunchTarget,
  LocalMachineConfig,
  ProcessTargetOptions,
} from "../../shared/types";
import type { ConfiguredAction, ConfiguredRow, RawObject } from "./types";

export function isObject(value: unknown): value is RawObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readText(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
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

function readStringList(value: unknown, key: string): string[] {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (typeof item !== "string" || !item.trim()) {
        throw new Error(`\`${key}[${index}]\` must be a non-empty string.`);
      }
      return item.trim();
    });
  }
  if (typeof value !== "string") {
    throw new Error(`\`${key}\` must be a string or YAML list of strings.`);
  }
  const text = value.trim();
  if (!text || text === "--") {
    return [];
  }
  if (text.includes(";")) {
    throw new Error(`\`${key}\` must use a YAML list instead of a semicolon-separated string.`);
  }
  return [text];
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

function emptyLocalMachineConfig(): LocalMachineConfig {
  return { phoebus: {}, hosts: {}, monitoring: {} };
}

export function readOptionalText(value: unknown): string | undefined {
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

export function parsePlatformAccessPolicies(value: unknown): Map<string, LaunchAccessPolicyOverride> {
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

// `local.phoebus.installRoot` is the Phoebus INSTALL DIRECTORY, which is what the
// config repo's `css-install` key carries (e.g. `C:\\CSS Phoebus\\product-5.0.2`).
// `local.phoebus.executable` is a FILE. An explicit executable always wins; only
// when it is absent is one derived from the install root.
//
// The launcher script name differs between Phoebus distributions, so the install
// root is PROBED rather than guessed: the first of these that actually exists is
// used. Only when none of them exist — which is the normal case when validating a
// Windows config on a POSIX workstation — does it fall back to the platform
// default, so the config still loads and the missing path is reported by the
// ordinary existence check at launch instead of at parse time.
export const PHOEBUS_LAUNCHER_CANDIDATES = ["phoebus.bat", "phoebus.sh", "phoebus"] as const;

export const PHOEBUS_LAUNCHER_BY_PLATFORM: Record<string, string> = {
  win32: "phoebus.bat",
  default: "phoebus.sh",
};

// A Windows-style root is kept Windows-style even on POSIX, so a config authored
// for a workstation reads back unchanged in `dump-config`.
function joinInstallRoot(installRoot: string, fileName: string): string {
  const trimmed = installRoot.replace(/[\\/]+$/, "");
  const separator = trimmed.includes("\\") && !trimmed.includes("/") ? "\\" : path.sep;
  return `${trimmed}${separator}${fileName}`;
}

function resolvePhoebusExecutable(phoebus: RawObject): string | undefined {
  const explicit = readOptionalText(phoebus["executable"]);
  if (explicit) {
    return explicit;
  }
  const installRoot = readOptionalText(phoebus["installRoot"]);
  if (!installRoot) {
    return undefined;
  }
  for (const candidate of PHOEBUS_LAUNCHER_CANDIDATES) {
    const resolved = joinInstallRoot(installRoot, candidate);
    try {
      if (existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // An unreadable install root is not a parse error; fall through to the
      // platform default and let the launch-time check report it.
    }
  }
  const fallback =
    PHOEBUS_LAUNCHER_BY_PLATFORM[os.platform()] ?? PHOEBUS_LAUNCHER_BY_PLATFORM["default"];
  return joinInstallRoot(installRoot, fallback as string);
}

export function parseLocalMachineConfig(value: unknown): LocalMachineConfig {
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
      ...(readOptionalText(phoebus["installRoot"])
        ? { installRoot: readOptionalText(phoebus["installRoot"]) }
        : {}),
      ...(resolvePhoebusExecutable(phoebus)
        ? { executable: resolvePhoebusExecutable(phoebus) }
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

export function parseRows(value: unknown): ConfiguredRow[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("`entries` must be a YAML list.");
  }
  return value.map((item, index) => {
    if (!isObject(item)) {
      throw new Error(`Entry ${index + 1} is not an object.`);
    }
    const id = readText(item["id"]);
    const name = readText(item["name"]);
    if (!id) {
      throw new Error(`Entry ${index + 1} is missing required \`id\`.`);
    }
    if (!name) {
      throw new Error(`Entry '${id}' is missing required \`name\`.`);
    }
    const access = parseAccessPolicyOverride(item["access"], `entries.${id}.access`);
    return {
      id,
      name,
      technology: readStringList(item["technology"], `entries.${id}.technology`),
      section: readStringList(item["section"], `entries.${id}.section`),
      platform: readText(item["platform"], "--"),
      rmc: readText(item["rmc"], "--"),
      note: readText(item["note"], "--"),
      target: parseTarget(item["target"], `Entry '${name}'`),
      ...(access ? { access } : {}),
    };
  });
}

export function parseActions(value: unknown, groupName: string): ConfiguredAction[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`\`${groupName}Actions\` must be a YAML list.`);
  }
  return value.map((item, index) => {
    if (!isObject(item)) {
      throw new Error(`${groupName} action ${index + 1} is not an object.`);
    }
    const id = readText(item["id"]);
    const label = readText(item["label"]);
    if (!id) {
      throw new Error(`${groupName} action ${index + 1} is missing required \`id\`.`);
    }
    if (!label) {
      throw new Error(`${groupName} action '${id}' is missing required \`label\`.`);
    }
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


export function parseYamlMapping(text: string, label: string): RawObject {
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
