import { contextBridge, ipcRenderer } from "electron";
import type { FieldReportInfo, LauncherConfig, LaunchResult, RuntimeSnapshot } from "../shared/types";

contextBridge.exposeInMainWorld("launcherApi", {
  getConfig: (): Promise<LauncherConfig> => ipcRenderer.invoke("launcher:get-config"),
  getRuntimeStates: (): Promise<RuntimeSnapshot> =>
    ipcRenderer.invoke("launcher:get-runtime-states"),
  onRuntimeStates: (listener: (snapshot: RuntimeSnapshot) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: RuntimeSnapshot): void => {
      listener(snapshot);
    };
    ipcRenderer.on("launcher:runtime-states", handler);
    return () => ipcRenderer.removeListener("launcher:runtime-states", handler);
  },
  launchItem: (itemId: string): Promise<LaunchResult> => ipcRenderer.invoke("launcher:launch-item", itemId),
  getFieldReport: (): Promise<FieldReportInfo | null> => ipcRenderer.invoke("launcher:get-field-report"),
});
