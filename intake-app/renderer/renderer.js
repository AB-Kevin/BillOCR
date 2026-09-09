// BillOCR Intake — renderer. Single vanilla-JS file, no framework: one
// `state` object, `render()` tears down and rebuilds #app from it, same
// pattern BillManager's renderer.js uses. This app has one job (run the
// extraction watcher), so it's a single page rather than a rail/sections.

const state = {
  settings: null,
  status: { running: false, pid: null, startedAt: null },
  pythonCheck: null, // {ok, version} | {ok:false, error} | null (checking)
  ollamaCheck: null,
  pendingCount: 0,
  logs: [], // {stream, line, ts}
  windowMaximized: false,
  startError: null,
  busy: false, // Start/Stop in flight
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
};

function renderTitlebar() {
  const bar = el(`
    <div class="bm-titlebar">
      <div class="bm-titlebar-brand"><span class="bm-titlebar-title">BillOCR Intake</span></div>
      <div class="bm-titlebar-controls">
        <button class="bm-titlebar-btn" id="win-minimize" title="Minimize">${ICONS.minimize}</button>
        <button class="bm-titlebar-btn" id="win-maximize" title="Maximize">${ICONS.maximize}</button>
        <button class="bm-titlebar-btn bm-titlebar-close" id="win-close" title="Close">${ICONS.close}</button>
      </div>
    </div>
  `);
  bar.querySelector("#win-minimize").addEventListener("click", () => window.api.windowMinimize());
  bar.querySelector("#win-maximize").addEventListener("click", () => window.api.windowMaximizeToggle());
  bar.querySelector("#win-close").addEventListener("click", () => window.api.windowClose());
  return bar;
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

function renderPage() {
  const s = state.settings || {};
  const running = state.status.running;

  const pythonInfo = describeCheck(state.pythonCheck, `Python ready (${state.pythonCheck?.version || ""})`, "Python not found");
  const ollamaInfo = describeCheck(state.ollamaCheck, "Ollama reachable", "Ollama unreachable");

  const page = el(`
    <div class="bo-page">
      <div class="bo-title-row">
        <div class="bo-title">BillOCR Intake</div>
        <div class="bo-version" id="app-version"></div>
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
        <div class="bo-toggle-label">This folder is shared over the network to the BillOCR Review app on the approval machine. It holds <code>incoming_1500/</code>, <code>incoming_ub04/</code> (drop scanned claim images here), and <code>pending_review/</code> (extracted claims waiting for review).</div>
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
            <span class="bm-field-label">Keep-alive</span>
            <input class="bm-input" id="field-keepAlive" value="${escapeAttr(s.keepAlive)}" placeholder="30m" />
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
          <span class="bo-toggle-label">Start automatically when this machine logs in</span>
          <label class="bm-checkbox-label">
            <input type="checkbox" id="field-openAtLogin" ${s.openAtLogin ? "checked" : ""} />
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
  bindField("#field-keepAlive", "keepAlive");
  bindField("#field-ollamaHost", "ollamaHost", null, (v) => checkOllama(v));
  bindField("#field-pythonPath", "pythonPath", null, (v) => checkPython(v));
  bindField("#field-openAtLogin", "openAtLogin");

  window.api.getAppVersion().then((v) => {
    const versionEl = page.querySelector("#app-version");
    if (versionEl) versionEl.textContent = `v${v}`;
  });

  return page;
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

async function refreshStatus() {
  state.status = await window.api.pipelineStatus();
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

let logPaneScrollBottom = true;

function render() {
  const app = document.getElementById("app");
  app.innerHTML = "";
  const root = document.createDocumentFragment();
  root.appendChild(renderTitlebar());
  root.appendChild(renderPage());
  app.appendChild(root);

  const logPane = document.getElementById("log-pane");
  if (logPane && logPaneScrollBottom) logPane.scrollTop = logPane.scrollHeight;
}

function appendLogLine(entry) {
  state.logs.push(entry);
  if (state.logs.length > MAX_LOG_LINES) state.logs.splice(0, state.logs.length - MAX_LOG_LINES);
  const logPane = document.getElementById("log-pane");
  if (!logPane) return;
  logPaneScrollBottom = logPane.scrollTop + logPane.clientHeight >= logPane.scrollHeight - 4;
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
  state.status = await window.api.pipelineStatus();
  render();

  checkPython(state.settings.pythonPath);
  checkOllama(state.settings.ollamaHost);
  refreshPendingCount();

  window.api.onPipelineLog((entry) => appendLogLine(entry));
  window.api.onPipelineExited((info) => {
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
