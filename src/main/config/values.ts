import path from "node:path";
import type { ProcessLaunchTarget, ProcessTargetOptions } from "../../shared/types";
import type { ConfigItemScope, LaunchContext } from "./types";

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
    // The install DIRECTORY, not the launcher script. An allow-list has to name
    // a directory, so without this a deployment could not permit Phoebus at all
    // without hardcoding the path it had already configured once.
    "local.phoebus.installRoot": context.local.phoebus.installRoot,
    "local.phoebus.executable": context.local.phoebus.executable,
    "local.phoebus.serverPort": context.local.phoebus.serverPort?.toString(),
    "local.phoebus.settingsFile": context.local.phoebus.settingsFile,
    "local.phoebus.layoutFile": context.local.phoebus.layoutFile,
    "local.phoebus.startupTimeoutMs": context.local.phoebus.startupTimeoutMs?.toString(),
    "local.phoebus.resourceReadyDelayMs": context.local.phoebus.resourceReadyDelayMs?.toString(),
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

export class MissingLocalSettingError extends Error {
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

export function isWindowsAbsolutePath(value: string): boolean {
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
