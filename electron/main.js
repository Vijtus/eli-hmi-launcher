import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let launcherConfig = {
  appName: "ELI HMI Launcher",
  menu: [],
};

function getConfigPath() {
  if (process.env.ELI_LAUNCHER_CONFIG) {
    return path.resolve(process.env.ELI_LAUNCHER_CONFIG);
  }

  return path.join(app.getAppPath(), "config", "launcher.yaml");
}

function collectLaunchables(nodes, launchablesById) {
  for (const node of nodes) {
    const launchables = Array.isArray(node?.launchables) ? node.launchables : [];

    for (const launchable of launchables) {
      if (launchable?.id) {
        launchablesById.set(launchable.id, launchable);
      }
    }

    const children = Array.isArray(node?.children) ? node.children : [];
    collectLaunchables(children, launchablesById);
  }
}

async function loadLauncherConfig() {
  const configPath = getConfigPath();
  const fileContent = await readFile(configPath, "utf8");
  const parsed = YAML.parse(fileContent);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Launcher config is empty or invalid.");
  }

  const menu = Array.isArray(parsed.menu) ? parsed.menu : [];
  const launchablesById = new Map();
  collectLaunchables(menu, launchablesById);

  launcherConfig = {
    appName: typeof parsed.appName === "string" ? parsed.appName : "ELI HMI Launcher",
    menu,
    launchablesById,
  };
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

async function launchWebTarget(url) {
  const parsedUrl = new URL(url);

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Only HTTP(S) URLs are allowed for web launchables.");
  }

  await shell.openExternal(url);
}

function launchExecutable(command, args = [], cwd) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    shell: false,
    cwd: cwd || undefined,
  });

  child.unref();
}

function registerIpcHandlers() {
  ipcMain.handle("launcher:get-config", async () => {
    return {
      appName: launcherConfig.appName,
      menu: launcherConfig.menu,
    };
  });

  ipcMain.handle("launcher:launch-item", async (_event, itemId) => {
    const item = launcherConfig.launchablesById.get(itemId);

    if (!item) {
      throw new Error(`Unknown launcher item id: ${itemId}`);
    }

    if (item.type === "web") {
      if (typeof item.url !== "string" || !item.url) {
        throw new Error(`Invalid URL for item ${itemId}`);
      }

      await launchWebTarget(item.url);
      return { ok: true };
    }

    if (item.type === "executable") {
      if (typeof item.command !== "string" || !item.command) {
        throw new Error(`Invalid executable command for item ${itemId}`);
      }

      const args = Array.isArray(item.args) ? item.args.map((value) => String(value)) : [];
      const cwd = typeof item.cwd === "string" ? item.cwd : undefined;
      launchExecutable(item.command, args, cwd);
      return { ok: true };
    }

    throw new Error(`Unsupported launcher item type for ${itemId}`);
  });
}

app.whenReady().then(async () => {
  await loadLauncherConfig();
  registerIpcHandlers();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
