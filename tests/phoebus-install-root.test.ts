// `local.phoebus.installRoot` is an install DIRECTORY (what the config repo's
// `css-install` key carries), while `executable` is a FILE. The launcher probes
// the directory rather than guessing a launcher-script name.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConfig, PHOEBUS_LAUNCHER_CANDIDATES } from "../src/main/config/load.ts";

const BASE = { appRoot: "/tmp/app", configDir: "/tmp/cfg" };

function withInstall(files: string[], run: (root: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "eli-phoebus-root-"));
  try {
    for (const file of files) {
      const full = path.join(root, file);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, "#!/bin/sh\n");
      chmodSync(full, 0o755);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function phoebusOf(yaml: string) {
  return parseConfig(yaml, BASE).context.local.phoebus;
}

test("the probe finds the launcher script that actually exists", () => {
  withInstall(["phoebus.sh"], (root) => {
    const phoebus = phoebusOf(`local:\n  phoebus:\n    installRoot: ${JSON.stringify(root)}\nentries: []\n`);
    assert.equal(phoebus.installRoot, root);
    assert.equal(phoebus.executable, path.join(root, "phoebus.sh"));
  });
});

test("candidates are probed in a documented order", () => {
  assert.deepEqual([...PHOEBUS_LAUNCHER_CANDIDATES], ["phoebus.bat", "phoebus.sh", "phoebus"]);
  withInstall(["phoebus.bat", "phoebus.sh", "phoebus"], (root) => {
    const phoebus = phoebusOf(`local:\n  phoebus:\n    installRoot: ${JSON.stringify(root)}\nentries: []\n`);
    assert.equal(phoebus.executable, path.join(root, "phoebus.bat"));
  });
});

test("an extensionless `phoebus` launcher is found", () => {
  withInstall(["phoebus"], (root) => {
    const phoebus = phoebusOf(`local:\n  phoebus:\n    installRoot: ${JSON.stringify(root)}\nentries: []\n`);
    assert.equal(phoebus.executable, path.join(root, "phoebus"));
  });
});

// The normal case when checking a Windows deployment from a POSIX workstation:
// nothing to probe, so the config must still LOAD and let the launch-time path
// check report the problem, rather than failing to parse.
test("an install root with no launcher still loads, using the platform default", () => {
  const phoebus = phoebusOf(
    'local:\n  phoebus:\n    installRoot: "C:\\\\CSS Phoebus\\\\product-5.0.2"\nentries: []\n',
  );
  assert.equal(phoebus.installRoot, "C:\\CSS Phoebus\\product-5.0.2");
  assert.match(phoebus.executable ?? "", /^C:\\CSS Phoebus\\product-5\.0\.2\\phoebus\.(bat|sh)$/);
});

test("a Windows-style root keeps Windows separators even on POSIX", () => {
  const phoebus = phoebusOf('local:\n  phoebus:\n    installRoot: "D:\\\\Phoebus\\\\"\nentries: []\n');
  assert.ok(!(phoebus.executable ?? "").includes("/"), phoebus.executable);
  assert.ok(!(phoebus.executable ?? "").includes("\\\\"), "no doubled separator from a trailing slash");
});

test("an explicit executable always wins over the probe", () => {
  withInstall(["phoebus.sh"], (root) => {
    const phoebus = phoebusOf(
      `local:\n  phoebus:\n    installRoot: ${JSON.stringify(root)}\n    executable: /opt/site/phoebus-wrapper\nentries: []\n`,
    );
    assert.equal(phoebus.executable, "/opt/site/phoebus-wrapper");
  });
});

test("no install root and no executable leaves both unset", () => {
  const phoebus = phoebusOf("local:\n  phoebus:\n    serverPort: 4918\nentries: []\n");
  assert.equal(phoebus.installRoot, undefined);
  assert.equal(phoebus.executable, undefined);
});
