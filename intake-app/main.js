// BillOCR Intake — main process.
//
// Runs extract_claim_fields.py's watcher (image -> extracted JSON + review
// page) on the dedicated OCR machine, continuously, in the background.
// This window is a control panel around that one child process: Start/Stop,
// live log, settings, and a system tray so it can keep running unattended
// after the window is closed (it only actually quits from the tray menu).

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn, execFile } = require("child_process");

const PIPELINE_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "pipeline")
  : path.join(__dirname, "..", "pipeline");

const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");
const DEFAULT_SETTINGS = {
  workspaceFolder: null,
  pythonPath: process.platform === "win32" ? "python" : "python3",
  model: "qwen3-vl:8b-instruct",
  maxDim: 1600,
  keepAlive: "30m",
  verificationPasses: 3, // 1 = off (today's single-read behavior); see extract_claim_fields.py's --verification-passes
  checkPassTemperature: 0.5, // see extract_claim_fields.py's --check-pass-temperature (DEFAULT_CHECK_PASS_TEMPERATURE)
  ollamaHost: "http://localhost:11434",
  openAtLogin: false,
};

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8")) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

let mainWindow = null;
let tray = null;
let quitting = false; // set true only when the tray/menu actually asks to quit

let proc = null; // the running extract_claim_fields.py child, or null
let procStartedAt = null;

const WORKSPACE_SUBDIRS = ["incoming_1500", "incoming_ub04", "pending_review"];

function ensureWorkspace(folder) {
  for (const sub of WORKSPACE_SUBDIRS) {
    fs.mkdirSync(path.join(folder, sub), { recursive: true });
  }
}

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function pipelineStatus() {
  return { running: !!proc, pid: proc ? proc.pid : null, startedAt: procStartedAt };
}

function startPipeline() {
  if (proc) return pipelineStatus();

  const settings = readSettings();
  if (!settings.workspaceFolder) {
    throw new Error("Choose a workspace folder first.");
  }
  // Note: extract_claim_fields.py never reads org_config.json (only
  // build_837.py/build_one.py, which is Review's job) -- so intake doesn't
  // need it to exist before starting, unlike Review's approve action.
  ensureWorkspace(settings.workspaceFolder);

  const args = [
    path.join(PIPELINE_DIR, "extract_claim_fields.py"),
    "--cms1500-in", path.join(settings.workspaceFolder, "incoming_1500"),
    "--ub04-in", path.join(settings.workspaceFolder, "incoming_ub04"),
    "--out", path.join(settings.workspaceFolder, "pending_review"),
    "--model", settings.model,
    "--host", settings.ollamaHost,
    "--poll-interval", "2",
  ];
  if (settings.keepAlive) args.push("--keep-alive", String(settings.keepAlive));
  if (settings.maxDim) args.push("--max-dim", String(settings.maxDim));
  if (settings.verificationPasses) args.push("--verification-passes", String(settings.verificationPasses));
  if (settings.checkPassTemperature != null) args.push("--check-pass-temperature", String(settings.checkPassTemperature));

  proc = spawn(settings.pythonPath, args, { cwd: PIPELINE_DIR });
  procStartedAt = new Date().toISOString();

  const forwardLine = (streamName) => (chunk) => {
    for (const line of chunk.toString("utf-8").split(/\r?\n/)) {
      if (line.length) sendToWindow("pipeline:log", { stream: streamName, line, ts: Date.now() });
    }
  };
  proc.stdout.on("data", forwardLine("stdout"));
  proc.stderr.on("data", forwardLine("stderr"));

  proc.on("error", (err) => {
    sendToWindow("pipeline:log", { stream: "stderr", line: `Failed to start: ${err.message}`, ts: Date.now() });
    proc = null;
    procStartedAt = null;
    sendToWindow("pipeline:exited", { code: null, error: err.message });
  });

  proc.on("exit", (code, signal) => {
    proc = null;
    procStartedAt = null;
    sendToWindow("pipeline:exited", { code, signal });
  });

  return pipelineStatus();
}

