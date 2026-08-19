#!/usr/bin/env node
// Drives a PACKAGED build the way an operator would: start the installed
// binary, ask it to launch its first catalog entry over the real IPC path, and
// confirm the mock launcher actually ran.
//
// This is the check that a dev-mode `npm start` cannot make. Packaging changes
// where `${APP_ROOT}` points, whether config/ and examples/ exist on disk at
// all, and whether the spawned command survives asar — so "it works in dev" is
// no evidence at all that the shipped artifact works.
//
//   node scripts/smoke-packaged.mjs [path-to-binary]
//
// Runs on Windows, macOS and Linux.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const releaseDir = path.join(repoRoot, "release");
const debugPort = Number(process.env["ELI_SMOKE_DEBUG_PORT"] ?? 19334);
const mockLog = path.join(os.tmpdir(), "eli-hmi-launcher-mock.log");

function fail(message) {
  console.error(`\x1b[1;31m[smoke] FAIL:\x1b[0m ${message}`);
  process.exit(1);
}
function info(message) {
  console.log(`\x1b[1;36m[smoke]\x1b[0m ${message}`);
}

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

// electron-builder writes per-arch directories, so probe rather than guess.
function locateBinary() {
  const explicit = process.argv[2];
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!existsSync(resolved)) {
      fail(`No such binary: ${resolved}`);
    }
    return resolved;
  }
  const suffixes = ["", "-x64", "-arm64", "-ia32"];
  if (process.platform === "win32") {
    return firstExisting(
      suffixes.map((s) => path.join(releaseDir, `win-unpacked${s}`, "ELI HMI Launcher.exe")),
    );
  }
  if (process.platform === "darwin") {
    return firstExisting(
      suffixes.map((s) =>
        path.join(releaseDir, `mac${s}`, "ELI HMI Launcher.app", "Contents", "MacOS", "ELI HMI Launcher"),
      ),
    );
  }
  return firstExisting(suffixes.map((s) => path.join(releaseDir, `linux-unpacked${s}`, "eli-hmi-launcher")));
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPageTarget(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no DevTools target returned";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const target = (await response.json()).find(
          (candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl,
        );
        if (target) return target;
        lastError = "no page target yet";
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(150);
  }
  throw new Error(`DevTools endpoint never became ready: ${lastError}`);
}

// Minimal CDP client: one in-flight call at a time is plenty here.
function connect(url) {
  if (typeof WebSocket === "undefined") {
    fail("This script needs a global WebSocket (Node 22+). Upgrade Node to run the packaged smoke test.");
  }
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message ?? "CDP error"));
    else call.resolve(message.result ?? {});
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("CDP socket error")));
  });
  return {
    ready,
    close: () => socket.close(),
    send(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails),
    );
  }
  return result.result?.value;
}

async function main() {
  const binary = locateBinary();
  if (!binary) {
    fail("No packaged build found. Run `npm run pack` (or `npm run dist`) first.");
  }
  info(`Binary: ${binary}`);

  const logSizeBefore = existsSync(mockLog) ? statSync(mockLog).size : 0;

  const args = [`--remote-debugging-port=${debugPort}`];
  // An unpacked build has a non-SUID chrome-sandbox; the installed .deb/.rpm
  // fixes that up, but this smoke test must work on both.
  if (process.platform === "linux") {
    args.push("--no-sandbox");
  }
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(stderr.trim());
    }
  });

  let client;
  try {
    const target = await waitForPageTarget(debugPort);
    client = connect(target.webSocketDebuggerUrl);
    await client.ready;
    await client.send("Runtime.enable", {});

    // The config-error window is a bare page with no preload, so a missing
    // bridge means startup failed before the launcher UI ever loaded — most
    // often because the packaged app could not find its config at all.
    const hasBridge = await evaluate(client, "typeof window.launcherApi !== 'undefined'");
    if (!hasBridge) {
      const title = await evaluate(client, "document.title");
      fail(
        `Packaged app did not reach the launcher UI (page title: ${JSON.stringify(title)}). ` +
          "It most likely failed to locate config/launcher.yaml — check that config/ and " +
          "examples/ were shipped as extraResources and that ${APP_ROOT} resolves outside app.asar.",
      );
    }

    // The renderer only ever gets a public config; if the main process failed to
    // load YAML it shows the error window instead and there are no rows.
    const config = await evaluate(client, "window.launcherApi.getConfig()");
    if (!config || !Array.isArray(config.rows) || config.rows.length === 0) {
      fail(
        "Packaged app started but exposed no catalog rows — it most likely failed to find or " +
          "parse its config. Check the launcher log.",
      );
    }
    info(`Catalog loaded: ${config.rows.length} rows, appName=${JSON.stringify(config.appName)}`);

    const entry = config.rows[0];
    info(`Launching first entry: ${entry.id} (${entry.name})`);
    const result = await evaluate(client, `window.launcherApi.launchItem(${JSON.stringify(entry.id)})`);
    if (!result || result.ok !== true) {
      fail(`Launch of '${entry.id}' failed: ${JSON.stringify(result)}`);
    }
    info("IPC launch reported success.");

    // The IPC result proves the main process was happy; the log proves a real
    // process ran and wrote to disk.
    let grew = false;
    for (let attempt = 0; attempt < 40 && !grew; attempt += 1) {
      await delay(100);
      grew = existsSync(mockLog) && statSync(mockLog).size > logSizeBefore;
    }
    if (!grew) {
      fail(`Mock launcher never wrote to ${mockLog}; nothing actually executed.`);
    }
    const lastLine = readFileSync(mockLog, "utf8").trimEnd().split("\n").at(-1);
    info(`Mock launcher ran: ${lastLine}`);
    console.log("\x1b[1;32m[smoke] PASS\x1b[0m — packaged build launches real processes.");
  } finally {
    client?.close();
    child.kill("SIGTERM");
    await delay(300);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
