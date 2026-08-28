import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  DEFAULT_STARTUP_GRACE_MS,
  detachedSpawnOptions,
  isWindowsBatchFile,
  spawnDetached,
  windowsBatchInvocation,
} from "../src/main/launch/process.ts";

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

// Node does not spawn .bat/.cmd as ordinary executables on Windows. Batch
// targets therefore need the checked cmd.exe path constructed below rather than
// enabling shell execution for every process launch.
test("batch files are recognised regardless of case or surrounding space", () => {
  assert.equal(isWindowsBatchFile("C:\\CSS Phoebus\\product-5.0.2\\phoebus.bat"), true);
  assert.equal(isWindowsBatchFile("C:\\tools\\Run.CMD"), true);
  assert.equal(isWindowsBatchFile("  C:\\tools\\x.bat  "), true);
  assert.equal(isWindowsBatchFile("C:\\tools\\phoebus.exe"), false);
  assert.equal(isWindowsBatchFile("/usr/bin/phoebus.sh"), false);
  // A file merely mentioning .bat mid-name is not a batch file.
  assert.equal(isWindowsBatchFile("C:\\tools\\combat.exe"), false);
});

// The install path contains a space, which is what breaks naive quoting.
test("a batch invocation quotes the path and every argument for cmd", () => {
  const invocation = windowsBatchInvocation("C:\\CSS Phoebus\\product-5.0.2\\phoebus.bat", [
    "-server",
    "4918",
    "-resource",
    "file:///C:/Workspaces/css-gui/pm.bob?app=display_runtime&P=13SIM1:",
  ]);
  assert.equal(invocation.args[0], "/c");
  assert.equal(invocation.verbatim, true);
  const line = invocation.args[1] as string;
  // cmd strips the outermost pair, leaving each token individually quoted.
  assert.ok(line.startsWith('""C:\\CSS Phoebus'), line);
  assert.ok(line.endsWith('"'), line);
  assert.match(line, /"-server" "4918"/);
  // The ampersand in the macro query must stay inside quotes, or cmd splits
  // the line and the macros are lost.
  assert.match(line, /"file:\/\/\/C:\/Workspaces\/css-gui\/pm\.bob\?app=display_runtime&P=13SIM1:"/);
});

test("embedded quotes are doubled rather than left to terminate the string", () => {
  const invocation = windowsBatchInvocation("C:\\t\\x.bat", ['say "hi"']);
  assert.match(invocation.args[1] as string, /"say ""hi"""/);
});

// A path ending in a backslash — a directory, or anything from a config field
// written with a trailing separator — closes as `"C:\CSS GUIs\"`. The CRT argv
// parser in the launched program reads that `\"` as an escaped quote and merges
// the next argument into it.
test("a trailing backslash cannot escape the closing quote", () => {
  const line = windowsBatchInvocation("C:\\t\\x.bat", ["C:\\CSS GUIs\\", "-flag"]).args[1] as string;
  // Written as plain strings: regex escaping of backslashes obscures the point.
  assert.ok(line.includes('"C:\\CSS GUIs\\\\"'), line);
  // The following argument must still be its own token.
  assert.ok(line.includes('"-flag"'), line);
});

test("interior backslashes are left alone", () => {
  const line = windowsBatchInvocation("C:\\t\\x.bat", ["C:\\a\\b\\c.txt"]).args[1] as string;
  assert.ok(line.includes('"C:\\a\\b\\c.txt"'), line);
});
