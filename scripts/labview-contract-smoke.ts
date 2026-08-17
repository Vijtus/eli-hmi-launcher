import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { parseConfig, type MaterializedProcess } from "../src/main/config";
import {
  materializeLabviewDeveloperTarget,
  materializeLabviewEpicsTarget,
} from "../src/main/labview-targets";
import { launchMaterializedProcess, type NativeLaunchResult } from "../src/main/native-launcher";
import { detachedSpawnOptions } from "../src/main/process-launcher";
import { RuntimeRegistry } from "../src/main/runtime-registry";
import {
  EntryLaunchGate,
  LaunchPolicyError,
  runWithLaunchPolicy,
} from "../src/main/launch-policy-enforcement";
import type {
  LabviewDeveloperLaunchTarget,
  LabviewEpicsLaunchTarget,
  LaunchAccessMode,
  LaunchAccessPolicy,
} from "../src/shared/types";
import {
  waitForLabviewContractCapture,
  type LabviewContractCapture,
} from "./labview-contract-capture";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const LABVIEW_CONTRACT_REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
export const LABVIEW_CONTRACT_CONFIG_PATH = path.join(
  LABVIEW_CONTRACT_REPOSITORY_ROOT,
  "examples",
  "labview-contract.yaml",
);
export const LABVIEW_CONTRACT_WORKSPACE_ROOT = path.join(
  LABVIEW_CONTRACT_REPOSITORY_ROOT,
  "examples",
  "labview-contract-workspace",
);
export const LABVIEW_DEVELOPER_FIXTURE_PATH = path.join(
  LABVIEW_CONTRACT_WORKSPACE_ROOT,
  "Common",
  "ELI",
  "IOCs",
  "Camera IOC",
  "Builds",
  "GUI Application",
  "Developer Contract.exe",
);
export const LABVIEW_EPICS_FIXTURE_PATH = path.join(
  LABVIEW_CONTRACT_WORKSPACE_ROOT,
  "Common",
  "ELI",
  "EPICS_GUIs",
  "Operator Panels",
  "Builds",
  "GUI Application",
  "EPICS Contract.exe",
);

const DEVELOPER_ENTRY_ID = "labview-contract-developer";
const EPICS_ENTRY_ID = "labview-contract-epics";

type EvidenceLaunch = {
  phase: "initial" | "relaunch";
  entryId: string;
  kind: "labview-dev" | "labview-epics";
  executable: string;
  args: string[];
  pid: number;
};

export type LabviewContractSmokeEvidence = {
  result: "passed";
  classification: "local-contract-smoke";
  runtimeClaim: "Executable POSIX fixtures ran; NI LabVIEW was not executed.";
  observedAt: string;
  durationMs: number;
  platform: NodeJS.Platform;
  workspaceRoot: string;
  captureFormat: string;
  launches: EvidenceLaunch[];
  policy: {
    singletonDenied: true;
    singletonReason: string;
    writerDenied: true;
    writerReason: string;
    relaunchAfterStop: true;
  };
  registryTransitions: {
    developer: ["running", "stopped", "running", "stopped"];
    epics: ["running", "stopped"];
  };
  shell: {
    spawnShell: false;
    markerPath: string;
    markerCreated: false;
  };
  cleanup: {
    ownedProcessesStopped: true;
  };
};

export type LabviewContractSmokeOptions = {
  evidencePath?: string;
};

function policyRequest(registry: RuntimeRegistry, entryId: string, policy: LaunchAccessPolicy) {
  return {
    entryId,
    policy,
    runtime: registry.getState(entryId),
    instances: registry.getProcessRecords(entryId).map((record) => ({
      state: record.state,
      launchMode: record.launchMode,
    })),
  };
}

