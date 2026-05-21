import type { LauncherConfig, LaunchResult } from "../../shared/types";

declare global {
  interface Window {
    launcherApi: {
      getConfig(): Promise<LauncherConfig>;
      launchItem(itemId: string): Promise<LaunchResult>;
    };
  }
}
