import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "../src/main/config.ts";
import { materializeLabviewEpicsTarget } from "../src/main/labview-targets.ts";
import { launchMaterializedProcess } from "../src/main/native-launcher.ts";
import type { LabviewEpicsLaunchTarget } from "../src/shared/types.ts";

const BASE = { appRoot: "/app", configDir: "/config" };

function epicsConfig(workspaceRoot: string, zoneSymbol = "L4"): string {
  return `
local:
  workspaceRoot: '${workspaceRoot.replace(/'/g, "''")}'
  zoneSymbol: ${zoneSymbol}
entries:
  - id: epics-overview
    name: EPICS Overview
    target:
      kind: labview-epics
      guiName: Main Overview
      guiType: OperatorPanels
      exeName: EPICS GUI.exe
`;
}

test("LabVIEW EPICS target builds the ticket argv with its distinct two-argument order", () => {
  const parsed = parseConfig(epicsConfig("C:\\ELI Workspace", "L4-ZONE"), BASE);
  const target = parsed.targetsById.get("epics-overview") as LabviewEpicsLaunchTarget;
  const materialized = materializeLabviewEpicsTarget(
    target,
    parsed.context,
    { id: "epics-overview", kind: "labview-epics", group: "entry" },
    "win32",
  );

  assert.equal(
    materialized.command,
    "C:\\ELI Workspace\\Common\\ELI\\EPICS_GUIs\\OperatorPanels\\Builds\\GUI Application\\EPICS GUI.exe",
  );
  assert.deepEqual(materialized.args, ["L4-ZONE", "Main Overview"]);
  assert.equal(materialized.args?.length, 2);
});

test("LabVIEW EPICS target uses POSIX path joining on a POSIX development host", () => {
  const parsed = parseConfig(epicsConfig("/srv/eli workspace"), BASE);
  const target = parsed.targetsById.get("epics-overview") as LabviewEpicsLaunchTarget;
  const materialized = materializeLabviewEpicsTarget(target, parsed.context, undefined, "linux");

  assert.equal(
    materialized.command,
    "/srv/eli workspace/Common/ELI/EPICS_GUIs/OperatorPanels/Builds/GUI Application/EPICS GUI.exe",
  );
});

test("LabVIEW EPICS target requires local zoneSymbol and names the entry", () => {
  assert.throws(
    () =>
      parseConfig(
        `
local:
  workspaceRoot: /srv/eli
entries:
  - id: missing-zone
    name: Missing zone
    target:
      kind: labview-epics
      guiName: Overview
      guiType: Panels
      exeName: GUI.exe
`,
        BASE,
      ),
    (error: unknown) => {
      assert.match(String(error), /`local\.zoneSymbol` is required/);
      assert.match(String(error), /entry `missing-zone`/);
      assert.match(String(error), /`kind: labview-epics`/);
      return true;
    },
  );
});

test("LabVIEW EPICS target requires all three ticket fields", () => {
  assert.throws(
    () =>
      parseConfig(
        `
local:
  workspaceRoot: /srv/eli
  zoneSymbol: L4
entries:
  - id: missing-type
    name: Missing type
    target:
      kind: labview-epics
      guiName: Overview
      exeName: GUI.exe
`,
        BASE,
      ),
    /labview-epics target without GUI type \(`guiType`\)/,
  );
});

test("missing resolved LabVIEW EPICS executable reports the exact path before spawn", async () => {
  const workspaceRoot = path.join(
    os.tmpdir(),
    `eli-missing-labview-epics-${process.pid}-${Date.now()}`,
  );
  const parsed = parseConfig(epicsConfig(workspaceRoot), {
    appRoot: workspaceRoot,
    configDir: workspaceRoot,
  });
  parsed.context.security.allowedCommandRoots = [workspaceRoot];
  parsed.context.security.allowBareCommands = false;

  const target = parsed.targetsById.get("epics-overview") as LabviewEpicsLaunchTarget;
  const materialized = materializeLabviewEpicsTarget(target, parsed.context);

  await assert.rejects(
    launchMaterializedProcess(materialized, parsed.context),
    new RegExp(
      `Configured command does not exist: ${materialized.command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
  );
});
