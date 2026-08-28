import { app } from "electron";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { redactError } from "../catalog/auth";
import { defaultDeps } from "../catalog/repo";
import { readDynamicConfigEnv, resolveDynamicConfig, type DynamicConfigResult } from "../catalog/load";
import { environmentWithSettings, loadSettings } from "../catalog/settings";
import { electronSecretStore } from "../catalog/secret-store";
import { logEvent } from "../diagnostics/log";
import { loadConfigFromFile, type ParsedConfig } from "./load";
import { buildConfigCandidates, resolveAppRoot, type AppLocation } from "./paths";

export type LoadedApplicationConfig = {
  config: ParsedConfig;
  configPath: string;
  editable: boolean;
  gitConfig?: DynamicConfigResult;
};

function resourcesPath(): string | undefined {
  const electronProcess = process as typeof process & { resourcesPath?: string };
  return typeof electronProcess.resourcesPath === "string" ? electronProcess.resourcesPath : undefined;
}

export function currentAppLocation(): AppLocation {
  return {
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: resourcesPath(),
    executableDir: path.dirname(process.execPath),
    cwd: process.cwd(),
    userDataDir: app.getPath("userData"),
    portableDir: process.env["PORTABLE_EXECUTABLE_DIR"],
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveApplicationConfigPath(): Promise<string> {
  const explicit = process.env["ELI_LAUNCHER_CONFIG"];
  if (explicit) {
    return path.resolve(explicit);
  }
  for (const candidate of buildConfigCandidates(currentAppLocation())) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "No launcher config found. Set ELI_LAUNCHER_CONFIG or place config/launcher.yaml next to the app.",
  );
}

async function bundledConfigRepoDir(): Promise<string | undefined> {
  const candidate = path.join(resolveAppRoot(currentAppLocation()), "config-repo");
  return (await exists(path.join(candidate, "launcher"))) ? candidate : undefined;
}

async function configDeclaresEntries(configPath: string): Promise<boolean> {
  try {
    const parsed = YAML.parse(await readFile(configPath, "utf8")) as unknown;
    const entries = (parsed as { entries?: unknown } | null)?.entries;
    return Array.isArray(entries) && entries.length > 0;
  } catch {
    return false;
  }
}

async function resolveGitConfig(localOwnsCatalog: boolean): Promise<DynamicConfigResult | undefined> {
  const bundled = await bundledConfigRepoDir();
  // Settings entered in the launcher fill in underneath the real environment, so
  // an operator can configure this without a terminal while a machine set up by
  // a deployment script keeps behaving exactly as before. The environment wins;
  // see catalog/settings.ts.
  const env = environmentWithSettings(
    process.env,
    loadSettings(app.getPath("userData"), electronSecretStore()),
  );
  const options = readDynamicConfigEnv(env, {
    cacheDir: path.join(app.getPath("userData"), "config-repo"),
    ...(bundled ? { localDir: bundled } : {}),
  });
  if (!options) {
    return undefined;
  }

  const bundledOnly =
    !env["ELI_LAUNCHER_CONFIG_REPO_URL"] &&
    !env["ELI_LAUNCHER_CONFIG_REPO_DIR"] &&
    Boolean(bundled);
  if (bundledOnly && localOwnsCatalog) {
    logEvent("info", "Local config defines entries; bundled catalog not applied");
    return undefined;
  }

  try {
    return await resolveDynamicConfig(options, await defaultDeps());
  } catch (error) {
    const message = redactError(error, options.token, options.username);
    if (bundledOnly) {
      logEvent("warn", "Bundled catalog does not cover this machine", { error: message });
      return undefined;
    }
    throw new Error(message);
  }
}

export async function loadApplicationConfig(configPath?: string): Promise<LoadedApplicationConfig> {
  const resolvedConfigPath = configPath ?? (await resolveApplicationConfigPath());
  const gitConfig = await resolveGitConfig(await configDeclaresEntries(resolvedConfigPath));
  const appRoot = resolveAppRoot(currentAppLocation());
  const config = loadConfigFromFile(resolvedConfigPath, {
    appRoot,
    configDir: path.dirname(resolvedConfigPath),
    catalogCacheDir: path.join(app.getPath("userData"), "catalog-cache"),
    ...(gitConfig ? { overlay: gitConfig.overlay } : {}),
  });

  return {
    config,
    configPath: resolvedConfigPath,
    editable: !app.isPackaged || !resolvedConfigPath.startsWith(appRoot),
    ...(gitConfig ? { gitConfig } : {}),
  };
}
