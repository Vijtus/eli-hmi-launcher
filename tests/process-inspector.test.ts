import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { inspectProcess, inspectProcesses } from "../src/main/process-inspector.ts";

// A non-Linux platform argument routes inspection through the `ps` path used on
// macOS/BSD. `ps` is exercised here against this test's own live process, so
// these cases only run where a `ps` binary exists — Windows takes the
// PowerShell branch in production and has nothing to exercise here.
const skipPs = { skip: process.platform === "win32" ? "requires a POSIX `ps`" : false };

test("POSIX inspection combines start time and command into a stable opaque identity", skipPs, async () => {
  const first = await inspectProcess(process.pid, "freebsd");
  assert.equal(first.alive, true);
  assert.match(first.identity ?? "", /^posix:.+/);
  const second = await inspectProcess(process.pid, "freebsd");
  assert.equal(second.identity, first.identity);
});

test("POSIX inspection reports a nonexistent PID as not alive", skipPs, async () => {
  const observation = await inspectProcess(2_000_000_000, "freebsd");
  assert.equal(observation.alive, false);
});

test("process inspection rejects a non-positive PID before shelling out", async () => {
  const observation = await inspectProcess(0, "freebsd");
  assert.equal(observation.alive, false);
  assert.match(observation.reason ?? "", /invalid process id/);
});

// Reconciling twelve launched GUIs used to spawn twelve subprocesses every five
// seconds. Each took about a second to start, so they blew their timeout, no
// start identity came back, and every row degraded to `unknown` while the
// snapshot went stale — the check failing exactly when the launcher was busiest.
test("batch inspection answers for many processes at once", skipPs, async () => {
  const children = [0, 1, 2].map(() =>
    spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0), 5000)"], { stdio: "ignore" }),
  );
  await Promise.all(children.map((c) => new Promise((r) => c.once("spawn", r))));
  const pids = children.map((c) => c.pid as number);
  try {
    const observations = await inspectProcesses(pids, "freebsd");
    assert.equal(observations.size, pids.length);
    for (const pid of pids) {
      const observation = observations.get(pid);
      assert.equal(observation?.alive, true, `pid ${pid} should be alive`);
      assert.match(observation?.identity ?? "", /^posix:.+/);
    }
  } finally {
    for (const child of children) child.kill("SIGKILL");
  }
});

test("batch inspection reports a dead process without claiming the rest died", skipPs, async () => {
  const alive = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0), 5000)"], {
    stdio: "ignore",
  });
  await new Promise((r) => alive.once("spawn", r));
  try {
    const observations = await inspectProcesses([alive.pid as number, 2_000_000_000], "freebsd");
    assert.equal(observations.get(alive.pid as number)?.alive, true);
    assert.equal(observations.get(2_000_000_000)?.alive, false);
  } finally {
    alive.kill("SIGKILL");
  }
});

test("batch inspection rejects invalid pids without shelling out", async () => {
  const observations = await inspectProcesses([0, -5], "freebsd");
  assert.equal(observations.get(0)?.alive, false);
  assert.match(observations.get(0)?.reason ?? "", /invalid process id/);
});
