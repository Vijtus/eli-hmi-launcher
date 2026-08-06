import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  expandConfiguredString,
  resolveConfiguredPath,
  type ConfigItemScope,
  type LaunchContext,
  type MaterializedProcess,
} from "./config";
import type { PhoebusLaunchTarget } from "../shared/types";

export const DEFAULT_PHOEBUS_STARTUP_TIMEOUT_MS = 30_000;

export type PhoebusServerPlan = MaterializedProcess & {
  port: number;
  startupTimeoutMs: number;
  resourceReadyDelayMs: number;
};

export type PhoebusLaunchPlans = {
  server: PhoebusServerPlan;
  openResource?: MaterializedProcess;
  layoutRequested: boolean;
};

export type PhoebusEnsureState = "started" | "reused-owned" | "reused-external";

export class PhoebusLayoutStartupError extends Error {
  constructor(port: number, state: Exclude<PhoebusEnsureState, "started">) {
    super(
      `Phoebus layout is a startup-only option, but a server is already listening on ` +
        `127.0.0.1:${port} (${state}). Stop that server or use a separate configured port ` +
        "before launching this layout.",
    );
    this.name = "PhoebusLayoutStartupError";
  }
}

export function assertPhoebusLayoutApplied(
  layoutRequested: boolean,
  state: PhoebusEnsureState,
  port: number,
): void {
  if (layoutRequested && state !== "started") {
    throw new PhoebusLayoutStartupError(port, state);
  }
}

function localValue(
  key:
    | "local.cssGuiRoot"
    | "local.phoebus.executable"
    | "local.phoebus.layoutFile"
    | "local.phoebus.serverPort",
  context: LaunchContext,
  scope?: ConfigItemScope,
): string {
  return expandConfiguredString(
    `\${${key}}`,
    context,
    scope ? { ...scope, field: key } : undefined,
  );
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function hasUriScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value);
}

function joinPlatformPath(
  root: string,
  relativePath: string,
  platform: NodeJS.Platform,
): string {
  if (platform === "win32") {
    return path.win32.join(root, relativePath);
  }
  return path.posix.join(root.replace(/\\/g, "/"), relativePath.replace(/\\/g, "/"));
}

function appendAppQuery(resource: string, appName: string): string {
  const hashIndex = resource.indexOf("#");
  const hash = hashIndex >= 0 ? resource.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? resource.slice(0, hashIndex) : resource;
  const queryIndex = withoutHash.indexOf("?");
  const base = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const search = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "";
  const parameters = new URLSearchParams(search);
  parameters.set("app", appName);
  return `${base}?${parameters.toString()}${hash}`;
}

function filesystemResourceUrl(resource: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") {
    return pathToFileURL(resource).toString();
  }

  const normalized = resource.replace(/\\/g, "/");
  if (normalized.startsWith("//")) {
    return new URL(`file:${normalized}`).toString();
  }
  return new URL(`file:///${normalized}`).toString();
}

export function resolvePhoebusResource(
  configuredResource: string,
  appName: string | undefined,
  context: LaunchContext,
  scope?: ConfigItemScope,
  platform: NodeJS.Platform = process.platform,
): string {
  const expanded = expandConfiguredString(
    configuredResource,
    context,
    scope ? { ...scope, field: "target.resource" } : undefined,
  );

  let resolved: string;
  if (hasUriScheme(expanded)) {
    let uri: URL;
    try {
      uri = new URL(expanded);
    } catch {
      throw new Error(`Phoebus resource has a malformed URI: '${expanded}'.`);
    }
    if (!["http:", "https:"].includes(uri.protocol)) {
      throw new Error(
        `Phoebus resource URI must use HTTP(S); got '${uri.protocol}' in '${expanded}'.`,
      );
    }
    resolved = uri.toString();
  } else if (path.isAbsolute(expanded) || isWindowsAbsolutePath(expanded)) {
    resolved = expanded;
  } else {
    const cssGuiRoot = localValue("local.cssGuiRoot", context, scope);
    resolved = joinPlatformPath(cssGuiRoot, expanded, platform);
  }

  if (appName === undefined) {
    return resolved;
  }
  const expandedApp = expandConfiguredString(
    appName,
    context,
    scope ? { ...scope, field: "target.app" } : undefined,
  );
  // Phoebus parses the application selector from a URI query. Appending a
  // query directly to a filesystem path makes '?' part of the filename in the
  // real product (for example, panel.bob%3Fapp=display_runtime). Convert local
  // paths to file: URIs before adding the selector.
  const queryableResource = hasUriScheme(resolved)
    ? resolved
    : filesystemResourceUrl(resolved, platform);
  return appendAppQuery(queryableResource, expandedApp);
}

export function materializePhoebusTarget(
  target: PhoebusLaunchTarget,
  context: LaunchContext,
  scope?: ConfigItemScope,
  platform: NodeJS.Platform = process.platform,
): PhoebusLaunchPlans {
  const executable = resolveConfiguredPath(
    localValue("local.phoebus.executable", context, scope),
    context,
    scope ? { ...scope, field: "local.phoebus.executable" } : undefined,
  );
  const portText = localValue("local.phoebus.serverPort", context, scope);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Resolved Phoebus server port is invalid: '${portText}'.`);
  }

  const serverArgs = ["-server", String(port)];
  if (context.local.phoebus.settingsFile !== undefined) {
    const settingsFile = resolveConfiguredPath(
      context.local.phoebus.settingsFile,
      context,
      scope ? { ...scope, field: "local.phoebus.settingsFile" } : undefined,
    );
    serverArgs.push("-settings", settingsFile);
  }
  if (target.layout) {
    const layoutFile = resolveConfiguredPath(
      localValue("local.phoebus.layoutFile", context, scope),
      context,
      scope ? { ...scope, field: "local.phoebus.layoutFile" } : undefined,
    );
    serverArgs.push("-layout", layoutFile);
  }

  const server: PhoebusServerPlan = {
    command: executable,
    args: serverArgs,
    port,
    startupTimeoutMs:
      context.local.phoebus.startupTimeoutMs ?? DEFAULT_PHOEBUS_STARTUP_TIMEOUT_MS,
    resourceReadyDelayMs: context.local.phoebus.resourceReadyDelayMs ?? 0,
  };

  if (target.resource === undefined) {
    return { server, layoutRequested: target.layout === true };
  }

  const resource = resolvePhoebusResource(
    target.resource,
    target.app,
    context,
    scope,
    platform,
  );
  return {
    server,
    layoutRequested: target.layout === true,
    openResource: {
      command: executable,
      args: ["-server", String(port), "-resource", resource],
    },
  };
}
