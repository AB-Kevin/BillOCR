// BillOCR Review — main process.
//
// No background process here (unlike Intake): reads the shared workspace's
// pending_review folder, lets a person edit claim JSON, and on Approve
// runs build_one.py synchronously (one short-lived process per claim) to
// produce the finished 837 (saved as .txt) immediately, then archives the source JSON into
// approved/. See pipeline/build_one.py for why this doesn't use
// build_837.py's watcher.

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile, execFileSync } = require("child_process");
const { autoUpdater } = require("electron-updater");
const { PrefixedGitHubProvider } = require("./updateProvider");

const PIPELINE_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "pipeline")
  : path.join(__dirname, "..", "pipeline");

const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");
const DEFAULT_SETTINGS = {
  workspaceFolder: null,
  pythonPath: process.platform === "win32" ? "python" : "python3",
  imagePaneWidth: 480, // remembered width of the review screen's image pane, dragged via its resize handle
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
let cachedSchema = null; // {CMS1500: {fields, required}, UB04: {...}} | null

// --- Auto-update -----------------------------------------------------------
// Driven entirely from the renderer's "Check for updates" control — never
// checked or downloaded silently in the background, so nothing happens on
// the user's bandwidth/disk without them asking for it first.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
// Lets "Check for updates" actually hit GitHub when running unpacked (npm
// start), reading dev-app-update.yml instead of silently no-op'ing. Has no
// effect on a packaged build.
autoUpdater.forceDevUpdateConfig = true;
// See updateProvider.js for why this app can't use electron-updater's stock
// GitHub provider as-is: Intake and Review share one GitHub repo, and the
// stock provider's "latest release" lookup is repo-wide, not per app.
autoUpdater.setFeedURL({ provider: "custom", updateProvider: PrefixedGitHubProvider });

// Mac builds are only ad-hoc signed (no paid Apple Developer ID), which is
// enough for the app to launch but not enough for Squirrel.Mac -- the
// mechanism electron-updater uses under the hood on macOS -- to silently
// install an update; it requires a real Developer ID signature to do that.
// So on Mac, "checking for updates" still works (it just reads the version
// info electron-builder publishes), but instead of downloading/installing
// in-app, we hand the user off to that release's GitHub page to grab the
// new .dmg themselves.
const IS_MAC = process.platform === "darwin";

function sendUpdateStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update-status", status);
  }
}

autoUpdater.on("checking-for-update", () => {
  sendUpdateStatus({ state: "checking" });
});
autoUpdater.on("update-available", (info) => {
  if (IS_MAC) {
    sendUpdateStatus({ state: "available-manual", version: info.version, tag: info.tag });
  } else {
    sendUpdateStatus({ state: "available", version: info.version });
  }
});
autoUpdater.on("update-not-available", () => {
  sendUpdateStatus({ state: "not-available" });
});
autoUpdater.on("download-progress", (progress) => {
  sendUpdateStatus({ state: "downloading", percent: Math.round(progress.percent) });
});
autoUpdater.on("update-downloaded", (info) => {
  sendUpdateStatus({ state: "downloaded", version: info.version });
});
autoUpdater.on("error", (err) => {
  sendUpdateStatus({ state: "error", message: (err && err.message) || String(err) });
});

ipcMain.handle("check-for-updates", async () => {
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    sendUpdateStatus({ state: "error", message: err.message });
  }
});
ipcMain.handle("download-update", async () => {
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    sendUpdateStatus({ state: "error", message: err.message });
  }
});
ipcMain.handle("quit-and-install", () => {
  autoUpdater.quitAndInstall();
});
ipcMain.handle("open-release-page", (_e, tag) => {
  shell.openExternal(`https://github.com/AB-Kevin/BillOCR/releases/tag/${tag}`);
});

function loadSchema(pythonPath) {
  try {
    const out = execFileSync(pythonPath, [path.join(PIPELINE_DIR, "dump_schema.py")], { cwd: PIPELINE_DIR, encoding: "utf-8" });
    cachedSchema = JSON.parse(out);
  } catch (err) {
    cachedSchema = null;
  }
  return cachedSchema;
}

