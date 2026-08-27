import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { decodeLabviewContractArgv } from "../scripts/labview-contract-capture.ts";
import {
  LABVIEW_DEVELOPER_FIXTURE_PATH,
  LABVIEW_EPICS_FIXTURE_PATH,
  runLabviewContractSmoke,
  type LabviewContractSmokeEvidence,
} from "../scripts/labview-contract-smoke.ts";

test("LabVIEW contract capture preserves executable and argv field boundaries", () => {
  const decoded = decodeLabviewContractArgv(
    Buffer.from("/tmp/GUI Application/Fixture.exe\0host;literal\0IOC $(literal)\0L4 ZONE\0"),
  );
  assert.equal(decoded.executable, "/tmp/GUI Application/Fixture.exe");
  assert.deepEqual(decoded.args, ["host;literal", "IOC $(literal)", "L4 ZONE"]);
  assert.throws(
    () => decodeLabviewContractArgv(Buffer.from("missing terminator")),
    /must end with a NUL byte/,
  );
});

test("the two .exe contract fixtures retain their exact POSIX executable paths", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX contract fixture mode is not applicable on Windows");
    return;
  }
  assert.match(LABVIEW_DEVELOPER_FIXTURE_PATH, /Camera IOC\/Builds\/GUI Application\/Developer Contract\.exe$/);
  assert.match(LABVIEW_EPICS_FIXTURE_PATH, /Operator Panels\/Builds\/GUI Application\/EPICS Contract\.exe$/);
  for (const fixturePath of [LABVIEW_DEVELOPER_FIXTURE_PATH, LABVIEW_EPICS_FIXTURE_PATH]) {
    const metadata = await stat(fixturePath);
    assert.notEqual(metadata.mode & 0o111, 0, `${fixturePath} must retain an executable mode`);
  }
});

test(
  "local LabVIEW contract smoke uses production launch, registry, and policy paths",
  { timeout: 20_000 },
  async (t) => {
    // The fixtures capture their own start identity from /proc/<pid>/stat, and
    // labview-contract-capture.ts requires that identity to be Linux start
    // ticks (/^\d+$/). That makes executing them Linux-only, not merely
    // non-Windows: on macOS the fixture exits 70 because there is no procfs.
    // src/main/runtime/process.ts makes the same Linux-vs-other-POSIX split.
    if (process.platform !== "linux") {
      t.skip(`Contract fixtures need /proc start ticks; not available on ${process.platform}`);
      return;
    }
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "eli-labview-evidence-test-"));
    t.after(() => rm(outputDirectory, { recursive: true, force: true }));
    const evidencePath = path.join(outputDirectory, "labview-contract-smoke.json");
    const evidence = await runLabviewContractSmoke({ evidencePath });

    assert.equal(evidence.result, "passed");
    assert.equal(evidence.classification, "local-contract-smoke");
    assert.match(evidence.runtimeClaim, /NI LabVIEW was not executed/);
    assert.equal(evidence.launches.length, 3);
    assert.deepEqual(evidence.launches[0]?.args.length, 3);
    assert.deepEqual(evidence.launches[1]?.args.length, 2);
    assert.equal(evidence.policy.singletonDenied, true);
    assert.equal(evidence.policy.writerDenied, true);
    assert.equal(evidence.policy.relaunchAfterStop, true);
    assert.deepEqual(evidence.registryTransitions.developer, [
      "running",
      "stopped",
      "running",
      "stopped",
    ]);
    assert.deepEqual(evidence.registryTransitions.epics, ["running", "stopped"]);
    assert.equal(evidence.shell.spawnShell, false);
    assert.equal(evidence.shell.markerCreated, false);
    assert.equal(evidence.cleanup.ownedProcessesStopped, true);

    const persisted = JSON.parse(
      await readFile(evidencePath, "utf8"),
    ) as LabviewContractSmokeEvidence;
    assert.deepEqual(persisted, evidence);
  },
);
