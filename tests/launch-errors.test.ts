import assert from "node:assert/strict";
import test from "node:test";
import {
  folderLaunchError,
  processLaunchError,
  webLaunchError,
} from "../src/main/launch/errors.ts";

function errno(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

test("ENOENT process errors identify the command and likely missing dependency", () => {
  const error = processLaunchError("/opt/eli/start.sh", errno("ENOENT", "spawn ENOENT"));
  assert.match(error.message, /\/opt\/eli\/start\.sh/);
  assert.match(error.message, /required interpreter was not found/);
  assert.match(error.message, /system PATH/);
});

test("permission-related process errors are actionable and retain the command", () => {
  for (const code of ["EACCES", "EPERM"]) {
    const error = processLaunchError("/opt/eli/start.sh", errno(code, `spawn ${code}`));
    assert.match(error.message, /\/opt\/eli\/start\.sh/);
    assert.match(error.message, /inaccessible or not executable/);
    assert.match(error.message, /permissions/);
  }
});

test("other process failures retain both command and actual cause", () => {
  const error = processLaunchError("/opt/eli/start.sh", new Error("Process exited during startup with exit code 7."));
  assert.match(error.message, /\/opt\/eli\/start\.sh/);
  assert.match(error.message, /exit code 7/);
});

test("web and folder errors retain their target and cause", () => {
  const webError = webLaunchError("https://controls.example/gui", new Error("No browser is registered"));
  assert.match(webError.message, /https:\/\/controls\.example\/gui/);
  assert.match(webError.message, /No browser is registered/);

  const folderError = folderLaunchError("/opt/eli/data", "No application can open this path");
  assert.match(folderError.message, /\/opt\/eli\/data/);
  assert.match(folderError.message, /No application can open this path/);
});
