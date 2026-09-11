// BillOCR Intake — renderer. Single vanilla-JS file, no framework: one
// `state` object, `render()` tears down and rebuilds #app from it, same
// pattern BillManager's renderer.js uses. This app has one job (run the
// extraction watcher), so it's a single page rather than a rail/sections.

const state = {
  settings: null,
  theme: "system", // "system" | "light" | "dark" | "midnight" -- see applyTheme()/setTheme()/resolveTheme(); persisted in settings.json alongside everything else
  status: { running: false, pid: null, startedAt: null, progress: null },
  pythonCheck: null, // {ok, version} | {ok:false, error} | null (checking)
  ollamaCheck: null,
  pendingCount: 0,
  logs: [], // {stream, line, ts}
  windowMaximized: false,
  startError: null,
  busy: false, // Start/Stop in flight
  stopModelStatus: null, // brief feedback text under the "Stop now" button
  updateStatus: { state: "idle" }, // idle | checking | available | available-manual | downloading | downloaded | not-available | error
  // Live "what's it doing right now" widget in the Status card (see
  // renderProgressWidget/patchProgressWidget) -- driven by extract_claim_fields.py's
  // PROGRESS lines (see common.emit_progress), forwarded here as "pipeline:progress"
  // IPC pushes (see main.js's forwardLine).
  progress: null, // {event:"pass_start", file, pass, of, stage} | null (idle/watching)
  doneFlash: null, // {file, ok, claim_id, missing, flagged, error} | null -- brief "✓/✗" shown after a file_done event, see scheduleDoneFlashClear()
};

const MAX_LOG_LINES = 500;

function el(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstChild;
}

