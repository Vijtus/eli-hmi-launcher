import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readZoneName,
  resolveHostDocument,
  resolveHostnameCandidates,
  resolveZoneDocument,
} from "../src/main/host-zone-resolver.ts";

// Mirrors the real repo: launcher/host/TESTZ-Deploy.yaml + launcher/zone/TESTZ.yaml
function fixture(files: Record<string, string> = {}): { root: string; configRoot: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "eli-host-zone-"));
  const configRoot = path.join(root, "launcher");
  mkdirSync(path.join(configRoot, "host"), { recursive: true });
  mkdirSync(path.join(configRoot, "zone"), { recursive: true });
  const defaults: Record<string, string> = {
    "host/TESTZ-Deploy.yaml": "zone: TESTZ\nP4-workspace: D:\\ws\n",
    "zone/TESTZ.yaml": "labview-dev:\nlabview-epics:\ncss:\nweb:\n",
  };
  for (const [name, text] of Object.entries({ ...defaults, ...files })) {
    writeFileSync(path.join(configRoot, name), text);
  }
  return { root, configRoot };
}

test("hostname is lowercased and yields FQDN then short-name candidates", () => {
  const resolved = resolveHostnameCandidates({ hostname: () => "TESTZ-Deploy.eli.example.CZ" });
  assert.equal(resolved.source, "os");
  assert.deepEqual(resolved.candidates, ["testz-deploy.eli.example.cz", "testz-deploy"]);
});

test("a hostname without dots yields a single candidate", () => {
  const resolved = resolveHostnameCandidates({ hostname: () => "TESTZ-Deploy" });
  assert.deepEqual(resolved.candidates, ["testz-deploy"]);
});

test("the env override replaces the OS hostname and is marked as such", () => {
  const resolved = resolveHostnameCandidates({
    override: "OTHER-MACHINE",
    hostname: () => "ignored-host",
  });
  assert.equal(resolved.source, "env");
  assert.equal(resolved.raw, "OTHER-MACHINE");
  assert.deepEqual(resolved.candidates, ["other-machine"]);
});

test("a trailing dot on an FQDN is normalized away", () => {
  const resolved = resolveHostnameCandidates({ hostname: () => "box.example.org." });
  assert.deepEqual(resolved.candidates, ["box.example.org", "box"]);
});

