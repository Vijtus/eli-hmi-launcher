import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateLaunchAccessPolicy,
  resolveLaunchAccessPolicy,
  type PolicyInstance,
} from "../src/main/access-policy.ts";
import type { LaunchAccessPolicy, RuntimeItemState } from "../src/shared/types.ts";

function running(launchMode: PolicyInstance["launchMode"]): PolicyInstance {
  return { state: "running", launchMode };
}

function runtime(overrides: Partial<RuntimeItemState> = {}): RuntimeItemState {
  return {
    id: "gui",
    kind: "labview-dev",
    model: "pid",
    status: "running",
    runningInstances: 1,
    totalInstances: 1,
    launchedAt: "2026-07-28T00:00:00.000Z",
    lastSeenAt: "2026-07-28T00:00:01.000Z",
    stale: false,
    detail: "fixture",
    ...overrides,
  };
}

function decision(policy: LaunchAccessPolicy, instances: PolicyInstance[], state?: RuntimeItemState) {
  return evaluateLaunchAccessPolicy({ entryId: "gui", policy, instances, runtime: state });
}

test("LabVIEW targets default to the more restrictive singleton and write-exclusive policy", () => {
  const policy = resolveLaunchAccessPolicy({ targetKind: "labview-dev" });
  assert.deepEqual(policy, {
    maxInstances: 1,
    writeModeExclusive: true,
    launchMode: "unknown",
    onAlreadyRunning: "block",
    onUnknownState: "block",
  });

  const legacyWrapperPolicy = resolveLaunchAccessPolicy({
    targetKind: "process",
    platform: "LabVIEW",
  });
  assert.deepEqual(legacyWrapperPolicy, policy);
});

test("both readings of the ambiguous LabVIEW rule are expressible", () => {
  const onlyOnce = resolveLaunchAccessPolicy({
    targetKind: "labview-dev",
    itemOverride: {
      maxInstances: 1,
      writeModeExclusive: false,
      launchMode: "unknown",
    },
  });
  assert.equal(onlyOnce.maxInstances, 1);
  assert.equal(onlyOnce.writeModeExclusive, false);

  const writeModeOnly = resolveLaunchAccessPolicy({
    targetKind: "labview-dev",
    itemOverride: {
      maxInstances: null,
      writeModeExclusive: true,
      launchMode: "write",
    },
  });
  assert.equal(writeModeOnly.maxInstances, undefined);
  assert.equal(writeModeOnly.writeModeExclusive, true);
  assert.equal(writeModeOnly.launchMode, "write");

  const both = resolveLaunchAccessPolicy({
    targetKind: "labview-dev",
    itemOverride: {
      maxInstances: 1,
      writeModeExclusive: true,
      launchMode: "write",
    },
  });
  assert.equal(both.maxInstances, 1);
  assert.equal(both.writeModeExclusive, true);
});

test("a singleton policy allows the first launch and blocks the next running instance", () => {
  const policy = resolveLaunchAccessPolicy({
    targetKind: "process",
    itemOverride: { maxInstances: 1, onAlreadyRunning: "block" },
  });
  assert.equal(decision(policy, []).allow, true);

  const blocked = decision(policy, [running("read")], runtime());
  assert.deepEqual(blocked, {
    allow: false,
    action: "block",
    cause: "instance-limit",
    reason: "Entry 'gui' already has 1 running instance(s); policy maxInstances is 1.",
  });
});

test("write-mode exclusivity blocks a second writer while allowing read-mode launches", () => {
  const writePolicy = resolveLaunchAccessPolicy({
    targetKind: "labview-dev",
    itemOverride: {
      maxInstances: null,
      writeModeExclusive: true,
      launchMode: "write",
    },
  });
  const blocked = decision(writePolicy, [running("write")], runtime());
  assert.equal(blocked.allow, false);
  if (!blocked.allow) {
    assert.equal(blocked.cause, "write-exclusive");
    assert.match(blocked.reason, /running write-mode instance/);
  }

  const allowedAfterReader = decision(writePolicy, [running("read")], runtime());
  assert.equal(allowedAfterReader.allow, true);

  const readPolicy = { ...writePolicy, launchMode: "read" as const };
  const allowedReader = decision(readPolicy, [running("write")], runtime());
  assert.equal(allowedReader.allow, true);
});

test("unknown or stale state fails closed unless trusted config explicitly allows it", () => {
  const blockedPolicy = resolveLaunchAccessPolicy({
    targetKind: "process",
    itemOverride: { maxInstances: 1 },
  });

  const stale = decision(blockedPolicy, [], runtime({ stale: true }));
  assert.equal(stale.allow, false);
  if (!stale.allow) {
    assert.equal(stale.cause, "state-unknown");
    assert.match(stale.reason, /stale/);
  }

  const unknownPid = decision(blockedPolicy, [{ state: "unknown", launchMode: "unknown" }]);
  assert.equal(unknownPid.allow, false);
  if (!unknownPid.allow) {
    assert.match(unknownPid.reason, /unknown liveness/);
  }

  const allowUnknown = { ...blockedPolicy, onUnknownState: "allow" as const };
  assert.equal(decision(allowUnknown, [], runtime({ stale: true })).allow, true);
});

test("unknown write-mode identity fails closed when an instance is already running", () => {
  const policy = resolveLaunchAccessPolicy({
    targetKind: "labview-dev",
    itemOverride: {
      maxInstances: null,
      writeModeExclusive: true,
      launchMode: "write",
    },
  });
  const result = decision(policy, [running("unknown")], runtime());
  assert.equal(result.allow, false);
  if (!result.allow) {
    assert.equal(result.cause, "state-unknown");
    assert.match(result.reason, /unknown read\/write mode/);
  }
});

test("configured prompt and focus actions are preserved in block decisions", () => {
  for (const action of ["prompt", "focus"] as const) {
    const policy = resolveLaunchAccessPolicy({
      targetKind: "process",
      itemOverride: { maxInstances: 1, onAlreadyRunning: action },
    });
    const result = decision(policy, [running("read")], runtime());
    assert.equal(result.allow, false);
    if (!result.allow) {
      assert.equal(result.action, action);
    }
  }
});
