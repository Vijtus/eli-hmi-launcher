import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("bundled POSIX mock launcher is executable and appends the requested label", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX mock launcher mode is not applicable on Windows");
    return;
  }

  const launcher = path.resolve("examples/launchers/mock-launch.sh");
  const metadata = await stat(launcher);
  assert.notEqual(metadata.mode & 0o111, 0, "mock-launch.sh must retain an executable mode");

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "eli-launcher-mock-test-"));
  try {
    await execFileAsync(launcher, ["Literal ; $() label"], {
      env: { ...process.env, TMPDIR: tempDir },
    });
    const log = await readFile(path.join(tempDir, "eli-hmi-launcher-mock.log"), "utf8");
    assert.match(log, /Mock launch: Literal ; \$\(\) label/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
