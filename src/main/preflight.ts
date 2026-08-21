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
} from "./config";
import {
  materializeLabviewDeveloperTarget,
  materializeLabviewEpicsTarget,
} from "./labview-targets";
import { materializePhoebusTarget } from "./phoebus-targets";
import type { LaunchTarget } from "../shared/types";

// ---------------------------------------------------------------------------
// Answers "would this entry actually launch on THIS machine?" without launching
// anything. Every check runs through the same materialisers and the same
// security policy the real launch path uses, so a `ready` verdict here means the
// command was resolved and the allow-list accepted it — not that a lookalike
// check passed.
// ---------------------------------------------------------------------------

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
        return { ...base, ...(await checkMaterialized(plans.server, context)) };
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