function icon(svgInner, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgInner}</svg>`;
}
const ICONS = {
  minimize: icon('<line x1="5" y1="12" x2="19" y2="12"/>'),
  maximize: icon('<rect x="5" y="5" width="14" height="14" rx="1"/>'),
  close: icon('<line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/>'),
  folder: icon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>', 14),
  check: icon('<polyline points="20 6 9 17 4 12"/>', 14),
  x: icon('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 14),
};

// True on macOS/Windows, computed once (not per-render): navigator.platform
// is a plain web API, available in the renderer with no preload/IPC surface
// of its own even under contextIsolation. IS_MAC is set as a class on <html>
// immediately so CSS keyed off .is-mac (see styles.css's
// .is-mac .bm-titlebar-brand) is correct from the very first paint.
const IS_MAC = /Mac/i.test(navigator.platform);
const IS_WINDOWS = /Win/i.test(navigator.platform);
document.documentElement.classList.toggle("is-mac", IS_MAC);

// The window is frameless only where neither OS offers a native alternative
// (Linux) -- there, the app draws its own chrome and wires the three
// controls to real window operations over IPC. On macOS, main.js instead
// uses titleBarStyle:"hiddenInset" (real traffic lights); on Windows,
// titleBarStyle:"hidden" + titleBarOverlay (real Fluent caption buttons,
// Snap Layouts included) -- either way the OS insets native buttons into
// this same custom bar, so the hand-drawn ones would be redundant (and, on
// Windows, would literally overlap the native ones in the same top-right
// corner) and are skipped entirely; only the drag region and title text are
// still ours.
function renderTitlebar() {
  const hasNativeButtons = IS_MAC || IS_WINDOWS;
  const bar = el(`
    <div class="bm-titlebar">
      <div class="bm-titlebar-brand"><span class="bm-titlebar-title">BillOCR Intake</span></div>
      ${
        hasNativeButtons
          ? ""
          : `<div class="bm-titlebar-controls">
        <button class="bm-titlebar-btn" id="win-minimize" title="Minimize">${ICONS.minimize}</button>
        <button class="bm-titlebar-btn" id="win-maximize" title="Maximize">${ICONS.maximize}</button>
        <button class="bm-titlebar-btn bm-titlebar-close" id="win-close" title="Close">${ICONS.close}</button>
      </div>`
      }
    </div>
  `);
  bar.querySelector("#win-minimize")?.addEventListener("click", () => window.api.windowMinimize());
  bar.querySelector("#win-maximize")?.addEventListener("click", () => window.api.windowMaximizeToggle());
  bar.querySelector("#win-close")?.addEventListener("click", () => window.api.windowClose());
  return bar;
}

// System/light/dark/midnight -- same .bm-theme-toggle widget as BillManager's
// Options modal, now with the same 4th "System" choice added there too; only
// where it lives differs (a row in this app's own Settings card, since this
// single-page app has no rail+modal to put it in). See styles.css's
// :root/[data-theme="dark"]/[data-theme="midnight"] blocks for the actual
// palettes -- already present here byte-for-byte, ported along with the
// rest of the shared design system, just never wired up to anything yet.
const THEME_CHOICES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "midnight", label: "Midnight" },
];

// "system" (the default -- see main.js's DEFAULT_SETTINGS.theme) has no CSS
// palette of its own -- it maps 1:1 onto plain light or dark, matching the
// OS's own preference, and never resolves to midnight (that's only ever
// reached by an explicit choice). matchMedia's "prefers-color-scheme: dark"
// is the renderer-side read of that OS preference -- see main.js's
// nativeTheme.shouldUseDarkColors for the equivalent used pre-paint, in the
// main process, before this window (and so this API) exists yet.
function resolveTheme(pref) {
  if (pref === "system" || !pref) return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return pref;
}

// Applied before the very first render() (see init()) so the window paints
// in the right theme from frame one instead of flashing light-then-dark --
// same ordering trick BillManager's own init() uses. Takes the raw
// preference (including "system") and resolves it -- state.theme itself
// keeps the raw preference, so the toggle can still show "System" as the
// active choice rather than whichever theme it happened to resolve to.
function applyTheme(pref) {
  document.documentElement.setAttribute("data-theme", resolveTheme(pref));
}

async function setTheme(theme) {
  state.theme = theme;
  applyTheme(theme);
  render();
  state.settings = await window.api.setSettings({ theme });
}

function statusDot(kind) {
  // kind: "ok" | "bad" | "pending" | null (unknown/gray)
  return `<span class="bo-dot ${kind || ""}"></span>`;
}

function describeCheck(check, okLabel, badLabelPrefix) {
  if (check === null) return { dot: "pending", text: "Checking…" };
  if (check.ok) return { dot: "ok", text: okLabel };
  return { dot: "bad", text: `${badLabelPrefix}: ${check.error || "not reachable"}` };
}

// ---- Updates ----
// The main process owns autoUpdater (against updateProvider.js's custom,
// Intake-only feed -- see its own comment) and only reports status back
// over "update-status"; nothing here talks to GitHub directly. Same
// state-machine shape as BillManager's renderer.js.
//
// "not-available" is shown only briefly: after the startup auto-check
// confirms there's nothing new, sitting on "Up to date" forever would be a
// permanent, slightly odd fixture next to the version number -- it reverts
// back to the plain "Check for updates" button on its own instead. Every
// other status (available/downloading/downloaded/error) is left as-is,
// since those need a person to actually do something about them.
const NOT_AVAILABLE_DISPLAY_MS = 4000;
let notAvailableResetTimer = null;

function setUpdateStatus(status) {
  if (notAvailableResetTimer) {
    clearTimeout(notAvailableResetTimer);
    notAvailableResetTimer = null;
  }
  state.updateStatus = status;
  render();
  if (status.state === "not-available") {
    notAvailableResetTimer = setTimeout(() => {
      notAvailableResetTimer = null;
      state.updateStatus = { state: "idle" };
      render();
    }, NOT_AVAILABLE_DISPLAY_MS);
  }
}

async function checkForUpdates() {
  setUpdateStatus({ state: "checking" });
  await window.api.checkForUpdates();
}
async function downloadUpdate() {
  setUpdateStatus({ ...state.updateStatus, state: "downloading", percent: 0 });
  await window.api.downloadUpdate();
}
function restartToInstall() {
  window.api.quitAndInstall();
}
// Mac builds can't silently install (see main.js's IS_MAC comment), so an
// available update there just opens that release's GitHub page.
function openReleasePage() {
  window.api.openReleasePage(state.updateStatus.tag);
}

function renderUpdateAction() {
  const s = state.updateStatus;
  if (s.state === "checking") return `<span class="bo-update-row">Checking for updates…</span>`;
  if (s.state === "available") return `<button class="bm-btn bm-btn-primary bm-btn-sm" id="update-download">Download update ${s.version}</button>`;
  if (s.state === "available-manual") return `<button class="bm-btn bm-btn-primary bm-btn-sm" id="update-manual">Get update ${s.version}</button>`;
  if (s.state === "downloading") return `<span class="bo-update-row">Downloading… ${s.percent ?? 0}%</span>`;
  if (s.state === "downloaded") return `<button class="bm-btn bm-btn-secondary bm-btn-sm" id="update-restart">Restart to install</button>`;
  if (s.state === "not-available") return `<span class="bo-update-row bo-update-clickable" id="update-recheck">Up to date</span>`;
  if (s.state === "error") return `<span class="bo-update-row bo-update-error bo-update-clickable" id="update-recheck" title="${escapeAttr(s.message || "")}">Update check failed</span>`;
  return `<button class="bm-btn bm-btn-secondary bm-btn-sm" id="update-check">Check for updates</button>`;
}

function bindUpdateAction(page) {
  const checkBtn = page.querySelector("#update-check");
  if (checkBtn) checkBtn.addEventListener("click", checkForUpdates);
  const downloadBtn = page.querySelector("#update-download");
  if (downloadBtn) downloadBtn.addEventListener("click", downloadUpdate);
  const manualBtn = page.querySelector("#update-manual");
  if (manualBtn) manualBtn.addEventListener("click", openReleasePage);
  const restartBtn = page.querySelector("#update-restart");
  if (restartBtn) restartBtn.addEventListener("click", restartToInstall);
  const recheckBtn = page.querySelector("#update-recheck");
  if (recheckBtn) recheckBtn.addEventListener("click", checkForUpdates);
}

function renderPage() {
  const s = state.settings || {};
  const running = state.status.running;

  const pythonInfo = describeCheck(state.pythonCheck, `Python ready (${state.pythonCheck?.version || ""})`, "Python not found");
  const ollamaInfo = describeCheck(state.ollamaCheck, "Ollama reachable", "Ollama unreachable");

  const page = el(`
    <div class="bo-page">
      <div class="bo-title-row">
        <div class="bo-title">BillOCR Intake</div>
        <div class="bo-version-group">
          <div class="bo-version" id="app-version"></div>
          ${renderUpdateAction()}
        </div>
      </div>

      ${state.startError ? `<div class="bo-error-banner">${escapeHtml(state.startError)}</div>` : ""}

      <div class="bo-card">
        <div class="bo-card-label">Status</div>
        <div class="bo-status-row">
          <div class="bo-status">${statusDot(running ? "ok" : "bad")} Pipeline: ${running ? "running" : "stopped"}</div>
          <div class="bo-status">${statusDot(pythonInfo.dot)} ${pythonInfo.text}</div>
          <div class="bo-status">${statusDot(ollamaInfo.dot)} ${ollamaInfo.text}</div>
          <div class="bo-pending-badge">${state.pendingCount} claim${state.pendingCount === 1 ? "" : "s"} awaiting review</div>
        </div>
        <div id="progress-widget">${renderProgressWidget()}</div>
        <div class="bo-start-row">
          <button class="bm-btn bm-btn-primary" id="start-stop-btn" ${state.busy || !s.workspaceFolder ? "disabled" : ""}>
            ${running ? "Stop" : "Start"}
          </button>
          ${!s.workspaceFolder ? '<span class="bo-toggle-label">Choose a workspace folder first</span>' : ""}
        </div>
      </div>

      <div class="bo-card">
        <div class="bo-card-label">Workspace</div>
        <div class="bo-path-row">
          <span class="bo-path ${s.workspaceFolder ? "" : "empty"}">${s.workspaceFolder ? escapeHtml(s.workspaceFolder) : "No folder chosen yet"}</span>
          <button class="bm-btn bm-btn-secondary bm-btn-sm" id="choose-folder-btn">${ICONS.folder} Choose folder</button>
        </div>
        <div class="bo-toggle-label">This folder is shared over the network to the BillOCR Review app on the approval machine. It holds <code>incoming_1500/</code>, <code>incoming_ub04/</code> (drop scanned claim images or PDFs here), and <code>pending_review/</code> (extracted claims waiting for review).</div>
      </div>

      <div class="bo-card">
        <div class="bo-card-label">Settings</div>
        <div class="bo-field-grid">
          <label class="bm-field">
            <span class="bm-field-label">Model</span>
            <input class="bm-input" id="field-model" value="${escapeAttr(s.model)}" placeholder="qwen3-vl:8b-instruct" />
          </label>
          <label class="bm-field">
            <span class="bm-field-label">Max image dimension</span>
            <input class="bm-input" id="field-maxDim" type="number" value="${s.maxDim ?? ""}" placeholder="1600" />
          </label>
          <label class="bm-field">
            <span class="bm-field-label">Model context window (tokens)</span>
            <input class="bm-input" id="field-numCtx" type="number" min="2048" step="1024" value="${s.numCtx ?? ""}" placeholder="8192" />
            <span class="bo-toggle-label">Has to fit the image, the prompt, and the full extracted claim together. Too low and a claim with many line items gets cut off mid-read -- showing up as a JSON error in the log for an otherwise-fine image. Raise this if that keeps happening.</span>
          </label>
          <label class="bm-field">
            <span class="bm-field-label">Keep-alive</span>
            <div class="bm-field-row">
              <input class="bm-input" id="field-keepAlive" value="${escapeAttr(s.keepAlive)}" placeholder="30m" />
              <button class="bm-btn bm-btn-secondary bm-btn-sm" id="stop-model-btn" type="button" title="Unload the model from Ollama's memory right now, instead of waiting out Keep-alive">Stop now</button>
            </div>
            ${state.stopModelStatus ? `<span class="bo-toggle-label">${escapeHtml(state.stopModelStatus)}</span>` : ""}
          </label>
          <label class="bm-field">
            <span class="bm-field-label">Ollama host</span>
            <input class="bm-input" id="field-ollamaHost" value="${escapeAttr(s.ollamaHost)}" placeholder="http://localhost:11434" />
          </label>
          <label class="bm-field">
            <span class="bm-field-label">Python path</span>
            <input class="bm-input" id="field-pythonPath" value="${escapeAttr(s.pythonPath)}" placeholder="python3" />
          </label>
        </div>
        <div class="bo-toggle-row">
          <span class="bo-toggle-label">Theme</span>
          <div class="bm-theme-toggle" role="group" id="theme-toggle">
            ${THEME_CHOICES.map(
              (choice) =>
                `<button class="bm-theme-toggle-btn ${state.theme === choice.value ? "active" : ""}" data-theme-choice="${choice.value}" type="button">${choice.label}</button>`
            ).join("")}
          </div>
        </div>
        <div class="bo-toggle-row">
          <span class="bo-toggle-label">Start automatically when this machine logs in</span>
          <label class="bm-checkbox-label">
            <input type="checkbox" id="field-openAtLogin" ${s.openAtLogin ? "checked" : ""} />
          </label>
        </div>
      </div>

      <div class="bo-card">
        <div class="bo-card-label">Flagging</div>
        <div class="bo-toggle-label">Flags claim fields worth double-checking in BillOCR Review — see the README's "Flagging likely misreads" section.</div>
        <div class="bo-field-grid">
          <label class="bm-field">
            <span class="bm-field-label">Verification passes</span>
            <input class="bm-input" id="field-verificationPasses" type="number" min="1" max="10" value="${s.verificationPasses ?? 1}" placeholder="3" />
            <span class="bo-toggle-label">1 = off (single read). Higher catches more likely misreads but takes proportionally longer per image.</span>
          </label>
          <label class="bm-field">
            <span class="bm-field-label">Check-pass temperature</span>
            <input class="bm-input" id="field-checkPassTemperature" type="number" min="0" max="2" step="0.05" value="${s.checkPassTemperature ?? 0.5}" placeholder="0.5" />
            <span class="bo-toggle-label">How much a check pass is allowed to vary from the primary read. Higher = more disagreement flags, but noisier ones. No effect when Verification passes is 1.</span>
          </label>
        </div>
      </div>

      <div class="bo-card">
        <div class="bo-card-label">Log</div>
        <div class="bo-log" id="log-pane">${renderLogLines()}</div>
      </div>
    </div>
  `);

  page.querySelector("#start-stop-btn").addEventListener("click", onStartStopClick);
  page.querySelector("#choose-folder-btn").addEventListener("click", onChooseFolderClick);
  page.querySelector("#stop-model-btn").addEventListener("click", onStopModelClick);
  page.querySelectorAll("#theme-toggle [data-theme-choice]").forEach((btn) =>
    btn.addEventListener("click", () => setTheme(btn.dataset.themeChoice))
  );
  bindUpdateAction(page);

  const bindField = (id, key, transform, onSaved) => {
    const input = page.querySelector(id);
    input.addEventListener("change", async () => {
      const raw = input.type === "checkbox" ? input.checked : input.value;
      const value = transform ? transform(raw) : raw;
      const next = await window.api.setSettings({ [key]: value });
      state.settings = next; // update state before any onSaved side-effect renders, so it reflects the saved value, not the stale one
      if (onSaved) onSaved(value);
    });
  };
  bindField("#field-model", "model");
  bindField("#field-maxDim", "maxDim", (v) => (v ? Number(v) : null));
  bindField("#field-numCtx", "numCtx", (v) => (v ? Number(v) : null));
  bindField("#field-keepAlive", "keepAlive");
  bindField("#field-ollamaHost", "ollamaHost", null, (v) => checkOllama(v));
  bindField("#field-verificationPasses", "verificationPasses", (v) => Math.max(1, Number(v) || 1));
  bindField("#field-checkPassTemperature", "checkPassTemperature", (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, n) : 0.5;
  });
  bindField("#field-pythonPath", "pythonPath", null, (v) => checkPython(v));
  bindField("#field-openAtLogin", "openAtLogin");

  window.api.getAppVersion().then((v) => {
    const versionEl = page.querySelector("#app-version");
    if (versionEl) versionEl.textContent = `v${v}`;
  });

  return page;
}

// How long a file_done result (✓/✗) stays visible before the widget reverts
// to "Watching for new files…" -- long enough to actually read on a quick
// glance, short enough not to look stuck once the pipeline has moved on.
const DONE_FLASH_MS = 6000;
let doneFlashTimer = null;

function progressStageLabel(event) {
  return event.stage === "primary" ? "Reading" : "Re-checking";
}

// The Status card's live "what's it doing right now" indicator (see the
// state.progress/state.doneFlash doc comments) -- three states: a file_done
// result flashed briefly, an active pass (spinner + a determinate N-of-M
// progress bar, per user feedback asking for "a moving circle... or even
// better a full status bar"), or idle/watching. Returns innerHTML only
// (not a full element) so both renderPage()'s initial build and
// patchProgressWidget()'s incremental update below can share it without
// going through a full render() on every progress event -- see render()'s
// own comment on why a full rebuild every few seconds already has to fight
// to preserve scroll/focus, which a live event stream would make worse.
function renderProgressWidget() {
  if (!state.status.running) return "";
  if (state.doneFlash) {
    const f = state.doneFlash;
    if (f.ok) {
      const notes = [f.missing && "missing required fields", f.flagged && "flagged for review"].filter(Boolean);
      return `<div class="bo-progress-line bo-progress-done">${ICONS.check} Extracted <strong>${escapeHtml(f.file)}</strong>${notes.length ? ` — ${notes.join(", ")}` : ""}</div>`;
    }
    return `<div class="bo-progress-line bo-progress-failed">${ICONS.x} Failed on <strong>${escapeHtml(f.file)}</strong>: ${escapeHtml(f.error || "unknown error")}</div>`;
  }
  const p = state.progress;
  if (!p) {
    return `<div class="bo-progress-line bo-progress-idle"><span class="bo-progress-idle-dot"></span> Watching for new files…</div>`;
  }
  const pct = Math.round((p.pass / p.of) * 100);
  return `
    <div class="bo-progress-line">
      <span class="bo-spinner"></span>
      ${escapeHtml(progressStageLabel(p))} <strong>${escapeHtml(p.file)}</strong>${p.of > 1 ? ` — pass ${p.pass} of ${p.of}` : ""}
    </div>
    <div class="bo-progress-track"><div class="bo-progress-fill" style="width:${pct}%"></div></div>
  `;
}

// Patches just the progress widget's own subtree in place -- called from
// the pipeline:progress subscription (see init()) instead of the full
// render(), so a fast-arriving pass_start (a check pass can complete in a
// couple of seconds) never resets page scroll or interrupts whatever the
// user is mid-typing in a settings field the way a full rebuild would risk
// on every event.
function patchProgressWidget() {
  const el = document.getElementById("progress-widget");
  if (el) el.innerHTML = renderProgressWidget();
}

function onPipelineProgressEvent(event) {
  if (doneFlashTimer) {
    clearTimeout(doneFlashTimer);
    doneFlashTimer = null;
  }
  if (event.event === "file_done") {
    state.progress = null;
    state.doneFlash = event;
    doneFlashTimer = setTimeout(() => {
      state.doneFlash = null;
      doneFlashTimer = null;
      patchProgressWidget();
    }, DONE_FLASH_MS);
  } else {
    state.doneFlash = null;
    state.progress = event;
  }
  patchProgressWidget();
}

function renderLogLines() {
  if (state.logs.length === 0) return '<div class="bo-log-empty">No output yet. Start the pipeline to see log lines here.</div>';
  return state.logs
    .map((l) => `<div class="bo-log-line ${l.stream === "stderr" ? "stderr" : ""}">${escapeHtml(l.line)}</div>`)
    .join("");
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) {
  return escapeHtml(str ?? "");
}

async function onStartStopClick() {
  state.busy = true;
  render();
  if (state.status.running) {
    await window.api.pipelineStop();
  } else {
    state.startError = null;
    const result = await window.api.pipelineStart();
    if (!result.ok) state.startError = result.error;
  }
  await refreshStatus();
  state.busy = false;
  render();
}

async function onChooseFolderClick() {
  const folder = await window.api.chooseWorkspace();
  state.settings = await window.api.getSettings();
  render();
  if (folder) refreshPendingCount();
}

async function onStopModelClick() {
  state.stopModelStatus = "Stopping…";
  render();
  const settings = state.settings;
  const result = await window.api.stopModelNow(settings.ollamaHost, settings.model);
  state.stopModelStatus = result.ok ? `Unloaded ${settings.model}.` : `Couldn't stop it: ${result.error}`;
  render();
}

