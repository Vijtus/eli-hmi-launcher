import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { adaptZoneDocument } from "../src/main/zone-adapter.ts";

// Verbatim copy of launcher/zone/TESTZ.yaml from eli-eric/eli-hmi-config@ad98e4b.
const REAL_ZONE = `labview-dev:
  - ioc-name: Camera Manager
    host: RMC00-001
    ioc-type: Camera Manager
    exe: CMD.exe
  - ioc-name: Camera Manager
    host: RMC00-002
    ioc-type: Camera Manager
    exe: CMD.exe
  - ioc-name: Camera Manager
    host: RMC00-003
    ioc-type: Camera Manager
    exe: CMD.exe
  - ioc-name: Fast Pointing IOC
    host: RMC00-001
    ioc-type: Fast Pointing IOC
    exe: Fast Pointing.exe
  - ioc-name: Pointing
    host: RMC00-002
    ioc-type: Pointing
    exe: Pointing4x4.exe
labview-epics:
css:
web:
`;

function adapt(text: string) {
  return adaptZoneDocument(YAML.parse(text) as Record<string, unknown>, "/repo/launcher/zone/TESTZ.yaml");
}

test("the real TESTZ zone file produces five labview-dev entries", () => {
  const { entries, warnings } = adapt(REAL_ZONE);
  assert.equal(entries.length, 5);
  assert.deepEqual(warnings, []);
});

test("empty (null) groups are valid and contribute nothing", () => {
  // labview-epics, css and web are all null in the real repo today.
  const { entries } = adapt("labview-dev:\nlabview-epics:\ncss:\nweb:\n");
  assert.deepEqual(entries, []);
});

test("labview-dev items map onto the launcher's labview-dev target", () => {
  const { entries } = adapt(REAL_ZONE);
  assert.deepEqual(entries[0], {
    id: "labview-dev-camera-manager-rmc00-001",
    name: "Camera Manager",
    technology: "--",
    section: "--",
    platform: "LabVIEW",
    rmc: "RMC00-001",
    note: "--",
    target: {
      kind: "labview-dev",
      iocName: "Camera Manager",
      hostName: "RMC00-001",
      iocType: "Camera Manager",
      exeName: "CMD.exe",
    },
  });
});

test("ids stay unique when one IOC name runs on several hosts", () => {
  const ids = adapt(REAL_ZONE).entries.map((entry) => entry["id"]);
  assert.deepEqual(new Set(ids).size, ids.length);
  assert.deepEqual(ids.slice(0, 3), [
    "labview-dev-camera-manager-rmc00-001",
    "labview-dev-camera-manager-rmc00-002",
    "labview-dev-camera-manager-rmc00-003",
  ]);
});

test("ids are deterministic across repeated adaptations", () => {
  assert.deepEqual(
    adapt(REAL_ZONE).entries.map((entry) => entry["id"]),
    adapt(REAL_ZONE).entries.map((entry) => entry["id"]),
  );
});

test("an explicit id in the config repo overrides the generated slug", () => {
  const { entries } = adapt(
    "labview-dev:\n  - id: custom-id\n    ioc-name: X\n    host: H\n    ioc-type: T\n    exe: E.exe\n",
  );
  assert.equal(entries[0]?.["id"], "custom-id");
});

test("optional display columns can be supplied per item", () => {
  const { entries } = adapt(
    "labview-dev:\n  - ioc-name: X\n    host: H\n    ioc-type: T\n    exe: E.exe\n" +
      "    technology: Cameras\n    section: L4b\n    note: two cams\n",
  );
  assert.equal(entries[0]?.["technology"], "Cameras");
  assert.equal(entries[0]?.["section"], "L4b");
  assert.equal(entries[0]?.["note"], "two cams");
});

test("labview-epics items map onto the launcher's labview-epics target", () => {
  const { entries } = adapt(
    "labview-epics:\n  - gui-name: Vacuum Overview\n    gui-type: Vacuum\n    exe: Vacuum.exe\n",
  );
  assert.deepEqual(entries[0]?.["target"], {
    kind: "labview-epics",
    guiName: "Vacuum Overview",
    guiType: "Vacuum",
    exeName: "Vacuum.exe",
  });
  assert.equal(entries[0]?.["platform"], "LabVIEW");
});

