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
  process.stdout.write(
    [
      `OK  ${target}`,
      `  appName        : ${cfg.appName}`,
      `  entries        : ${cfg.rows.length}`,
      `  quickActions   : ${cfg.quickActions.length}`,
      `  moreActions    : ${cfg.moreActions.length}`,
      `  unique ids     : ${cfg.targetsById.size}`,
      `  allowedRoots   : ${sec.allowedCommandRoots.join(", ") || "(none configured — process targets are unrestricted)"}`,
      `  allowBare      : ${sec.allowBareCommands}`,
      "",
    ].join("\n"),
  );
  process.exit(0);
} catch (error) {
  process.stderr.write(`INVALID  ${target}\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
