import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { access } from "node:fs/promises";
import path from "node:path";
import {
  loadConfigFromFile,
  materializeProcessTarget,
  resolveConfiguredPath,
  type LaunchContext,
  type ParsedConfig,
} from "./config";
import { getLogFilePath, initLogger, logEvent, logLaunch } from "./logger";
import { defaultDeps } from "./config-repo";
import { readDynamicConfigEnv, resolveDynamicConfig, type DynamicConfigResult } from "./dynamic-config";
import { redactError } from "./config-repo-auth";
import { buildEffectiveConfig } from "./effective-config";
import { attachLaunchDiagnostics, diagnosticsFromError } from "./launch-diagnostics";
import {
  assertFolderPathUsable,
  assertResolvedValueNotEmpty,
} from "./launch-validation";
import { folderLaunchError } from "./launch-errors";
import {
  materializeLabviewDeveloperTarget,
  materializeLabviewEpicsTarget,
} from "./labview-targets";
import { launchMaterializedProcess, type NativeLaunchResult } from "./native-launcher";
import { PhoebusServerManager } from "./phoebus-server";
import { assertPhoebusLayoutApplied, materializePhoebusTarget } from "./phoebus-targets";
import {
  createHmiApiAdapter,
  NoopHmiApiAdapter,
  type HmiApiAdapter,
} from "./hmi-api";
import { HmiLifecycleCoordinator } from "./hmi-lifecycle-coordinator";
import { isConstrainedLaunchPolicy } from "./access-policy";
import {
  EntryLaunchGate,
  describeUnperformedLaunch,
  runWithLaunchPolicy,
} from "./launch-policy-enforcement";
import {
  DEFAULT_RUNTIME_RECONCILE_INTERVAL_MS,
  RuntimeRegistry,
} from "./runtime-registry";
import { launchWebTarget } from "./web-launcher";
import type {
  LaunchResult,
  LaunchTarget,
  LauncherConfig,
  LaunchAccessMode,
  ProcessLaunchTarget,
  RuntimeSnapshot,
} from "../shared/types";

const DEFAULT_APP_NAME = "L4 Launcher";

let loaded: ParsedConfig | undefined;
let runtimeRegistry: RuntimeRegistry | undefined;
const phoebusServers = new PhoebusServerManager();
let hmiApi: HmiApiAdapter = new NoopHmiApiAdapter();
let lifecycleCoordinator: HmiLifecycleCoordinator | undefined;
const entryLaunchGate = new EntryLaunchGate();
let lifecycleShutdownStarted = false;
let lastLifecycleHealthStatus: string | undefined;

function emptyRuntimeSnapshot(): RuntimeSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    reconcileIntervalMs: DEFAULT_RUNTIME_RECONCILE_INTERVAL_MS,
    items: [],
    hmiApi: lifecycleCoordinator?.health() ?? hmiApi.health(),
  };
}

function runtimeSnapshot(): RuntimeSnapshot {
  const snapshot = runtimeRegistry?.snapshot() ?? emptyRuntimeSnapshot();
  return {
    ...snapshot,
    hmiApi: lifecycleCoordinator?.health() ?? hmiApi.health(),
  };
}

function broadcastRuntimeSnapshot(snapshot: RuntimeSnapshot): void {
  const publicSnapshot: RuntimeSnapshot = {
    ...snapshot,
    hmiApi: lifecycleCoordinator?.health() ?? hmiApi.health(),
  };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("launcher:runtime-states", publicSnapshot);
    }
  }
}

function publicConfig(): LauncherConfig {
  if (!loaded) {
    return {
      appName: DEFAULT_APP_NAME,
      rows: [],
      quickActions: [],
      moreActions: [],
      catalogStatus: { stale: false, sources: [], warnings: [] },
    };
  }
  return {
    appName: loaded.appName,
    rows: loaded.rows,
    quickActions: loaded.quickActions,
    moreActions: loaded.moreActions,
    catalogStatus: loaded.catalogStatus,
  };
}

// ---------------------------------------------------------------------------
// Config discovery.
// ---------------------------------------------------------------------------

function getElectronResourcesPath(): string | undefined {
  const electronProcess = process as typeof process & { resourcesPath?: string };
  return typeof electronProcess.resourcesPath === "string" ? electronProcess.resourcesPath : undefined;
}