test("css items map onto the phoebus target and default to the CSS platform", () => {
  const { entries } = adapt("css:\n  - name: Cooling\n    resource: cooling.bob\n");
  assert.deepEqual(entries[0]?.["target"], { kind: "phoebus", resource: "cooling.bob" });
  assert.equal(entries[0]?.["platform"], "CSS");
});

test("a css item may name the Phoebus app that opens its resource", () => {
  const { entries } = adapt("css:\n  - name: Alarms\n    resource: alarms.bob\n    app: alarm_tree\n");
  assert.deepEqual(entries[0]?.["target"], { kind: "phoebus", resource: "alarms.bob", app: "alarm_tree" });
});

test("a css item may restore a saved layout instead of a resource", () => {
  const { entries } = adapt("css:\n  - name: Layout\n    layout: true\n");
  assert.deepEqual(entries[0]?.["target"], { kind: "phoebus", layout: true });
});

test("a css item with nothing to open is rejected with a remedy", () => {
  assert.throws(() => adapt("css:\n  - name: Empty\n"), /must set `resource` or `layout: true`/);
});

// The launcher treats `app` as a query parameter applied to a resource, so an
// app-only entry would load here and fail later; reject it where the message can
// name the config repo file.
test("a css item with `app` but no `resource` is rejected in the adapter", () => {
  assert.throws(
    () => adapt("css:\n  - name: Alarms\n    app: alarm_tree\n"),
    (error: Error) => {
      assert.match(error.message, /sets `app` without `resource`/);
      assert.match(error.message, /Remedy: add `resource:`, or drop `app` and use `layout: true`/);
      return true;
    },
  );
});

test("web items map onto the web target", () => {
  const { entries } = adapt("web:\n  - name: Wiki\n    url: https://wiki.example.org\n");
  assert.deepEqual(entries[0]?.["target"], { kind: "web", url: "https://wiki.example.org" });
  assert.equal(entries[0]?.["platform"], "Web");
});

test("a missing required key names the group, the item, and the remedy", () => {
  assert.throws(
    () => adapt("labview-dev:\n  - ioc-name: X\n    ioc-type: T\n    exe: E.exe\n"),
    (error: Error) => {
      assert.match(error.message, /entry 1 in `labview-dev` is missing required key `host`/);
      assert.match(error.message, /Remedy: add `host: <value>`/);
      return true;
    },
  );
});

test("a group that is not a list is rejected with the file and the key", () => {
  assert.throws(() => adapt("labview-dev: nonsense\n"), /key `labview-dev` must be a YAML list or empty/);
});

test("a non-mapping list item is rejected naming its position", () => {
  assert.throws(() => adapt("labview-dev:\n  - just-a-string\n"), /entry 1 in `labview-dev` is not a mapping/);
});

test("an unknown group is skipped with a warning rather than failing", () => {
  const { entries, warnings } = adapt("labview-dev:\nfuture-group:\n  - name: X\n");
  assert.deepEqual(entries, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /unknown group `future-group`; it was ignored/);
});

test("zone-level metadata keys are not treated as HMI groups", () => {
  const { entries, warnings } = adapt("zone: TESTZ\ndescription: test zone\nlocal:\n  zoneSymbol: TESTZ\n");
  assert.deepEqual(entries, []);
  assert.deepEqual(warnings, []);
});

test("a duplicate generated id is rejected naming both contributors", () => {
  assert.throws(
    () =>
      adapt(
        "labview-dev:\n  - ioc-name: X\n    host: H\n    ioc-type: T\n    exe: E.exe\n" +
          "  - ioc-name: X\n    host: H\n    ioc-type: T2\n    exe: E2.exe\n",
      ),
    (error: Error) => {
      assert.match(error.message, /duplicate launcher id 'labview-dev-x-h'/);
      assert.match(error.message, /`labview-dev` entry 1 and `labview-dev` entry 2/);
      return true;
    },
  );
});
