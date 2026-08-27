import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCommandPathUsable,
  assertFolderPathUsable,
  assertResolvedValueNotEmpty,
  assertWorkingDirectoryUsable,
} from "../src/main/launch/validation.ts";

const skipPosixPermissionTests =
  process.platform === "win32" ||
  (typeof process.getuid === "function" && process.getuid() === 0);

test("empty resolved launcher values are rejected with configuration context", () => {
  for (const description of ["process command", "working directory", "folder target"]) {
    assert.throws(
      () => assertResolvedValueNotEmpty(" \t ", description),
      new RegExp(
        `Configured ${description} resolves to an empty value\\. Check its environment-variable substitutions\\.`,
      ),
    );
  }

  assert.doesNotThrow(() => assertResolvedValueNotEmpty("/opt/eli/launcher", "process command"));
});

test("launch path validation distinguishes files and directories", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eli-launch-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const command = path.join(root, "launcher.sh");
  const ordinaryFile = path.join(root, "not-a-folder.txt");
  await writeFile(command, "#!/bin/sh\nexit 0\n", "utf8");
  await writeFile(ordinaryFile, "x", "utf8");
  if (process.platform !== "win32") {
    await chmod(command, 0o755);
  }

  await assert.doesNotReject(assertCommandPathUsable(command));
  await assert.doesNotReject(assertWorkingDirectoryUsable(root));
  await assert.doesNotReject(assertFolderPathUsable(root));

  await assert.rejects(
    assertCommandPathUsable(root),
    new RegExp(`Configured command is not a file: ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  await assert.rejects(
    assertWorkingDirectoryUsable(ordinaryFile),
    /Configured working directory is not a directory:/,
  );
  await assert.rejects(
    assertFolderPathUsable(ordinaryFile),
    /Configured folder target is not a directory:/,
  );
});

test("missing paths produce user-readable errors", async () => {
  const missing = path.join(os.tmpdir(), `eli-launcher-missing-${process.pid}-${Date.now()}`);
  await assert.rejects(assertCommandPathUsable(missing), /Configured command does not exist:/);
  await assert.rejects(assertWorkingDirectoryUsable(missing), /Configured working directory does not exist:/);
  await assert.rejects(assertFolderPathUsable(missing), /Configured folder target does not exist:/);
});

test("non-executable POSIX command is rejected", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eli-launch-validation-mode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = path.join(root, "launcher.sh");
  await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  await assert.rejects(assertCommandPathUsable(command), /Configured command is not executable:/);
});

test(
  "command paths below an inaccessible directory are rejected",
  { skip: skipPosixPermissionTests },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eli-launch-validation-command-access-"));
    const restricted = path.join(root, "restricted");
    const command = path.join(restricted, "launcher.sh");
    await mkdir(restricted);
    await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    t.after(async () => {
      await chmod(restricted, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });

    await chmod(restricted, 0o000);
    await assert.rejects(
      assertCommandPathUsable(command),
      /Configured command is not accessible:/,
    );
  },
);

test(
  "working directories must be traversable",
  { skip: skipPosixPermissionTests },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eli-launch-validation-cwd-access-"));
    const cwd = path.join(root, "cwd");
    await mkdir(cwd);
    t.after(async () => {
      await chmod(cwd, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });

    await chmod(cwd, 0o600);
    await assert.rejects(
      assertWorkingDirectoryUsable(cwd),
      /Configured working directory is not accessible:/,
    );
  },
);

test(
  "folder targets must be readable and traversable",
  { skip: skipPosixPermissionTests },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eli-launch-validation-folder-access-"));
    const folder = path.join(root, "folder");
    await mkdir(folder);
    t.after(async () => {
      await chmod(folder, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });

    await chmod(folder, 0o100);
    await assert.rejects(
      assertFolderPathUsable(folder),
      /Configured folder target is not readable:/,
    );

    await chmod(folder, 0o400);
    await assert.rejects(
      assertFolderPathUsable(folder),
      /Configured folder target is not accessible:/,
    );
  },
);
