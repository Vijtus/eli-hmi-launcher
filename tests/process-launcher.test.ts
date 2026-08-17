import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  DEFAULT_STARTUP_GRACE_MS,
  detachedSpawnOptions,
  spawnDetached,
} from "../src/main/process-launcher.ts";

test("default startup grace remains 500 ms and is not a liveness assertion", () => {
  assert.equal(DEFAULT_STARTUP_GRACE_MS, 500);
});

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

test("detached launch passes shell metacharacters as literal argv", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eli-launcher-no-shell-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "argv.txt");
  const marker = path.join(root, "shell-ran.txt");
  const literal = `; touch ${marker} & $(touch ${marker})`;

  await spawnDetached(
    process.execPath,
    [
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], process.argv[2], 'utf8')",
      output,
      literal,
    ],
    undefined,
    undefined,
    500,
  );

  assert.equal(await readFile(output, "utf8"), literal);
  await assert.rejects(readFile(marker, "utf8"), /ENOENT/);
  assert.equal(detachedSpawnOptions(undefined, undefined).shell, false);
});
