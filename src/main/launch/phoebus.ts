import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  expandConfiguredString,
  resolveConfiguredPath,
  type ConfigItemScope,
  type LaunchContext,
  type MaterializedProcess,
} from "../config/load";
import type { PhoebusLaunchTarget } from "../../shared/types";

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

// Phoebus reads `app` first and treats what follows as display macros, and the
// site's own guide states the order plainly: "Put app=... first, then macros".
//
// Macro text is carried through verbatim rather than re-encoded. URLSearchParams
// percent-encodes characters that are perfectly legal in a query, and an EPICS
// prefix almost always ends in a colon — turning `P=13SIM1:` into `P=13SIM1%3A`
// changes what the panel is handed for no benefit. Only the app name, which the
// launcher supplies, is encoded.
// Space, '#' and a bare '%' cannot appear literally in a URI query. Everything
// else a macro uses — ':' in an EPICS prefix, '=' and '&' as separators — is
// legal and is left exactly as written.
function encodeUriBreakers(part: string): string {
  return part
    .replace(/%(?![0-9A-Fa-f]{2})/g, "%25")
    .replace(/ /g, "%20")
    .replace(/#/g, "%23");
}

function appendAppQuery(resource: string, applicationName: string): string {
  const hashIndex = resource.indexOf("#");
  const hash = hashIndex >= 0 ? resource.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? resource.slice(0, hashIndex) : resource;
  const queryIndex = withoutHash.indexOf("?");
  const base = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const search = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "";

  // A configured `app` in the resource is replaced by the entry's own.
  const macros = search
    .split("&")
    .filter((part) => part.length > 0 && !/^app=/i.test(part));

  // Encode only what genuinely breaks a URI. Dropping URLSearchParams stopped
  // `P=13SIM1:` becoming `P=13SIM1%3A`, but it also stopped encoding anything at
  // all — a space inside `LABEL=Beam Line` produces a URI Phoebus rejects, and a
  // `#` is swallowed as a fragment before it is ever read as a macro.
  const query = [`app=${encodeURIComponent(applicationName)}`, ...macros.map(encodeUriBreakers)].join("&");
  return `${base}?${query}${hash}`;
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
  applicationName: string | undefined,
  context: LaunchContext,
  scope?: ConfigItemScope,
  platform: NodeJS.Platform = process.platform,
): string {
  const expanded = expandConfiguredString(
    configuredResource,
    context,
    scope ? { ...scope, field: "target.resource" } : undefined,
  );

  // Macros are written on the resource as a query — `panel.bob?P=PLANT:&M1=X`.
  // They have to be separated before the path becomes a file: URI, because a
  // path-to-URI conversion treats the whole string as a filename and encodes
  // the '?' into it (panel.bob%3FP=PLANT:), silently turning the macros into
  // part of a name no file has.
  let macroQuery = "";
  let pathPart = expanded;
  if (!hasUriScheme(expanded)) {
    const queryIndex = expanded.indexOf("?");
    if (queryIndex >= 0) {
      pathPart = expanded.slice(0, queryIndex);
      // Encoded here, at the point the macros are separated from the path.
      // appendAppQuery splits a fragment off first, so a '#' inside a macro
      // value would be gone before any encoder further down could see it.
      macroQuery = encodeUriBreakers(expanded.slice(queryIndex + 1));
    }
  }

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
  } else if (path.isAbsolute(pathPart) || isWindowsAbsolutePath(pathPart)) {
    resolved = pathPart;
  } else {
    const cssGuiRoot = localValue("local.cssGuiRoot", context, scope);
    resolved = joinPlatformPath(cssGuiRoot, pathPart, platform);
  }

  if (applicationName === undefined) {
    // No selector, but any macros still belong on the resource.
    if (!macroQuery) {
      return resolved;
    }
    const base = hasUriScheme(resolved) ? resolved : filesystemResourceUrl(resolved, platform);
    return `${base}${base.includes("?") ? "&" : "?"}${macroQuery}`;
  }
  const expandedApp = expandConfiguredString(
    applicationName,
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
  const withMacros = macroQuery
    ? `${queryableResource}${queryableResource.includes("?") ? "&" : "?"}${macroQuery}`
    : queryableResource;
  return appendAppQuery(withMacros, expandedApp);
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

  // The site's own launch scripts all pass -nosplash, and an operator clicking a
  // row does not want a splash screen between them and the panel. It applies to
  // the instance being started, not to a resource handed to a running one.
  const serverArgs = ["-server", String(port), "-nosplash"];
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
