import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SURVEY_LIMITS, surveyRoot } from "../src/main/workspace-survey.ts";

// Shaped like the real TESTZ workspace: hosts under Deployment/Resource/Host,
// one Windows build, and real-time targets that are not Windows executables.
function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "eli-survey-"));
  const host = path.join(root, "TESTZone", "Deployment", "Resource", "Host");
  mkdirSync(path.join(host, "TESTZ-Deploy-CM", "Builds"), { recursive: true });
  writeFileSync(path.join(host, "TESTZ-Deploy-CM", "Builds", "TESTZ-Deploy-CM.exe"), "x");
  mkdirSync(path.join(host, "RMC00-001", "Builds", "c", "ni-rt", "startup"), { recursive: true });
  writeFileSync(path.join(host, "RMC00-001", "Builds", "c", "ni-rt", "startup", "RMC00-001.rtexe"), "x");
  mkdirSync(path.join(root, "TESTZone", "Launcher", "Builds", "GUI Application"), { recursive: true });
  writeFileSync(path.join(root, "TESTZone", "Launcher", "Builds", "GUI Application", "TESTZ Launcher.exe"), "x");
  return root;
}

test("the survey finds the executables that actually exist", async () => {
  const root = workspace();
  try {
    const result = await surveyRoot(root);
    assert.equal(result.exists, true);
    assert.deepEqual(result.topLevel, ["TESTZone"]);
    const found = result.executables.map((p) => p.split(path.sep).join("/"));
    assert.ok(
      found.includes("TESTZone/Deployment/Resource/Host/TESTZ-Deploy-CM/Builds/TESTZ-Deploy-CM.exe"),
      `expected the Windows build, got ${JSON.stringify(found)}`,
    );
    assert.ok(
      found.includes("TESTZone/Launcher/Builds/GUI Application/TESTZ Launcher.exe"),
      "expected the LabVIEW launcher itself",
    );
    // .rtexe runs on the cRIO, not on Windows, but seeing it is what tells a
    // reader why there is no Windows build for that host.
    assert.ok(
      found.some((p) => p.endsWith("RMC00-001.rtexe")),
      "expected real-time targets to be listed too",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the scan count is recorded so truncation can be judged", async () => {
  const root = workspace();
  try {
    const result = await surveyRoot(root);
    assert.ok(result.scanned > 0, "expected a non-zero scan count");
    assert.equal(result.truncated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing root is reported, not thrown", async () => {
  const result = await surveyRoot(path.join(os.tmpdir(), "eli-survey-does-not-exist"));
  assert.equal(result.exists, false);
  assert.match(result.reason ?? "", /does not exist/);
  assert.deepEqual(result.executables, []);
});

// A diagnostic must never be the reason the launcher feels broken.
test("the walk stops at its entry limit and says so", async () => {
  const root = workspace();
  try {
    const result = await surveyRoot(root, { ...DEFAULT_SURVEY_LIMITS, maxEntries: 1 });
    assert.equal(result.truncated, true);
    assert.match(result.reason ?? "", /stopped after 1 entries/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("depth is bounded so a deep tree cannot run away", async () => {
  const root = workspace();
  try {
    const shallow = await surveyRoot(root, { ...DEFAULT_SURVEY_LIMITS, maxDepth: 1 });
    assert.deepEqual(shallow.topLevel, ["TESTZone"]);
    assert.equal(shallow.executables.length, 0, "nothing is that shallow in this fixture");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
