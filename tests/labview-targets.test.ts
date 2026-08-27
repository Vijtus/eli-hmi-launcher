import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "../src/main/config/load.ts";
import { materializeLabviewDeveloperTarget } from "../src/main/launch/labview.ts";
import { launchMaterializedProcess } from "../src/main/launch/native.ts";
import type { LabviewDeveloperLaunchTarget } from "../src/shared/types.ts";

const BASE = { appRoot: "/app", configDir: "/config" };

function developerConfig(workspaceRoot: string, zoneSymbol = "L4"): string {
  return `
local:
  workspaceRoot: '${workspaceRoot.replace(/'/g, "''")}'
  zoneSymbol: ${zoneSymbol}
entries:
  - id: dev-camera
    name: Developer Camera
    target:
      kind: labview-dev
      iocName: IOC-CAMERA-01
      hostName: controls-host
      iocType: CameraIOC
      exeName: Camera GUI.exe
`;
}

test("LabVIEW developer target builds the required argv with the space-containing directory", () => {
  const parsed = parseConfig(developerConfig("C:\\ELI Workspace", "L4-ZONE"), BASE);
  const target = parsed.targetsById.get("dev-camera") as LabviewDeveloperLaunchTarget;
  const materialized = materializeLabviewDeveloperTarget(
    target,
    parsed.context,
    { id: "dev-camera", kind: "labview-dev", group: "entry" },
    "win32",
  );

  assert.equal(
    materialized.command,
    "C:\\ELI Workspace\\Common\\ELI\\IOCs\\CameraIOC\\Builds\\GUI Application\\Camera GUI.exe",
  );
  assert.deepEqual(materialized.args, ["controls-host", "IOC-CAMERA-01", "L4-ZONE"]);
});

test("LabVIEW developer target uses POSIX joining without pretending to map Windows drives", () => {
  const parsed = parseConfig(developerConfig("/srv/eli workspace"), BASE);
  const target = parsed.targetsById.get("dev-camera") as LabviewDeveloperLaunchTarget;
  const materialized = materializeLabviewDeveloperTarget(target, parsed.context, undefined, "linux");

  assert.equal(
    materialized.command,
    "/srv/eli workspace/Common/ELI/IOCs/CameraIOC/Builds/GUI Application/Camera GUI.exe",
  );
});

test("LabVIEW developer target requires local workspaceRoot and names the entry", () => {
  assert.throws(
    () =>
      parseConfig(
        `
local:
  zoneSymbol: L4
entries:
  - id: missing-workspace
    name: Missing workspace
    target:
      kind: labview-dev
      iocName: IOC-1
      hostName: host-1
      iocType: TypeA
      exeName: GUI.exe
`,
        BASE,
      ),
    (error: unknown) => {
      assert.match(String(error), /`local\.workspaceRoot` is required/);
      assert.match(String(error), /entry `missing-workspace`/);
      assert.match(String(error), /`kind: labview-dev`/);
      return true;
    },
  );
});

test("LabVIEW developer target requires all four target fields", () => {
  assert.throws(
    () =>
      parseConfig(
        `
local:
  workspaceRoot: /srv/eli
  zoneSymbol: L4
entries:
  - id: missing-host
    name: Missing host
    target:
      kind: labview-dev
      iocName: IOC-1
      iocType: TypeA
      exeName: GUI.exe
`,
        BASE,
      ),
    /labview-dev target without host name \(`hostName`\)/,
  );
});

test("missing resolved LabVIEW developer executable reports the exact path before spawn", async () => {
  const workspaceRoot = path.join(
    os.tmpdir(),
    `eli-missing-labview-dev-${process.pid}-${Date.now()}`,
  );
  const parsed = parseConfig(developerConfig(workspaceRoot), {
    appRoot: workspaceRoot,
    configDir: workspaceRoot,
  });
  parsed.context.security.allowedCommandRoots = [workspaceRoot];
  parsed.context.security.allowBareCommands = false;

  const target = parsed.targetsById.get("dev-camera") as LabviewDeveloperLaunchTarget;
  const materialized = materializeLabviewDeveloperTarget(target, parsed.context);

  await assert.rejects(
    launchMaterializedProcess(materialized, parsed.context),
    new RegExp(
      `Configured command does not exist: ${materialized.command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
  );
});
