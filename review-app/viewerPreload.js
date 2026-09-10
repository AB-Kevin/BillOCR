// BillOCR Review's claim viewer window — preload bridge. Same convention as
// the main window's preload.js: one exposeInMainWorld("viewerApi", {...}),
// every call a thin ipcRenderer.invoke wrapper.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("viewerApi", {
  windowMinimize: () => ipcRenderer.invoke("viewer-window-minimize"),
  windowMaximizeToggle: () => ipcRenderer.invoke("viewer-window-maximize-toggle"),
  windowClose: () => ipcRenderer.invoke("viewer-window-close"),
  readClaimFile: (filePath) => ipcRenderer.invoke("viewer-read-file", filePath),
});
