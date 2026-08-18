import assert from "node:assert/strict";
import test from "node:test";
import { deepMerge, mergeMappings } from "../src/main/config-merge.ts";

test("mappings merge key by key and recursively", () => {
  const merged = deepMerge(
    { phoebus: { serverPort: 4918, startupTimeoutMs: 30000 }, zoneSymbol: "L4" },
    { phoebus: { serverPort: 5000 } },
  );
  assert.deepEqual(merged, {
    phoebus: { serverPort: 5000, startupTimeoutMs: 30000 },
    zoneSymbol: "L4",
  });
});

test("scalars replace", () => {
  assert.equal(deepMerge("zone-value", "host-value"), "host-value");
  assert.deepEqual(deepMerge({ a: 1 }, { a: 2 }), { a: 2 });
});

test("lists REPLACE wholesale and never concatenate", () => {
  const merged = deepMerge({ hmis: ["a", "b", "c"] }, { hmis: ["only"] });
  assert.deepEqual(merged, { hmis: ["only"] });
});

test("an empty list clears a base list deliberately", () => {
  assert.deepEqual(deepMerge({ hmis: ["a", "b"] }, { hmis: [] }), { hmis: [] });
});

test("absent and null keys never override the base", () => {
  const merged = deepMerge(
    { workspaceRoot: "D:/ws", cssGuiRoot: "D:/css" },
    { workspaceRoot: null, other: "x" },
  );
  assert.deepEqual(merged, { workspaceRoot: "D:/ws", cssGuiRoot: "D:/css", other: "x" });
});

test("a null or undefined override returns the base untouched", () => {
  assert.deepEqual(deepMerge({ a: 1 }, null), { a: 1 });
  assert.deepEqual(deepMerge({ a: 1 }, undefined), { a: 1 });
});

test("an object may be replaced by a scalar and vice versa", () => {
  assert.equal(deepMerge({ a: 1 }, "flat"), "flat");
  assert.deepEqual(deepMerge("flat", { a: 1 }), { a: 1 });
});

test("merging does not mutate either input", () => {
  const base = { phoebus: { serverPort: 1 } };
  const override = { phoebus: { serverPort: 2 } };
  deepMerge(base, override);
  assert.deepEqual(base, { phoebus: { serverPort: 1 } });
  assert.deepEqual(override, { phoebus: { serverPort: 2 } });
});

test("mergeMappings always yields a mapping", () => {
  assert.deepEqual(mergeMappings({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
});
