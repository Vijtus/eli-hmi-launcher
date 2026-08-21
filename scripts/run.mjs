#!/usr/bin/env node
// Start the ELI HMI Launcher from a source checkout on any OS.
//
//   npm run app       (or: node scripts/run.mjs, ./run.sh, run.cmd)
//
// Installs dependencies on first run, validates the YAML config, then starts
// electron-vite. This replaces the bash-only logic that used to live in run.sh,
// which left Windows with no entry point at all.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");

const info = (message) => console.log(`\x1b[1;36m[run]\x1b[0m ${message}`);
const warn = (message) => console.warn(`\x1b[1;33m[run] WARNING:\x1b[0m ${message}`);
function fail(message, ...hints) {
  console.error(`\x1b[1;31m[run] ERROR:\x1b[0m ${message}`);
  for (const hint of hints) console.error(`        ${hint}`);
  process.exit(1);
}

// npm is npm.cmd on Windows, and Node refuses to spawn .cmd without a shell.
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function npmRun(args, { capture = false } = {}) {
  return spawnSync(npm, args, {
    cwd: repoRoot,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: process.platform === "win32",
    encoding: "utf8",
  });
}

// --- prerequisites ---------------------------------------------------------

function requiredNodeMajorMinor() {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const match = /(\d+)\.(\d+)/.exec(manifest.engines?.node ?? "");
  return match ? [Number(match[1]), Number(match[2])] : [20, 19];
}

const [needMajor, needMinor] = requiredNodeMajorMinor();
const [haveMajor, haveMinor] = process.versions.node.split(".").map(Number);
if (haveMajor < needMajor || (haveMajor === needMajor && haveMinor < needMinor)) {
  fail(
    `Node ${process.versions.node} is too old; need ${needMajor}.${needMinor} or newer.`,
    "Install a current Node from https://nodejs.org and re-run.",
  );
}
info(`Node ${process.version} on ${process.platform}/${process.arch}`);

// Electron needs a desktop session. macOS and Windows always have one.
if (process.platform === "linux" && !process.env["DISPLAY"] && !process.env["WAYLAND_DISPLAY"]) {
  fail(
    "No graphical display detected (DISPLAY and WAYLAND_DISPLAY are both unset).",
    "Electron needs a desktop session. Over SSH, enable X11 forwarding (ssh -X),",
    "or run headless under: xvfb-run -a npm run app",
  );
}

// --- dependencies ----------------------------------------------------------

const electronViteBin = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-vite.cmd" : "electron-vite",
);
if (!existsSync(electronViteBin)) {
  info("Installing dependencies (first run downloads Electron, ~100-200 MB)...");
  // `npm ci` installs exactly what package-lock.json pins and never rewrites it,
  // matching .github/workflows/ci.yml.
  if (npmRun(["ci"]).status !== 0) {
    fail("Dependency installation failed.");
  }
} else {
  info("Dependencies present (delete node_modules to force a clean reinstall).");
}

// --- config ----------------------------------------------------------------

info("Validating config/launcher.yaml...");
const validation = npmRun(["run", "--silent", "validate-config"], { capture: true });
if (validation.status !== 0) {
  console.error(`${validation.stdout ?? ""}${validation.stderr ?? ""}`.trimEnd());
  fail(
    "Config validation failed.",
    "Fix config/launcher.yaml (or point ELI_LAUNCHER_CONFIG elsewhere) and re-run.",
  );
}

// --- start -----------------------------------------------------------------

const mockLog = path.join(os.tmpdir(), "eli-hmi-launcher-mock.log");
info(`Starting launcher...  (mock launches -> ${mockLog})`);

const started = npmRun(["start"]);

// The single most common first-run failure on Debian-family hosts: Electron's
// SUID sandbox helper is not root-owned in a plain npm checkout.
if (started.status !== 0 && process.platform === "linux") {
  warn("Electron exited non-zero.");
  console.error(
    "        If the error mentions 'chrome-sandbox is owned by root and has mode 4755',\n" +
      "        either run once with:  ELECTRON_DISABLE_SANDBOX=1 npm run app\n" +
      "        or fix the helper:     sudo chown root node_modules/electron/dist/chrome-sandbox \\\n" +
      "                            && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox\n" +
      "        Installed packages (.deb/.rpm) set this up for you; this only affects source checkouts.",
  );
}
process.exit(started.status ?? 1);
