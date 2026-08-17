import assert from "node:assert/strict";
import test from "node:test";
import { convertIntakeCsv, parseCsv, yamlScalar } from "../src/shared/intake.ts";
import { parseConfig } from "../src/main/config.ts";

const HEADER =
  "Entry ID,Name,Technology,Section,Platform,RMC,Note,Target kind (process/web/folder)," +
  '"Command, URL, or folder path",Arguments (JSON or semicolon-separated),Working directory,' +
  "Environment requirements,Owner/contact,Enabled (yes/no),Tested on host,Test result/date,Comments";

function sheet(...rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

test("CSV parser handles quoted fields, embedded commas, and escaped quotes", () => {
  const rows = parseCsv('a,"b,c","d""e"\n"multi\nline",x,');
  assert.deepEqual(rows, [
    ["a", "b,c", 'd"e'],
    ["multi\nline", "x", ""],
  ]);
});

test("converted enabled rows produce YAML the real config parser accepts", () => {
  const csv = sheet(
    'L4-GUI-001,Example Process GUI,Cameras; Timing,"L4b, L4c",LabVIEW,RMC000,Test note,process,' +
      '/opt/example/wrapper.sh,--layout; overview,/opt/example,EPICS_ADDR=10.0.0.1,Owner A,yes,host1,OK 2026-07-01,First row',
    "L4-GUI-002,Example Web GUI,Laser,L4c,Web,--,--,web,https://gui.example/status,,,,Owner B,yes,,,",
  );

  const result = convertIntakeCsv(csv);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.includedIds, ["l4-gui-001", "l4-gui-002"]);

  const parsed = parseConfig(result.yaml, { appRoot: "/tmp/app", configDir: "/tmp/cfg" });
  assert.equal(parsed.rows.length, 2);

  const first = parsed.rows[0];
  assert.equal(first.id, "l4-gui-001");
  assert.equal(first.name, "Example Process GUI");
  assert.deepEqual(first.technology, ["Cameras", "Timing"]);
  assert.deepEqual(first.section, ["L4b", "L4c"]);
  assert.equal(first.rmc, "RMC000");

  const firstTarget = parsed.targetsById.get("l4-gui-001");
  assert.ok(firstTarget && firstTarget.kind === "process");
  assert.equal(firstTarget.command, "/opt/example/wrapper.sh");
  assert.deepEqual(firstTarget.args, ["--layout", "overview"]);
  assert.equal(firstTarget.cwd, "/opt/example");
  assert.deepEqual(firstTarget.env, { EPICS_ADDR: "10.0.0.1" });

  const secondTarget = parsed.targetsById.get("l4-gui-002");
  assert.ok(secondTarget && secondTarget.kind === "web");
  assert.equal(secondTarget.url, "https://gui.example/status");
});

test("conversion is deterministic and keeps sheet metadata as comments", () => {
  const csv = sheet(
    "L4-GUI-001,Some GUI,Vacuum,L4,CSS,--,--,folder,/mnt/shared,,,,Owner C,yes,hostX,OK,Needs review",
  );
  const first = convertIntakeCsv(csv);
  const second = convertIntakeCsv(csv);
  assert.equal(first.yaml, second.yaml);
  assert.match(first.yaml, /# owner: Owner C \| tested on: hostX \| result: OK/);
  assert.match(first.yaml, /# Needs review/);
  assert.match(first.yaml, /path: \/mnt\/shared/);
});

test("blank template rows are ignored; Enabled=no rows are skipped with a reason", () => {
  const csv = sheet(
    "L4-GUI-001,,,,,,,,,,,,,,,,",
    "L4-GUI-002,Disabled GUI,Vacuum,L4,CSS,--,--,process,/opt/x.sh,,,,Owner,no,,,",
    "L4-GUI-003,Enabled GUI,Vacuum,L4,CSS,--,--,process,/opt/y.sh,,,,Owner,yes,,,",
  );
  const result = convertIntakeCsv(csv);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.includedIds, ["l4-gui-003"]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].row, 3);
  assert.match(result.skipped[0].reason, /Enabled is 'no'/);
});

