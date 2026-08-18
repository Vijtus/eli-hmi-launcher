import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfigFromFile } from "../src/main/config.ts";
import {
  DEFAULT_SUBPATH,
  ENV,
  readDynamicConfigEnv,
  resolveFromCheckout,
} from "../src/main/dynamic-config.ts";
import type { ConfigRepoResult } from "../src/main/config-repo.ts";

// Verbatim from eli-eric/eli-hmi-config@ad98e4b.
const REAL_HOST = `zone: TESTZ
P4-workspace: D:\\Workspaces\\Perforce\\TESTZ_dev_TESTZ-Deploy_8929
css-gui: D:\\Workspaces\\css-gui
css-install: C:\\CSS Phoebus\\product-5.0.2
hmi-server: testz-deploy20:8082
`;
const REAL_ZONE = `labview-dev:
  - ioc-name: Camera Manager
    host: RMC00-001
    ioc-type: Camera Manager
    exe: CMD.exe
  - ioc-name: Fast Pointing IOC
    host: RMC00-001
    ioc-type: Fast Pointing IOC
    exe: Fast Pointing.exe
labview-epics:
css:
web:
`;

type Tree = { root: string; repoDir: string; appRoot: string; configDir: string; configPath: string };

function tree(files: Record<string, string> = {}, rootConfig?: string): Tree {
  const root = mkdtempSync(path.join(os.tmpdir(), "eli-dynamic-config-"));
  const repoDir = path.join(root, "cache", "repo");
  const appRoot = path.join(root, "app");
  const configDir = path.join(appRoot, "config");
  mkdirSync(path.join(repoDir, DEFAULT_SUBPATH, "host"), { recursive: true });
  mkdirSync(path.join(repoDir, DEFAULT_SUBPATH, "zone"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const defaults: Record<string, string> = {
    "host/TESTZ-Deploy.yaml": REAL_HOST,
    "zone/TESTZ.yaml": REAL_ZONE,
  };
  for (const [name, text] of Object.entries({ ...defaults, ...files })) {
    writeFileSync(path.join(repoDir, DEFAULT_SUBPATH, name), text);
  }
  const configPath = path.join(configDir, "launcher.yaml");
  writeFileSync(configPath, rootConfig ?? "appName: L4 Launcher\nentries: []\n");
  return { root, repoDir, appRoot, configDir, configPath };
}

function repoResult(t: Tree, source: "fresh" | "cached" = "fresh"): ConfigRepoResult {
  return {
    repoDir: t.repoDir,
    ref: "main",
    commitSha: "c".repeat(40),
    fetchedAt: "2026-08-18T10:00:00.000Z",
    source,
    warnings: [],
  };
}

function resolve(t: Tree, source: "fresh" | "cached" = "fresh", hostname = "TESTZ-Deploy") {
  return resolveFromCheckout(repoResult(t, source), {
    subpath: DEFAULT_SUBPATH,
    hostnameOverride: hostname,
    url: "https://git.example.org/eli-hmi-config.git",
    cacheDir: path.join(t.root, "cache"),
  });
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

test("the feature is off when no repo URL is configured", () => {
  assert.equal(readDynamicConfigEnv({}), undefined);
  assert.equal(readDynamicConfigEnv({ [ENV.token]: "t" }), undefined);
});

test("environment defaults match the documented table", () => {
  const options = readDynamicConfigEnv({ [ENV.url]: "https://git.example.org/c.git" });
  assert.equal(options?.subpath, "launcher");
  assert.equal(options?.timeoutMs, 10_000);
  assert.equal(options?.offline, false);
  assert.equal(options?.ref, undefined);
  assert.equal(options?.token, undefined);
});

test("every environment variable is read", () => {
  const options = readDynamicConfigEnv({
    [ENV.url]: "https://git.example.org/c.git",
    [ENV.token]: "ghp_x",
    [ENV.username]: "deploy-token-user",
    [ENV.ref]: "v1.2.3",
    [ENV.subpath]: "other",
    [ENV.cacheDir]: "/var/cache/eli",
    [ENV.hostname]: "BOX-1",
    [ENV.timeoutMs]: "25000",
    [ENV.offline]: "yes",
  });
  assert.deepEqual(options, {
    url: "https://git.example.org/c.git",
    token: "ghp_x",
    username: "deploy-token-user",
    ref: "v1.2.3",
    subpath: "other",
    cacheDir: "/var/cache/eli",
    hostnameOverride: "BOX-1",
    timeoutMs: 25000,
    offline: true,
  });
});

test("a malformed timeout or offline flag fails with a named remedy", () => {
  assert.throws(
    () => readDynamicConfigEnv({ [ENV.url]: "u", [ENV.timeoutMs]: "soon" }),
    /ELI_LAUNCHER_CONFIG_FETCH_TIMEOUT_MS` must be a positive integer/,
  );
  assert.throws(
    () => readDynamicConfigEnv({ [ENV.url]: "u", [ENV.offline]: "maybe" }),
    /ELI_LAUNCHER_CONFIG_OFFLINE` must be a boolean/,
  );
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test("host and zone resolve from a checkout and report provenance", () => {
  const t = tree();
  try {
    const { provenance } = resolve(t);
    assert.equal(provenance.hostname, "TESTZ-Deploy");
    assert.equal(provenance.hostnameSource, "env");
    assert.match(provenance.hostFile, /TESTZ-Deploy\.yaml$/);
    assert.equal(provenance.zone, "TESTZ");
    assert.match(provenance.zoneFile, /TESTZ\.yaml$/);
    assert.equal(provenance.entryCount, 2);
    assert.equal(provenance.commitSha, "c".repeat(40));
    assert.equal(provenance.source, "fresh");
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("the OS hostname is used when no override is set", () => {
  const t = tree({ [`host/${os.hostname().split(".")[0]}.yaml`]: "zone: TESTZ\n" });
  try {
    const result = resolveFromCheckout(repoResult(t), {
      subpath: DEFAULT_SUBPATH,
      hostnameOverride: undefined,
      url: "https://git.example.org/c.git",
      cacheDir: t.root,
    });
    assert.equal(result.provenance.hostnameSource, "os");
    assert.equal(result.provenance.zone, "TESTZ");
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Merge precedence (FR5)
// ---------------------------------------------------------------------------

test("zone `local:` is the base and the host file overrides it key by key", () => {
  const t = tree({
    "zone/TESTZ.yaml":
      "local:\n  cssGuiRoot: Z:\\zone-default\n  phoebus:\n    serverPort: 4918\n    startupTimeoutMs: 30000\nlabview-dev:\n",
  });
  try {
    const { overlay } = resolve(t);
    const local = overlay.local as Record<string, unknown>;
    // host `css-gui` wins over the zone default...
    assert.equal(local["cssGuiRoot"], "D:\\Workspaces\\css-gui");
    // ...while zone-only keys survive.
    assert.deepEqual(local["phoebus"], {
      serverPort: 4918,
      startupTimeoutMs: 30000,
      installRoot: "C:\\CSS Phoebus\\product-5.0.2",
    });
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("a host `local:` block wins over the kebab-case aliases", () => {
  const t = tree({
    "host/TESTZ-Deploy.yaml": `${REAL_HOST}local:\n  cssGuiRoot: E:\\explicit\n`,
  });
  try {
    const local = resolve(t).overlay.local as Record<string, unknown>;
    assert.equal(local["cssGuiRoot"], "E:\\explicit");
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Launcher-level settings owned by the config repo
// ---------------------------------------------------------------------------

test("a zone can own appName and the action buttons", () => {
  const t = tree({
    "zone/TESTZ.yaml":
      "launcher:\n" +
      "  appName: L4 Launcher — TESTZ\n" +
      "  quickActions:\n" +
      "    - id: data-browser\n      label: Data Browser\n      target: { kind: web, url: 'https://example.local/db' }\n" +
      "  moreActions:\n" +
      "    - id: sequencer\n      label: Sequencer\n      target: { kind: web, url: 'https://example.local/seq' }\n" +
      "labview-dev:\n",
  });
  try {
    const parsed = loadConfigFromFile(t.configPath, {
      appRoot: t.appRoot,
      configDir: t.configDir,
      overlay: resolve(t).overlay,
    });
    assert.equal(parsed.appName, "L4 Launcher — TESTZ");
    assert.deepEqual(parsed.quickActions.map((a) => a.id), ["data-browser"]);
    assert.deepEqual(parsed.moreActions.map((a) => a.id), ["sequencer"]);
    assert.deepEqual(parsed.targetsById.get("data-browser"), {
      kind: "web",
      url: "https://example.local/db",
    });
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("a host overrides the zone's launcher settings", () => {
  const t = tree({
    "zone/TESTZ.yaml": "launcher:\n  appName: Zone name\nlabview-dev:\n",
    "host/TESTZ-Deploy.yaml": `${REAL_HOST}launcher:\n  appName: Host name\n`,
  });
  try {
    const parsed = loadConfigFromFile(t.configPath, {
      appRoot: t.appRoot,
      configDir: t.configDir,
      overlay: resolve(t).overlay,
    });
    assert.equal(parsed.appName, "Host name");
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("action lists REPLACE the root file's rather than appending to it", () => {
  const t = tree(
    {
      "zone/TESTZ.yaml":
        "launcher:\n  quickActions:\n    - id: from-zone\n      label: From zone\n" +
        "      target: { kind: web, url: 'https://example.local/z' }\nlabview-dev:\n",
    },
    "appName: L4\nentries: []\nquickActions:\n  - id: from-file\n    label: From file\n" +
      "    target: { kind: web, url: 'https://example.local/f' }\n",
  );
  try {
    const parsed = loadConfigFromFile(t.configPath, {
      appRoot: t.appRoot,
      configDir: t.configDir,
      overlay: resolve(t).overlay,
    });
    assert.deepEqual(parsed.quickActions.map((a) => a.id), ["from-zone"]);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("when the repo sets no launcher block the root file still decides", () => {
  const t = tree(
    {},
    "appName: Root name\nentries: []\nquickActions:\n  - id: from-file\n    label: From file\n" +
      "    target: { kind: web, url: 'https://example.local/f' }\n",
  );
  try {
    const parsed = loadConfigFromFile(t.configPath, {
      appRoot: t.appRoot,
      configDir: t.configDir,
      overlay: resolve(t).overlay,
    });
    assert.equal(parsed.appName, "Root name");
    assert.deepEqual(parsed.quickActions.map((a) => a.id), ["from-file"]);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("a `launcher:` block is not mistaken for an HMI group", () => {
  const t = tree({ "zone/TESTZ.yaml": "launcher:\n  appName: X\nlabview-dev:\n" });
  try {
    const result = resolve(t);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.provenance.entryCount, 0);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Feeding the launcher's existing config model (FR6)
// ---------------------------------------------------------------------------

test("zone entries reach the launcher's parsed config as ordinary rows", () => {
  const t = tree();
  try {
    const parsed = loadConfigFromFile(t.configPath, {
      appRoot: t.appRoot,
      configDir: t.configDir,
      catalogCacheDir: path.join(t.root, "catalog-cache"),
      overlay: resolve(t).overlay,
    });
    assert.deepEqual(parsed.rows.map((row) => row.id), [
      "labview-dev-camera-manager-rmc00-001",
      "labview-dev-fast-pointing-ioc-rmc00-001",
    ]);
    assert.deepEqual(parsed.targetsById.get("labview-dev-camera-manager-rmc00-001"), {
      kind: "labview-dev",
      iocName: "Camera Manager",
      hostName: "RMC00-001",
      iocType: "Camera Manager",
      exeName: "CMD.exe",
    });
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("host machine values reach context.local, including the derived Phoebus executable", () => {
  const t = tree();
  try {
    const parsed = loadConfigFromFile(t.configPath, {
      appRoot: t.appRoot,
      configDir: t.configDir,
      overlay: resolve(t).overlay,
    });
    const local = parsed.context.local;
    assert.equal(local.zoneSymbol, "TESTZ");
    assert.equal(local.workspaceRoot, "D:\\Workspaces\\Perforce\\TESTZ_dev_TESTZ-Deploy_8929");
    assert.equal(local.cssGuiRoot, "D:\\Workspaces\\css-gui");
    assert.equal(local.phoebus.installRoot, "C:\\CSS Phoebus\\product-5.0.2");
    // Derived from installRoot because no explicit executable was configured.
    assert.match(local.phoebus.executable ?? "", /phoebus\.(bat|sh)$/);
    assert.equal(local.hosts["hmi-server"], "testz-deploy20:8082");
    // `hmi-server` becomes a usable lifecycle base URL, with the plain-HTTP
    // opt-in recorded explicitly rather than silently.
    assert.equal(local.hmiApi.baseUrl, "http://testz-deploy20:8082/api/lifecycle/v1");
    assert.equal(local.hmiApi.allowInsecureTransport, true);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("an explicit executable in the config repo wins over the derived one", () => {
  const t = tree({
    "host/TESTZ-Deploy.yaml": `${REAL_HOST}local:\n  phoebus:\n    executable: C:\\custom\\phoebus.exe\n`,
  });
  try {
    const parsed = loadConfigFromFile(t.configPath, {
      appRoot: t.appRoot,
      configDir: t.configDir,
      overlay: resolve(t).overlay,
    });
    assert.equal(parsed.context.local.phoebus.executable, "C:\\custom\\phoebus.exe");
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("the git overlay overrides the local file's `local:` block", () => {
  const t = tree({}, "appName: L4\nlocal:\n  zoneSymbol: STALE\n  cssGuiRoot: C:\\old\nentries: []\n");
  try {
    const parsed = loadConfigFromFile(t.configPath, {
      appRoot: t.appRoot,
      configDir: t.configDir,
      overlay: resolve(t).overlay,
    });
    assert.equal(parsed.context.local.zoneSymbol, "TESTZ");
    assert.equal(parsed.context.local.cssGuiRoot, "D:\\Workspaces\\css-gui");
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("zone entries override an inline entry with the same id", () => {
  const t = tree(
    {
      "zone/TESTZ.yaml":
        "labview-dev:\n  - id: shared\n    ioc-name: Zone winner\n    host: H\n    ioc-type: T\n    exe: E.exe\n",
    },
    "appName: L4\nentries:\n  - id: shared\n    name: Inline loser\n    target: { kind: web, url: 'https://example.local/x' }\n",
  );
  try {
    const parsed = loadConfigFromFile(t.configPath, {
      appRoot: t.appRoot,
      configDir: t.configDir,
      overlay: resolve(t).overlay,
    });
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0]?.name, "Zone winner");
    assert.match(parsed.catalogStatus.warnings.at(-1) ?? "", /later configured sources take precedence/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

// SECURITY: the config file is a trust root. A pushable remote repo must never be
// able to relax the command allow-list.
test("the config repo cannot alter the security policy", () => {
  const t = tree(
    { "host/TESTZ-Deploy.yaml": `${REAL_HOST}local:\n  workspaceRoot: D:\\ws\n` },
    "appName: L4\nsecurity:\n  allowedCommandRoots:\n    - /opt/eli/approved\n  allowBareCommands: false\nentries: []\n",
  );
  try {
    const parsed = loadConfigFromFile(t.configPath, {
      appRoot: t.appRoot,
      configDir: t.configDir,
      overlay: {
        ...resolve(t).overlay,
        // Even if an overlay somehow carried these, they are not consulted.
        local: { ...(resolve(t).overlay.local as object) },
      },
    });
    assert.deepEqual(parsed.context.security.allowedCommandRoots, ["/opt/eli/approved"]);
    assert.equal(parsed.context.security.allowBareCommands, false);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("a cached repo marks the zone source stale so the UI shows CATALOG STALE", () => {
  const t = tree();
  try {
    const parsed = loadConfigFromFile(t.configPath, {
      appRoot: t.appRoot,
      configDir: t.configDir,
      overlay: resolve(t, "cached").overlay,
    });
    assert.equal(parsed.catalogStatus.stale, true);
    const zoneSource = parsed.catalogStatus.sources.find((source) => source.id === "zone:TESTZ");
    assert.equal(zoneSource?.state, "cached");
    assert.equal(zoneSource?.loadedAt, "2026-08-18T10:00:00.000Z");
    assert.match(zoneSource?.message ?? "", /Cached config repo commit c{40}/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("a fresh repo leaves the launcher unstale", () => {
  const t = tree();
  try {
    const parsed = loadConfigFromFile(t.configPath, {
      appRoot: t.appRoot,
      configDir: t.configDir,
      overlay: resolve(t, "fresh").overlay,
    });
    assert.equal(parsed.catalogStatus.stale, false);
    assert.equal(parsed.catalogStatus.sources.find((s) => s.id === "zone:TESTZ")?.state, "fresh");
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("with no overlay the launcher behaves exactly as before the feature", () => {
  const t = tree({}, "appName: L4\nentries:\n  - id: only\n    name: Only\n    target: { kind: web, url: 'https://example.local/x' }\n");
  try {
    const parsed = loadConfigFromFile(t.configPath, { appRoot: t.appRoot, configDir: t.configDir });
    assert.deepEqual(parsed.rows.map((r) => r.id), ["only"]);
    assert.equal(parsed.catalogStatus.stale, false);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("a missing host file fails the whole load rather than starting half-configured", () => {
  const t = tree();
  try {
    assert.throws(() => resolve(t, "fresh", "not-this-machine"), /No host configuration for machine/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});
