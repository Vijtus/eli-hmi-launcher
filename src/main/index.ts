import { app, BrowserWindow, ipcMain, shell } from "electron";
import { access } from "node:fs/promises";
import path from "node:path";
import {
  assertCommandAllowed,
  assertWebUrlAllowed,
  loadConfigFromFile,
  materializeProcessTarget,
  resolveConfiguredPath,
  type LaunchContext,
  type ParsedConfig,
} from "./config";
import { getLogFilePath, initLogger, logEvent, logLaunch } from "./logger";
import {
  assertCommandPathUsable,
  assertFolderPathUsable,
  assertResolvedValueNotEmpty,
  assertWorkingDirectoryUsable,
} from "./launch-validation";
import {
  folderLaunchError,
  launchErrorCode,
  processLaunchError,
  webLaunchError,
} from "./launch-errors";
import { spawnDetached } from "./process-launcher";
import type {
  LaunchResult,
  LaunchTarget,
  LauncherConfig,
  ProcessLaunchTarget,
} from "../shared/types";

const DEFAULT_APP_NAME = "L4 Launcher";

let loaded: ParsedConfig | undefined;

function publicConfig(): LauncherConfig {
  if (!loaded) {
    return { appName: DEFAULT_APP_NAME, rows: [], quickActions: [], moreActions: [] };
  }
  return {
    appName: loaded.appName,
    rows: loaded.rows,
    quickActions: loaded.quickActions,
    moreActions: loaded.moreActions,
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

async function launchWebTarget(url: string, context: LaunchContext): Promise<void> {
  let resolvedUrl = url;
  try {
    const parsed = assertWebUrlAllowed(url, context);
    resolvedUrl = parsed.toString();
    await shell.openExternal(resolvedUrl);
  } catch (error) {
    throw webLaunchError(resolvedUrl, error);
  }
}

async function launchProcessTarget(target: ProcessLaunchTarget, context: LaunchContext): Promise<string> {
  const materialized = materializeProcessTarget(target, context);
  assertResolvedValueNotEmpty(materialized.command, "process command");
  if (materialized.cwd !== undefined) {
    assertResolvedValueNotEmpty(materialized.cwd, "working directory");
  }

  // Authoritative security gate: enforce the command allow-list against the
  // exact command that will be spawned on this platform.
  assertCommandAllowed(materialized.command, context.security);

  // Pre-flight checks so a bad config path produces a readable error instead of
  // a raw ENOENT. A command with a path separator has already been resolved to
  // an absolute path; a bare name is resolved via the OS PATH by spawn itself.
  const hasSeparator = materialized.command.includes("/") || materialized.command.includes("\\");
  if (hasSeparator) {
    await assertCommandPathUsable(materialized.command);
  }
  if (materialized.cwd) {
    await assertWorkingDirectoryUsable(materialized.cwd);
  }

  try {
    await spawnDetached(materialized.command, materialized.args ?? [], materialized.cwd, materialized.env);
  } catch (error) {
    const code = launchErrorCode(error);
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
      // Re-check both paths so a directory or command changed after pre-flight
      // is reported accurately instead of every ENOENT being blamed on PATH.
      if (materialized.cwd) {
        await assertWorkingDirectoryUsable(materialized.cwd);
      }
      if (hasSeparator) {
        await assertCommandPathUsable(materialized.command);
      }
    }
    throw processLaunchError(materialized.command, error);
  }
  return materialized.command;
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

// Returns the resolved command (process targets only) for diagnostics logging.
async function launchTarget(target: LaunchTarget, context: LaunchContext): Promise<string | undefined> {
  if (target.kind === "web") {
    await launchWebTarget(target.url, context);
    return undefined;
  }
  if (target.kind === "process") {
    return await launchProcessTarget(target, context);
  }
  await launchFolderTarget(target.path, context);
  return undefined;
}

// ---------------------------------------------------------------------------
// IPC.
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {
  ipcMain.handle("launcher:get-config", async (): Promise<LauncherConfig> => publicConfig());

  ipcMain.handle("launcher:launch-item", async (_event, itemId: unknown): Promise<LaunchResult> => {
    const startedAt = Date.now();
    const nowIso = new Date().toISOString();

    if (typeof itemId !== "string" || !itemId.trim()) {
      logEvent("warn", "Launch requested with an invalid id", { itemId: String(itemId) });
      return { ok: false, id: String(itemId), label: "(invalid id)", kind: "unknown", error: "Invalid launcher item id.", launchedAt: nowIso };
    }

    const target = loaded?.targetsById.get(itemId);
    const label = loaded?.labelsById.get(itemId) ?? itemId;

    if (!loaded || !target) {
      logEvent("warn", "Launch requested for unknown id", { id: itemId });
      return { ok: false, id: itemId, label, kind: "unknown", error: `Unknown launcher item id: ${itemId}`, launchedAt: nowIso };
    }

    try {
      const resolvedCommand = await launchTarget(target, loaded.context);
      const durationMs = Date.now() - startedAt;
      logLaunch({ id: itemId, label, target, resolvedCommand, ok: true, durationMs });
      return { ok: true, id: itemId, label, kind: target.kind, launchedAt: nowIso };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logLaunch({ id: itemId, label, target, ok: false, error: errorMessage, durationMs });
      return { ok: false, id: itemId, label, kind: target.kind, error: errorMessage, launchedAt: nowIso };
    }
  });
}

// ---------------------------------------------------------------------------
// Bootstrap.
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  initLogger(path.join(app.getPath("logs"), "launcher.log.jsonl"));

  let configPath: string | undefined;
  try {
    configPath = await resolveConfigPath();
    loaded = loadConfigFromFile(configPath, { appRoot: app.getAppPath(), configDir: path.dirname(configPath) });
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
  });

  if (loaded.context.security.allowedCommandRoots.length === 0) {
    logEvent("warn", "No security.allowedCommandRoots configured: process targets may run any absolute command. Consider adding an allow-list for production deployments.");
  }

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
