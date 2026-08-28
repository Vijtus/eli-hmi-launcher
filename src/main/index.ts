import { app, BrowserWindow, dialog, shell } from "electron";
import os from "node:os";
import path from "node:path";
import { redactError } from "./catalog/auth";
import { buildEffectiveConfig } from "./catalog/effective";
import { loadApplicationConfig, resolveApplicationConfigPath } from "./config/application";
import type { ParsedConfig } from "./config/load";
import { createDiagnosticsSession } from "./diagnostics/session";
import { getLogFilePath, initLogger, logEvent } from "./diagnostics/log";
import { electronSecretStore } from "./catalog/secret-store";
import {
  clearSettingsFor,
  readSettingsView,
  saveSettingsFrom,
  testSettings,
  type SettingsServiceDeps,
} from "./catalog/settings-service";
import { registerIpc } from "./ipc";
import { createLauncher } from "./launch";
import { PhoebusServerManager } from "./launch/phoebus-server";
import { createRuntime, type ApplicationRuntime } from "./runtime";
import { DEFAULT_RUNTIME_RECONCILE_INTERVAL_MS } from "./runtime/registry";
import { IPC } from "../shared/ipc";
import {
  PRODUCT_NAME,
  type ConfigLocation,
  type LauncherConfig,
  type RuntimeSnapshot,
} from "../shared/types";

let loaded: ParsedConfig | undefined;
let runtime: ApplicationRuntime | undefined;
let configLocation: ConfigLocation | null = null;
let shutdownStarted = false;

function publicConfig(): LauncherConfig {
  if (!loaded) {
    return {
      productName: PRODUCT_NAME,
      rows: [],
      quickActions: [],
      moreActions: [],
      catalogStatus: { stale: false, sources: [], warnings: [] },
    };
  }
  return {
    productName: loaded.productName,
    ...(loaded.siteName ? { siteName: loaded.siteName } : {}),
    rows: loaded.rows,
    quickActions: loaded.quickActions,
    moreActions: loaded.moreActions,
    catalogStatus: loaded.catalogStatus,
  };
}

function runtimeSnapshot(): RuntimeSnapshot {
  return runtime?.snapshot() ?? {
    generatedAt: new Date().toISOString(),
    reconcileIntervalMs: DEFAULT_RUNTIME_RECONCILE_INTERVAL_MS,
    items: [],
  };
}

function broadcastRuntimeSnapshot(snapshot: RuntimeSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC.runtimeStates, snapshot);
    }
  }
}

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
    void window.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void window.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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
