import assert from "node:assert/strict";
import test from "node:test";
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
