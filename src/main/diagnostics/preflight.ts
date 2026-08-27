import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import {
  assertCommandAllowed,
  assertWebUrlAllowed,
  materializeProcessTarget,
  resolveConfiguredPath,
  type LaunchContext,
  type MaterializedProcess,
  type ParsedConfig,
} from "../config/load";
import {
  materializeLabviewDeveloperTarget,
  materializeLabviewEpicsTarget,
} from "../launch/labview";
import { materializePhoebusTarget } from "../launch/phoebus";
import type { LaunchTarget } from "../../shared/types";

// Preflight uses the same target materialization and command policy as launch,
// but stops before spawning so diagnostics do not create side effects.

export type PreflightStatus =
  // Resolved, present on disk, executable, and allowed by security policy.
  | "ready"
  // Config is fine but the target is not on this machine (wrong host, not installed).
  | "missing"
  // Present, but security.allowedCommandRoots / allowBareCommands refuses it.
  | "denied"
  // Could not even be resolved: missing local.* value, bad substitution, bad URL.
  | "unresolved"
  // Nothing to check without side effects (web/folder handled separately).
  | "not-checked";

export type PreflightFinding = {
  id: string;
  name: string;
  kind: LaunchTarget["kind"];
  status: PreflightStatus;
  resolvedCommand?: string;
  resolvedArgs?: string[];
  detail?: string;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Mirrors launch-validation.assertCommandPathUsable, but reports instead of
// throwing, and distinguishes "absent" from "present but not runnable".
async function checkCommandPath(commandPath: string): Promise<{ status: PreflightStatus; detail?: string }> {
  const bare = !commandPath.includes("/") && !commandPath.includes("\\");
  if (bare) {
    // Resolved through the OS PATH at spawn time; there is nothing to stat.
    return { status: "ready", detail: "bare command, resolved via PATH at launch" };
  }
  let info;
  try {
    info = await stat(commandPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { status: "missing", detail: "does not exist on this machine" };
    }
    return { status: "missing", detail: `not accessible (${code ?? message(error)})` };
  }
  if (!info.isFile()) {
    return { status: "missing", detail: "exists but is not a file" };
  }
  if (process.platform !== "win32") {
    try {
      await access(commandPath, constants.X_OK);
    } catch {
      return { status: "missing", detail: "exists but is not executable" };
    }
  }
  return { status: "ready" };
}

async function checkMaterialized(
  materialized: MaterializedProcess,
  context: LaunchContext,
): Promise<Pick<PreflightFinding, "status" | "detail" | "resolvedCommand" | "resolvedArgs">> {
  const resolvedCommand = materialized.command;
  const resolvedArgs = materialized.args ?? [];

  // Security first: an allow-list refusal is a config problem, and reporting it
  // as "missing" would send someone hunting for a file that was never the issue.
  try {
    assertCommandAllowed(resolvedCommand, context.security);
  } catch (error) {
    return { status: "denied", detail: message(error), resolvedCommand, resolvedArgs };
  }

  const path = await checkCommandPath(resolvedCommand);
  const result: Pick<PreflightFinding, "status" | "detail" | "resolvedCommand" | "resolvedArgs"> = {
    status: path.status,
    resolvedCommand,
    resolvedArgs,
  };
  if (path.detail) {
    result.detail = path.detail;
  }

  if (path.status === "ready" && materialized.cwd) {
    try {
      const info = await stat(materialized.cwd);
      if (!info.isDirectory()) {
        return { ...result, status: "missing", detail: `working directory is not a directory: ${materialized.cwd}` };
      }
    } catch {
      return { ...result, status: "missing", detail: `working directory does not exist: ${materialized.cwd}` };
    }
  }
  return result;
}

async function checkDirectory(
  directoryPath: string,
): Promise<Pick<PreflightFinding, "status" | "detail">> {
  try {
    const info = await stat(directoryPath);
    return info.isDirectory()
      ? { status: "ready" }
      : { status: "missing", detail: "exists but is not a directory" };
  } catch {
    return { status: "missing", detail: "does not exist on this machine" };
  }
}

// A Phoebus resource is a URI by the time it reaches the argv. Only a local
// file can be checked; an http(s) panel is somebody else's server and is not
// probed from a diagnostic run.
// A Phoebus resource reaches the argv as a file: URI when the entry names an app
// or carries macros, and as a bare path when it names neither. Both have to be
// checked: the bare form is the plainest entry anyone writes.
export function phoebusResourcePath(resourceArg: string): string | undefined {
  if (!resourceArg.startsWith("file:")) {
    // Not a URI at all — a local path, unless it is somebody else's server.
    // A scheme needs two or more characters: `C:\...` is a drive letter, and
    // treating it as a scheme silently skips every Windows path.
    return /^[a-z][a-z0-9+.-]+:/i.test(resourceArg) ? undefined : resourceArg;
  }
  try {
    const url = new URL(resourceArg);
    const pathname = decodeURIComponent(url.pathname);
    // A UNC share survives as the URI host: file://eli-fs/css-gui/pm.bob must
    // become \\eli-fs\css-gui\pm.bob again, not /css-gui/pm.bob, or a panel
    // that exists is reported missing.
    if (url.hostname) {
      return `\\\\${url.hostname}${pathname.replace(/\//g, "\\")}`;
    }
    return /^\/[A-Za-z]:/.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return undefined;
  }
}

async function checkPhoebusResource(
  resourceArg: string | undefined,
): Promise<Pick<PreflightFinding, "status" | "detail" | "resolvedCommand"> | undefined> {
  if (!resourceArg) {
    return undefined;
  }
  const filePath = phoebusResourcePath(resourceArg);
  if (!filePath) {
    return undefined;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return {
        status: "missing",
        detail: `Phoebus panel is not a file: ${filePath}`,
        resolvedCommand: filePath,
      };
    }
    return undefined;
  } catch {
    return {
      status: "missing",
      detail: `Phoebus starts, but the panel does not exist: ${filePath}`,
      resolvedCommand: filePath,
    };
  }
}