async function markerExists(markerPath: string): Promise<boolean> {
  try {
    await access(markerPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function signalOwnedProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    // spawnDetached creates a new process group, so this also handles a fixture
    // that replaces itself with another executable.
    process.kill(-pid, signal);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return;
    }
  }
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

async function stopAndObserve(
  registry: RuntimeRegistry,
  pids: number[],
  entryIds: string[],
): Promise<void> {
  for (const pid of pids) {
    signalOwnedProcess(pid, "SIGTERM");
  }

  let deadline = Date.now() + 4_000;
  let usedSigkill = false;
  while (true) {
    await registry.reconcile();
    if (entryIds.every((entryId) => registry.getState(entryId)?.status === "stopped")) {
      return;
    }
    if (Date.now() >= deadline) {
      if (usedSigkill) {
        throw new Error(
          `Timed out waiting for fixture registry state to stop: ${entryIds.join(", ")}`,
        );
      }
      for (const pid of pids) {
        signalOwnedProcess(pid, "SIGKILL");
      }
      usedSigkill = true;
      deadline = Date.now() + 2_000;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function writeEvidence(
  evidencePath: string,
  evidence: LabviewContractSmokeEvidence,
): Promise<void> {
  const absolutePath = path.resolve(evidencePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, absolutePath);
}

function assertCapture(
  capture: LabviewContractCapture,
  result: NativeLaunchResult,
  expectedArgs: string[],
): void {
  assert.equal(capture.pid, result.receipt.pid);
  assert.equal(capture.executable, result.command);
  assert.deepEqual(capture.args, expectedArgs);
  assert.deepEqual(result.args, expectedArgs);
}

export async function runLabviewContractSmoke(
  options: LabviewContractSmokeOptions = {},
): Promise<LabviewContractSmokeEvidence> {
  if (process.platform === "win32") {
    throw new Error("The local LabVIEW contract fixtures are POSIX executables, not Windows binaries.");
  }

  const startedAt = Date.now();
  const captureDirectory = await mkdtemp(path.join(os.tmpdir(), "eli-labview-contract-"));
  const markerPath = path.join(captureDirectory, "shell-interpretation-marker");
  const contractValues = {
    ELI_LABVIEW_FIXTURE_CAPTURE_DIR: captureDirectory,
    ELI_LABVIEW_FIXTURE_LIFETIME_SECONDS: "30",
    ELI_LABVIEW_CONTRACT_HOST: `controls-host; touch ${markerPath}`,
    ELI_LABVIEW_CONTRACT_IOC: `IOC-CAMERA-01 & $(touch ${markerPath})`,
    ELI_LABVIEW_CONTRACT_ZONE: `L4 ZONE; touch ${markerPath}`,
    ELI_LABVIEW_CONTRACT_GUI: `Main Overview | $(touch ${markerPath})`,
  } as const;
  const priorEnvironment = new Map<string, string | undefined>();
  const ownedPids = new Set<number>();
  const registry = new RuntimeRegistry({ reconcileIntervalMs: 100 });

  try {
    for (const [name, value] of Object.entries(contractValues)) {
      priorEnvironment.set(name, process.env[name]);
      process.env[name] = value;
    }

    const rawConfig = await readFile(LABVIEW_CONTRACT_CONFIG_PATH, "utf8");
    const parsed = parseConfig(rawConfig, {
      appRoot: LABVIEW_CONTRACT_REPOSITORY_ROOT,
      configDir: path.dirname(LABVIEW_CONTRACT_CONFIG_PATH),
    });
    const developerTarget = parsed.targetsById.get(DEVELOPER_ENTRY_ID);
    const epicsTarget = parsed.targetsById.get(EPICS_ENTRY_ID);
    if (!developerTarget || developerTarget.kind !== "labview-dev") {
      throw new Error(`Missing ${DEVELOPER_ENTRY_ID} labview-dev fixture target.`);
    }
    if (!epicsTarget || epicsTarget.kind !== "labview-epics") {
      throw new Error(`Missing ${EPICS_ENTRY_ID} labview-epics fixture target.`);
    }
    const developerPolicy = parsed.accessPoliciesById.get(DEVELOPER_ENTRY_ID);
    const epicsPolicy = parsed.accessPoliciesById.get(EPICS_ENTRY_ID);
    if (!developerPolicy || !epicsPolicy) {
      throw new Error("LabVIEW contract fixture access policies are missing.");
    }

    const developerMaterialized = materializeLabviewDeveloperTarget(
      developerTarget as LabviewDeveloperLaunchTarget,
      parsed.context,
      { id: DEVELOPER_ENTRY_ID, kind: "labview-dev", group: "entry" },
    );
    const epicsMaterialized = materializeLabviewEpicsTarget(
      epicsTarget as LabviewEpicsLaunchTarget,
      parsed.context,
      { id: EPICS_ENTRY_ID, kind: "labview-epics", group: "entry" },
    );
    assert.equal(developerMaterialized.command, LABVIEW_DEVELOPER_FIXTURE_PATH);
    assert.equal(epicsMaterialized.command, LABVIEW_EPICS_FIXTURE_PATH);

    const expectedDeveloperArgs = [
      contractValues.ELI_LABVIEW_CONTRACT_HOST,
      contractValues.ELI_LABVIEW_CONTRACT_IOC,
      contractValues.ELI_LABVIEW_CONTRACT_ZONE,
    ];
    const expectedEpicsArgs = [
      contractValues.ELI_LABVIEW_CONTRACT_ZONE,
      contractValues.ELI_LABVIEW_CONTRACT_GUI,
    ];
    const gate = new EntryLaunchGate();

    const launchAndRegister = async (
      entryId: string,
      kind: "labview-dev" | "labview-epics",
      materialized: MaterializedProcess,
      launchMode: LaunchAccessMode,
    ): Promise<NativeLaunchResult> => {
      const result = await launchMaterializedProcess(materialized, parsed.context);
      ownedPids.add(result.receipt.pid);
      await registry.registerProcess({
        entryId,
        kind,
        command: result.command,
        args: result.args,
        receipt: result.receipt,
        launchMode,
      });
      return result;
    };

    const policyLaunch = async (
      entryId: string,
      kind: "labview-dev" | "labview-epics",
      materialized: MaterializedProcess,
      policy: LaunchAccessPolicy,
    ): Promise<NativeLaunchResult> =>
      await gate.run(entryId, async () => {
        const outcome = await runWithLaunchPolicy(
          policyRequest(registry, entryId, policy),
          async () => await launchAndRegister(entryId, kind, materialized, policy.launchMode),
        );
        if (!outcome.launched || !outcome.value) {
          throw new Error(`Access policy did not launch fixture entry '${entryId}'.`);
        }
        return outcome.value;
      });

    const developerInitial = await policyLaunch(
      DEVELOPER_ENTRY_ID,
      "labview-dev",
      developerMaterialized,
      developerPolicy,
    );
    const developerInitialCapture = await waitForLabviewContractCapture(
      captureDirectory,
      developerInitial.receipt.pid,
    );
    assertCapture(developerInitialCapture, developerInitial, expectedDeveloperArgs);
    assert.equal(registry.getState(DEVELOPER_ENTRY_ID)?.status, "running");

    let singletonLaunchCallbackInvoked = false;
    let singletonReason = "";
    try {
      await gate.run(DEVELOPER_ENTRY_ID, async () =>
        await runWithLaunchPolicy(
          policyRequest(registry, DEVELOPER_ENTRY_ID, developerPolicy),
          async () => {
            singletonLaunchCallbackInvoked = true;
          },
        ),
      );
      throw new Error("Singleton policy accepted a second running Developer fixture.");
    } catch (error) {
      if (!(error instanceof LaunchPolicyError)) {
        throw error;
      }
      singletonReason = error.message;
    }
    assert.equal(singletonLaunchCallbackInvoked, false);
    assert.match(singletonReason, /maxInstances is 1/);

    const epicsInitial = await policyLaunch(
      EPICS_ENTRY_ID,
      "labview-epics",
      epicsMaterialized,
      epicsPolicy,
    );
    const epicsInitialCapture = await waitForLabviewContractCapture(
      captureDirectory,
      epicsInitial.receipt.pid,
    );
    assertCapture(epicsInitialCapture, epicsInitial, expectedEpicsArgs);
    assert.equal(registry.getState(EPICS_ENTRY_ID)?.status, "running");

    const writerOnlyPolicy: LaunchAccessPolicy = { ...epicsPolicy };
    delete writerOnlyPolicy.maxInstances;
    writerOnlyPolicy.writeModeExclusive = true;
    writerOnlyPolicy.launchMode = "write";
    let writerLaunchCallbackInvoked = false;
    let writerReason = "";
    try {
      await gate.run(EPICS_ENTRY_ID, async () =>
        await runWithLaunchPolicy(
          policyRequest(registry, EPICS_ENTRY_ID, writerOnlyPolicy),
          async () => {
            writerLaunchCallbackInvoked = true;
          },
        ),
      );
      throw new Error("Write-exclusive policy accepted a second write-mode EPICS fixture.");
    } catch (error) {
      if (!(error instanceof LaunchPolicyError)) {
        throw error;
      }
      writerReason = error.message;
    }
    assert.equal(writerLaunchCallbackInvoked, false);
    assert.match(writerReason, /running write-mode instance/);

    assert.equal(detachedSpawnOptions(undefined, undefined).shell, false);
    assert.equal(await markerExists(markerPath), false);

    await stopAndObserve(
      registry,
      [developerInitial.receipt.pid, epicsInitial.receipt.pid],
      [DEVELOPER_ENTRY_ID, EPICS_ENTRY_ID],
    );
    assert.equal(registry.getState(DEVELOPER_ENTRY_ID)?.status, "stopped");
    assert.equal(registry.getState(EPICS_ENTRY_ID)?.status, "stopped");

    const developerRelaunch = await policyLaunch(
      DEVELOPER_ENTRY_ID,
      "labview-dev",
      developerMaterialized,
      developerPolicy,
    );
    const developerRelaunchCapture = await waitForLabviewContractCapture(
      captureDirectory,
      developerRelaunch.receipt.pid,
    );
    assertCapture(developerRelaunchCapture, developerRelaunch, expectedDeveloperArgs);
    assert.equal(registry.getState(DEVELOPER_ENTRY_ID)?.status, "running");
    assert.equal(await markerExists(markerPath), false);

    await stopAndObserve(
      registry,
      [developerRelaunch.receipt.pid],
      [DEVELOPER_ENTRY_ID],
    );
    assert.equal(registry.getState(DEVELOPER_ENTRY_ID)?.status, "stopped");

    const launches: EvidenceLaunch[] = [
      {
        phase: "initial",
        entryId: DEVELOPER_ENTRY_ID,
        kind: "labview-dev",
        executable: developerInitialCapture.executable,
        args: developerInitialCapture.args,
        pid: developerInitialCapture.pid,
      },
      {
        phase: "initial",
        entryId: EPICS_ENTRY_ID,
        kind: "labview-epics",
        executable: epicsInitialCapture.executable,
        args: epicsInitialCapture.args,
        pid: epicsInitialCapture.pid,
      },
      {
        phase: "relaunch",
        entryId: DEVELOPER_ENTRY_ID,
        kind: "labview-dev",
        executable: developerRelaunchCapture.executable,
        args: developerRelaunchCapture.args,
        pid: developerRelaunchCapture.pid,
      },
    ];
    const evidence: LabviewContractSmokeEvidence = {
      result: "passed",
      classification: "local-contract-smoke",
      runtimeClaim: "Executable POSIX fixtures ran; NI LabVIEW was not executed.",
      observedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      platform: process.platform,
      workspaceRoot: LABVIEW_CONTRACT_WORKSPACE_ROOT,
      captureFormat: "launch-<pid>.argv.nul (executable then argv, NUL-delimited) + launch-<pid>.pid",
      launches,
      policy: {
        singletonDenied: true,
        singletonReason,
        writerDenied: true,
        writerReason,
        relaunchAfterStop: true,
      },
      registryTransitions: {
        developer: ["running", "stopped", "running", "stopped"],
        epics: ["running", "stopped"],
      },
      shell: {
        spawnShell: false,
        markerPath,
        markerCreated: false,
      },
      cleanup: {
        ownedProcessesStopped: true,
      },
    };
    if (options.evidencePath) {
      await writeEvidence(options.evidencePath, evidence);
    }
    return evidence;
  } finally {
    for (const pid of ownedPids) {
      signalOwnedProcess(pid, "SIGTERM");
    }
    for (const [name, value] of priorEnvironment) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(captureDirectory, { recursive: true, force: true });
  }
}
