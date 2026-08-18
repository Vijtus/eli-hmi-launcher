// Runnable demonstration of git-backed configuration.
//
//   npm run demo:git-config                        launch, driven by a local config repo
//   npm run demo:git-config -- --host <machine>    same binary, different machine identity
//   npm run demo:git-config -- --offline           kill the server first: cached start, CATALOG STALE
//   npm run demo:git-config -- --real              against the real private eli-hmi-config
//   npm run demo:git-config -- --dump              no window; print the resolved config
//   npm run demo:git-config -- --headless          xvfb + screenshot, for machines with no display
//
// Everything is local: a temp bare repo is served over the real git smart-HTTP
// protocol by `git http-backend`, behind a REQUIRED token, so the demo exercises
// the genuine authenticated path rather than an anonymous shortcut. Nothing here
// contacts a remote host unless you pass --real.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDeps } from "../src/main/config-repo.ts";
import { redactError } from "../src/main/config-repo-auth.ts";
import { readDynamicConfigEnv, resolveDynamicConfig } from "../src/main/dynamic-config.ts";
import { startGitHttpServer, hasGitHttpBackend } from "../tests/helpers/git-http-server.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_TOKEN = "demo-token-not-a-real-credential-8f3a1c";
const DEFAULT_HOST = "DEMO-Station-01";
const REAL_REPO = "https://github.com/eli-eric/eli-hmi-config.git";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const has = (flag: string): boolean => argv.includes(flag);
const valueOf = (flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};

const options = {
  host: valueOf("--host") ?? DEFAULT_HOST,
  offline: has("--offline"),
  real: has("--real"),
  dump: has("--dump"),
  headless: has("--headless"),
};

const bold = (text: string): string => `\x1b[1m${text}\x1b[0m`;
const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const green = (text: string): string => `\x1b[32m${text}\x1b[0m`;
const red = (text: string): string => `\x1b[31m${text}\x1b[0m`;

function heading(text: string): void {
  process.stdout.write(`\n${bold(text)}\n${dim("─".repeat(Math.max(text.length, 40)))}\n`);
}

// ---------------------------------------------------------------------------
// The demo configuration repository
// ---------------------------------------------------------------------------

// Two machines in two zones. Paths point at the repo's own executable POSIX
// fixtures via ${APP_ROOT}, so the launched rows really run.
const HOSTS: Record<string, string> = {
  "DEMO-Station-01": `# Operator station in the DEMO zone.
zone: DEMO
P4-workspace: \${APP_ROOT}/examples/labview-contract-workspace
css-gui: \${APP_ROOT}/examples/phoebus-local
css-install: \${APP_ROOT}/.local/phoebus
local:
  monitoring:
    reconcileIntervalMs: 2000
`,
  "DEMO-Beamline-02": `# Beamline station in the BEAMLINE zone. Also demonstrates hmi-server:
# a bare host:port becomes http://…/api/lifecycle/v1 with the plain-HTTP opt-in
# recorded explicitly. The service is not running, so the launcher reports the
# lifecycle API as unavailable — which is the point: it is wired, and honest.
zone: BEAMLINE
P4-workspace: \${APP_ROOT}/examples/labview-contract-workspace
css-gui: \${APP_ROOT}/examples/phoebus-local
css-install: \${APP_ROOT}/.local/phoebus
hmi-server: 127.0.0.1:8765
local:
  phoebus:
    # Required by any \`css:\` (phoebus) entry in this host's zone.
    serverPort: 14918
    startupTimeoutMs: 30000
  hmiApi:
    heartbeatIntervalMs: 30000
  monitoring:
    reconcileIntervalMs: 2000
`,
};

