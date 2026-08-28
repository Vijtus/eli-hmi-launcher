import type {
  ConfigLocation,
  FieldReportInfo,
  LauncherConfig,
  LaunchResult,
  RepoSettingsInput,
  RepoSettingsSaveResult,
  RepoSettingsTestResult,
  RepoSettingsView,
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
  getRepoSettings: "launcher:get-repo-settings",
  saveRepoSettings: "launcher:save-repo-settings",
  clearRepoSettings: "launcher:clear-repo-settings",
  testRepoSettings: "launcher:test-repo-settings",
  restartApp: "launcher:restart-app",
} as const;

export type LauncherApi = {
  getConfig(): Promise<LauncherConfig>;
  getRuntimeStates(): Promise<RuntimeSnapshot>;
  onRuntimeStates(listener: (snapshot: RuntimeSnapshot) => void): () => void;
  launchItem(itemId: string): Promise<LaunchResult>;
  getFieldReport(): Promise<FieldReportInfo | null>;
  getConfigLocation(): Promise<ConfigLocation | null>;
  revealConfig(): Promise<void>;
  getRepoSettings(): Promise<RepoSettingsView>;
  saveRepoSettings(settings: RepoSettingsInput): Promise<RepoSettingsSaveResult>;
  clearRepoSettings(): Promise<void>;
  testRepoSettings(settings: RepoSettingsInput): Promise<RepoSettingsTestResult>;
  restartApp(): Promise<void>;
};