function uniquePaths(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function getDefaultConfigCandidates(): string[] {
  const appRoot = app.getAppPath();
  const executableDir = path.dirname(process.execPath);
  const resourcesPath = getElectronResourcesPath();
  return uniquePaths([
    path.join(process.cwd(), "config", "launcher.yaml"),
    path.join(appRoot, "config", "launcher.yaml"),
    resourcesPath ? path.join(resourcesPath, "config", "launcher.yaml") : "",
    path.join(executableDir, "config", "launcher.yaml"),
  ]);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveConfigPath(): Promise<string> {
  const configuredPath = process.env["ELI_LAUNCHER_CONFIG"];
  if (configuredPath) {
    return path.resolve(configuredPath);
  }
  for (const candidate of getDefaultConfigCandidates()) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "No launcher config found. Set ELI_LAUNCHER_CONFIG or place config/launcher.yaml next to the app.",
  );
}

// ---------------------------------------------------------------------------
// Windows.
// ---------------------------------------------------------------------------

function baseWebPreferences(): Electron.WebPreferences {
  return {
    preload: path.join(__dirname, "../preload/index.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1405,
    height: 851,
    useContentSize: true,
    minWidth: 1024,
    minHeight: 680,
    autoHideMenuBar: true,
    webPreferences: baseWebPreferences(),
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    window.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    window.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Startup config failures must be visible. A dedicated window explains what
// went wrong and how to fix it instead of the process silently exiting.
function showConfigErrorWindow(message: string, configPath: string | undefined): void {
  const window = new BrowserWindow({
    width: 780,
    height: 520,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>L4 Launcher — configuration error</title>
<style>
  :root { color-scheme: dark; background: #000000; color: #ffffff; }
  body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; background: #000000; color: #ffffff; padding: 1.5rem 1.75rem; }
  h1 { font-size: 1.1rem; text-transform: uppercase; letter-spacing: .04em; margin: 0 0 1rem; }
  .msg { border: 2px solid #ffffff; background: #000000; color: #ffffff; padding: 1rem; white-space: pre-wrap; word-break: break-word; font-family: "Cascadia Code", Consolas, monospace; font-size: .92rem; }
  .path { color: #ffffff; margin: 1rem 0 .25rem; font-size: .85rem; }
  ul { color: #ffffff; font-size: .9rem; line-height: 1.5; }
  code { color: #ffffff; }
</style></head><body>
  <h1>Launcher configuration error</h1>
  <div class="msg">${escapeHtml(message)}</div>
  <p class="path">Config file: <code>${escapeHtml(configPath ?? "(not resolved)")}</code></p>
  <ul>
    <li>Fix the reported problem in the YAML config, then restart the launcher.</li>
    <li>To point at a different file: set <code>ELI_LAUNCHER_CONFIG</code> to an absolute path.</li>
    <li>Validate a config without launching: <code>npm run validate-config -- &lt;path-to-yaml&gt;</code></li>
  </ul>
</body></html>`;
  window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}

// ---------------------------------------------------------------------------
// Launching.
// ---------------------------------------------------------------------------

async function launchProcessTarget(
  target: ProcessLaunchTarget,
  context: LaunchContext,
): Promise<NativeLaunchResult> {
  const materialized = materializeProcessTarget(target, context);
  return await launchMaterializedProcess(materialized, context);
}

async function launchFolderTarget(folderPath: string, context: LaunchContext): Promise<void> {
  const materializedPath = resolveConfiguredPath(folderPath, context);
  assertResolvedValueNotEmpty(materializedPath, "folder target");

  await assertFolderPathUsable(materializedPath);

  let message: string;
  try {
    message = await shell.openPath(materializedPath);
  } catch (error) {
    throw folderLaunchError(materializedPath, error);
  }
  if (message) {
    throw folderLaunchError(materializedPath, message);
  }
}

type LaunchDiagnostics = {
  resolvedCommand?: string;
  resolvedArgs?: string[];
};

async function launchTarget(
  itemId: string,
  target: LaunchTarget,
  context: LaunchContext,
  launchMode: LaunchAccessMode,
): Promise<LaunchDiagnostics> {
  if (target.kind === "web") {
    await launchWebTarget(target.url, context, (url) => shell.openExternal(url));
    runtimeRegistry?.recordHandoff(itemId, "web");
    return {};
  }
  if (target.kind === "process") {
    const result = await launchProcessTarget(target, context);
    await runtimeRegistry?.registerProcess({
      entryId: itemId,
      kind: "process",
      command: result.command,
      args: result.args,
      receipt: result.receipt,
      launchMode,
    });
    return { resolvedCommand: result.command, resolvedArgs: result.args };
  }
  if (target.kind === "labview-dev") {
    const materialized = materializeLabviewDeveloperTarget(target, context);
    const result = await launchMaterializedProcess(materialized, context);
    await runtimeRegistry?.registerProcess({
      entryId: itemId,
      kind: "labview-dev",
      command: result.command,
      args: result.args,
      receipt: result.receipt,
      launchMode,
    });
    return { resolvedCommand: result.command, resolvedArgs: result.args };
  }
  if (target.kind === "labview-epics") {
    const materialized = materializeLabviewEpicsTarget(target, context);
    const result = await launchMaterializedProcess(materialized, context);
    await runtimeRegistry?.registerProcess({
      entryId: itemId,
      kind: "labview-epics",
      command: result.command,
      args: result.args,
      receipt: result.receipt,
      launchMode,
    });
    return { resolvedCommand: result.command, resolvedArgs: result.args };
  }
  if (target.kind === "phoebus") {
    const plans = materializePhoebusTarget(target, context);
    let ensured;
    try {
      ensured = await phoebusServers.ensureServer(plans.server, async (serverPlan) => {
        const started = await launchMaterializedProcess(serverPlan, context);
        return started.receipt;
      });
      assertPhoebusLayoutApplied(plans.layoutRequested, ensured.state, plans.server.port);
    } catch (error) {
      throw attachLaunchDiagnostics(error, plans.server);
    }
    if (plans.openResource) {
      const opened = await launchMaterializedProcess(plans.openResource, context);
      runtimeRegistry?.recordPhoebus({
        entryId: itemId,
        port: plans.server.port,
        ownership: ensured.state,
        resource: plans.openResource.args?.at(-1),
      });
      return { resolvedCommand: opened.command, resolvedArgs: opened.args };
    }
    runtimeRegistry?.recordPhoebus({
      entryId: itemId,
      port: plans.server.port,
      ownership: ensured.state,
    });
    return {
      resolvedCommand: plans.server.command,
      resolvedArgs: plans.server.args ?? [],
    };
  }
  await launchFolderTarget(target.path, context);
  runtimeRegistry?.recordHandoff(itemId, "folder");
  return {};
}

// ---------------------------------------------------------------------------
// IPC.
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {
  ipcMain.handle("launcher:get-config", async (): Promise<LauncherConfig> => publicConfig());
  ipcMain.handle(
    "launcher:get-runtime-states",
    async (): Promise<RuntimeSnapshot> => runtimeSnapshot(),
  );

  ipcMain.handle("launcher:launch-item", async (_event, itemId: unknown): Promise<LaunchResult> => {
    const startedAt = Date.now();
    const nowIso = new Date().toISOString();

    if (typeof itemId !== "string" || !itemId.trim()) {
      logEvent("warn", "Launch requested with an invalid id", { itemId: String(itemId) });
      return { ok: false, id: String(itemId), label: "(invalid id)", kind: "unknown", error: "Invalid launcher item id.", launchedAt: nowIso };
    }

    const currentConfig = loaded;
    const target = currentConfig?.targetsById.get(itemId);
    const label = currentConfig?.labelsById.get(itemId) ?? itemId;
    const accessPolicy = currentConfig?.accessPoliciesById.get(itemId);

    if (!currentConfig || !target || !accessPolicy) {
      logEvent("warn", "Launch requested for unknown id", { id: itemId });
      return { ok: false, id: itemId, label, kind: "unknown", error: `Unknown launcher item id: ${itemId}`, launchedAt: nowIso };
    }

    try {
      const policyResult = await entryLaunchGate.run(itemId, async () =>
        {
          await lifecycleCoordinator?.refresh(itemId);
          return await runWithLaunchPolicy(
            {
              entryId: itemId,
              policy: accessPolicy,
              runtime: runtimeRegistry?.getState(itemId),
              instances: [
                ...(runtimeRegistry?.getProcessRecords(itemId).map((record) => ({
                  state: record.state,
                  launchMode: record.launchMode,
                })) ?? []),
                ...(lifecycleCoordinator?.policyInstances(itemId) ?? []),
              ],
            },
            async () => {
              if (isConstrainedLaunchPolicy(accessPolicy)) {
                await lifecycleCoordinator?.acquireReservation({
                  entryId: itemId,
                  launchMode: accessPolicy.launchMode,
                  ...(accessPolicy.maxInstances !== undefined
                    ? { maxInstances: accessPolicy.maxInstances }
                    : {}),
                  writeModeExclusive: accessPolicy.writeModeExclusive,
                });
              }
              try {
                const result = await launchTarget(
                  itemId,
                  target,
                  currentConfig.context,
                  accessPolicy.launchMode,
                );
                await lifecycleCoordinator?.flush();
                return result;
              } catch (error) {
                await lifecycleCoordinator?.releasePendingReservation(itemId);
                throw error;
              }
            },
            {
              confirmOverride: async (reason) => {
                const result = await dialog.showMessageBox({
                  type: "warning",
                  buttons: ["Cancel", "Launch another instance"],
                  defaultId: 0,
                  cancelId: 0,
                  noLink: true,
                  title: "Launch restriction",
                  message: `Launch another instance of ${label}?`,
                  detail: reason,
                });
                const allowed = result.response === 1;
                logEvent("warn", "Launch policy prompt resolved", {
                  id: itemId,
                  allowed,
                  reason,
                });
                return allowed;
              },
            },
          );
        },
      );
      const unperformed = describeUnperformedLaunch(itemId, policyResult);
      if (unperformed) {
        logEvent("warn", "Launch was not performed by the access policy", {
          id: itemId,
          focused: policyResult.focused,
        });
        return {
          ok: false,
          id: itemId,
          label,
          kind: target.kind,
          error: unperformed,
          launchedAt: nowIso,
        };
      }
      const diagnostics = policyResult.value ?? {};
      const durationMs = Date.now() - startedAt;
      logLaunch({ id: itemId, label, target, ...diagnostics, ok: true, durationMs });
      return { ok: true, id: itemId, label, kind: target.kind, launchedAt: nowIso };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const diagnostics = diagnosticsFromError(error);
      logLaunch({
        id: itemId,
        label,
        target,
        ...diagnostics,
        ok: false,
        error: errorMessage,
        durationMs,
      });
      return { ok: false, id: itemId, label, kind: target.kind, error: errorMessage, launchedAt: nowIso };
    }
  });
}

// ---------------------------------------------------------------------------
// Bootstrap.
// ---------------------------------------------------------------------------

// FR1-FR5 — fetch the git configuration repo and resolve this machine's host and
// zone documents. Returns undefined when the feature is switched off, in which
// case the launcher's behaviour is unchanged from before this feature.
//
// Nothing here mutates launcher state: the result is handed to the config loader
// as an overlay, and `loaded` is only assigned once a complete, validated
// ParsedConfig exists. A failure at any step therefore lands in the same error
// window as any other config failure, never a half-configured launcher.
async function resolveGitConfig(): Promise<DynamicConfigResult | undefined> {
  const options = readDynamicConfigEnv(process.env, {
    cacheDir: path.join(app.getPath("userData"), "config-repo"),
  });
  if (!options) {
    return undefined;
  }
  try {
    return await resolveDynamicConfig(options, await defaultDeps());
  } catch (error) {
    // Redact before the message can reach a log line or the error window.
    throw new Error(redactError(error, options.token));
  }
}

async function bootstrap(): Promise<void> {
  initLogger(path.join(app.getPath("logs"), "launcher.log.jsonl"));

  let configPath: string | undefined;
  let gitConfig: DynamicConfigResult | undefined;
  try {
    gitConfig = await resolveGitConfig();
    configPath = await resolveConfigPath();
    loaded = loadConfigFromFile(configPath, {
      appRoot: app.getAppPath(),
      configDir: path.dirname(configPath),
      catalogCacheDir: path.join(app.getPath("userData"), "catalog-cache"),
      ...(gitConfig ? { overlay: gitConfig.overlay } : {}),
    });
    hmiApi = createHmiApiAdapter(loaded.context.local.hmiApi);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("error", "Config load failed", { configPath: configPath ?? null, error: message });
    // Register a minimal IPC surface so a stray renderer request cannot crash,
    // then show the error window and keep the process alive so the user sees it.
    registerIpcHandlers();
    showConfigErrorWindow(message, configPath);
    return;
  }

  logEvent("info", "Config loaded", {
    configPath,
    rows: loaded.rows.length,
    quickActions: loaded.quickActions.length,
    moreActions: loaded.moreActions.length,
    logFile: getLogFilePath(),
    catalogStale: loaded.catalogStatus.stale,
  });

  // NFR8 — everything an operator needs to answer "which config is this?".
  if (gitConfig) {
    const provenance = gitConfig.provenance;
    logEvent(provenance.source === "cached" ? "warn" : "info", "Config repo resolved", {
      ...provenance,
      // The URL may embed userinfo if an operator pasted credentials into it.
      url: redactError(provenance.url, process.env[ "ELI_LAUNCHER_CONFIG_REPO_TOKEN" ]),
    });
    if (provenance.source === "cached") {
      logEvent(
        "warn",
        `Launcher started on a CACHED config repo commit ${provenance.commitSha} fetched at ` +
          `${provenance.fetchedAt}; the remote could not be reached.`,
      );
    }
    for (const warning of gitConfig.warnings) {
      logEvent("warn", "Config repo warning", { warning });
    }
    logEvent("debug", "Effective configuration resolved", {
      effectiveConfig: buildEffectiveConfig(loaded, gitConfig.provenance),
    });
  }

  for (const warning of loaded.catalogStatus.warnings) {
    logEvent("warn", "Catalog source warning", { warning });
  }

  if (loaded.context.security.allowedCommandRoots.length === 0) {
    logEvent("warn", "No security.allowedCommandRoots configured: process targets may run any absolute command. Consider adding an allow-list for production deployments.");
  }

  runtimeRegistry = new RuntimeRegistry({
    reconcileIntervalMs: loaded.context.local.monitoring.reconcileIntervalMs,
    onChange: (snapshot) => {
      broadcastRuntimeSnapshot(snapshot);
      lifecycleCoordinator?.observeSnapshot(snapshot);
    },
    onError: (error) => {
      logEvent("error", "Runtime reconciliation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  lifecycleCoordinator = new HmiLifecycleCoordinator(hmiApi, {
    getSnapshot: () => runtimeRegistry?.snapshot() ?? emptyRuntimeSnapshot(),
    getProcessRecords: () => runtimeRegistry?.getProcessRecords() ?? [],
    onHealthChange: (health) => {
      broadcastRuntimeSnapshot(runtimeSnapshot());
      if (health.status !== lastLifecycleHealthStatus) {
        logEvent(health.status === "connected" ? "info" : "warn", "HMI lifecycle API state changed", {
          status: health.status,
          reason: health.reason ?? null,
          lastSuccessAt: health.lastSuccessAt ?? null,
          contract: "local-launcher-lifecycle",
        });
        lastLifecycleHealthStatus = health.status;
      }
    },
    onError: (error) => {
      logEvent("error", "HMI lifecycle coordination failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  runtimeRegistry.start();
  await lifecycleCoordinator.start();

  registerIpcHandlers();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}

app
  .whenReady()
  .then(bootstrap)
  .catch((error: unknown) => {
    // Last-resort guard. Config errors are handled above with a visible window;
    // reaching here means something lower-level failed.
    const message = error instanceof Error ? error.message : String(error);
    logEvent("error", "Fatal startup error", { error: message });
    showConfigErrorWindow(message, undefined);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

async function shutdownLifecycle(): Promise<void> {
  if (lifecycleCoordinator) {
    await lifecycleCoordinator.stop();
  }
}

app.on("before-quit", (event) => {
  runtimeRegistry?.stop();
  if (!lifecycleCoordinator || lifecycleShutdownStarted) {
    return;
  }
  event.preventDefault();
  lifecycleShutdownStarted = true;
  void shutdownLifecycle()
    .catch((error: unknown) => {
      logEvent("warn", "Lifecycle shutdown deadline failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => app.quit());
});