async function refreshStatus() {
  state.status = await window.api.pipelineStatus();
  // Reconcile with main.js's own record of the current pass (see
  // pipelineStatus()/lastProgress in main.js) -- catches a window that
  // (re)opened mid-processing and so missed the pipeline:progress push
  // that would otherwise be the only way to learn about it. Doesn't touch
  // doneFlash: that's a purely local, timed "✓/✗ just now" flash (see
  // onPipelineProgressEvent) with no equivalent on the main-process side.
  state.progress = state.status.progress;
}
async function refreshPendingCount() {
  state.pendingCount = await window.api.pendingCount();
}
async function checkPython(pythonPath) {
  state.pythonCheck = null;
  render();
  state.pythonCheck = await window.api.checkPython(pythonPath);
  render();
}
async function checkOllama(host) {
  state.ollamaCheck = null;
  render();
  state.ollamaCheck = await window.api.checkOllama(host);
  render();
}

// Whether the log pane should auto-follow new output -- true only while the
// user is actually scrolled to (or near) the bottom. Kept fresh by a
// "scroll" listener on the pane itself (see render() below), not just
// recomputed when a line happens to arrive: otherwise, scrolling up to read
// an old line and then *not* getting a new line before the next periodic
// render() (see its comment) would leave this at whatever it was last set
// to, and the full-page rebuild below would snap the reader back to the
// bottom out from under them even though nothing they did asked for that.
let logPaneScrollBottom = true;

