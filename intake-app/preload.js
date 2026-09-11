// BillOCR Intake — preload bridge. Exposes a small `window.api` surface to
// the renderer; every call is a thin ipcRenderer.invoke wrapper (mirrors
// BillManager's preload.js convention) except the three push-channel
// subscriptions at the bottom, which return an unsubscribe function.

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel) {
  return (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("api", {
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximizeToggle: () => ipcRenderer.invoke("window-maximize-toggle"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),

  getSettings: () => ipcRenderer.invoke("settings-get"),
  setSettings: (patch) => ipcRenderer.invoke("settings-set", patch),

  chooseWorkspace: () => ipcRenderer.invoke("workspace-choose"),

  pipelineStart: () => ipcRenderer.invoke("pipeline-start"),
  pipelineStop: () => ipcRenderer.invoke("pipeline-stop"),
  pipelineStatus: () => ipcRenderer.invoke("pipeline-status"),

  checkPython: (pythonPath) => ipcRenderer.invoke("python-check", pythonPath),
  checkOllama: (host) => ipcRenderer.invoke("ollama-check", host),
  stopModelNow: (host, model) => ipcRenderer.invoke("ollama-stop-model", { host, model }),
  pendingCount: () => ipcRenderer.invoke("pending-count"),

  openFolder: (folderPath) => ipcRenderer.invoke("shell-open-folder", folderPath),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),

  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  quitAndInstall: () => ipcRenderer.invoke("quit-and-install"),
  openReleasePage: (tag) => ipcRenderer.invoke("open-release-page", tag),

  onPipelineLog: subscribe("pipeline:log"),
  onPipelineProgress: subscribe("pipeline:progress"),
  onPipelineExited: subscribe("pipeline:exited"),
  onWindowState: subscribe("window-state"),
  onUpdateStatus: subscribe("update-status"),
});
