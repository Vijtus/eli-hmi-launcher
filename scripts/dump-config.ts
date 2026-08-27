// Print the fully resolved effective configuration for on-site
// troubleshooting, using the exact loader the launcher uses, without Electron.
//
//   npm run dump-config                 # uses config/launcher.yaml + the env vars
//   npm run dump-config -- path/to.yaml # explicit root config
//
// Secrets are redacted. Exits 0 on success, 1 with a named error on failure.

import path from "node:path";
import { loadConfigFromFile } from "../src/main/config/load";
import { defaultDeps } from "../src/main/catalog/repo";
import { redactError } from "../src/main/catalog/auth";
import { buildEffectiveConfig } from "../src/main/catalog/effective";
import { readDynamicConfigEnv, resolveDynamicConfig } from "../src/main/catalog/load";

async function main(): Promise<void> {
  const arg = process.argv[2];
  const target = arg ? path.resolve(arg) : path.resolve("config/launcher.yaml");
  const options = readDynamicConfigEnv(process.env);

  let overlay;
  let provenance;
  if (options) {
    try {
      const resolved = await resolveDynamicConfig(options, await defaultDeps());
      overlay = resolved.overlay;
      provenance = resolved.provenance;
      for (const warning of resolved.warnings) {
        process.stderr.write(`WARNING  ${warning}\n`);
      }
    } catch (error) {
      throw new Error(redactError(error, options.token, options.username));
    }
  } else {
    process.stderr.write(
      `NOTE     ELI_LAUNCHER_CONFIG_REPO_URL is not set; dumping the local config only.\n`,
    );
  }

  const parsed = loadConfigFromFile(target, {
    appRoot: process.cwd(),
    configDir: path.dirname(target),
    ...(overlay ? { overlay } : {}),
  });
  process.stdout.write(`${JSON.stringify(buildEffectiveConfig(parsed, provenance), null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`FAILED   ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
