import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { watchLaunch } from "../src/main/launch-watch.ts";

const fast = [50, 100, 200];
const noSleep = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, 250))));
};

// The case that matters: a GUI that spawns, throws its error dialog and dies.
// It returned a pid, so a launcher that stops watching at spawn calls it a win.
test("a process that dies shortly after launch is reported as exited early", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(3), 60)"], {
    stdio: "ignore",
  });
  await new Promise((resolve) => child.once("spawn", resolve));
  const result = await watchLaunch(child.pid as number, undefined, fast, noSleep);
  assert.equal(result.outcome, "exited-early");
  assert.ok(result.observedForMs < 200, `observed for ${result.observedForMs}ms`);
});

// The child has to outlive the probing, not just the checkpoints. Each
// inspection costs a PowerShell subprocess on Windows — around two seconds —
// so three checkpoints take far longer than the checkpoint values suggest, and
// a short-lived child exits mid-watch and is correctly reported as having quit.
test("a process that keeps running is reported as still running", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0), 120000)"], {
    stdio: "ignore",
  });
  await new Promise((resolve) => child.once("spawn", resolve));
  try {
    const result = await watchLaunch(child.pid as number, undefined, fast, noSleep);
    assert.equal(result.outcome, "still-running");
    assert.equal(result.observedForMs, 200);
  } finally {
    child.kill("SIGKILL");
  }
});

// Whatever the program printed is the actual explanation; without it the report
// can only say "it stopped".
test("captured output is attached so the failure explains itself", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "eli-watch-"));
  try {
    const capture = path.join(dir, "out.log");
    writeFileSync(capture, "LabVIEW: Error 1055 occurred at Open VI Reference\n");
    const child = spawn(process.execPath, ["-e", "process.exit(1)"], { stdio: "ignore" });
    await new Promise((resolve) => child.once("spawn", resolve));
    const result = await watchLaunch(child.pid as number, capture, fast, noSleep);
    assert.equal(result.outcome, "exited-early");
    assert.match(result.output ?? "", /Error 1055/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing capture file is not an error", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  const result = await watchLaunch(
    child.pid as number,
    path.join(os.tmpdir(), "eli-watch-does-not-exist.log"),
    fast,
    noSleep,
  );
  assert.equal(result.outcome, "exited-early");
  assert.equal(result.output, undefined);
});
