import type { ParsedConfig, LaunchContext, MaterializedProcess } from "../config/load";
import { assertWebUrlAllowed, materializeProcessTarget, resolveConfiguredPath } from "../config/load";
import { logEvent, logLaunch, redactLaunchArgs } from "../diagnostics/log";
import type { SessionLaunch } from "../diagnostics/report";
import type { RuntimeRegistry } from "../runtime/registry";
import type {
  LaunchAccessMode,
  LaunchResult,
  LaunchTarget,
} from "../../shared/types";
import { EntryLaunchGate, describeUnperformedLaunch, runWithLaunchPolicy } from "./access";
import { attachLaunchDiagnostics, diagnosticsFromError, folderLaunchError, webLaunchError } from "./errors";
import { materializeLabviewDeveloperTarget, materializeLabviewEpicsTarget } from "./labview";
import { launchMaterializedProcess } from "./native";
import { PhoebusServerManager } from "./phoebus-server";
import { assertPhoebusLayoutApplied, materializePhoebusTarget } from "./phoebus";
import { assertFolderPathUsable, assertResolvedValueNotEmpty } from "./validation";

type LaunchDiagnostics = {
  resolvedCommand?: string;
  resolvedArgs?: string[];
};

export async function launchWebTarget(
  configuredUrl: string,
  context: LaunchContext,
  openExternal: (url: string) => Promise<void>,
): Promise<string> {
  let resolvedUrl = configuredUrl;
  try {
    resolvedUrl = assertWebUrlAllowed(configuredUrl, context).toString();
    await openExternal(resolvedUrl);
    return resolvedUrl;
  } catch (error) {
    throw webLaunchError(resolvedUrl, error);
  }
}

type LauncherDependencies = {
  getConfig(): ParsedConfig | undefined;
  getRuntime(): RuntimeRegistry | undefined;
  phoebusServers: PhoebusServerManager;
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<string>;
  confirmOverride(label: string, reason: string): Promise<boolean>;
  captureFileFor(itemId: string): string | undefined;
  watchLaunch(itemId: string, pid: number | undefined, captureTo: string | undefined): void;
  recordLaunch(entry: SessionLaunch): void;
};

async function launchFolder(
  configuredPath: string,
  context: LaunchContext,
  openPath: LauncherDependencies["openPath"],
): Promise<void> {
  const targetPath = resolveConfiguredPath(configuredPath, context);
  assertResolvedValueNotEmpty(targetPath, "folder target");
  await assertFolderPathUsable(targetPath);

  let message: string;
  try {
    message = await openPath(targetPath);
  } catch (error) {
    throw folderLaunchError(targetPath, error);
  }
  if (message) {
    throw folderLaunchError(targetPath, message);
  }
}

async function launchNativeTarget(
  itemId: string,
  kind: "process" | "labview-dev" | "labview-epics",
  target: MaterializedProcess,
  context: LaunchContext,
  launchMode: LaunchAccessMode,
  deps: LauncherDependencies,
): Promise<LaunchDiagnostics> {
  const captureTo = deps.captureFileFor(itemId);
  const result = await launchMaterializedProcess(target, context, captureTo);
  deps.watchLaunch(itemId, result.receipt.pid, captureTo);
  await deps.getRuntime()?.registerProcess({
    entryId: itemId,
    kind,
    command: result.command,
    args: result.args,
    receipt: result.receipt,
    launchMode,
  });
  return { resolvedCommand: result.command, resolvedArgs: result.args };
}

async function launchTarget(
  itemId: string,
  target: LaunchTarget,
  context: LaunchContext,
  launchMode: LaunchAccessMode,
  deps: LauncherDependencies,
): Promise<LaunchDiagnostics> {
  if (target.kind === "web") {
    await launchWebTarget(target.url, context, deps.openExternal);
    deps.getRuntime()?.recordHandoff(itemId, "web");
    return {};
  }

  if (target.kind === "folder") {
    await launchFolder(target.path, context, deps.openPath);
    deps.getRuntime()?.recordHandoff(itemId, "folder");
    return {};
  }

  if (target.kind === "process") {
    return launchNativeTarget(
      itemId,
      target.kind,
      materializeProcessTarget(target, context),
      context,
      launchMode,
      deps,
    );
  }

  if (target.kind === "labview-dev") {
    return launchNativeTarget(
      itemId,
      target.kind,
      materializeLabviewDeveloperTarget(target, context),
      context,
      launchMode,
      deps,
    );
  }

  if (target.kind === "labview-epics") {
    return launchNativeTarget(
      itemId,
      target.kind,
      materializeLabviewEpicsTarget(target, context),
      context,
      launchMode,
      deps,
    );
  }

  const plans = materializePhoebusTarget(target, context);
  let ensured;
  try {
    ensured = await deps.phoebusServers.ensureServer(plans.server, async (serverPlan) => {
      const started = await launchMaterializedProcess(serverPlan, context);
      return started.receipt;
    });
    assertPhoebusLayoutApplied(plans.layoutRequested, ensured.state, plans.server.port);
  } catch (error) {
    throw attachLaunchDiagnostics(error, plans.server);
  }

  if (plans.openResource) {
    const opened = await launchMaterializedProcess(plans.openResource, context);
    deps.getRuntime()?.recordPhoebus({
      entryId: itemId,
      port: plans.server.port,
      ownership: ensured.state,
      resource: plans.openResource.args?.at(-1),
    });
    return { resolvedCommand: opened.command, resolvedArgs: opened.args };
  }

  deps.getRuntime()?.recordPhoebus({
    entryId: itemId,
    port: plans.server.port,
    ownership: ensured.state,
  });
  return { resolvedCommand: plans.server.command, resolvedArgs: plans.server.args ?? [] };
}

