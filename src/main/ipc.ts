import { ipcMain, shell } from "electron";
import { IPC } from "../shared/ipc";
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
} from "../shared/types";

type IpcDependencies = {
  getConfig(): LauncherConfig;
  getRuntimeSnapshot(): RuntimeSnapshot;
  launch(itemId: unknown): Promise<LaunchResult>;
  getFieldReport(): FieldReportInfo | null;
  getConfigLocation(): ConfigLocation | null;
  getRepoSettings(): RepoSettingsView;
  saveRepoSettings(settings: RepoSettingsInput): RepoSettingsSaveResult;
  clearRepoSettings(): void;
  testRepoSettings(settings: RepoSettingsInput): Promise<RepoSettingsTestResult>;
  restartApp(): void;
};

export function registerIpc(deps: IpcDependencies): void {
  ipcMain.handle(IPC.getConfig, async (): Promise<LauncherConfig> => deps.getConfig());
  ipcMain.handle(IPC.getRuntimeStates, async (): Promise<RuntimeSnapshot> => deps.getRuntimeSnapshot());
  ipcMain.handle(IPC.launchItem, async (_event, itemId: unknown): Promise<LaunchResult> => deps.launch(itemId));
  ipcMain.handle(IPC.getFieldReport, async (): Promise<FieldReportInfo | null> => deps.getFieldReport());
  ipcMain.handle(IPC.getConfigLocation, async (): Promise<ConfigLocation | null> => deps.getConfigLocation());
  ipcMain.handle(IPC.revealConfig, async (): Promise<void> => {
    const location = deps.getConfigLocation();
    if (location) {
      shell.showItemInFolder(location.path);
    }
  });
  ipcMain.handle(IPC.getRepoSettings, async (): Promise<RepoSettingsView> => deps.getRepoSettings());
  ipcMain.handle(
    IPC.saveRepoSettings,
    async (_event, settings: RepoSettingsInput): Promise<RepoSettingsSaveResult> =>
      deps.saveRepoSettings(settings),
  );
  ipcMain.handle(IPC.clearRepoSettings, async (): Promise<void> => deps.clearRepoSettings());
  ipcMain.handle(
    IPC.testRepoSettings,
    async (_event, settings: RepoSettingsInput): Promise<RepoSettingsTestResult> =>
      deps.testRepoSettings(settings),
  );
  ipcMain.handle(IPC.restartApp, async (): Promise<void> => deps.restartApp());
}
