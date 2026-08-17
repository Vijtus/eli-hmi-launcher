import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Electron main refreshes remote state before policy and acquires a reservation before constrained spawn", async () => {
  const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
  const handler = source.indexOf('ipcMain.handle("launcher:launch-item"');
  const refresh = source.indexOf("lifecycleCoordinator?.refresh(itemId)", handler);
  const policy = source.indexOf("runWithLaunchPolicy(", handler);
  const reservation = source.indexOf("acquireReservation({", policy);
  const spawn = source.indexOf("await launchTarget(", reservation);

  assert.ok(handler >= 0, "launch handler exists in Electron main");
  assert.ok(refresh > handler, "remote lifecycle state is refreshed inside the launch gate");
  assert.ok(policy > refresh, "policy evaluates after the remote refresh");
  assert.ok(reservation > policy, "reservation is acquired after the policy permits launch");
  assert.ok(spawn > reservation, "target spawn happens only after reservation acquisition");
});

test("runtime registry changes are published and shutdown attempts deregistration", async () => {
  const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
  assert.match(source, /lifecycleCoordinator\?\.observeSnapshot\(snapshot\)/);
  assert.match(source, /await lifecycleCoordinator\.stop\(\)/);
  assert.match(source, /app\.quit\(\)/);
});