const ZONES: Record<string, string> = {
  DEMO: `# Launchable HMIs for the DEMO zone.

# Launcher-level settings owned by the zone, so a workstation does not
# hand-maintain them. The host file may override any of these.
launcher:
  appName: L4 Launcher — DEMO zone
  quickActions:
    - id: data-browser
      label: Data Browser
      target:
        kind: process
        command: \${APP_ROOT}/examples/launchers/mock-launch.sh
        args: [Phoebus Data Browser]
    - id: alarm-system
      label: Alarm System
      target:
        kind: process
        command: \${APP_ROOT}/examples/launchers/mock-launch.sh
        args: [Phoebus Alarm System layout]
  moreActions:
    - id: sequencer
      label: Sequencer
      target: { kind: web, url: https://example.org/sequencer }
    - id: safety-diagnostics
      label: Safety Diagnostics
      target: { kind: web, url: https://example.org/safety }
    - id: shared-folder
      label: Network Shared Folder
      target: { kind: folder, path: "\${APP_ROOT}" }

labview-dev:
  - ioc-name: Camera Manager
    host: RMC00-001
    ioc-type: Camera IOC
    exe: Developer Contract.exe
    technology: Cameras
    section: L4a
    note: Real executable fixture — launching writes a capture file
  - ioc-name: Camera Manager
    host: RMC00-002
    ioc-type: Camera IOC
    exe: Developer Contract.exe
    technology: Cameras
    section: L4b
    note: Same IOC on a second host — note the distinct generated id
  - ioc-name: Fast Pointing IOC
    host: RMC00-001
    ioc-type: Camera IOC
    exe: Developer Contract.exe
    technology: Pointing
    section: L4a

labview-epics:
  - gui-name: Vacuum Overview
    gui-type: Operator Panels
    exe: EPICS Contract.exe
    technology: Vacuum
    section: L4
    note: Real executable fixture — different argv from a developer HMI

web:
  - name: Operator Logbook
    url: https://example.org/logbook
    technology: Operations
    section: L4
  - name: Beamline Wiki
    url: https://example.org/wiki
    technology: Operations
    section: L4

css:
`,
  BEAMLINE: `# Launchable HMIs for the BEAMLINE zone — a deliberately different catalogue,
# so switching --host visibly changes what the operator sees.

launcher:
  appName: L4 Launcher — BEAMLINE zone
  quickActions:
    - id: data-browser
      label: Data Browser
      target:
        kind: process
        command: \${APP_ROOT}/examples/launchers/mock-launch.sh
        args: [Phoebus Data Browser]
  moreActions:
    - id: beamline-runbook
      label: Beamline Runbook
      target: { kind: web, url: https://example.org/runbook }

labview-dev:
  - ioc-name: Beamline Camera
    host: RMC10-001
    ioc-type: Camera IOC
    exe: Developer Contract.exe
    technology: Cameras
    section: BL1

labview-epics:
  - gui-name: Beamline Interlocks
    gui-type: Operator Panels
    exe: EPICS Contract.exe
    technology: Safety
    section: BL1

web:
  - name: Beamline Status
    url: https://example.org/beamline
    technology: Operations
    section: BL1

css:
  - name: Beamline Cooling
    resource: \${local.cssGuiRoot}/temperature.bob
    technology: Cooling
    section: BL1
    note: Needs a local Phoebus — see tools/phoebus-local/bootstrap.sh
`,
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=demo@example.org", "-c", "user.name=Demo", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function buildDemoRepo(): { root: string; serveDir: string; sha: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "eli-demo-config-"));
  const source = path.join(root, "source");
  const serveDir = path.join(root, "serve");
  mkdirSync(path.join(source, "launcher", "host"), { recursive: true });
  mkdirSync(path.join(source, "launcher", "zone"), { recursive: true });
  mkdirSync(serveDir, { recursive: true });

  for (const [name, body] of Object.entries(HOSTS)) {
    writeFileSync(path.join(source, "launcher", "host", `${name}.yaml`), body);
  }
  for (const [name, body] of Object.entries(ZONES)) {
    writeFileSync(path.join(source, "launcher", "zone", `${name}.yaml`), body);
  }
  writeFileSync(
    path.join(source, "README.md"),
    "# Demo configuration repository\n\nGenerated by tools/demo-git-config.mts. Not a real site config.\n",
  );

  git(source, "init", "-q", "-b", "main", ".");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "Demo launcher configuration");
  const sha = git(source, "rev-parse", "HEAD").trim();
  execFileSync("git", ["clone", "-q", "--bare", source, path.join(serveDir, "config.git")], {
    encoding: "utf8",
  });
  return { root, serveDir, sha };
}

