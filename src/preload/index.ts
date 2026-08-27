import { contextBridge, ipcRenderer } from "electron";
import { IPC, type LauncherApi } from "../shared/ipc";
import type { RuntimeSnapshot } from "../shared/types";

const api: LauncherApi = {
  getConfig: () => ipcRenderer.invoke(IPC.getConfig),
  getRuntimeStates: () => ipcRenderer.invoke(IPC.getRuntimeStates),
  onRuntimeStates: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: RuntimeSnapshot): void => listener(snapshot);
    ipcRenderer.on(IPC.runtimeStates, handler);
    return () => ipcRenderer.removeListener(IPC.runtimeStates, handler);
  },
  launchItem: (itemId) => ipcRenderer.invoke(IPC.launchItem, itemId),
  getFieldReport: () => ipcRenderer.invoke(IPC.getFieldReport),
  getConfigLocation: () => ipcRenderer.invoke(IPC.getConfigLocation),
  revealConfig: () => ipcRenderer.invoke(IPC.revealConfig),
};

contextBridge.exposeInMainWorld("launcherApi", api);
