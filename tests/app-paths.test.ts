import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  buildConfigCandidates,
  resolveAppRoot,
  type AppLocation,
} from "../src/main/app-paths.ts";

// Mirrors a dev checkout: electron-vite runs the app straight from the project.
function devLocation(overrides: Partial<AppLocation> = {}): AppLocation {
  return {
    isPackaged: false,
    appPath: "/home/op/eli-hmi-launcher",
    resourcesPath: "/home/op/eli-hmi-launcher/node_modules/electron/dist/resources",
    executableDir: "/home/op/eli-hmi-launcher/node_modules/electron/dist",
    cwd: "/home/op/eli-hmi-launcher",
    userDataDir: "/home/op/.config/eli-hmi-launcher",
    ...overrides,
  };
}

// Mirrors an installed build: app.getAppPath() points INSIDE the asar archive.
function packagedLocation(overrides: Partial<AppLocation> = {}): AppLocation {
  return {
    isPackaged: true,
    appPath: "/opt/ELI HMI Launcher/resources/app.asar",
    resourcesPath: "/opt/ELI HMI Launcher/resources",
    executableDir: "/opt/ELI HMI Launcher",
    cwd: "/home/op",
    userDataDir: "/home/op/.config/eli-hmi-launcher",
    ...overrides,
  };
}

test("dev app root is the project directory", () => {
  assert.equal(resolveAppRoot(devLocation()), "/home/op/eli-hmi-launcher");
});

// The bug this module exists to prevent: ${APP_ROOT} must never resolve into
// app.asar, because no configured command under it could be stat'd or spawned.
test("packaged app root is the resources directory, never the asar archive", () => {
  const root = resolveAppRoot(packagedLocation());
  assert.equal(root, "/opt/ELI HMI Launcher/resources");
  assert.ok(!root.includes("app.asar"), `app root must stay outside the archive, got ${root}`);
});

test("packaged app root falls back to the app path when resourcesPath is absent", () => {
  const root = resolveAppRoot(packagedLocation({ resourcesPath: undefined }));
  assert.equal(root, "/opt/ELI HMI Launcher/resources/app.asar");
});

test("dev candidates prefer the working directory, then the project directory", () => {
  // A checkout run from elsewhere, so cwd and the project directory differ and
  // the ordering is actually observable.
  const candidates = buildConfigCandidates(devLocation({ cwd: "/home/op/scratch" }));
  assert.deepEqual(candidates, [
    path.join("/home/op/scratch", "config", "launcher.yaml"),
    path.join("/home/op/eli-hmi-launcher", "config", "launcher.yaml"),
    path.join("/home/op/eli-hmi-launcher/node_modules/electron/dist/resources", "config", "launcher.yaml"),
    path.join("/home/op/eli-hmi-launcher/node_modules/electron/dist", "config", "launcher.yaml"),
  ]);
});

test("dev candidates keep working when cwd is the project directory", () => {
  const candidates = buildConfigCandidates(devLocation());
  assert.equal(candidates[0], path.join("/home/op/eli-hmi-launcher", "config", "launcher.yaml"));
  assert.equal(new Set(candidates).size, candidates.length);
});

test("packaged candidates let a user-writable config beat the bundled one", () => {
  const candidates = buildConfigCandidates(packagedLocation());
  assert.deepEqual(candidates, [
    path.join("/home/op/.config/eli-hmi-launcher", "launcher.yaml"),
    path.join("/opt/ELI HMI Launcher/resources", "config", "launcher.yaml"),
    path.join("/opt/ELI HMI Launcher", "config", "launcher.yaml"),
  ]);
});

// An installed launcher is started from arbitrary directories, and the config
// decides which commands get spawned.
test("packaged candidates ignore the working directory", () => {
  const candidates = buildConfigCandidates(packagedLocation({ cwd: "/tmp/attacker" }));
  for (const candidate of candidates) {
    assert.ok(!candidate.startsWith("/tmp/attacker"), `cwd leaked into candidates: ${candidate}`);
  }
});

test("candidates are de-duplicated when the layout collapses", () => {
  const candidates = buildConfigCandidates(
    packagedLocation({ executableDir: "/opt/ELI HMI Launcher/resources" }),
  );
  assert.equal(new Set(candidates).size, candidates.length);
  assert.equal(candidates.length, 2);
});