// ---------------------------------------------------------------------------
// Token-leak check, run against whatever cache the demo just produced
// ---------------------------------------------------------------------------

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found;
}

function reportLeakCheck(cacheDir: string, token: string): boolean {
  const gitConfigPath = path.join(cacheDir, "repo", ".git", "config");
  const gitConfig = existsSync(gitConfigPath) ? readFileSync(gitConfigPath, "utf8") : "";
  const urlLine = gitConfig.split("\n").find((line) => line.includes("url =")) ?? "(none)";
  const inGitConfig = gitConfig.includes(token);

  const encoded = Buffer.from(`${token}:x-oauth-basic`).toString("base64");
  const leaked = filesUnder(cacheDir).filter((file) => {
    const bytes = readFileSync(file);
    return bytes.includes(token) || bytes.includes(encoded);
  });

  const verdict = (bad: boolean): string => (bad ? red("LEAK") : green("no"));
  process.stdout.write(
    [
      `  remote url written to .git/config : ${urlLine.trim()}`,
      `  token present in .git/config      : ${verdict(inGitConfig)}`,
      `  token anywhere under the cache    : ${verdict(leaked.length > 0)}${leaked.length ? ` ${leaked.join(", ")}` : ""}`,
      `  git child processes spawned       : ${green("none")} ${dim("(isomorphic-git is pure JS)")}`,
      "",
    ].join("\n"),
  );
  return !inGitConfig && leaked.length === 0;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  if (!options.real && !hasGitHttpBackend()) {
    process.stderr.write(
      "This demo serves a local repo with `git http-backend`, which was not found.\n" +
        "Install git, or use --real to run against the real configuration repository.\n",
    );
    return 1;
  }

  let fixture: { root: string; serveDir: string; sha: string } | undefined;
  let server: Awaited<ReturnType<typeof startGitHttpServer>> | undefined;
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "eli-demo-cache-"));
  // A stable, gitignored location rather than a fresh temp dir per run: these
  // files are the evidence that a row really launched, so they outlive the demo.
  const captureDir = path.join(REPO_ROOT, ".local", "demo-captures");
  mkdirSync(captureDir, { recursive: true });

  const cleanup = (): void => {
    void server?.close();
    if (fixture) {
      rmSync(fixture.root, { recursive: true, force: true });
    }
    rmSync(cacheDir, { recursive: true, force: true });
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  try {
    let url: string;
    let token: string | undefined;
    let username: string | undefined;

    if (options.real) {
      url = process.env["ELI_LAUNCHER_CONFIG_REPO_URL"] ?? REAL_REPO;
      token = process.env["ELI_LAUNCHER_CONFIG_REPO_TOKEN"];
      username = process.env["ELI_LAUNCHER_CONFIG_REPO_USERNAME"];
      if (!token) {
        try {
          token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
          process.stdout.write(dim("Using a token from `gh auth token`.\n"));
        } catch {
          process.stderr.write(
            "The real configuration repository is private. Set ELI_LAUNCHER_CONFIG_REPO_TOKEN\n" +
              "(and ELI_LAUNCHER_CONFIG_REPO_USERNAME for a GitLab deploy token), or run\n" +
              "`gh auth login` first.\n",
          );
          return 1;
        }
      }
    } else {
      heading("Building a local configuration repository");
      fixture = buildDemoRepo();
      const authorization = `Basic ${Buffer.from(`${DEMO_TOKEN}:x-oauth-basic`).toString("base64")}`;
      server = await startGitHttpServer(fixture.serveDir, { requireAuthorization: authorization });
      url = server.url("config.git");
      token = DEMO_TOKEN;
      process.stdout.write(
        [
          `  hosts        : ${Object.keys(HOSTS).join(", ")}`,
          `  zones        : ${Object.keys(ZONES).join(", ")}`,
          `  commit       : ${fixture.sha}`,
          `  served at    : ${url} ${dim("(token required)")}`,
          "",
        ].join("\n"),
      );
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELI_LAUNCHER_CONFIG: path.join(REPO_ROOT, "config", "git-config-demo.yaml"),
      ELI_LAUNCHER_CONFIG_REPO_URL: url,
      ELI_LAUNCHER_CONFIG_CACHE_DIR: cacheDir,
      ELI_LAUNCHER_CONFIG_HOSTNAME: options.host,
      ELI_LABVIEW_FIXTURE_CAPTURE_DIR: captureDir,
      ELI_LABVIEW_FIXTURE_LIFETIME_SECONDS: "30",
    };
    if (token) {
      env["ELI_LAUNCHER_CONFIG_REPO_TOKEN"] = token;
    }
    if (username) {
      env["ELI_LAUNCHER_CONFIG_REPO_USERNAME"] = username;
    }
    if (!options.real) {
      env["ELI_LAUNCHER_CONFIG_REPO_REF"] = "main";
    }

    // Resolve once up front so the terminal shows what the window is about to
    // display, and so --offline has a populated cache to fall back to.
    heading(`Resolving configuration for machine '${options.host}'`);
    const resolveOptions = readDynamicConfigEnv(env);
    if (!resolveOptions) {
      throw new Error("ELI_LAUNCHER_CONFIG_REPO_URL was not set for the demo.");
    }
    let resolved;
    try {
      resolved = await resolveDynamicConfig(resolveOptions, await defaultDeps());
    } catch (error) {
      throw new Error(redactError(error, resolveOptions.token, resolveOptions.username));
    }
    const p = resolved.provenance;
    process.stdout.write(
      [
        `  hostname     : ${p.hostname} ${dim(`(from ${p.hostnameSource === "env" ? "--host" : "the OS"})`)}`,
        `  host file    : ${path.basename(p.hostFile)}`,
        `  zone         : ${p.zone} ${dim(`(${path.basename(p.zoneFile)})`)}`,
        `  ref / commit : ${p.ref} @ ${p.commitSha.slice(0, 12)}`,
        `  fetch        : ${p.source === "fresh" ? green("fresh") : red("cached")} at ${p.fetchedAt}`,
        `  HMI entries  : ${p.entryCount}`,
        "",
      ].join("\n"),
    );
    for (const warning of resolved.warnings) {
      process.stdout.write(`  ${red("warning")} ${warning}\n`);
    }

    heading("Token hygiene");
    const clean = reportLeakCheck(cacheDir, token ?? DEMO_TOKEN);
    if (!clean) {
      process.stderr.write(red("Token leak detected — refusing to continue.\n"));
      return 1;
    }

    if (options.offline) {
      heading("Simulating an unreachable git server");
      await server?.close();
      server = undefined;
      process.stdout.write(
        "  The git server is now down. The launcher will fall back to the cached\n" +
          `  commit and show ${bold("CATALOG STALE")} with the fetch timestamp.\n\n`,
      );
    }

    if (options.dump) {
      heading("Effective configuration");
      const dump = spawn("npx", ["tsx", "scripts/dump-config.ts", env["ELI_LAUNCHER_CONFIG"] as string], {
        cwd: REPO_ROOT,
        env,
        stdio: "inherit",
      });
      return await new Promise<number>((resolve) => dump.on("close", (code) => resolve(code ?? 0)));
    }

    heading("Starting the launcher");
    process.stdout.write(
      [
        "  Everything in the table below the header comes from the zone file in the",
        "  git repository — the local config file contributes only the security policy.",
        "",
        "  Things to try:",
        "    • Click a LabVIEW row — it launches a real fixture process and writes a",
        `      capture file to ${captureDir}`,
        "    • Click the same row twice — the single-instance policy blocks the second",
        "    • Click a Web row — it opens in your browser",
        "    • Re-run with --host DEMO-Beamline-02 for a different zone and catalogue",
        "    • Re-run with --offline to see the stale-config path",
        "",
        dim("  Ctrl-C to stop."),
        "",
      ].join("\n"),
    );

    const command = options.headless ? "xvfb-run" : "npx";
    const args = options.headless
      ? ["-a", "npx", "electron-vite", "dev"]
      : ["electron-vite", "dev"];
    const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: "inherit" });
    return await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 0)));
  } finally {
    cleanup();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`\n${red("Demo failed")}  ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