// This is the regression that a naive path.join would produce: the real repo file
// is `TESTZ-Deploy.yaml` while the normalized hostname is `testz-deploy`, so the
// lookup must be a case-insensitive scan or it works on Windows and fails on Linux.
test("host files match case-insensitively against the normalized hostname", () => {
  const { root, configRoot } = fixture();
  try {
    const host = resolveHostDocument(
      configRoot,
      resolveHostnameCandidates({ hostname: () => "TESTZ-DEPLOY" }),
    );
    assert.equal(host.fileName, "TESTZ-Deploy.yaml");
    assert.equal(host.document["zone"], "TESTZ");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the short name is used when the FQDN has no host file", () => {
  const { root, configRoot } = fixture();
  try {
    const host = resolveHostDocument(
      configRoot,
      resolveHostnameCandidates({ hostname: () => "testz-deploy.eli.example.cz" }),
    );
    assert.equal(host.fileName, "TESTZ-Deploy.yaml");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the FQDN file wins over the short-name file when both exist", () => {
  const { root, configRoot } = fixture({
    "host/box.example.org.yaml": "zone: TESTZ\nnote-fqdn: yes\n",
    "host/box.yaml": "zone: TESTZ\n",
  });
  try {
    const host = resolveHostDocument(
      configRoot,
      resolveHostnameCandidates({ hostname: () => "box.example.org" }),
    );
    assert.equal(host.fileName, "box.example.org.yaml");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a .yml extension is accepted alongside .yaml", () => {
  const { root, configRoot } = fixture({ "host/shortbox.yml": "zone: TESTZ\n" });
  try {
    const host = resolveHostDocument(
      configRoot,
      resolveHostnameCandidates({ hostname: () => "shortbox" }),
    );
    assert.equal(host.fileName, "shortbox.yml");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no matching host file fails hard, naming what was tried and what exists", () => {
  const { root, configRoot } = fixture();
  try {
    assert.throws(
      () =>
        resolveHostDocument(configRoot, resolveHostnameCandidates({ hostname: () => "unknown-box" })),
      (error: Error) => {
        assert.match(error.message, /No host configuration for machine 'unknown-box'/);
        assert.match(error.message, /Tried \(case-insensitively\): unknown-box/);
        assert.match(error.message, /Available host files: TESTZ-Deploy/);
        assert.match(error.message, /ELI_LAUNCHER_CONFIG_HOSTNAME/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two host files differing only by case are rejected as ambiguous", () => {
  const { root, configRoot } = fixture({
    "host/dupe.yaml": "zone: TESTZ\n",
    "host/DUPE.yml": "zone: TESTZ\n",
  });
  try {
    assert.throws(
      () => resolveHostDocument(configRoot, resolveHostnameCandidates({ hostname: () => "dupe" })),
      /matches more than one file/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the zone name comes from the host file's `zone` key", () => {
  const { root, configRoot } = fixture();
  try {
    const host = resolveHostDocument(configRoot, resolveHostnameCandidates({ hostname: () => "testz-deploy" }));
    assert.equal(readZoneName(host), "TESTZ");
    const zone = resolveZoneDocument(configRoot, "TESTZ", host.filePath);
    assert.equal(zone.name, "TESTZ");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a host file with no `zone` key fails with the file and the remedy", () => {
  const { root, configRoot } = fixture({ "host/nozone.yaml": "P4-workspace: D:\\ws\n" });
  try {
    const host = resolveHostDocument(configRoot, resolveHostnameCandidates({ hostname: () => "nozone" }));
    assert.throws(() => readZoneName(host), (error: Error) => {
      assert.match(error.message, /nozone\.yaml' is missing the required `zone` key/);
      assert.match(error.message, /Remedy: add `zone: <ZONE-NAME>`/);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown zone reference fails naming the host file and the available zones", () => {
  const { root, configRoot } = fixture({ "host/badzone.yaml": "zone: NOPE\n" });
  try {
    assert.throws(
      () => resolveZoneDocument(configRoot, "NOPE", path.join(configRoot, "host", "badzone.yaml")),
      (error: Error) => {
        assert.match(error.message, /names `zone: NOPE`, but no matching file exists/);
        assert.match(error.message, /Available zones: TESTZ/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("zone names match case-insensitively too", () => {
  const { root, configRoot } = fixture();
  try {
    assert.equal(resolveZoneDocument(configRoot, "testz", "host.yaml").fileName, "TESTZ.yaml");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed YAML is rejected naming the file and the syntax problem", () => {
  const { root, configRoot } = fixture({ "host/broken.yaml": "zone: [unclosed\n" });
  try {
    assert.throws(
      () => resolveHostDocument(configRoot, resolveHostnameCandidates({ hostname: () => "broken" })),
      (error: Error) => {
        assert.match(error.message, /broken\.yaml' is not valid YAML/);
        assert.match(error.message, /Remedy: fix the YAML syntax/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty host file is rejected rather than silently yielding no settings", () => {
  const { root, configRoot } = fixture({ "host/empty.yaml": "\n" });
  try {
    assert.throws(
      () => resolveHostDocument(configRoot, resolveHostnameCandidates({ hostname: () => "empty" })),
      /empty\.yaml' is empty/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing host directory reports the subpath remedy", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "eli-host-zone-empty-"));
  try {
    assert.throws(
      () =>
        resolveHostDocument(
          path.join(root, "launcher"),
          resolveHostnameCandidates({ hostname: () => "any" }),
        ),
      /ELI_LAUNCHER_CONFIG_REPO_SUBPATH/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