function stopPipeline() {
  if (!proc) return pipelineStatus();
  if (process.platform === "win32") {
    // child_process has no clean SIGINT equivalent on Windows -- this is a
    // hard stop (no graceful "Stopping..." message from the script), which
    // is safe here since the watch loop only ever interrupts between polls.
    execFile("taskkill", ["/pid", String(proc.pid), "/t", "/f"], () => {});
  } else {
    proc.kill("SIGINT"); // caught by the script's own `except KeyboardInterrupt`
  }
  return pipelineStatus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: "#FFFFFF",
    autoHideMenuBar: true,
    frame: false,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.on("maximize", () => sendToWindow("window-state", { maximized: true }));
  mainWindow.on("unmaximize", () => sendToWindow("window-state", { maximized: false }));

  // Closing the window hides it instead of quitting -- this app is meant to
  // keep watching in the background. Real quit only happens from the tray
  // menu (or Cmd+Q on mac, which still routes through this the same way).
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  tray = new Tray(path.join(__dirname, "build", "tray.png"));
  tray.setToolTip("BillOCR Intake");
  const rebuildMenu = () => {
    const running = !!proc;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Show window", click: () => mainWindow && mainWindow.show() },
        { type: "separator" },
        { label: running ? "Stop" : "Start", click: () => (running ? stopPipeline() : startPipeline()), enabled: !!readSettings().workspaceFolder },
        { label: running ? "Running" : "Stopped", enabled: false },
        { type: "separator" },
        { label: "Quit", click: () => { quitting = true; app.quit(); } },
      ])
    );
  };
  rebuildMenu();
  tray.on("click", () => mainWindow && mainWindow.show());
  // Keep the tray menu's Start/Stop label in sync with actual state.
  setInterval(rebuildMenu, 2000);
}

// --- IPC ---------------------------------------------------------------

ipcMain.handle("window-minimize", () => mainWindow && mainWindow.minimize());
ipcMain.handle("window-maximize-toggle", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle("window-close", () => mainWindow && mainWindow.close());
ipcMain.handle("window-is-maximized", () => (mainWindow ? mainWindow.isMaximized() : false));

ipcMain.handle("settings-get", () => readSettings());
ipcMain.handle("settings-set", (_e, patch) => {
  const next = writeSettings(patch);
  if (typeof patch.openAtLogin === "boolean") {
    app.setLoginItemSettings({ openAtLogin: patch.openAtLogin });
  }
  return next;
});

ipcMain.handle("workspace-choose", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || !result.filePaths[0]) return readSettings().workspaceFolder;
  const folder = result.filePaths[0];
  ensureWorkspace(folder);
  writeSettings({ workspaceFolder: folder });
  return folder;
});

ipcMain.handle("pipeline-start", () => {
  try {
    return { ok: true, status: startPipeline() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("pipeline-stop", () => ({ ok: true, status: stopPipeline() }));
ipcMain.handle("pipeline-status", () => pipelineStatus());

ipcMain.handle("python-check", async (_e, pythonPath) => {
  return new Promise((resolve) => {
    execFile(pythonPath || readSettings().pythonPath, ["--version"], (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true, version: (stdout || stderr).trim() });
    });
  });
});

ipcMain.handle("ollama-check", async (_e, host) => {
  const url = host || readSettings().ollamaHost;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return { ok: res.ok };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Unloads the model from Ollama's memory immediately, instead of waiting
// out the Keep-alive setting. keep_alive: 0 on a request with no actual
// prompt/messages is Ollama's documented way to do this via its own HTTP
// API (same effect as running `ollama stop <model>` from a terminal) --
// no dependency on the `ollama` CLI being on PATH, just the server this
// app already talks to.
ipcMain.handle("ollama-stop-model", async (_e, { host, model }) => {
  const url = (host || readSettings().ollamaHost).replace(/\/+$/, "");
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: text || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("pending-count", () => {
  const settings = readSettings();
  if (!settings.workspaceFolder) return 0;
  const dir = path.join(settings.workspaceFolder, "pending_review");
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
});

ipcMain.handle("shell-open-folder", (_e, folderPath) => shell.openPath(folderPath));
ipcMain.handle("get-app-version", () => app.getVersion());

// --- App lifecycle -------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();
    app.setLoginItemSettings({ openAtLogin: readSettings().openAtLogin });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else mainWindow.show();
    });
  });

  app.on("window-all-closed", () => {
    // Never quit on window close for this app -- it lives in the tray.
  });

  app.on("before-quit", (event) => {
    quitting = true;
    if (proc) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: "warning",
        buttons: ["Quit anyway", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        message: "The extraction pipeline is running.",
        detail: "Quitting now stops claim intake on this machine. Quit anyway?",
      });
      if (choice === 1) {
        event.preventDefault();
        quitting = false;
        return;
      }
      stopPipeline();
    }
  });
}