test("invalid rows abort with row-numbered errors instead of guessed values", () => {
  const csv = sheet(
    "L4-GUI-001,,Vacuum,L4,CSS,--,--,process,/opt/a.sh,,,,Owner,yes,,,", // no name
    "L4-GUI-002,Bad Kind,Vacuum,L4,CSS,--,--,shortcut,/opt/b.sh,,,,Owner,yes,,,", // bad kind
    "L4-GUI-003,Bad URL,Laser,L4,Web,--,--,web,ftp://example/x,,,,Owner,yes,,,", // bad scheme
    "L4-GUI-004,Bad Env,Vacuum,L4,CSS,--,--,process,/opt/c.sh,,,not-a-pair,Owner,yes,,,", // bad env
    "L4-GUI-005,No Decision,Vacuum,L4,CSS,--,--,process,/opt/d.sh,,,,Owner,,,,", // enabled empty
  );
  const result = convertIntakeCsv(csv);
  assert.equal(result.yaml, "");
  assert.deepEqual(
    result.errors.map((error) => error.row),
    [2, 3, 4, 5, 6],
  );
  assert.match(result.errors[0].message, /Name is required/);
  assert.match(
    result.errors[1].message,
    /must be process, web, folder, labview-dev, labview-epics, or phoebus/,
  );
  assert.match(result.errors[2].message, /http\(s\) URL/);
  assert.match(result.errors[3].message, /NAME=value/);
  assert.match(result.errors[4].message, /Enabled/);
});

test("duplicate ids across rows are rejected", () => {
  const csv = sheet(
    "L4-GUI-001,Twin,Vacuum,L4,CSS,--,--,process,/opt/a.sh,,,,O,yes,,,",
    "l4 gui 001,Other Twin,Vacuum,L4,CSS,--,--,process,/opt/b.sh,,,,O,yes,,,",
  );
  const result = convertIntakeCsv(csv);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].row, 3);
  assert.match(result.errors[0].message, /Duplicate id 'l4-gui-001'/);
});

test("a UTF-8 BOM before the header is tolerated", () => {
  const csv = "﻿" + sheet("L4-GUI-001,BOM GUI,Vacuum,L4,CSS,--,--,process,/opt/a.sh,,,,O,yes,,,");
  const result = convertIntakeCsv(csv);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.includedIds, ["l4-gui-001"]);
});

test("YAML scalars that need quoting are quoted", () => {
  assert.equal(yamlScalar("plain-value"), "plain-value");
  assert.equal(yamlScalar("--"), "--");
  assert.equal(yamlScalar("--layout"), "'--layout'");
  assert.equal(yamlScalar("C:\\ELI\\wrapper.exe"), "'C:\\ELI\\wrapper.exe'");
  assert.equal(yamlScalar("has: colon"), "'has: colon'");
  assert.equal(yamlScalar("it's"), "'it''s'");
  assert.equal(yamlScalar("123"), "'123'");
  assert.equal(yamlScalar("yes"), "'yes'");
});

test("intake conversion emits the four LabVIEW developer fields without a hand-written command", () => {
  const extendedHeader =
    HEADER + ",IOC name,Host name,IOC type,GUI name,GUI type,EXE name,Phoebus resource URI/path,Phoebus app name,Phoebus use configured layout (yes/no)";
  const csv = [
    extendedHeader,
    "L4-GUI-DEV,Developer GUI,Laser,L4,LabVIEW,--,--,labview-dev,,,,,Owner,yes,,," +
      ",IOC-L4-01,controls-host,MainIOC,,,Developer GUI.exe,,,",
  ].join("\n");

  const result = convertIntakeCsv(csv);
  assert.deepEqual(result.errors, []);
  assert.match(result.yaml, /kind: labview-dev/);
  assert.match(result.yaml, /iocName: IOC-L4-01/);
  assert.match(result.yaml, /hostName: controls-host/);
  assert.match(result.yaml, /iocType: MainIOC/);
  assert.match(result.yaml, /exeName: Developer GUI\.exe/);
  assert.doesNotMatch(result.yaml, /command:/);

  const withLocal = result.yaml.replace(
    "appName: L4 Launcher",
    "appName: L4 Launcher\nlocal:\n  workspaceRoot: /srv/eli\n  zoneSymbol: L4",
  );
  const parsed = parseConfig(withLocal, { appRoot: "/tmp/app", configDir: "/tmp/cfg" });
  const target = parsed.targetsById.get("l4-gui-dev");
  assert.ok(target && target.kind === "labview-dev");
  assert.equal(target.exeName, "Developer GUI.exe");
});