const WORKSPACE_SUBDIRS = ["pending_review", "approved", "output_837"];

function ensureWorkspace(folder) {
  for (const sub of WORKSPACE_SUBDIRS) {
    fs.mkdirSync(path.join(folder, sub), { recursive: true });
  }
  const orgPath = path.join(folder, "org_config.json");
  const examplePath = path.join(PIPELINE_DIR, "org_config.example.json");
  let orgSeeded = false;
  if (!fs.existsSync(orgPath) && fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, orgPath);
    orgSeeded = true;
  }
  return { orgSeeded };
}

function paths(workspaceFolder) {
  return {
    pendingReview: path.join(workspaceFolder, "pending_review"),
    rejected: path.join(workspaceFolder, "pending_review", "_rejected"),
    approved: path.join(workspaceFolder, "approved"),
    outputDir: path.join(workspaceFolder, "output_837"),
    org: path.join(workspaceFolder, "org_config.json"),
    controlState: path.join(workspaceFolder, "control_numbers.json"),
  };
}

function readClaimRecord(jsonPath) {
  return JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
}

function claimSummary(record) {
  const f = record.fields || {};
  const name = [f.patient_first_name, f.patient_last_name].filter(Boolean).join(" ");
  const totalCharge = f.total_charge ?? f.total_charges ?? null;
  return {
    claim_id: record.claim_id,
    form_type: record.form_type,
    extracted_at: record.extracted_at,
    missing_required_fields: record.missing_required_fields || [],
    flagged_count: Object.keys(record.flagged_fields || {}).length,
    used_thinking_fallback: !!record.used_thinking_fallback,
    patient_name: name,
    total_charge: totalCharge,
  };
}

function recomputeMissing(formType, fields) {
  const required = cachedSchema?.[formType]?.required || [];
  return required.filter((key) => {
    const v = fields[key];
    return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  });
}

// --- IPC: window chrome (same as Intake) ---------------------------------

ipcMain.handle("window-minimize", () => mainWindow && mainWindow.minimize());
ipcMain.handle("window-maximize-toggle", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle("window-close", () => mainWindow && mainWindow.close());
ipcMain.handle("window-is-maximized", () => (mainWindow ? mainWindow.isMaximized() : false));

// --- IPC: settings / workspace -------------------------------------------

ipcMain.handle("settings-get", () => readSettings());
ipcMain.handle("settings-set", (_e, patch) => {
  const next = writeSettings(patch);
  if (patch.pythonPath) loadSchema(next.pythonPath);
  return next;
});

// Names of the folders a real workspace root contains -- if someone picks
// one of these directly (easy mistake: pending_review is the one folder
// you actually look at day to day) rather than its parent, redirect to the
// parent instead of silently creating a second, nested workspace inside it.
const KNOWN_WORKSPACE_SUBDIRS = ["pending_review", "approved", "output_837", "incoming_1500", "incoming_ub04"];

ipcMain.handle("workspace-choose", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || !result.filePaths[0]) return { folder: readSettings().workspaceFolder, orgSeeded: false, correctedFrom: null };

  let folder = result.filePaths[0];
  let correctedFrom = null;
  if (KNOWN_WORKSPACE_SUBDIRS.includes(path.basename(folder))) {
    correctedFrom = folder;
    folder = path.dirname(folder);
  }

  const { orgSeeded } = ensureWorkspace(folder);
  writeSettings({ workspaceFolder: folder });
  return { folder, orgSeeded, correctedFrom };
});

ipcMain.handle("python-check", async (_e, pythonPath) => {
  return new Promise((resolve) => {
    execFile(pythonPath || readSettings().pythonPath, ["--version"], (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true, version: (stdout || stderr).trim() });
    });
  });
});

ipcMain.handle("schema-get", () => cachedSchema || loadSchema(readSettings().pythonPath));

// --- IPC: org config -------------------------------------------------------

ipcMain.handle("org-get", () => {
  const settings = readSettings();
  if (!settings.workspaceFolder) return null;
  try {
    return JSON.parse(fs.readFileSync(paths(settings.workspaceFolder).org, "utf-8"));
  } catch {
    return null;
  }
});
ipcMain.handle("org-save", (_e, org) => {
  const settings = readSettings();
  if (!settings.workspaceFolder) throw new Error("No workspace folder chosen.");
  fs.writeFileSync(paths(settings.workspaceFolder).org, JSON.stringify(org, null, 2), "utf-8");
  return true;
});