export function createLauncher(deps: LauncherDependencies): (itemId: unknown) => Promise<LaunchResult> {
  const gate = new EntryLaunchGate();

  return async (itemId: unknown): Promise<LaunchResult> => {
    const startedAt = Date.now();
    const launchedAt = new Date().toISOString();

    if (typeof itemId !== "string" || !itemId.trim()) {
      logEvent("warn", "Launch requested with an invalid id", { itemId: String(itemId) });
      return {
        ok: false,
        id: String(itemId),
        label: "(invalid id)",
        kind: "unknown",
        error: "Invalid launcher item id.",
        launchedAt,
      };
    }

    const config = deps.getConfig();
    const target = config?.targetsById.get(itemId);
    const label = config?.labelsById.get(itemId) ?? itemId;
    const accessPolicy = config?.accessPoliciesById.get(itemId);

    if (!config || !target || !accessPolicy) {
      logEvent("warn", "Launch requested for unknown id", { id: itemId });
      return {
        ok: false,
        id: itemId,
        label,
        kind: "unknown",
        error: `Unknown launcher item id: ${itemId}`,
        launchedAt,
      };
    }

    const runtime = deps.getRuntime();

    try {
      const policyResult = await gate.run(itemId, async () => {
        return runWithLaunchPolicy(
          {
            entryId: itemId,
            policy: accessPolicy,
            runtime: runtime?.getState(itemId),
            instances: [
              ...(runtime?.getProcessRecords(itemId).map((record) => ({
                state: record.state,
                launchMode: record.launchMode,
              })) ?? []),
            ],
          },
          async () =>
            launchTarget(
              itemId,
              target,
              config.context,
              accessPolicy.launchMode,
              deps,
            ),
          {
            confirmOverride: async (reason) => {
              const allowed = await deps.confirmOverride(label, reason);
              logEvent("warn", "Launch policy prompt resolved", { id: itemId, allowed, reason });
              return allowed;
            },
          },
        );
      });

      const unperformed = describeUnperformedLaunch(itemId, policyResult);
      if (unperformed) {
        logEvent("warn", "Launch was not performed by the access policy", {
          id: itemId,
          focused: policyResult.focused,
        });
        deps.recordLaunch({ id: itemId, label, ok: false, error: unperformed, at: launchedAt });
        return { ok: false, id: itemId, label, kind: target.kind, error: unperformed, launchedAt };
      }

      const diagnostics = policyResult.value ?? {};
      logLaunch({
        id: itemId,
        label,
        target,
        ...diagnostics,
        ok: true,
        durationMs: Date.now() - startedAt,
      });
      deps.recordLaunch({
        id: itemId,
        label,
        ok: true,
        command: diagnostics.resolvedCommand,
        args: diagnostics.resolvedArgs ? redactLaunchArgs(diagnostics.resolvedArgs) : undefined,
        at: launchedAt,
      });
      return { ok: true, id: itemId, label, kind: target.kind, launchedAt };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const diagnostics = diagnosticsFromError(error);
      logLaunch({
        id: itemId,
        label,
        target,
        ...diagnostics,
        ok: false,
        error: errorMessage,
        durationMs: Date.now() - startedAt,
      });
      deps.recordLaunch({
        id: itemId,
        label,
        ok: false,
        command: diagnostics?.resolvedCommand,
        args: diagnostics?.resolvedArgs ? redactLaunchArgs(diagnostics.resolvedArgs) : undefined,
        error: errorMessage,
        at: launchedAt,
      });
      return { ok: false, id: itemId, label, kind: target.kind, error: errorMessage, launchedAt };
    }
  };
}
