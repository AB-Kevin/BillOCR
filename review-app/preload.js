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
  listApprovedClaims: () => ipcRenderer.invoke("claims-list-approved"),
  getApprovedClaim: (claimId) => ipcRenderer.invoke("claims-get-approved", claimId),
  saveClaim: (claimId, fields) => ipcRenderer.invoke("claims-save", { claimId, fields }),
  dismissFlag: (claimId, fields, key) => ipcRenderer.invoke("claims-dismiss-flag", { claimId, fields, key }),
  approveClaim: (claimId, fields) => ipcRenderer.invoke("claims-approve", { claimId, fields }),
  discardClaim: (claimId) => ipcRenderer.invoke("claims-discard", claimId),
  getClaimCounts: () => ipcRenderer.invoke("claims-counts"),

  listExports: () => ipcRenderer.invoke("exports-list"),
  openExportViewer: (filename) => ipcRenderer.invoke("open-export-viewer", filename),

  openFolder: (folderPath) => ipcRenderer.invoke("shell-open-folder", folderPath),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  usesBundledPipeline: () => ipcRenderer.invoke("uses-bundled-pipeline"),

  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  quitAndInstall: () => ipcRenderer.invoke("quit-and-install"),
  openReleasePage: (tag) => ipcRenderer.invoke("open-release-page", tag),

  onWindowState: subscribe("window-state"),
  onUpdateStatus: subscribe("update-status"),
  // Autosave's flush-before-close handshake -- see main.js's "close"
  // handler and renderer.js's init().
  onBeforeClose: subscribe("app-before-close"),
  notifyFlushedBeforeClose: () => ipcRenderer.invoke("app-flushed-before-close"),
});
