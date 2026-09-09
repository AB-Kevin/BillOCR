// BillOCR Review — preload bridge. Same convention as Intake's preload.js
// (and BillManager's before it): one exposeInMainWorld("api", {...}),
// every renderer->main call is ipcRenderer.invoke.

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
  checkPython: (pythonPath) => ipcRenderer.invoke("python-check", pythonPath),
  getSchema: () => ipcRenderer.invoke("schema-get"),

  getOrgConfig: () => ipcRenderer.invoke("org-get"),
  saveOrgConfig: (org) => ipcRenderer.invoke("org-save", org),

  listPendingClaims: () => ipcRenderer.invoke("claims-list-pending"),
  getClaim: (claimId) => ipcRenderer.invoke("claims-get", claimId),
  saveClaim: (claimId, fields) => ipcRenderer.invoke("claims-save", { claimId, fields }),
  approveClaim: (claimId, fields) => ipcRenderer.invoke("claims-approve", { claimId, fields }),
  discardClaim: (claimId) => ipcRenderer.invoke("claims-discard", claimId),
  getClaimCounts: () => ipcRenderer.invoke("claims-counts"),

  openFolder: (folderPath) => ipcRenderer.invoke("shell-open-folder", folderPath),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),

  onWindowState: subscribe("window-state"),
});
