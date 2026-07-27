import assert from "node:assert/strict";
import test from "node:test";
import {
  filterLauncherRows,
  getUniqueMultiValues,
  matchesLauncherSearch,
} from "../src/shared/filtering.ts";
import type { LauncherRow } from "../src/shared/types.ts";

const row: LauncherRow = {
  id: "camera-manager",
  name: "Camera Manager",
  technology: ["LabVIEW", "EPICS"],
  section: ["L4b"],
  platform: "Windows",
  rmc: "RMC-17",
  note: "Controls the east tunnel cameras",
};

test("search matches name and note case-insensitively", () => {
  assert.equal(matchesLauncherSearch(row, "camera manager"), true);
  assert.equal(matchesLauncherSearch(row, "EAST TUNNEL"), true);
});

test("search trims its query and performs substring matching", () => {
  assert.equal(matchesLauncherSearch(row, "  mera Man  "), true);
  assert.equal(matchesLauncherSearch(row, "  tunnel cam  "), true);
});

test("search does not match technology, section, platform, or RMC", () => {
  for (const query of ["LabVIEW", "EPICS", "L4b", "Windows", "RMC-17"]) {
    assert.equal(matchesLauncherSearch(row, query), false, query);
  }
});

test("metadata-looking values still match when they occur in Name or Note", () => {
  const searchable: LauncherRow = {
    ...row,
    id: "searchable-metadata-words",
    name: "Windows LabVIEW Console",
    note: "EPICS controls for L4b and RMC-17",
  };

  for (const query of ["LabVIEW", "EPICS", "L4b", "Windows", "RMC-17"]) {
    assert.equal(matchesLauncherSearch(searchable, query), true, query);
  }
});

test("search does not match IDs or a phrase spanning the Name and Note boundary", () => {
  assert.equal(matchesLauncherSearch(row, "camera-manager"), false);
  assert.equal(matchesLauncherSearch(row, "manager controls"), false);
});

test("only Technology and Section affect dropdown filtering", () => {
  assert.deepEqual(
    filterLauncherRows([row], { search: "", technology: "", section: "" }),
    [row],
  );
  assert.deepEqual(
    filterLauncherRows([row], { search: "", technology: "LabVIEW", section: "L4b" }),
    [row],
  );
  assert.deepEqual(
    filterLauncherRows([row], { search: "", technology: "Phoebus", section: "" }),
    [],
  );
  assert.deepEqual(
    filterLauncherRows([row], { search: "", technology: "", section: "L4c" }),
    [],
  );
});

test("multivalue rows match on every one of their values", () => {
  // technology = ["LabVIEW", "EPICS"], section = ["L4b"]: both technology
  // values must select the row, alone and combined with a section filter.
  for (const technology of ["LabVIEW", "EPICS"]) {
    assert.deepEqual(filterLauncherRows([row], { search: "", technology, section: "" }), [row], technology);
    assert.deepEqual(filterLauncherRows([row], { search: "", technology, section: "L4b" }), [row], technology);
  }

  const multiSection = { ...row, id: "multi-section", section: ["L4b", "L4c"] };
  for (const section of ["L4b", "L4c"]) {
    assert.deepEqual(filterLauncherRows([multiSection], { search: "", technology: "", section }), [multiSection], section);
  }
  assert.deepEqual(
    filterLauncherRows([multiSection], { search: "", technology: "EPICS", section: "L4c" }),
    [multiSection],
  );
});

test("filters and search combine: a filtered-in row still honours search scope", () => {
  assert.deepEqual(filterLauncherRows([row], { search: "east tunnel", technology: "EPICS", section: "" }), [row]);
  assert.deepEqual(filterLauncherRows([row], { search: "RMC-17", technology: "EPICS", section: "" }), []);
});

test("filter option values are unique, sorted, and omit placeholders", () => {
  const second = {
    ...row,
    id: "two",
    technology: ["EPICS", "Phoebus", "--"],
    section: ["L4c", "L4a", "L4b"],
  };
  assert.deepEqual(getUniqueMultiValues([row, second], "technology"), ["EPICS", "LabVIEW", "Phoebus"]);
  assert.deepEqual(getUniqueMultiValues([row, second], "section"), ["L4a", "L4b", "L4c"]);
});