<title>${PRODUCT_NAME} — configuration error</title>
<style>
:root { color-scheme: dark; background: #000000; color: #ffffff; }
body { margin: 0; padding: 1.5rem 1.75rem; background: #000000; color: #ffffff; font-family: "Segoe UI", Arial, sans-serif; }
h1 { margin: 0 0 1rem; font-size: 1.1rem; letter-spacing: .04em; text-transform: uppercase; }
.msg { border: 2px solid #ffffff; padding: 1rem; white-space: pre-wrap; word-break: break-word; font-family: Consolas, monospace; }
.path, ul { font-size: .9rem; line-height: 1.5; }
</style></head><body>
<h1>Launcher configuration error</h1>
<div class="msg">${escapeHtml(message)}</div>
<p class="path">Config file: <code>${escapeHtml(configPath ?? "(not resolved)")}</code></p>
<ul><li>Fix the YAML and restart the launcher.</li><li>Use <code>ELI_LAUNCHER_CONFIG</code> to select another file.</li><li>Validate with <code>npm run validate-config -- &lt;path&gt;</code>.</li></ul>
</body></html>`;
  void window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}

const diagnostics = createDiagnosticsSession({
  appVersion: app.getVersion(),
  hostname: os.hostname(),
  platform: process.platform,
  arch: process.arch,
  electronVersion: process.versions.electron ?? "unknown",
  homeDir: app.getPath("home"),
  userDataDir: app.getPath("userData"),
  env: process.env,
  getConfig: () => loaded,
});

const launcher = createLauncher({
  getConfig: () => loaded,
  getRuntime: () => runtime?.registry,
  phoebusServers: new PhoebusServerManager(),
  openExternal: (url) => shell.openExternal(url),
  openPath: (targetPath) => shell.openPath(targetPath),
  confirmOverride: async (label, reason) => {
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
    return result.response === 1;
  },
  captureFileFor: diagnostics.captureFileFor,
  watchLaunch: diagnostics.watchLaunch,
  recordLaunch: diagnostics.recordLaunch,
});

// Everything the settings screen needs, gathered once. `env` is process.env so
// the screen can report which fields the environment is overriding.
function settingsDeps(): SettingsServiceDeps {
  return {
    userDataDir: app.getPath("userData"),
    secrets: electronSecretStore(),
    env: process.env,
    hostname: () => os.hostname(),
  };
}

function installIpc(): void {
  registerIpc({
    getConfig: publicConfig,
    getRuntimeSnapshot: runtimeSnapshot,
    launch: launcher,
    getFieldReport: diagnostics.info,
    getConfigLocation: () => configLocation,
    getRepoSettings: () => readSettingsView(settingsDeps()),
    saveRepoSettings: (settings) => saveSettingsFrom(settingsDeps(), settings),
    clearRepoSettings: () => clearSettingsFor(settingsDeps()),
    testRepoSettings: (settings) => testSettings(settingsDeps(), settings),
    // Settings only take effect at startup, because that is when the catalog is
    // resolved. Restarting is honest about that rather than pretending a live
    // reload happened.
    restartApp: () => {
      app.relaunch();
      app.exit(0);
    },
  });
}

async function main(): Promise<void> {
  diagnostics.start();
  initLogger(path.join(app.getPath("logs"), "launcher.log.jsonl"));

  let configPath: string | undefined;
  try {
    configPath = await resolveApplicationConfigPath();
    const applicationConfig = await loadApplicationConfig(configPath);
    loaded = applicationConfig.config;
    configLocation = { path: configPath, editable: applicationConfig.editable };

    logEvent("info", "Config loaded", {
      configPath,
      rows: loaded.rows.length,
      logFile: getLogFilePath(),
      catalogStale: loaded.catalogStatus.stale,
    });

    const gitConfig = applicationConfig.gitConfig;
    if (gitConfig) {
      const provenance = gitConfig.provenance;
      logEvent(provenance.source === "cached" ? "warn" : "info", "Config repo resolved", {
        ...provenance,
        url: redactError(
          provenance.url,
          process.env["ELI_LAUNCHER_CONFIG_REPO_TOKEN"],
          process.env["ELI_LAUNCHER_CONFIG_REPO_USERNAME"],
        ),
      });
      logEvent("debug", "Effective configuration resolved", {
        effectiveConfig: buildEffectiveConfig(loaded, provenance),
      });
      for (const warning of gitConfig.warnings) logEvent("warn", "Config repo warning", { warning });
    }
    for (const warning of loaded.catalogStatus.warnings) logEvent("warn", "Catalog warning", { warning });
    if (loaded.context.security.allowedCommandRoots.length === 0) {
      logEvent("warn", "No command allow-list configured");
    }

    diagnostics.writeStartup(configPath, gitConfig);
    runtime = createRuntime(loaded, broadcastRuntimeSnapshot);
    runtime.start();
    installIpc();
    createMainWindow();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("error", "Config load failed", { configPath: configPath ?? null, error: message });
    await diagnostics.writeStartupFailure(configPath, message);
    installIpc();
    showConfigErrorWindow(message, configPath);
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

app.whenReady().then(main).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logEvent("error", "Fatal startup error", { error: message });
  showConfigErrorWindow(message, undefined);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  void diagnostics.rewriteOnExit()
    .then(() => runtime?.stop())
    .catch((error: unknown) => logEvent("warn", "Shutdown cleanup failed", {
      error: error instanceof Error ? error.message : String(error),
    }))
    .finally(() => app.quit());
});
