// Validate a launcher YAML config using the exact same parser/validator/security
// logic the app uses at startup — without launching Electron.
//
//   npm run validate-config                 # validates config/launcher.yaml
//   npm run validate-config -- path/to.yaml # validates a specific file
//
// Exits 0 when valid, 1 when invalid (suitable for CI / pre-deploy checks).

import path from "node:path";
import { loadConfigFromFile } from "../src/main/config";

const arg = process.argv[2];
const target = arg ? path.resolve(arg) : path.resolve("config/launcher.yaml");

try {
  const cfg = loadConfigFromFile(target, { appRoot: process.cwd(), configDir: path.dirname(target) });
  const sec = cfg.context.security;
  const local = cfg.context.local;
  const configuredLocalKeys = [
    local.workspaceRoot && "workspaceRoot",
    local.cssGuiRoot && "cssGuiRoot",
    local.zoneSymbol && "zoneSymbol",
    local.phoebus.executable && "phoebus.executable",
    local.phoebus.serverPort !== undefined && "phoebus.serverPort",
    local.phoebus.settingsFile && "phoebus.settingsFile",
    local.phoebus.layoutFile && "phoebus.layoutFile",
    local.phoebus.startupTimeoutMs !== undefined && "phoebus.startupTimeoutMs",
    local.phoebus.resourceReadyDelayMs !== undefined && "phoebus.resourceReadyDelayMs",
    Object.keys(local.hosts).length > 0 && `hosts(${Object.keys(local.hosts).length})`,
    local.hmiApi.baseUrl && "hmiApi.baseUrl",
    local.hmiApi.stationId && "hmiApi.stationId",
    local.hmiApi.authTokenEnv && "hmiApi.authTokenEnv",
    local.hmiApi.requestTimeoutMs !== undefined && "hmiApi.requestTimeoutMs",
    local.hmiApi.heartbeatIntervalMs !== undefined && "hmiApi.heartbeatIntervalMs",
    local.monitoring.reconcileIntervalMs !== undefined && "monitoring.reconcileIntervalMs",
  ].filter(Boolean);
  const restrictedLaunches = [...cfg.accessPoliciesById.values()].filter(
    (policy) => policy.maxInstances !== undefined || policy.writeModeExclusive,
  ).length;
  process.stdout.write(
    [
      `OK  ${target}`,
      `  appName        : ${cfg.appName}`,
      `  entries        : ${cfg.rows.length}`,
      `  quickActions   : ${cfg.quickActions.length}`,
      `  moreActions    : ${cfg.moreActions.length}`,
      `  unique ids     : ${cfg.targetsById.size}`,
      `  catalog stale : ${cfg.catalogStatus.stale}`,
      `  catalog sources: ${cfg.catalogStatus.sources
        .map((source) => `${source.id}=${source.state}:${source.entryCount}`)
        .join(", ")}`,
      `  local settings : ${configuredLocalKeys.join(", ") || "(none; no current item requires them)"}`,
      `  access limited : ${restrictedLaunches}`,
      `  allowedRoots   : ${sec.allowedCommandRoots.join(", ") || "(none configured — process targets are unrestricted)"}`,
      `  allowBare      : ${sec.allowBareCommands}`,
      "",
    ].join("\n"),
  );
  for (const warning of cfg.catalogStatus.warnings) {
    process.stderr.write(`WARNING  ${warning}\n`);
  }
  process.exit(0);
} catch (error) {
  process.stderr.write(`INVALID  ${target}\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
