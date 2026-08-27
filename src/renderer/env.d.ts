import type { LauncherApi } from "../shared/ipc";

declare global {
  interface Window {
    launcherApi: LauncherApi;
  }
}
