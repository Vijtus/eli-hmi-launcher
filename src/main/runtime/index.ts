import type { ParsedConfig } from "../config/load";
import { logEvent } from "../diagnostics/log";
import type { RuntimeSnapshot } from "../../shared/types";
import { RuntimeRegistry } from "./registry";

export type ApplicationRuntime = {
  registry: RuntimeRegistry;
  snapshot(): RuntimeSnapshot;
  start(): void;
  stop(): void;
};

export function createRuntime(
  config: ParsedConfig,
  onSnapshot: (snapshot: RuntimeSnapshot) => void,
): ApplicationRuntime {
  const registry = new RuntimeRegistry({
    reconcileIntervalMs: config.context.local.monitoring.reconcileIntervalMs,
    onChange: onSnapshot,
    onError: (error) => {
      logEvent("error", "Runtime reconciliation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  return {
    registry,
    snapshot: () => registry.snapshot(),
    start: () => registry.start(),
    stop: () => registry.stop(),
  };
}
