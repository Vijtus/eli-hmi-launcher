import { contextBridge, ipcRenderer } from "electron";
import type { LauncherConfig, LaunchResult } from "../shared/types";

contextBridge.exposeInMainWorld("launcherApi", {
  getConfig: (): Promise<LauncherConfig> => ipcRenderer.invoke("launcher:get-config"),
  launchItem: (itemId: string): Promise<LaunchResult> => ipcRenderer.invoke("launcher:launch-item", itemId),
});
