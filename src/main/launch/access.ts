import type { LaunchAccessPolicy, RuntimeItemState } from "../../shared/types";
import {
  evaluateLaunchAccessPolicy,
  type PolicyInstance,
} from "./policy";

export class LaunchPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchPolicyError";
  }
}

export type LaunchPolicyEnforcementDependencies = {
  confirmOverride?: (reason: string) => Promise<boolean>;
  focusExisting?: (reason: string) => Promise<boolean>;
};

export type LaunchPolicyRequest = {
  entryId: string;
  policy: LaunchAccessPolicy;
  runtime?: RuntimeItemState;
  instances: PolicyInstance[];
};

export async function runWithLaunchPolicy<T>(
  request: LaunchPolicyRequest,
  launch: () => Promise<T>,
  dependencies: LaunchPolicyEnforcementDependencies = {},
): Promise<{ launched: boolean; focused: boolean; value?: T }> {
  const decision = evaluateLaunchAccessPolicy(request);
  if (decision.allow) {
    return { launched: true, focused: false, value: await launch() };
  }

  if (decision.action === "prompt") {
    if (!dependencies.confirmOverride || !(await dependencies.confirmOverride(decision.reason))) {
      throw new LaunchPolicyError(`${decision.reason} Operator override was not granted.`);
    }
    return { launched: true, focused: false, value: await launch() };
  }

  if (decision.action === "focus") {
    if (dependencies.focusExisting && (await dependencies.focusExisting(decision.reason))) {
      return { launched: false, focused: true };
    }
    throw new LaunchPolicyError(
      `${decision.reason} The configured action is 'focus', but no focusable native window identity is available.`,
    );
  }

  throw new LaunchPolicyError(decision.reason);
}

// A policy decision can resolve without spawning anything (for example an
// `onAlreadyRunning: focus` outcome). Callers must not report or log a launch
// in that case: doing so would claim a launch that never happened and would
// write a launch record for a process that was never spawned.
// Returns undefined when a launch did occur.
export function describeUnperformedLaunch(
  entryId: string,
  outcome: { launched: boolean; focused: boolean },
): string | undefined {
  if (outcome.launched) {
    return undefined;
  }
  if (outcome.focused) {
    return (
      `No process was launched for '${entryId}': the access policy focused an ` +
      "existing instance instead. Focus is not a verified capability here; no " +
      "native window identity mechanism has been supplied."
    );
  }
  return `No process was launched for '${entryId}': the access policy did not perform a launch.`;
}

export class EntryLaunchGate {
  private readonly pending = new Map<string, Promise<unknown>>();

  async run<T>(entryId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(entryId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.pending.set(entryId, current);
    try {
      return await current;
    } finally {
      if (this.pending.get(entryId) === current) {
        this.pending.delete(entryId);
      }
    }
  }
}
