// Pure configuration layer: YAML parsing, schema validation, security-policy
// resolution, variable expansion, path resolution, and process-command
// allow-list enforcement.
//
// This module intentionally imports ONLY `yaml` and Node built-ins. It must not
// import `electron`, so it can be exercised by `npm run validate-config`
// (via tsx) and by unit harnesses without spinning up a browser window.

import { readFileSync, statSync, realpathSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type {
  LaunchTarget,
  LauncherAction,
  LauncherRow,
  ProcessLaunchTarget,
  ProcessTargetOptions,
  SecurityPolicy,
} from "../shared/types";

type RawObject = Record<string, unknown>;

export type LaunchContext = {
  appRoot: string;
  configDir: string;
  security: SecurityPolicy;
};

export type ConfiguredRow = LauncherRow & { target: LaunchTarget };
export type ConfiguredAction = LauncherAction & { target: LaunchTarget };

export type ParsedConfig = {
  appName: string;
  rows: LauncherRow[];
  quickActions: LauncherAction[];
  moreActions: LauncherAction[];
  targetsById: Map<string, LaunchTarget>;
  labelsById: Map<string, string>;
  context: LaunchContext;
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

// ---------------------------------------------------------------------------
// Variable expansion and path resolution.
// ---------------------------------------------------------------------------

function getVariableMap(context: LaunchContext): Record<string, string> {
  return {
    APP_ROOT: context.appRoot,
    CONFIG_DIR: context.configDir,
    HOME: process.env["HOME"] ?? "",
    USERPROFILE: process.env["USERPROFILE"] ?? "",
    TEMP: process.env["TEMP"] ?? process.env["TMP"] ?? process.env["TMPDIR"] ?? "",
    TMP: process.env["TMP"] ?? process.env["TEMP"] ?? process.env["TMPDIR"] ?? "",
    TMPDIR: process.env["TMPDIR"] ?? process.env["TEMP"] ?? process.env["TMP"] ?? "",
  };
}

export function expandConfiguredString(value: string, context: LaunchContext): string {
  const variables = getVariableMap(context);
  const expandVariable = (match: string, name: string): string => {
    const upperName = name.toUpperCase();
    return variables[upperName] ?? process.env[name] ?? process.env[upperName] ?? match;
  };
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, expandVariable)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, expandVariable);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.includes("\\") || value.startsWith(".");
}

export function resolveConfiguredPath(value: string, context: LaunchContext): string {
  const expanded = expandConfiguredString(value, context);
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
    return {
      id,
      name,
      technology: readStringList(item["technology"] ?? item["type"]),
      section: readStringList(item["section"]),
      platform: readText(item["platform"] ?? item["guiType"], "--"),
      rmc: readText(item["rmc"], "--"),
      note: readText(item["note"], "--"),
      target: parseTarget(item["target"], `Entry '${name}'`),
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
    return {
      id,
      label,
      target: parseTarget(item["target"], `${groupName} action '${label}'`),
    };
  });
}

// ---------------------------------------------------------------------------
// Security policy.
// ---------------------------------------------------------------------------

function parseSecurityPolicy(value: unknown, base: { appRoot: string; configDir: string }): SecurityPolicy {
  const raw = isObject(value) ? value : {};
  const ctxForRoots: LaunchContext = {
    appRoot: base.appRoot,
    configDir: base.configDir,
    security: { allowedCommandRoots: [], allowBareCommands: true, allowInsecureConfigPermissions: false },
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

export function assertWebUrlAllowed(url: string, context: LaunchContext): URL {
  const expanded = expandConfiguredString(url, context);
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

export function materializeProcessTarget(target: ProcessLaunchTarget, context: LaunchContext): MaterializedProcess {
  const override = currentProcessOverride(target);
  const merged = {
    command: override?.command ?? target.command,
    args: override?.args ?? target.args,
    cwd: override?.cwd ?? target.cwd,
    env: { ...(target.env ?? {}), ...(override?.env ?? {}) },
  };
  const env = Object.fromEntries(
    Object.entries(merged.env).map(([key, value]) => [key, expandConfiguredString(value, context)]),
  );
  return {
    command: resolveConfiguredPath(merged.command, context),
    ...(merged.args ? { args: merged.args.map((item) => expandConfiguredString(item, context)) } : {}),
    ...(merged.cwd ? { cwd: resolveConfiguredPath(merged.cwd, context) } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

// ---------------------------------------------------------------------------
// Top-level parse + validate.
// ---------------------------------------------------------------------------

export function parseConfig(
  rawYamlText: string,
  base: { appRoot: string; configDir: string },
): ParsedConfig {
  let parsed: unknown;
  try {
    parsed = YAML.parse(rawYamlText);
  } catch (error) {
    throw new Error(`Config YAML failed to parse: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isObject(parsed)) {
    throw new Error("Launcher config is empty or not a YAML mapping.");
  }

  const security = parseSecurityPolicy(parsed["security"], base);
  const context: LaunchContext = { appRoot: base.appRoot, configDir: base.configDir, security };

  const rowsWithTargets = parseRows(parsed["entries"] ?? parsed["rows"]);
  const quickActionsWithTargets = parseActions(parsed["quickActions"], "Quick");
  const moreActionsWithTargets = parseActions(parsed["moreActions"], "More");

  const targetsById = new Map<string, LaunchTarget>();
  const labelsById = new Map<string, string>();

  const register = (id: string, label: string, target: LaunchTarget): void => {
    if (targetsById.has(id)) {
      throw new Error(`Duplicate launcher id '${id}'. Every row and action id must be unique.`);
    }
    // Eagerly validate web URLs (platform-independent) so a bad URL fails at startup.
    if (target.kind === "web") {
      assertWebUrlAllowed(target.url, context);
    }
    targetsById.set(id, target);
    labelsById.set(id, label);
  };

  for (const row of rowsWithTargets) {
    register(row.id, row.name, row.target);
  }
  for (const action of [...quickActionsWithTargets, ...moreActionsWithTargets]) {
    register(action.id, action.label, action.target);
  }

  return {
    appName: readText(parsed["appName"], DEFAULT_APP_NAME),
    rows: rowsWithTargets.map(({ target: _t, ...row }) => row),
    quickActions: quickActionsWithTargets.map(({ target: _t, ...a }) => a),
    moreActions: moreActionsWithTargets.map(({ target: _t, ...a }) => a),
    targetsById,
    labelsById,
    context,
  };
}

// Convenience wrapper used by main and by the validate-config script.
export function loadConfigFromFile(
  configPath: string,
  base: { appRoot: string; configDir: string },
): ParsedConfig {
  const text = readFileSync(configPath, "utf8");
  const result = parseConfig(text, base);
  assertConfigFilePermissions(configPath, result.context.security);
  return result;
}
