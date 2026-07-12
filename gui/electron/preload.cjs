const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("localModelRouter", {
  getState: () => ipcRenderer.invoke("app:getState"),
  rendererReady: () => ipcRenderer.invoke("app:rendererReady"),
  hideToTray: () => ipcRenderer.invoke("app:hideToTray"),
  cancelClose: () => ipcRenderer.invoke("app:cancelClose"),
  quitAndStop: () => ipcRenderer.invoke("app:quitAndStop"),
  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  startRouter: () => ipcRenderer.invoke("router:start"),
  stopRouter: () => ipcRenderer.invoke("router:stop"),
  restartRouter: () => ipcRenderer.invoke("router:restart"),
  checkHealth: (options) => ipcRenderer.invoke("router:health", options),
  readLogs: (options) => ipcRenderer.invoke("logs:read", options),
  openConfig: () => ipcRenderer.invoke("file:openConfig"),
  openLog: () => ipcRenderer.invoke("file:openLog"),
  writeClipboard: (text) => ipcRenderer.invoke("clipboard:writeText", text),
  onOpenSettings: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("app:openSettings", listener);
    return () => ipcRenderer.removeListener("app:openSettings", listener);
  },
  onConfirmClose: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("app:confirmClose", listener);
    return () => ipcRenderer.removeListener("app:confirmClose", listener);
  },
});
