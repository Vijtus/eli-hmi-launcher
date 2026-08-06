import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfigFromFile } from "../src/main/config.ts";

function tempTree(): { root: string; app: string; config: string; shared: string; cache: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "eli-catalog-test-"));
  const app = path.join(root, "app");
  const config = path.join(app, "config");
  const shared = path.join(root, "outside-app", "catalog.yaml");
  const cache = path.join(root, "cache");
  mkdirSync(config, { recursive: true });
  mkdirSync(path.dirname(shared), { recursive: true });
  return { root, app, config, shared, cache };
}

function catalog(entries: string): string {
  return `entries:\n${entries}\n`;
}

function rootConfig(sourcePath: string, inlineEntries = ""): string {
  return `
appName: Test
catalog:
  sources:
    - id: shared
      path: ${JSON.stringify(sourcePath)}
entries:
${inlineEntries || "  []"}
`;
}

test("catalog loads from a filesystem path outside the application directory", () => {
  const tree = tempTree();
  try {
    writeFileSync(
      tree.shared,
      catalog(`  - id: external\n    name: Outside app\n    target: { kind: web, url: https://example.local/external }`),
    );
    const configPath = path.join(tree.config, "launcher.yaml");
    writeFileSync(configPath, rootConfig(tree.shared));

    const parsed = loadConfigFromFile(configPath, {
      appRoot: tree.app,
      configDir: tree.config,
      catalogCacheDir: tree.cache,
    });
    assert.deepEqual(parsed.rows.map((row) => row.id), ["external"]);
    assert.equal(parsed.catalogStatus.stale, false);
    assert.equal(parsed.catalogStatus.sources[1]?.state, "fresh");
  } finally {
    rmSync(tree.root, { recursive: true, force: true });
  }
});

test("an unreachable shared catalog degrades with a warning and no crash", () => {
  const tree = tempTree();
  try {
    const missing = path.join(tree.root, "missing-share", "catalog.yaml");
    const configPath = path.join(tree.config, "launcher.yaml");
    writeFileSync(
      configPath,
      rootConfig(
        missing,
        `  - id: inline\n    name: Inline\n    target: { kind: web, url: https://example.local/inline }`,
      ),
    );

    const parsed = loadConfigFromFile(configPath, {
      appRoot: tree.app,
      configDir: tree.config,
      catalogCacheDir: tree.cache,
    });
    assert.deepEqual(parsed.rows.map((row) => row.id), ["inline"]);
    assert.equal(parsed.catalogStatus.stale, true);
    assert.equal(parsed.catalogStatus.sources[1]?.state, "unavailable");
    assert.match(parsed.catalogStatus.warnings[0] ?? "", /no usable cache exists/);
  } finally {
    rmSync(tree.root, { recursive: true, force: true });
  }
});

test("a previously loaded catalog is reused from cache when the source disappears", () => {
  const tree = tempTree();
  try {
    writeFileSync(
      tree.shared,
      catalog(`  - id: cached-entry\n    name: Cached entry\n    target: { kind: web, url: https://example.local/cached }`),
    );
    const configPath = path.join(tree.config, "launcher.yaml");
    writeFileSync(configPath, rootConfig(tree.shared));
    const base = { appRoot: tree.app, configDir: tree.config, catalogCacheDir: tree.cache };

    const fresh = loadConfigFromFile(configPath, base);
    assert.equal(fresh.catalogStatus.sources[1]?.state, "fresh");
    unlinkSync(tree.shared);

    const cached = loadConfigFromFile(configPath, base);
    assert.deepEqual(cached.rows.map((row) => row.id), ["cached-entry"]);
    assert.equal(cached.catalogStatus.sources[1]?.state, "cached");
    assert.equal(cached.catalogStatus.stale, true);
  } finally {
    rmSync(tree.root, { recursive: true, force: true });
  }
});

test("later catalog sources deterministically override duplicate ids", () => {
  const tree = tempTree();
  try {
    writeFileSync(
      tree.shared,
      catalog(`  - id: duplicate\n    name: Shared winner\n    target: { kind: web, url: https://example.local/shared }`),
    );
    const configPath = path.join(tree.config, "launcher.yaml");
    writeFileSync(
      configPath,
      rootConfig(
        tree.shared,
        `  - id: duplicate\n    name: Inline loser\n    target: { kind: web, url: https://example.local/inline }`,
      ),
    );

    const parsed = loadConfigFromFile(configPath, {
      appRoot: tree.app,
      configDir: tree.config,
      catalogCacheDir: tree.cache,
    });
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0]?.name, "Shared winner");
    assert.match(parsed.catalogStatus.warnings.at(-1) ?? "", /later configured sources take precedence/);
  } finally {
    rmSync(tree.root, { recursive: true, force: true });
  }
});
