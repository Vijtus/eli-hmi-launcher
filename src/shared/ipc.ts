import type {
  ConfigLocation,
  FieldReportInfo,
  LauncherConfig,
  LaunchResult,
  RuntimeSnapshot,
} from "./types";

export const IPC = {
  getConfig: "launcher:get-config",
  getRuntimeStates: "launcher:get-runtime-states",
  runtimeStates: "launcher:runtime-states",
  launchItem: "launcher:launch-item",
  getFieldReport: "launcher:get-field-report",
  getConfigLocation: "launcher:get-config-location",
  revealConfig: "launcher:reveal-config",
} as const;

export type LauncherApi = {
  getConfig(): Promise<LauncherConfig>;
  getRuntimeStates(): Promise<RuntimeSnapshot>;
  onRuntimeStates(listener: (snapshot: RuntimeSnapshot) => void): () => void;
  launchItem(itemId: string): Promise<LaunchResult>;
  getFieldReport(): Promise<FieldReportInfo | null>;
  getConfigLocation(): Promise<ConfigLocation | null>;
  revealConfig(): Promise<void>;
};
