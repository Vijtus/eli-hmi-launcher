import assert from "node:assert/strict";
import test from "node:test";
import { catalogStalenessMessage } from "../src/shared/catalog-status.ts";

test("fresh catalogs do not render a staleness message", () => {
  assert.equal(catalogStalenessMessage({ stale: false, sources: [], warnings: [] }), undefined);
});

test("cached and unavailable source ids are visible in the staleness message", () => {
  const message = catalogStalenessMessage({
    stale: true,
    warnings: ["degraded"],
    sources: [
      { id: "inline", state: "inline", stale: false, entryCount: 1 },
      { id: "shared", state: "cached", stale: true, entryCount: 2, loadedAt: "2026-07-28T09:00:00.000Z" },
      { id: "optional", state: "unavailable", stale: true, entryCount: 0 },
    ],
  });
  assert.match(message ?? "", /CATALOG STALE/);
  assert.match(message ?? "", /shared: cached/);
  assert.match(message ?? "", /optional: unavailable/);
});
