import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { assertCommandAllowed } from "../src/main/config.ts";

// A Windows deployment's allow-list is routinely checked from a Linux
// workstation — the field report does exactly that. Windows path comparison is
// case-insensitive and separator-agnostic, so the answer must not depend on the
// host doing the checking.
test("a Windows allow-list matches regardless of separator and case, from any host", () => {
  const policy = {
    allowedCommandRoots: ["D:\\Workspaces\\Perforce\\TESTZ_dev_TESTZ-Deploy_8929"],
    allowBareCommands: false,
    allowInsecureConfigPermissions: false,
  };
  // Exactly what the zone adapter produces: forward slashes, mixed case.
  assert.doesNotThrow(() =>
    assertCommandAllowed(
      "D:/Workspaces/Perforce/TESTZ_dev_TESTZ-Deploy_8929/Common/ELI/IOCs/Camera Manager/Builds/GUI Application/CMD.exe",
      policy,
      "win32",
    ),
  );
  assert.doesNotThrow(() =>
    assertCommandAllowed("d:\\workspaces\\perforce\\testz_dev_testz-deploy_8929\\x.exe", policy, "win32"),
  );
});

test("a Windows allow-list still refuses a sibling directory that shares a prefix", () => {
  const policy = {
    allowedCommandRoots: ["D:\\Workspaces\\Perforce\\TESTZ_dev"],
    allowBareCommands: false,
    allowInsecureConfigPermissions: false,
  };
  assert.throws(
    () => assertCommandAllowed("D:\\Workspaces\\Perforce\\TESTZ_dev_evil\\x.exe", policy, "win32"),
    /not inside any allowed command root/,
  );
});

// macOS makes this routine: /var is a symlink to /private/var, so every
// temporary directory sits under one. A command under a symlinked parent
// resolved to the real path while a root that did not itself exist kept the
// symlinked one, and the two stopped sharing a prefix — refusing a launch that
// was plainly inside its allowed root. Reproduced here on any platform with an
// explicit symlink.
test("a command under a symlinked root is allowed even when neither path exists yet", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX symlink semantics");
    return;
  }
  const real = mkdtempSync(path.join(os.tmpdir(), "eli-allow-real-"));
  const link = path.join(mkdtempSync(path.join(os.tmpdir(), "eli-allow-link-")), "via-symlink");
  try {
    symlinkSync(real, link);
    // Neither the root nor the command exists — the "program not installed yet"
    // case, which is exactly when a clear message matters most.
    const root = path.join(link, "workspace");
    const command = path.join(root, "Builds", "GUI Application", "App.exe");
    assert.doesNotThrow(() =>
      assertCommandAllowed(command, {
        allowedCommandRoots: [root],
        allowBareCommands: false,
        allowInsecureConfigPermissions: false,
      }),
    );
  } finally {
    rmSync(path.dirname(link), { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test("a symlinked root still refuses a command outside it", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX symlink semantics");
    return;
  }
  const real = mkdtempSync(path.join(os.tmpdir(), "eli-allow-real2-"));
  const link = path.join(mkdtempSync(path.join(os.tmpdir(), "eli-allow-link2-")), "via-symlink");
  try {
    symlinkSync(real, link);
    assert.throws(
      () =>
        assertCommandAllowed(path.join(link, "elsewhere", "App.exe"), {
          allowedCommandRoots: [path.join(link, "workspace")],
          allowBareCommands: false,
          allowInsecureConfigPermissions: false,
        }),
      /not inside any allowed command root/,
    );
  } finally {
    rmSync(path.dirname(link), { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});
