import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnDetached } from "../src/main/process-launcher.ts";

test("detached launch accepts a process that survives the startup window", async () => {
  await assert.doesNotReject(
    spawnDetached(process.execPath, ["-e", "setTimeout(() => process.exit(0), 150)"], undefined, undefined, 25),
  );
});

test("detached launch accepts a wrapper that exits zero immediately", async () => {
  await assert.doesNotReject(
    spawnDetached(process.execPath, ["-e", "process.exit(0)"], undefined, undefined, 100),
  );
});

test("detached launch reports an immediate non-zero exit", async () => {
  await assert.rejects(
    spawnDetached(process.execPath, ["-e", "process.exit(7)"], undefined, undefined, 500),
    /Process exited during startup with exit code 7/,
  );
});

test("detached launch preserves ENOENT when process spawning fails", async () => {
  const missingCommand = path.join(
    os.tmpdir(),
    `eli-launcher-missing-command-${process.pid}-${Date.now()}`,
  );

  await assert.rejects(
    spawnDetached(missingCommand, [], undefined, undefined, 25),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      return true;
    },
  );
});