export async function preflightEntry(
  id: string,
  name: string,
  target: LaunchTarget,
  context: LaunchContext,
): Promise<PreflightFinding> {
  const scope = { id, kind: target.kind, group: "entry" as const };
  const base = { id, name, kind: target.kind };

  try {
    switch (target.kind) {
      case "process":
        return { ...base, ...(await checkMaterialized(materializeProcessTarget(target, context, scope), context)) };
      case "labview-dev":
        return {
          ...base,
          ...(await checkMaterialized(materializeLabviewDeveloperTarget(target, context, scope), context)),
        };
      case "labview-epics":
        return {
          ...base,
          ...(await checkMaterialized(materializeLabviewEpicsTarget(target, context, scope), context)),
        };
      case "phoebus": {
        // The server plan carries the Phoebus launcher script; if that is not
        // runnable nothing about this entry can work.
        const plans = materializePhoebusTarget(target, context, scope);
        const server = await checkMaterialized(plans.server, context);
        if (server.status !== "ready") {
          return { ...base, ...server };
        }
        // Checking only the launcher was how a row could report `ready` and
        // then fail with Phoebus's own "cannot find the file specified": the
        // panel is the thing the entry actually opens, and nothing was looking
        // at it.
        const panel = await checkPhoebusResource(plans.openResource?.args?.at(-1));
        return panel ? { ...base, ...panel } : { ...base, ...server };
      }
      case "web": {
        // Reachability is deliberately not probed: it would put traffic on a
        // control network from a diagnostic run. Only the URL contract is checked.
        const url = assertWebUrlAllowed(target.url, context, scope);
        return { ...base, status: "ready", detail: `opens ${url.protocol}//${url.host} in the default browser` };
      }
      case "folder": {
        const resolved = resolveConfiguredPath(target.path, context, scope);
        return { ...base, ...(await checkDirectory(resolved)), resolvedCommand: resolved };
      }
      default:
        return { ...base, status: "not-checked" };
    }
  } catch (error) {
    // Materialisation threw: a required local.* value is absent, a substitution
    // failed, or the target is malformed. That is the most useful finding of all.
    return { ...base, status: "unresolved", detail: message(error) };
  }
}

export async function preflightConfig(parsed: ParsedConfig): Promise<PreflightFinding[]> {
  const named = new Map<string, string>();
  for (const row of parsed.rows) {
    named.set(row.id, row.name);
  }
  for (const action of [...parsed.quickActions, ...parsed.moreActions]) {
    named.set(action.id, action.label);
  }

  const findings: PreflightFinding[] = [];
  for (const [id, target] of parsed.targetsById) {
    findings.push(await preflightEntry(id, named.get(id) ?? id, target, parsed.context));
  }
  return findings;
}
