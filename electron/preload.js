const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("launcherApi", {
  getConfig: () => ipcRenderer.invoke("launcher:get-config"),
  launchItem: (itemId) => ipcRenderer.invoke("launcher:launch-item", itemId),
});
