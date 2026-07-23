import assert from "node:assert/strict";
import test from "node:test";
import { statusForLaunchResult } from "../src/shared/launch-status.ts";

test("successful launches are silent (no status message at all)", () => {
  assert.equal(
    statusForLaunchResult({
      ok: true,
      id: "camera-manager",
      label: "Camera Manager",
      kind: "process",
      launchedAt: "2026-07-23T10:00:00.000Z",
    }),
    null,
  );
});

test("failed launches produce a visible error naming the item and the cause", () => {
  const status = statusForLaunchResult({
    ok: false,
    id: "camera-manager",
    label: "Camera Manager",
    kind: "process",
    error: "Configured command does not exist: /opt/nowhere/launch.sh",
    launchedAt: "2026-07-23T10:00:00.000Z",
  });
  assert.ok(status, "failure must produce a status");
  assert.equal(status.isError, true);
  assert.match(status.message, /Camera Manager/);
  assert.match(status.message, /Configured command does not exist: \/opt\/nowhere\/launch\.sh/);
});
