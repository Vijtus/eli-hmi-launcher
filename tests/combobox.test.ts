import assert from "node:assert/strict";
import test from "node:test";
import { matchOptionByTypeahead } from "../src/renderer/combobox.ts";

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