// --- IPC: claims -----------------------------------------------------------

ipcMain.handle("claims-list-pending", () => {
  const settings = readSettings();
  if (!settings.workspaceFolder) return [];
  const p = paths(settings.workspaceFolder);
  let files;
  try {
    files = fs.readdirSync(p.pendingReview).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const summaries = [];
  for (const file of files) {
    try {
      summaries.push(claimSummary(readClaimRecord(path.join(p.pendingReview, file))));
    } catch (err) {
      summaries.push({ claim_id: file.replace(/\.json$/, ""), form_type: "?", error: `Could not read: ${err.message}` });
    }
  }
  summaries.sort((a, b) => String(a.extracted_at).localeCompare(String(b.extracted_at)));
  return summaries;
});

ipcMain.handle("claims-get", (_e, claimId) => {
  const settings = readSettings();
  const p = paths(settings.workspaceFolder);
  const jsonPath = path.join(p.pendingReview, `${claimId}.json`);
  const record = readClaimRecord(jsonPath);
  const imagePath = record.source_image ? path.join(p.pendingReview, record.source_image) : null;
  return { record, imagePath: imagePath && fs.existsSync(imagePath) ? imagePath : null };
});

// Fresh validation flags after an edit, via pipeline/validate_fields.py --
// Review has no Ollama/model dependency of its own, so it can't recompute
// extract_claim_fields.py's verification-pass disagreement flags (that
// needs re-running the model); it CAN recompute the deterministic
// validation ones (NPI checksum, code shape, sum-of-lines) the same way
// every time, via the one shared Python implementation in
// field_validation.py, rather than reimplementing those checks in JS.
function recomputeValidationFlags(pythonPath, formType, fields) {
  try {
    const out = execFileSync(pythonPath, [path.join(PIPELINE_DIR, "validate_fields.py")], {
      cwd: PIPELINE_DIR,
      input: JSON.stringify({ form_type: formType, fields }),
      encoding: "utf-8",
    });
    return JSON.parse(out).flags || {};
  } catch (err) {
    // Don't let a broken validator block saving the claim -- just skip
    // the refresh this time (existing validation flags, if any, are left
    // as they were).
    return null;
  }
}

function saveClaim(workspaceFolder, claimId, fields) {
  const p = paths(workspaceFolder);
  const jsonPath = path.join(p.pendingReview, `${claimId}.json`);
  const record = readClaimRecord(jsonPath);
  const previousFields = record.fields || {};
  const previousFlagged = record.flagged_fields || {};

  record.fields = fields;
  record.missing_required_fields = recomputeMissing(record.form_type, fields);

  // Disagreement flags are historical (from the original multi-pass
  // extraction) -- keep them for any field the human didn't touch, but
  // drop them for one they just edited by hand (that's presumably
  // resolved now). Validation flags get recomputed fresh below instead of
  // carried forward at all here -- but only replaced if that recompute
  // actually succeeds (see recomputeValidationFlags), so a failed/missing
  // Python doesn't silently erase existing validation flags on fields the
  // human never touched.
  const flagged = {};
  for (const [key, entries] of Object.entries(previousFlagged)) {
    const changed = JSON.stringify(previousFields[key]) !== JSON.stringify(fields[key]);
    const kept = changed ? entries.filter((e) => e.type !== "disagreement") : entries;
    if (kept.length) flagged[key] = kept;
  }
  const settings = readSettings();
  const freshValidation = recomputeValidationFlags(settings.pythonPath, record.form_type, fields);
  if (freshValidation) {
    for (const key of Object.keys(flagged)) {
      flagged[key] = flagged[key].filter((e) => e.type !== "validation");
      if (flagged[key].length === 0) delete flagged[key];
    }
    for (const [key, entries] of Object.entries(freshValidation)) {
      flagged[key] = [...(flagged[key] || []), ...entries];
    }
  }
  record.flagged_fields = flagged;

  fs.writeFileSync(jsonPath, JSON.stringify(record, null, 2), "utf-8");
  return record;
}

ipcMain.handle("claims-save", (_e, { claimId, fields }) => {
  const settings = readSettings();
  if (!settings.workspaceFolder) throw new Error("No workspace folder chosen.");
  return saveClaim(settings.workspaceFolder, claimId, fields);
});

function moveClaimFiles(workspaceFolder, claimId, destDirName) {
  const p = paths(workspaceFolder);
  const destDir = path.join(workspaceFolder, destDirName);
  fs.mkdirSync(destDir, { recursive: true });
  const stem = claimId;
  for (const name of [`${stem}.json`, `${stem}_review.html`]) {
    const src = path.join(p.pendingReview, name);
    if (fs.existsSync(src)) fs.renameSync(src, path.join(destDir, name));
  }
  const imagesDir = path.join(p.pendingReview, "images");
  try {
    for (const file of fs.readdirSync(imagesDir)) {
      if (file.startsWith(stem)) {
        fs.mkdirSync(path.join(destDir, "images"), { recursive: true });
        fs.renameSync(path.join(imagesDir, file), path.join(destDir, "images", file));
      }
    }
  } catch {
    // no images dir, or nothing to move -- fine
  }
}

ipcMain.handle("claims-approve", (_e, { claimId, fields }) => {
  const settings = readSettings();
  if (!settings.workspaceFolder) throw new Error("No workspace folder chosen.");
  const p = paths(settings.workspaceFolder);
  if (!fs.existsSync(p.org)) {
    return { ok: false, missingFields: false, message: "org_config.json not found in the workspace. Fill it in under Organization Settings first." };
  }

  saveClaim(settings.workspaceFolder, claimId, fields);

  const jsonPath = path.join(p.pendingReview, `${claimId}.json`);
  // .txt, not .837 -- the content is still X12 837 EDI text, just saved
  // with a plain-text extension per Kevin's request.
  const outPath = path.join(p.outputDir, `${claimId}.txt`);
  fs.mkdirSync(p.outputDir, { recursive: true });

  return new Promise((resolve) => {
    execFile(
      settings.pythonPath,
      [path.join(PIPELINE_DIR, "build_one.py"), "--claim", jsonPath, "--org", p.org, "--control-state", p.controlState, "--out", outPath],
      { cwd: PIPELINE_DIR },
      (err, stdout, stderr) => {
        if (err) {
          const text = (stderr || err.message || "").trim();
          const missingFields = text.startsWith("MISSING_FIELDS:");
          resolve({ ok: false, missingFields, message: missingFields ? text.replace(/^MISSING_FIELDS:\s*/, "") : text });
          return;
        }
        moveClaimFiles(settings.workspaceFolder, claimId, "approved");
        resolve({ ok: true, outputPath: stdout.trim() });
      }
    );
  });
});

ipcMain.handle("claims-discard", (_e, claimId) => {
  const settings = readSettings();
  if (!settings.workspaceFolder) throw new Error("No workspace folder chosen.");
  moveClaimFiles(settings.workspaceFolder, claimId, path.join("pending_review", "_rejected"));
  return true;
});

ipcMain.handle("claims-counts", () => {
  const settings = readSettings();
  if (!settings.workspaceFolder) return { pending: 0, approved: 0, output: 0 };
  const p = paths(settings.workspaceFolder);
  const countFiles = (dir, ext) => {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith(ext)).length;
    } catch {
      return 0;
    }
  };
  return {
    pending: countFiles(p.pendingReview, ".json"),
    approved: countFiles(p.approved, ".json"),
    output: countFiles(p.outputDir, ".txt"),
  };
});

ipcMain.handle("shell-open-folder", (_e, folderPath) => shell.openPath(folderPath));
ipcMain.handle("get-app-version", () => app.getVersion());

// --- App lifecycle ---------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
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
  mainWindow.on("maximize", () => mainWindow.webContents.send("window-state", { maximized: true }));
  mainWindow.on("unmaximize", () => mainWindow.webContents.send("window-state", { maximized: false }));
}

app.whenReady().then(() => {
  loadSchema(readSettings().pythonPath);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