test("intake conversion emits the three LabVIEW EPICS fields without a hand-written command", () => {
  const extendedHeader =
    HEADER + ",IOC name,Host name,IOC type,GUI name,GUI type,EXE name,Phoebus resource URI/path,Phoebus app name,Phoebus use configured layout (yes/no)";
  const csv = [
    extendedHeader,
    "L4-GUI-EPICS,EPICS GUI,Laser,L4,LabVIEW,--,--,labview-epics,,,,,Owner,yes,,," +
      ",,,,MainPanels,Overview,EPICS Overview.exe,,,",
  ].join("\n");

  const result = convertIntakeCsv(csv);
  assert.deepEqual(result.errors, []);
  assert.match(result.yaml, /kind: labview-epics/);
  assert.match(result.yaml, /guiName: MainPanels/);
  assert.match(result.yaml, /guiType: Overview/);
  assert.match(result.yaml, /exeName: EPICS Overview\.exe/);
  assert.doesNotMatch(result.yaml, /command:/);

  const withLocal = result.yaml.replace(
    "appName: L4 Launcher",
    "appName: L4 Launcher\nlocal:\n  workspaceRoot: /srv/eli\n  zoneSymbol: L4",
  );
  const parsed = parseConfig(withLocal, { appRoot: "/tmp/app", configDir: "/tmp/cfg" });
  const target = parsed.targetsById.get("l4-gui-epics");
  assert.ok(target && target.kind === "labview-epics");
  assert.equal(target.guiName, "MainPanels");
});

test("intake conversion emits a Phoebus server/resource target", () => {
  const extendedHeader =
    HEADER + ",IOC name,Host name,IOC type,GUI name,GUI type,EXE name,Phoebus resource URI/path,Phoebus app name,Phoebus use configured layout (yes/no)";
  const csv = [
    extendedHeader,
    "L4-PHOEBUS,Panel,Laser,L4,Phoebus,--,--,phoebus,,,,,Owner,yes,,," +
      ",,,,,,,panels/main.bob,<app-name-from-list>,",
  ].join("\n");

  const result = convertIntakeCsv(csv);
  assert.deepEqual(result.errors, []);
  assert.match(result.yaml, /kind: phoebus/);
  assert.match(result.yaml, /resource: panels\/main\.bob/);
  assert.match(result.yaml, /app: '<app-name-from-list>'/);
  assert.doesNotMatch(result.yaml, /command:/);

  const withLocal = result.yaml.replace(
    "appName: L4 Launcher",
    "appName: L4 Launcher\nlocal:\n  cssGuiRoot: /srv/css\n  phoebus:\n    executable: /opt/phoebus/phoebus.sh\n    serverPort: 4918",
  );
  const parsed = parseConfig(withLocal, { appRoot: "/tmp/app", configDir: "/tmp/cfg" });
  const target = parsed.targetsById.get("l4-phoebus");
  assert.ok(target && target.kind === "phoebus");
  assert.equal(target.resource, "panels/main.bob");
  assert.equal(target.app, "<app-name-from-list>");
});

test("intake conversion can request the locally configured Phoebus layout", () => {
  const extendedHeader =
    HEADER + ",IOC name,Host name,IOC type,GUI name,GUI type,EXE name,Phoebus resource URI/path,Phoebus app name,Phoebus use configured layout (yes/no)";
  const csv = [
    extendedHeader,
    "L4-ALARMS,Alarm layout,Laser,L4,Phoebus,--,--,phoebus,,,,,Owner,yes,,," +
      ",,,,,,,,,yes",
  ].join("\n");

  const result = convertIntakeCsv(csv);
  assert.deepEqual(result.errors, []);
  assert.match(result.yaml, /kind: phoebus/);
  assert.match(result.yaml, /layout: true/);

  const withLocal = result.yaml.replace(
    "appName: L4 Launcher",
    "appName: L4 Launcher\nlocal:\n  phoebus:\n    executable: /opt/phoebus/phoebus.sh\n    serverPort: 4918\n    layoutFile: /srv/css/alarm.memento",
  );
  const parsed = parseConfig(withLocal, { appRoot: "/tmp/app", configDir: "/tmp/cfg" });
  const target = parsed.targetsById.get("l4-alarms");
  assert.ok(target && target.kind === "phoebus");
  assert.equal(target.layout, true);
});

test("intake rejects a per-entry Phoebus layout path", () => {
  const extendedHeader =
    HEADER + ",IOC name,Host name,IOC type,GUI name,GUI type,EXE name,Phoebus resource URI/path,Phoebus app name,Phoebus use configured layout (yes/no)";
  const csv = [
    extendedHeader,
    "L4-ALARMS,Alarm layout,Laser,L4,Phoebus,--,--,phoebus,,,,,Owner,yes,,," +
      ",,,,,,,,,C:/invented/alarm.memento",
  ].join("\n");

  const result = convertIntakeCsv(csv);
  assert.equal(result.yaml, "");
  assert.match(result.errors[0]?.message ?? "", /must be yes or no/);
  assert.match(result.errors[0]?.message ?? "", /local\.phoebus\.layoutFile/);
});