function isLogPaneAtBottom(logPane) {
  return logPane.scrollTop + logPane.clientHeight >= logPane.scrollHeight - 4;
}

function render() {
  const app = document.getElementById("app");

  // This app re-renders periodically (see the 5s interval in init()) to
  // keep status dots/counts/log fresh, which tears down and rebuilds the
  // whole page every time -- without this, that reset .bo-page's scroll
  // to the top and yanked focus out of whatever field you were typing in,
  // every 5 seconds. Capture both before the rebuild, restore after.
  // Same problem for the log pane's own scroll position (see
  // logPaneScrollBottom above) -- captured here alongside the rest.
  const prevPage = document.querySelector(".bo-page");
  const prevScrollTop = prevPage ? prevPage.scrollTop : 0;
  const prevLogPane = document.getElementById("log-pane");
  const prevLogScrollTop = prevLogPane ? prevLogPane.scrollTop : 0;
  const active = document.activeElement;
  const focusId = active && active.id && app.contains(active) ? active.id : null;
  const selection =
    focusId && typeof active.selectionStart === "number" ? { start: active.selectionStart, end: active.selectionEnd } : null;

  app.innerHTML = "";
  const root = document.createDocumentFragment();
  root.appendChild(renderTitlebar());
  root.appendChild(renderPage());
  app.appendChild(root);

  const newPage = document.querySelector(".bo-page");
  if (newPage) newPage.scrollTop = prevScrollTop;

  if (focusId) {
    const restored = document.getElementById(focusId);
    if (restored) {
      restored.focus();
      if (selection && typeof restored.setSelectionRange === "function") {
        restored.setSelectionRange(selection.start, selection.end);
      }
    }
  }

  const logPane = document.getElementById("log-pane");
  if (logPane) {
    // Only jump to the bottom if the user was actually down there;
    // otherwise put the freshly-rebuilt pane back exactly where they'd
    // scrolled it, so reading (or screenshotting) an older line survives
    // this rebuild instead of being yanked away mid-read.
    logPane.scrollTop = logPaneScrollBottom ? logPane.scrollHeight : prevLogScrollTop;
    logPane.addEventListener("scroll", () => {
      logPaneScrollBottom = isLogPaneAtBottom(logPane);
    });
  }
}

