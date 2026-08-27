import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/main/config/load.ts";
import { buildEffectiveConfig, redactDeep } from "../src/main/catalog/effective.ts";

const BASE = { appRoot: "/tmp/app", configDir: "/tmp/cfg" };

test("sensitive keys are redacted in the troubleshooting dump", () => {
  assert.deepEqual(
    redactDeep({ token: "ghp_secret", apiKey: "k", authorization: "Basic abc", note: "fine" }),
    { token: "[REDACTED]", apiKey: "[REDACTED]", authorization: "[REDACTED]", note: "fine" },
  );
});

test("redaction reaches nested structures and lists", () => {
  assert.deepEqual(
    redactDeep({ outer: { inner: [{ password: "p" }, { safe: "s" }] } }),
    { outer: { inner: [{ password: "[REDACTED]" }, { safe: "s" }] } },
  );
});

test("credentials embedded in any URL string are stripped", () => {
  assert.deepEqual(redactDeep({ url: "https://user:pw@git.example.org/c.git" }), {
    url: "https://[REDACTED]@git.example.org/c.git",
  });
});

test("non-sensitive values pass through unchanged", () => {
  assert.deepEqual(redactDeep({ port: 4918, enabled: true, name: "L4" }), {
    port: 4918,
    enabled: true,
    name: "L4",
  });
});

test("the dump carries the resolved entries, targets, and machine settings", () => {
  const parsed = parseConfig(
    `siteName: TESTZ
local:
  zoneSymbol: TESTZ
entries:
  - id: a
    name: A
    target: { kind: web, url: "https://example.local/a" }
`,
    BASE,
  );
  const dump = buildEffectiveConfig(parsed) as Record<string, unknown>;
  assert.equal(dump["productName"], "ELI HMI Launcher");
  assert.equal(dump["siteName"], "TESTZ");
  assert.equal(dump["entryCount"], 1);
  const entries = dump["entries"] as Record<string, unknown>[];
  assert.equal(entries[0]?.["id"], "a");
  assert.deepEqual(entries[0]?.["target"], { kind: "web", url: "https://example.local/a" });
  assert.equal((dump["local"] as Record<string, unknown>)["zoneSymbol"], "TESTZ");
});

test("the dump includes config repo provenance when the feature is active", () => {
  const parsed = parseConfig(`siteName: L4\nentries: []\n`, BASE);
  const dump = buildEffectiveConfig(parsed, {
    url: "https://git.example.org/eli-hmi-config.git",
    ref: "main",
    commitSha: "d".repeat(40),
    fetchedAt: "2026-08-18T10:00:00.000Z",
    source: "cached",
    cacheDir: "/var/cache/eli",
    hostname: "TESTZ-Deploy",
    hostnameSource: "os",
    hostFile: "/cache/repo/launcher/host/TESTZ-Deploy.yaml",
    zone: "TESTZ",
    zoneFile: "/cache/repo/launcher/zone/TESTZ.yaml",
    entryCount: 5,
  }) as Record<string, unknown>;
  const provenance = dump["configRepo"] as Record<string, unknown>;
  assert.equal(provenance["commitSha"], "d".repeat(40));
  assert.equal(provenance["source"], "cached");
  assert.equal(provenance["zone"], "TESTZ");
});

test("a token pasted into the repo URL is redacted in the dump", () => {
  const parsed = parseConfig(`siteName: L4\nentries: []\n`, BASE);
  const dump = buildEffectiveConfig(parsed, {
    url: "https://ghp_secrettoken@git.example.org/c.git",
    ref: "main",
    commitSha: "e".repeat(40),
    fetchedAt: "2026-08-18T10:00:00.000Z",
    source: "fresh",
    cacheDir: "/var/cache/eli",
    hostname: "box",
    hostnameSource: "os",
    hostFile: "h.yaml",
    zone: "Z",
    zoneFile: "z.yaml",
    entryCount: 0,
  }) as Record<string, unknown>;
  const url = (dump["configRepo"] as Record<string, unknown>)["url"] as string;
  assert.ok(!url.includes("ghp_secrettoken"));
  assert.match(url, /https:\/\/\[REDACTED\]@git\.example\.org/);
});
