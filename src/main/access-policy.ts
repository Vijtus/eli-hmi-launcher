import type {
  LaunchAccessPolicy,
  LaunchAccessPolicyOverride,
  LaunchTarget,
  RuntimeItemState,
} from "../shared/types";

export type PolicyInstance = {
  state: "running" | "stopped" | "unknown";
  launchMode: "read" | "write" | "unknown";
};

export type LaunchPolicyDecision =
  | { allow: true; reason: string }
  | {
      allow: false;
      action: "block" | "focus" | "prompt";
      cause: "instance-limit" | "write-exclusive" | "state-unknown";
      reason: string;
    };

const BASE_POLICY: LaunchAccessPolicy = {
  writeModeExclusive: false,
  launchMode: "unknown",
  onAlreadyRunning: "block",
  onUnknownState: "block",
};

const LABVIEW_RESTRICTIVE_DEFAULT: LaunchAccessPolicyOverride = {
  maxInstances: 1,
  writeModeExclusive: true,
  launchMode: "unknown",
  onAlreadyRunning: "block",
  onUnknownState: "block",
};

function applyOverride(
  policy: LaunchAccessPolicy,
  override: LaunchAccessPolicyOverride | undefined,
): LaunchAccessPolicy {
  if (!override) {
    return policy;
  }
  const next: LaunchAccessPolicy = {
    ...policy,
    ...(override.writeModeExclusive !== undefined
      ? { writeModeExclusive: override.writeModeExclusive }
      : {}),
    ...(override.launchMode !== undefined ? { launchMode: override.launchMode } : {}),
    ...(override.onAlreadyRunning !== undefined
      ? { onAlreadyRunning: override.onAlreadyRunning }
      : {}),
    ...(override.onUnknownState !== undefined
      ? { onUnknownState: override.onUnknownState }
      : {}),
  };
  if (override.maxInstances === null) {
    delete next.maxInstances;
  } else if (override.maxInstances !== undefined) {
    next.maxInstances = override.maxInstances;
  }
  return next;
}

export function isLabviewPolicySubject(
  targetKind: LaunchTarget["kind"],
  platform: string | undefined,
): boolean {
  return (
    targetKind === "labview-dev" ||
    targetKind === "labview-epics" ||
    platform?.trim().toLowerCase() === "labview"
  );
}

export function resolveLaunchAccessPolicy(input: {
  targetKind: LaunchTarget["kind"];
  platform?: string;
  platformOverride?: LaunchAccessPolicyOverride;
  itemOverride?: LaunchAccessPolicyOverride;
}): LaunchAccessPolicy {
  let policy = { ...BASE_POLICY };
  if (isLabviewPolicySubject(input.targetKind, input.platform)) {
    policy = applyOverride(policy, LABVIEW_RESTRICTIVE_DEFAULT);
  }
  policy = applyOverride(policy, input.platformOverride);
  policy = applyOverride(policy, input.itemOverride);
  return policy;
}

export function isConstrainedLaunchPolicy(policy: LaunchAccessPolicy): boolean {
  return policy.maxInstances !== undefined || policy.writeModeExclusive;
}

function unknownDecision(
  policy: LaunchAccessPolicy,
  reason: string,
): LaunchPolicyDecision {
  if (policy.onUnknownState === "allow") {
    return { allow: true, reason: `${reason} Policy explicitly permits launch on unknown state.` };
  }
  return {
    allow: false,
    action: "block",
    cause: "state-unknown",
    reason: `${reason} Policy is fail-closed because onUnknownState is 'block'.`,
  };
}

export function evaluateLaunchAccessPolicy(input: {
  entryId: string;
  policy: LaunchAccessPolicy;
  runtime?: RuntimeItemState;
  instances: PolicyInstance[];
}): LaunchPolicyDecision {
  const { entryId, policy, runtime, instances } = input;
  if (!isConstrainedLaunchPolicy(policy)) {
    return { allow: true, reason: `Entry '${entryId}' has no instance restriction.` };
  }

  if (runtime?.stale) {
    return unknownDecision(
      policy,
      `Runtime state for entry '${entryId}' is stale.`,
    );
  }
  if (
    runtime &&
    (runtime.status === "unknown" ||
      runtime.status === "handed-off" ||
      runtime.status === "shared")
  ) {
    return unknownDecision(
      policy,
      `Runtime state for entry '${entryId}' is '${runtime.status}' under the '${runtime.model}' observation model.`,
    );
  }

  const unknownInstances = instances.filter((instance) => instance.state === "unknown");
  if (unknownInstances.length > 0) {
    return unknownDecision(
      policy,
      `${unknownInstances.length} prior instance(s) for entry '${entryId}' have unknown liveness.`,
    );
  }

  const running = instances.filter((instance) => instance.state === "running");
  if (policy.maxInstances !== undefined && running.length >= policy.maxInstances) {
    return {
      allow: false,
      action: policy.onAlreadyRunning,
      cause: "instance-limit",
      reason:
        `Entry '${entryId}' already has ${running.length} running instance(s); ` +
        `policy maxInstances is ${policy.maxInstances}.`,
    };
  }

  if (policy.writeModeExclusive && running.length > 0) {
    if (policy.launchMode === "unknown") {
      return unknownDecision(
        policy,
        `Entry '${entryId}' has running instance(s), but the requested launch mode is unknown.`,
      );
    }
    if (policy.launchMode === "write") {
      const unknownModes = running.filter((instance) => instance.launchMode === "unknown");
      if (unknownModes.length > 0) {
        return unknownDecision(
          policy,
          `Entry '${entryId}' has ${unknownModes.length} running instance(s) with unknown read/write mode.`,
        );
      }
      if (running.some((instance) => instance.launchMode === "write")) {
        return {
          allow: false,
          action: policy.onAlreadyRunning,
          cause: "write-exclusive",
          reason: `Entry '${entryId}' already has a running write-mode instance.`,
        };
      }
    }
  }

  return { allow: true, reason: `Entry '${entryId}' satisfies its configured access policy.` };
}