function appendLogLine(entry) {
  state.logs.push(entry);
  if (state.logs.length > MAX_LOG_LINES) state.logs.splice(0, state.logs.length - MAX_LOG_LINES);
  const logPane = document.getElementById("log-pane");
  if (!logPane) return;
  const empty = logPane.querySelector(".bo-log-empty");
  if (empty) empty.remove();
  const lineEl = document.createElement("div");
  lineEl.className = `bo-log-line ${entry.stream === "stderr" ? "stderr" : ""}`;
  lineEl.textContent = entry.line;
  logPane.appendChild(lineEl);
  if (logPaneScrollBottom) logPane.scrollTop = logPane.scrollHeight;
}

(async function init() {
  state.settings = await window.api.getSettings();
  // Applied before the first render (and before any other await) so the
  // window paints in the right theme instead of flashing light-then-dark --
  // same ordering BillManager's own init() uses for the same reason.
  state.theme = state.settings.theme || "system";
  applyTheme(state.theme);
  // Keeps "System" in sync with the OS while the app stays open, not just at
  // launch -- e.g. macOS switching to Dark Mode at sunset. Guarded so it
  // never overrides an explicit Light/Dark/Midnight choice.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.theme === "system") applyTheme(state.theme);
  });
  await refreshStatus();
  render();

  checkPython(state.settings.pythonPath);
  checkOllama(state.settings.ollamaHost);
  refreshPendingCount();

  window.api.onUpdateStatus((status) => setUpdateStatus(status));
  checkForUpdates(); // not awaited -- a startup check shouldn't hold up the page

  window.api.onPipelineLog((entry) => appendLogLine(entry));
  window.api.onPipelineProgress((event) => onPipelineProgressEvent(event));
  window.api.onPipelineExited((info) => {
    // The process is gone -- any in-flight pass or "just finished" flash is
    // now stale (see onPipelineProgressEvent for the timer this clears).
    if (doneFlashTimer) {
      clearTimeout(doneFlashTimer);
      doneFlashTimer = null;
    }
    state.doneFlash = null;
    refreshStatus().then(() => {
      if (info.error) state.startError = info.error;
      else if (info.code !== 0 && info.code !== null) state.startError = `Pipeline exited unexpectedly (code ${info.code}). Check the log above.`;
      render();
    });
  });

  // Periodic light refresh -- keeps the window honest even if the tray
  // menu (a separate control surface for the same process) changed state.
  setInterval(async () => {
    await refreshStatus();
    await refreshPendingCount();
    render();
  }, 5000);
})();
