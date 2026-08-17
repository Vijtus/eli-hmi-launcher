import assert from "node:assert/strict";
import test from "node:test";
import {
  comboboxOptionId,
  deriveComboboxIds,
  matchOptionByTypeahead,
} from "../src/renderer/combobox.ts";

const labels = ["Select", "Cameras", "Laser", "Pointing", "Timing", "Vacuum"];

test("type-ahead matches the first option starting with the query", () => {
  assert.equal(matchOptionByTypeahead(labels, "c", 0), 1);
  assert.equal(matchOptionByTypeahead(labels, "va", 0), 5);
  assert.equal(matchOptionByTypeahead(labels, "ti", 0), 4);
});

test("type-ahead is case-insensitive", () => {
  assert.equal(matchOptionByTypeahead(labels, "LAS", 0), 2);
});

test("type-ahead searches forward from a start index and wraps once", () => {
  // Two options start with "T" (none here) — use a set with a genuine repeat.
  const repeated = ["Select", "Timing", "Trigger", "Vacuum"];
  assert.equal(matchOptionByTypeahead(repeated, "t", 2), 2);
  assert.equal(matchOptionByTypeahead(repeated, "t", 3), 1); // wraps past Vacuum back to Timing
});

test("type-ahead returns -1 when nothing matches or query is empty", () => {
  assert.equal(matchOptionByTypeahead(labels, "z", 0), -1);
  assert.equal(matchOptionByTypeahead(labels, "", 0), -1);
});

// Regression: the mount element owns `baseId`. Every id the component creates
// must differ from it, or the document contains duplicate id attributes and
// document.getElementById(baseId) resolves to the mount, not the control.
// Observed on the current host before the fix: `technology-filter` and
// `section-filter` each appeared twice in the live renderer DOM.
test("combobox element ids never collide with the mount id", () => {
  const baseId = "technology-filter";
  const ids = deriveComboboxIds(baseId);
  const created = [ids.controlId, ids.listboxId, ids.valueId, comboboxOptionId(baseId, 0)];

  for (const id of created) {
    assert.notEqual(id, baseId, `${id} must not reuse the mount id`);
  }
  assert.equal(new Set(created).size, created.length, "created ids must be unique");
});

test("combobox ids stay namespaced under the mount id", () => {
  const ids = deriveComboboxIds("section-filter");
  assert.equal(ids.controlId, "section-filter-control");
  assert.equal(ids.listboxId, "section-filter-listbox");
  assert.equal(ids.valueId, "section-filter-value");
  assert.equal(comboboxOptionId("section-filter", 3), "section-filter-option-3");
});
