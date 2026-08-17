import assert from "node:assert/strict";
import test from "node:test";
import { inspectProcess } from "../src/main/process-inspector.ts";

// A non-Linux platform argument routes inspection through the `ps` path used on
// macOS/BSD. `ps` is exercised here against this test's own live process.
test("POSIX inspection combines start time and command into a stable opaque identity", async () => {
  const first = await inspectProcess(process.pid, "freebsd");
  assert.equal(first.alive, true);
  assert.match(first.identity ?? "", /^posix:.+/);
  const second = await inspectProcess(process.pid, "freebsd");
  assert.equal(second.identity, first.identity);
});

test("POSIX inspection reports a nonexistent PID as not alive", async () => {
  const observation = await inspectProcess(2_000_000_000, "freebsd");
  assert.equal(observation.alive, false);
});

test("process inspection rejects a non-positive PID before shelling out", async () => {
  const observation = await inspectProcess(0, "freebsd");
  assert.equal(observation.alive, false);
  assert.match(observation.reason ?? "", /invalid process id/);
});
