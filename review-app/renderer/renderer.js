// BillOCR Review — renderer. Single vanilla-JS file, same pattern as
// BillManager/Intake: one `state` object, `render()` tears down and
// rebuilds #app. Form inputs are uncontrolled (read from the DOM only on
// Save/Approve/navigate) rather than synced into state on every keystroke,
// so typing doesn't trigger a full-tree rebuild.

const DEFAULT_IMAGE_PANE_WIDTH = 480;
const MIN_IMAGE_PANE_WIDTH = 240;
const MIN_FORM_PANE_WIDTH = 280;

const state = {
  settings: null,
  schema: null, // {CMS1500:{fields,required}, UB04:{...}} | null
  view: "queue", // "queue" | "review" | "org" | "about" | "exports" | "approved" | "approved-detail"
  pendingList: [],
  counts: { pending: 0, approved: 0, output: 0 },
  selectedIndex: -1,
  currentClaim: null, // {record, imagePath, imageUrl} -- imagePath is a native OS path (openFolder), imageUrl a real file:// URL for <img src> (see main.js's claims-get)
  // Read-only counterpart to pendingList/currentClaim, for the "approved"
  // view (see renderApprovedListView/renderApprovedDetailView) -- the only
  // way to see what a claim's fields looked like at the moment it was
  // approved, short of opening approved/<claim_id>.json by hand.
  approvedList: [],
  currentApprovedClaim: null, // {record, imagePath, imageUrl} | null
  reviewError: null,
  saveStatus: null,
  busy: false,
  org: null,
  orgStatus: null,
  orgSeededNotice: false,
  workspaceCorrectedNotice: null,
  pythonCheck: null, // {ok, version} | {ok:false, error} | null (checking) -- irrelevant when usesBundledPipeline
  usesBundledPipeline: false, // true in a packaged build -- see main.js's PIPELINE_CLI_PATH
  exports: [], // [{name, size, mtimeMs}, ...] -- built .837/.txt files, see loadExports
  updateStatus: { state: "idle" }, // idle | checking | available | available-manual | downloading | downloaded | not-available | error
  theme: "system", // "system" | "light" | "dark" | "midnight" -- see applyTheme()/setTheme()/resolveTheme(); persisted in settings.json alongside pythonPath/workspaceFolder
};

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

// System/light/dark/midnight -- same .bm-theme-toggle widget as BillManager's
// Options modal, now with the same 4th "System" choice added there too
// (already reused elsewhere in this file for the org view's Test/Production
// switch, see renderOrgView). This app has no rail+modal settings surface
// like BillManager's, so the toggle instead lives in the org view's first
// settings group, alongside the other app-level (not per-org) preference,
// Python path -- see renderOrgView. Palette itself is styles.css's
// :root/[data-theme="dark"]/[data-theme="midnight"] blocks, already present
// byte-for-byte from the shared design system, just never wired up before.
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

// Applied before the first render() (see init()) so the window paints in
// the right theme instead of flashing light-then-dark. Takes the raw
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
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) {
  return escapeHtml(str ?? "");
}
function icon(inner, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
const ICONS = {
  minimize: icon('<line x1="5" y1="12" x2="19" y2="12"/>'),
  maximize: icon('<rect x="5" y="5" width="14" height="14" rx="1"/>'),
  close: icon('<line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/>'),
  inbox: icon('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
  settings: icon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  info: icon('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
  chevronLeft: icon('<polyline points="15 18 9 12 15 6"/>', 14),
  chevronRight: icon('<polyline points="9 18 15 12 9 6"/>', 14),
  folder: icon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>', 14),
  plus: icon('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', 12),
  remove: icon('<line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/>', 12),
};

// --- Titlebar --------------------------------------------------------------

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
      <div class="bm-titlebar-brand"><span class="bm-titlebar-title">BillOCR Review</span></div>
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

// ---- Updates ----
// The main process owns autoUpdater (against updateProvider.js's custom,
// Review-only feed -- see its own comment) and only reports status back
// over "update-status"; nothing here talks to GitHub directly. Same
// state-machine shape as BillManager's renderer.js.
//
// "not-available" is shown only briefly: after the startup auto-check
// confirms there's nothing new, sitting on "Up to date" forever would be a
// permanent, slightly odd fixture in the rail footer -- it reverts back to
// the plain "Check for updates" button on its own instead. Every other
// status (available/downloading/downloaded/error) is left as-is, since
// those need a person to actually do something about them.
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
  if (s.state === "checking") return `<span class="bm-rail-update-row">Checking for updates…</span>`;
  if (s.state === "available") return `<button class="bm-btn bm-btn-primary bm-btn-maroon bm-btn-sm bm-btn-block" id="update-download">Download update ${s.version}</button>`;
  if (s.state === "available-manual") return `<button class="bm-btn bm-btn-primary bm-btn-maroon bm-btn-sm bm-btn-block" id="update-manual">Get update ${s.version}</button>`;
  if (s.state === "downloading") return `<span class="bm-rail-update-row">Downloading… ${s.percent ?? 0}%</span>`;
  if (s.state === "downloaded") return `<button class="bm-btn bm-btn-reversed bm-btn-sm bm-btn-block" id="update-restart">Restart to install</button>`;
  if (s.state === "not-available") return `<span class="bm-rail-update-row bm-rail-update-clickable" id="update-recheck">Up to date</span>`;
  if (s.state === "error") return `<span class="bm-rail-update-row bm-rail-update-error bm-rail-update-clickable" id="update-recheck" title="${escapeAttr(s.message || "")}">Update check failed</span>`;
  return `<button class="bm-btn bm-btn-reversed bm-btn-sm bm-btn-block" id="update-check">Check for updates</button>`;
}

function bindUpdateAction(rail) {
  const checkBtn = rail.querySelector("#update-check");
  if (checkBtn) checkBtn.addEventListener("click", checkForUpdates);
  const downloadBtn = rail.querySelector("#update-download");
  if (downloadBtn) downloadBtn.addEventListener("click", downloadUpdate);
  const manualBtn = rail.querySelector("#update-manual");
  if (manualBtn) manualBtn.addEventListener("click", openReleasePage);
  const restartBtn = rail.querySelector("#update-restart");
  if (restartBtn) restartBtn.addEventListener("click", restartToInstall);
  const recheckBtn = rail.querySelector("#update-recheck");
  if (recheckBtn) recheckBtn.addEventListener("click", checkForUpdates);
}

// --- Rail --------------------------------------------------------------

function renderRail() {
  const items = [
    { id: "queue", label: "Review Queue", icon: ICONS.inbox, badge: state.counts.pending || null },
    { id: "org", label: "Organization Settings", icon: ICONS.settings },
    { id: "about", label: "About", icon: ICONS.info },
  ];
  const rail = el(`
    <div class="bm-rail">
      <div class="bm-rail-brand">
        <div class="bm-rail-title">BillOCR</div>
        <div class="bm-rail-sub">Review</div>
      </div>
      <div class="bm-rail-scroll">
        <div class="bm-choose-folder-wrap">
          <button class="bm-btn bm-btn-reversed bm-btn-block bm-btn-sm" id="choose-folder-btn">${ICONS.folder} ${state.settings?.workspaceFolder ? "Change workspace" : "Choose workspace"}</button>
          <div class="bm-rail-path-row"><div class="bm-rail-path">${state.settings?.workspaceFolder ? escapeHtml(state.settings.workspaceFolder) : "No workspace chosen"}</div></div>
          <div class="bm-rail-hint">Pick the same folder BillOCR Intake writes to (the one <em>containing</em> pending_review/, not pending_review itself).</div>
        </div>
        <div class="bm-rail-label-row"><span class="bm-rail-label">Navigate</span></div>
        <div class="bm-folder-nav-list">
          ${items
            .map(
              (it) => `
            <div class="bm-nav-item ${state.view === it.id || (it.id === "queue" && state.view === "review") ? "active" : ""}" data-view="${it.id}">
              <span class="bm-nav-name">${it.icon}<span class="bm-nav-name-text">${it.label}</span></span>
              ${it.badge ? `<span class="bm-nav-count">${it.badge}</span>` : ""}
            </div>`
            )
            .join("")}
        </div>
      </div>
      <div class="bm-rail-footer">
        <div class="bm-rail-footer-row bm-rail-footer-link ${state.view === "approved" || state.view === "approved-detail" ? "active" : ""}" data-view="approved" title="See what a claim's fields looked like when it was approved">
          <span>Approved</span><span>${state.counts.approved}</span>
        </div>
        <div class="bm-rail-footer-row bm-rail-footer-link ${state.view === "exports" ? "active" : ""}" data-view="exports" title="View built .837 files">
          <span>Built .txt</span><span>${state.counts.output}</span>
        </div>
        ${renderUpdateAction()}
      </div>
    </div>
  `);
  rail.querySelectorAll("[data-view]").forEach((node) => {
    node.addEventListener("click", () => switchView(node.getAttribute("data-view")));
  });
  rail.querySelector("#choose-folder-btn").addEventListener("click", onChooseWorkspace);
  bindUpdateAction(rail);
  return rail;
}

async function switchView(view) {
  if (state.view === "review") await flushAutosave();
  state.view = view;
  if (view === "queue") await loadQueue();
  if (view === "org") await loadOrg();
  if (view === "exports") await loadExports();
  if (view === "approved") await loadApproved();
  render();
}

// --- Queue view ----------------------------------------------------------

function claimBadges(summary) {
  const missingCount = (summary.missing_required_fields || []).length;
  const flaggedCount = summary.flagged_count || 0;
  const badges = [];
  badges.push(
    missingCount === 0
      ? `<span class="rv-badge rv-badge-ok">Ready</span>`
      : `<span class="rv-badge rv-badge-missing">${missingCount} missing</span>`
  );
  if (flaggedCount > 0) badges.push(`<span class="rv-badge rv-badge-flagged">${flaggedCount} flagged</span>`);
  return badges.join(" ");
}

function renderQueueView() {
  if (!state.settings?.workspaceFolder) return renderNoWorkspace();
  if (state.pendingList.length === 0) {
    return el(`
      <div class="rv-main">
        <div class="rv-main-header"><div class="rv-main-title">Review Queue</div></div>
        ${state.workspaceCorrectedNotice ? `<div class="rv-review-warning">${escapeHtml(state.workspaceCorrectedNotice)}</div>` : ""}
        ${schemaWarningBanner()}
        <div class="rv-empty">
          <div class="rv-empty-title">Nothing waiting for review</div>
          <div>New claims extracted by BillOCR Intake will show up here.</div>
        </div>
      </div>
    `);
  }
  const main = el(`
    <div class="rv-main">
      <div class="rv-main-header">
        <div class="rv-main-title">Review Queue</div>
        <div class="rv-main-sub">${state.pendingList.length} pending</div>
      </div>
      ${state.workspaceCorrectedNotice ? `<div class="rv-review-warning">${escapeHtml(state.workspaceCorrectedNotice)}</div>` : ""}
      ${schemaWarningBanner()}
      <div class="rv-queue-list">
        ${state.pendingList
          .map(
            (c, i) => `
          <div class="rv-claim-row" data-index="${i}">
            <div class="rv-claim-name">${escapeHtml(c.patient_name || c.claim_id)}</div>
            <div class="rv-claim-meta">${escapeHtml(c.form_type)}</div>
            <div class="rv-claim-charge">${c.total_charge != null ? "$" + c.total_charge : "—"}</div>
            <div class="rv-claim-badges">${claimBadges(c)}</div>
            <div class="rv-claim-meta">${escapeHtml(c.extracted_at || "")}</div>
          </div>`
          )
          .join("")}
      </div>
    </div>
  `);
  main.querySelectorAll("[data-index]").forEach((row) => {
    row.addEventListener("click", () => openClaim(Number(row.getAttribute("data-index"))));
  });
  return main;
}

function renderNoWorkspace() {
  return el(`
    <div class="rv-main">
      <div class="rv-empty">
        <div class="rv-empty-title">No workspace chosen</div>
        <div>Choose the shared network folder BillOCR Intake writes claims into (top-left).</div>
      </div>
    </div>
  `);
}

async function onChooseWorkspace() {
  const result = await window.api.chooseWorkspace();
  state.settings = await window.api.getSettings();
  if (result.orgSeeded) state.orgSeededNotice = true;
  state.workspaceCorrectedNotice = result.correctedFrom
    ? `You picked "${result.correctedFrom}" — using its parent folder as the workspace instead, since that's the one containing pending_review/, approved/, etc.`
    : null;
  await loadQueue();
  render();
}

async function loadQueue() {
  if (!state.settings?.workspaceFolder) {
    state.pendingList = [];
    state.counts = { pending: 0, approved: 0, output: 0 };
    return;
  }
  state.pendingList = await window.api.listPendingClaims();
  state.counts = await window.api.getClaimCounts();
}

// --- Approved view (read-only) ---------------------------------------------
// The only way to see what a claim's fields actually looked like at the
// moment it was approved -- approved/<claim_id>.json is an exact, untouched
// copy of what saveClaim() wrote from the reviewer's on-screen fields right
// before building (see main.js's claims-approve/moveClaimFiles), but
// nothing in this app surfaced it anywhere before this. Deliberately a
// separate, simpler set of render functions rather than reusing
// renderReviewView's editable form -- there's nothing to edit, save,
// autosave, dismiss a flag on, or add/remove a line from here, and forcing
// all of that machinery into a disabled state would be a lot of surface
// area for what's really just a read-only field dump next to the image.

async function loadApproved() {
  if (!state.settings?.workspaceFolder) {
    state.approvedList = [];
    return;
  }
  state.approvedList = await window.api.listApprovedClaims();
}

function renderApprovedListView() {
  if (!state.settings?.workspaceFolder) return renderNoWorkspace();
  if (state.approvedList.length === 0) {
    return el(`
      <div class="rv-main">
        <div class="rv-main-header"><div class="rv-main-title">Approved</div></div>
        <div class="rv-empty">
          <div class="rv-empty-title">Nothing approved yet</div>
          <div>Claims you approve show up here, exactly as they looked the moment you approved them.</div>
        </div>
      </div>
    `);
  }
  const main = el(`
    <div class="rv-main">
      <div class="rv-main-header">
        <div class="rv-main-title">Approved</div>
        <div class="rv-main-sub">${state.approvedList.length} claim${state.approvedList.length === 1 ? "" : "s"}</div>
      </div>
      <div class="rv-queue-list">
        ${state.approvedList
          .map(
            (c, i) => `
          <div class="rv-claim-row" data-index="${i}">
            <div class="rv-claim-name">${escapeHtml(c.patient_name || c.claim_id)}</div>
            <div class="rv-claim-meta">${escapeHtml(c.form_type)}</div>
            <div class="rv-claim-charge">${c.total_charge != null ? "$" + c.total_charge : "—"}</div>
            <div class="rv-claim-badges">${claimBadges(c)}</div>
            <div class="rv-claim-meta">${escapeHtml(c.approved_at || c.extracted_at || "")}</div>
          </div>`
          )
          .join("")}
      </div>
    </div>
  `);
  main.querySelectorAll("[data-index]").forEach((row) => {
    row.addEventListener("click", () => openApprovedClaim(Number(row.getAttribute("data-index"))));
  });
  return main;
}

async function openApprovedClaim(index) {
  const summary = state.approvedList[index];
  if (!summary) return;
  const result = await window.api.getApprovedClaim(summary.claim_id);
  state.currentApprovedClaim = result;
  state.selectedIndex = index;
  state.view = "approved-detail";
  render();
}

// Turns one field's raw JSON value into a plain, read-only display string --
// no inputs, no editing. Object-array (line-item) fields are expanded one
// line per row using their own *_ARRAY_ITEMS sub-field labels -- the same
// labels the editable line-item editor uses (see objectArrayItemHtml) -- so
// a service_lines entry reads the same way here as it did on the review
// screen that approved it, just as plain text instead of inputs.
function formatApprovedValue(formType, key, value) {
  if (value == null || value === "") return "—";
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    const spec = objectArrayItemSpec(formType, key);
    if (!spec) return escapeHtml(value.join(", "));
    return value
      .map((item, i) => {
        const subfieldsHtml = Object.entries(spec.item_fields)
          .map(([subKey, label]) => {
            const v = item?.[subKey];
            const shown = Array.isArray(v) ? v.join(", ") || "—" : v == null || v === "" ? "—" : String(v);
            return `<div class="rv-approved-subfield"><span class="rv-approved-subfield-label">${escapeHtml(label)}</span> ${escapeHtml(shown)}</div>`;
          })
          .join("");
        return `<div class="rv-approved-line"><div class="rv-approved-line-head">Line ${i + 1}</div>${subfieldsHtml}</div>`;
      })
      .join("");
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return escapeHtml(String(value));
}

function renderApprovedDetailView() {
  const { record, imagePath, imageUrl } = state.currentApprovedClaim;
  const fieldSpecs = state.schema?.[record.form_type]?.fields || {};
  const fields = record.fields || {};
  const flagged = record.flagged_fields || {};
  const missing = new Set(record.missing_required_fields || []);

  const rows = Object.keys(fieldSpecs)
    .filter((key) => key !== "form_type")
    .map((key) => {
      const desc = fieldSpecs[key];
      const flagEntries = flagged[key] || [];
      return `
        <div class="bm-field rv-field ${missing.has(key) ? "missing" : ""} ${flagEntries.length ? "flagged" : ""}">
          <span class="bm-field-label">${escapeHtml(key)}${missing.has(key) ? " — was missing at approval" : ""}</span>
          <div class="rv-approved-value">${formatApprovedValue(record.form_type, key, fields[key])}</div>
          <span class="rv-field-hint">${escapeHtml(desc)}</span>
          ${flagEntries.length ? `<span class="rv-field-flag-reason">⚠ ${flagEntries.map((e) => escapeHtml(e.reason)).join("; ")} (was flagged at approval)</span>` : ""}
        </div>`;
    })
    .join("");

  const main = el(`
    <div class="rv-main">
      <div class="rv-review">
        <div class="rv-review-topbar">
          <button class="bm-btn bm-btn-ghost bm-btn-sm" id="back-to-approved">${ICONS.chevronLeft} Approved</button>
          <span class="rv-review-counter">${state.selectedIndex + 1} of ${state.approvedList.length}</span>
          <div class="rv-review-nav">
            <button class="bm-btn bm-btn-secondary bm-btn-sm" id="prev-approved" ${state.selectedIndex <= 0 ? "disabled" : ""}>${ICONS.chevronLeft}</button>
            <button class="bm-btn bm-btn-secondary bm-btn-sm" id="next-approved" ${state.selectedIndex >= state.approvedList.length - 1 ? "disabled" : ""}>${ICONS.chevronRight}</button>
          </div>
        </div>
        <div class="rv-review-warning">Read-only — this is exactly what was approved${record.approved_at ? ` on ${escapeHtml(record.approved_at)}` : ""}.</div>
        <div class="rv-review-layout" id="review-layout">
          <div class="rv-review-image-pane" id="image-pane" style="width: ${state.settings?.imagePaneWidth || DEFAULT_IMAGE_PANE_WIDTH}px">
            ${
              imageUrl
                ? `<img id="claim-image" src="${escapeAttr(imageUrl)}" alt="Source scan" draggable="false" />
                   <div class="rv-zoom-controls">
                     <button class="rv-zoom-btn" id="zoom-out" title="Zoom out">&minus;</button>
                     <button class="rv-zoom-btn rv-zoom-label" id="zoom-reset" title="Reset to fit">Fit</button>
                     <button class="rv-zoom-btn" id="zoom-in" title="Zoom in">+</button>
                     <button class="rv-zoom-btn" id="open-image" title="Open image file">${ICONS.folder}</button>
                   </div>`
                : "<span>No image</span>"
            }
          </div>
          <div class="rv-resize-handle" id="resize-handle" title="Drag to resize"></div>
          <div class="rv-review-form-pane">${rows}</div>
        </div>
      </div>
    </div>
  `);
  main.querySelector("#back-to-approved").addEventListener("click", () => switchView("approved"));
  main.querySelector("#prev-approved").addEventListener("click", () => openApprovedClaim(state.selectedIndex - 1));
  main.querySelector("#next-approved").addEventListener("click", () => openApprovedClaim(state.selectedIndex + 1));
  // Same handle/persisted width and the same zoom/pan (see wireResizeHandle/
  // wireImagePane) as the editable review screen -- one remembered pane
  // split and per-claim zoom state across both, not a separate one just for
  // this read-only view. Nothing about zoom/pan writes to the claim itself
  // (it only ever touches persistedZoomState + the <img>'s own inline
  // style), so reusing it here doesn't compromise "read-only."
  wireResizeHandle(main);
  wireImagePane(main, imagePath, record.claim_id);
  return main;
}

// --- Review view -----------------------------------------------------------

// From dump_schema.py's "arrays" list (claim_schemas.py's
// *_STRING_ARRAY_FIELDS + *_ARRAY_ITEMS' own keys combined), not sniffed
// from the field's description text -- this used to be a `/JSON array/i`
// regex against the description, which broke the moment ARRAY_REVIEW_HINTS
// started rewording service_lines/revenue_lines/etc.'s description to no
// longer say "JSON array" (see claim_schemas.py's own isBooleanField-
// adjacent comment: the exact same failure mode already happened once for
// booleans, which is why THAT one stopped sniffing text long ago).
function isArrayField(formType, key) {
  return !!state.schema?.[formType]?.arrays?.includes(key);
}

// Which fields are booleans -- from dump_schema.py's "booleans" list
// (see claim_schemas.py's *_BOOLEAN_FIELDS), not sniffed from the
// description text. dump_schema.py rewrites a boolean field's description
// for Review into something that describes the form rather than JSON
// true/false (see its BOOLEAN_REVIEW_HINTS), so detecting "is this a
// boolean field" from that same text would silently break the moment the
// wording changed -- which is exactly what happened the first time this
// was a regex on "true if...else false".
function isBooleanField(formType, key) {
  return !!state.schema?.[formType]?.booleans?.includes(key);
}

// Per-field toggle options, in the exact left-to-right order to render
// them. ssn_box_checked/ein_box_checked are each a literal checkbox
// observation on the form (see claim_schemas.py -- deliberately two
// independent fields rather than one is-it-an-SSN boolean, so a claim
// where the form itself is ambiguous -- both checked, or neither -- can
// be flagged instead of silently forced into a single answer), so
// "Checked"/"Unchecked" reads better than generic True/False. Falls back
// to a generic False/True pair for any boolean field not listed here.
const CHECKBOX_OPTIONS = [
  { value: false, label: "Unchecked" },
  { value: true, label: "Checked" },
];
const BOOLEAN_FIELD_OPTIONS = {
  ssn_box_checked: CHECKBOX_OPTIONS,
  ein_box_checked: CHECKBOX_OPTIONS,
};
// Yes first, then No -- matches the form itself, which prints every real
// yes/no box (Box 20's outside lab, Box 27's accept assignment, etc. -- see
// claim_schemas.py's *_BOOLEAN_FIELDS descriptions) with YES to the left of
// NO, and labels them that way rather than generic True/False.
const DEFAULT_BOOLEAN_OPTIONS = [
  { value: true, label: "Yes" },
  { value: false, label: "No" },
];

// --- Array field editors -----------------------------------------------
// diagnosis_codes/other_diagnosis_codes/condition_codes (arrays of plain
// strings) and service_lines/revenue_lines/value_codes (arrays of line-item
// objects) used to all render as one JSON-array-in-a-textarea, which made
// hand-checking a value against the source image (or just eyeballing
// whether a line looks right) much harder than every other field on the
// form. These render an actual add/remove list instead -- one plain input
// per string, one small fieldset of labeled inputs per line item -- built
// from claim_schemas.py's array_items metadata (see dump_schema.py) so
// there's no separate JS copy of which line-item fields exist.
//
// Rows are plain, uncontrolled inputs exactly like every other field (see
// file header) -- only structural changes (add/remove a row) touch the DOM
// directly (see wireArrayEditors), never a full render(), so editing one
// field never disturbs unsaved edits anywhere else on the form.

function objectArrayItemSpec(formType, key) {
  return state.schema?.[formType]?.array_items?.[key] || null;
}

function stringArrayRowHtml(value) {
  // tabindex="-1" on the remove button (and every other non-text control in
  // the form -- see the same on the boolean toggles/add buttons/flag
  // actions below) keeps it clickable but out of the Tab order, so tabbing
  // through a list of these rows lands on each row's actual value, not on
  // "value, remove, value, remove, ...".
  return `<div class="rv-array-row" data-array-row>
    <input class="bm-input" data-array-value value="${escapeAttr(value ?? "")}" />
    <button class="rv-array-remove-btn" data-array-remove type="button" tabindex="-1" title="Remove">${ICONS.remove}</button>
  </div>`;
}

function nestedArrayChipHtml(value) {
  return `<span class="rv-nested-chip" data-nested-row>
    <input class="rv-nested-input" data-nested-value value="${escapeAttr(value ?? "")}" />
    <button class="rv-nested-remove-btn" data-nested-remove type="button" tabindex="-1" title="Remove">${ICONS.remove}</button>
  </span>`;
}

// itemFlags: {subKey: [flagEntry, ...]} for THIS item only (see
// itemFlagsFor) -- a validation/disagreement problem on one line no longer
// paints the whole service_lines/revenue_lines editor amber (see
// field_validation.py and collect_disagreement_flags's "key[index].subKey"
// flag keys); it's pinpointed to the one input that's actually wrong, with
// its own reason text right under it. A brand-new line from "+ Add line"
// has no flags yet, so this is omitted there.
function objectArrayItemHtml(spec, item, itemFlags, arrayKey, index) {
  item = item && typeof item === "object" && !Array.isArray(item) ? item : {};
  itemFlags = itemFlags || {};
  const arraySubfields = spec.array_subfields || [];
  const booleanSubfields = spec.boolean_subfields || [];
  let anyFieldFlagged = false;
  const fieldsHtml = Object.entries(spec.item_fields)
    .map(([subKey, label]) => {
      const flagEntries = itemFlags[subKey];
      const flagClass = flagEntries ? "flagged" : "";
      if (flagEntries) anyFieldFlagged = true;
      const flagHtml = flagEntries
        ? `<span class="rv-line-item-flag-reason">${flagReasonHtml(`${arrayKey}[${index}].${subKey}`, flagEntries)}</span>${flagActionsHtml(
            `${arrayKey}[${index}].${subKey}`,
            flagEntries
          )}`
        : "";
      if (arraySubfields.includes(subKey)) {
        const values = Array.isArray(item[subKey]) ? item[subKey] : [];
        return `<div class="rv-line-item-field rv-line-item-field-array ${flagClass}">
          <span class="rv-line-item-label">${escapeHtml(label)}</span>
          <div class="rv-nested-array" data-nested-array data-nested-key="${escapeAttr(subKey)}">
            <div class="rv-nested-rows">${values.map(nestedArrayChipHtml).join("")}</div>
            <button class="rv-nested-add-btn" data-nested-add type="button" tabindex="-1" title="Add">${ICONS.plus}</button>
          </div>
          ${flagHtml}
        </div>`;
      }
      if (booleanSubfields.includes(subKey)) {
        // Same real-boolean toggle as top-level fields (see isBooleanField/
        // wireBooleanToggles) -- a per-line checkbox like box 24C's EMG
        // indicator is genuinely rare (per user feedback, "not usually
        // filled, but the option is important"), so it still deserves an
        // actual Yes/No control rather than a free-text "true"/"false" box.
        const v = item[subKey];
        const options = BOOLEAN_FIELD_OPTIONS[subKey] || DEFAULT_BOOLEAN_OPTIONS;
        const buttonsHtml = options
          .map(
            (opt) =>
              `<button class="bm-theme-toggle-btn ${v === opt.value ? "active" : ""}" data-bool-set="${opt.value}" type="button" tabindex="-1">${escapeHtml(opt.label)}</button>`
          )
          .join("");
        return `<div class="rv-line-item-field ${flagClass}">
          <span class="rv-line-item-label">${escapeHtml(label)}</span>
          <div class="bm-theme-toggle" data-item-key="${escapeAttr(subKey)}" data-bool-toggle data-value="${v === true ? "true" : "false"}">
            ${buttonsHtml}
          </div>
          ${flagHtml}
        </div>`;
      }
      const v = item[subKey];
      return `<div class="rv-line-item-field ${flagClass}">
        <span class="rv-line-item-label">${escapeHtml(label)}</span>
        <input class="bm-input" data-item-key="${escapeAttr(subKey)}" data-focus-key="${escapeAttr(`${arrayKey}[${index}].${subKey}`)}" value="${escapeAttr(v == null ? "" : v)}" />
        ${flagHtml}
      </div>`;
    })
    .join("");
  return `<div class="rv-line-item ${anyFieldFlagged ? "flagged" : ""}" data-array-row>
    <div class="rv-line-item-fields">${fieldsHtml}</div>
    <button class="rv-array-remove-btn rv-line-item-remove-btn" data-array-remove type="button" tabindex="-1" title="Remove line">${ICONS.remove}</button>
  </div>`;
}

// Pulls out just one line item's own flags from the full flagged_fields
// dict, keyed "arrayKey[index].subKey" (see field_validation.py), as
// {subKey: [flagEntry, ...]} for objectArrayItemHtml to render inline.
function itemFlagsFor(flagged, arrayKey, index) {
  const prefix = `${arrayKey}[${index}].`;
  const out = {};
  for (const [flagKey, entries] of Object.entries(flagged || {})) {
    if (flagKey.startsWith(prefix)) out[flagKey.slice(prefix.length)] = entries;
  }
  return out;
}

function renderArrayField(formType, key, value, flagged) {
  const items = Array.isArray(value) ? value : [];
  const spec = objectArrayItemSpec(formType, key);
  const kind = spec ? "object" : "string";
  const rowsHtml = spec
    ? items.map((item, i) => objectArrayItemHtml(spec, item, itemFlagsFor(flagged, key, i), key, i)).join("")
    : items.map((v) => stringArrayRowHtml(typeof v === "string" ? v : String(v ?? ""))).join("");
  const addLabel = spec ? "Add line" : "Add";
  return `<div class="rv-array-editor" id="field-${key}" data-array-field data-array-kind="${kind}">
    <div class="rv-array-rows">${rowsHtml}</div>
    <button class="bm-btn bm-btn-secondary bm-btn-sm rv-array-add-btn" data-array-add type="button" tabindex="-1">${ICONS.plus} ${addLabel}</button>
  </div>`;
}

// Wires every array editor's add/remove buttons with direct DOM
// manipulation (append/remove one row, no render()) -- same reasoning as
// wireBooleanToggles: an add/remove click shouldn't blow away whatever the
// reviewer is mid-typing in every other field on the form.
function wireArrayEditors(root, formType) {
  root.querySelectorAll("[data-array-field]").forEach((container) => {
    const key = container.id.replace(/^field-/, "");
    const kind = container.dataset.arrayKind;
    const rowsEl = container.querySelector(":scope > .rv-array-rows");
    const addBtn = container.querySelector(":scope > [data-array-add]");

    const wireRow = (row) => {
      const removeBtn = row.querySelector(":scope > [data-array-remove]");
      if (removeBtn)
        removeBtn.addEventListener("click", () => {
          row.remove();
          scheduleAutosave(0);
        });
      if (kind === "object") wireNestedArrays(row);
    };
    // Rows already in the initial render's HTML are covered by the
    // page-wide wireBooleanToggles(main) call this same render already
    // makes (see renderReviewView) -- only a brand-new row from "+ Add
    // line" below needs its own boolean-toggle wiring, since it didn't
    // exist yet when that page-wide pass ran.
    rowsEl.querySelectorAll(":scope > [data-array-row]").forEach(wireRow);

    addBtn.addEventListener("click", () => {
      const rowHtml =
        kind === "object"
          ? objectArrayItemHtml(objectArrayItemSpec(formType, key) || { item_fields: {} }, {}, {}, key, rowsEl.children.length)
          : stringArrayRowHtml("");
      const row = el(rowHtml);
      rowsEl.appendChild(row);
      wireRow(row);
      if (kind === "object") wireBooleanToggles(row); // per-line boolean subfields (see objectArrayItemHtml) -- same widget as top-level fields
      // A brand-new row has no values yet -- nothing meaningful to save
      // until its inputs are filled in and blurred/paused-on, so this is
      // really just to make missing_required_fields/flags reflect the new
      // (empty) row's presence right away rather than only after the
      // first keystroke in it.
      scheduleAutosave(0);
    });
  });
}

function wireNestedArrays(row) {
  row.querySelectorAll("[data-nested-array]").forEach((nested) => {
    const rowsEl = nested.querySelector(".rv-nested-rows");
    const addBtn = nested.querySelector(":scope > [data-nested-add]");

    const wireChip = (chip) => {
      const removeBtn = chip.querySelector("[data-nested-remove]");
      if (removeBtn)
        removeBtn.addEventListener("click", () => {
          chip.remove();
          scheduleAutosave(0);
        });
    };
    rowsEl.querySelectorAll(":scope > [data-nested-row]").forEach(wireChip);

    addBtn.addEventListener("click", () => {
      const chip = el(nestedArrayChipHtml(""));
      rowsEl.appendChild(chip);
      wireChip(chip);
      scheduleAutosave(0);
    });
  });
}

// Reads one array field's current DOM state back into the JSON shape
// extract_claim_fields.py/build_837.py expect. String-array rows left
// blank are dropped (an empty row means "no value entered", not a literal
// empty-string code); object-array rows are always kept even if partially
// filled -- field_validation.py's per-line checks are already all
// conditional on a sub-field being present, so a sparse line item is not a
// new failure mode.
function readArrayField(formType, key, container) {
  const kind = container.dataset.arrayKind;
  const rows = Array.from(container.querySelectorAll(":scope > .rv-array-rows > [data-array-row]"));
  if (kind !== "object") {
    return rows
      .map((row) => row.querySelector("[data-array-value]")?.value ?? "")
      .map((v) => v.trim())
      .filter((v) => v !== "");
  }
  const spec = objectArrayItemSpec(formType, key) || { item_fields: {}, array_subfields: [], numeric_subfields: [], boolean_subfields: [] };
  const arraySubfields = spec.array_subfields || [];
  const numericSubfields = spec.numeric_subfields || [];
  const booleanSubfields = spec.boolean_subfields || [];
  return rows.map((row) => {
    const item = {};
    for (const subKey of Object.keys(spec.item_fields)) {
      if (arraySubfields.includes(subKey)) {
        const nested = row.querySelector(`[data-nested-array][data-nested-key="${subKey}"]`);
        const chips = nested ? Array.from(nested.querySelectorAll("[data-nested-value]")) : [];
        item[subKey] = chips.map((c) => c.value.trim()).filter((v) => v !== "");
        continue;
      }
      if (booleanSubfields.includes(subKey)) {
        // A real boolean read from data-value, not a text input -- same
        // reasoning as readFormFields()'s top-level isBooleanField branch.
        const toggle = row.querySelector(`[data-item-key="${subKey}"][data-bool-toggle]`);
        item[subKey] = toggle?.dataset.value === "true";
        continue;
      }
      const input = row.querySelector(`[data-item-key="${subKey}"]`);
      const raw = (input?.value ?? "").trim();
      if (raw === "") {
        item[subKey] = null;
      } else if (numericSubfields.includes(subKey)) {
        const n = Number(raw);
        item[subKey] = Number.isNaN(n) ? raw : n;
      } else {
        item[subKey] = raw;
      }
    }
    return item;
  });
}

// --- Flag actions --------------------------------------------------------
// Turns a field's flag reasons into three ways to resolve it (see main.js's
// claims-dismiss-flag and saveClaim's dismissKey handling for the backend
// half of this):
//   1. "Approve current value" -- dismisses the flag(s) as-is, no edit.
//   2. Click the alternate value itself, linked inline within the reason
//      text (see flagReasonHtml) -- one per disagreement entry that
//      carries a structured alternate value (see extract_claim_fields.py's
//      collect_disagreement_flags) -- fills the field in, same as typing
//      it by hand.
//   3. Manually enter a value -- no dedicated control; the field is already
//      a normal editable input right above these actions.
// Options 2 and 3 clear the flag the same way any manual edit already does
// (on the next Save, via saveClaim's changed-value check) -- only option 1
// needs its own round-trip, since it isn't a value edit at all.
const FLAG_KEY_ITEM_RE = /^([^[]+)\[(\d+)\]\.(.+)$/;

// Formats a flag's raw value (a string/number/bool/array/null) as short,
// readable text -- shared by the ⚠ reason line below and nowhere else,
// since it's specifically about presenting one of these values inline.
function formatFlagValue(value) {
  if (value == null || value === "") return "(blank)";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "(blank)";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

// The ⚠ reason text -- built from structured fields (pass/value/
// primary_value), not extract_claim_fields.py's own "reason" prose,
// specifically so ONLY the alternate value itself is the link, not the
// whole sentence (the underline then reads as "this is what it'd become"
// rather than an undifferentiated wall of clickable text). A validation
// entry (no alternate value to offer) or a legacy disagreement entry from
// before "value"/"pass" existed on disk falls back to the plain reason
// text unchanged.
function flagReasonHtml(key, entries) {
  if (!entries || entries.length === 0) return "";
  const parts = entries.map((e) => {
    if (e.type === "disagreement" && e.value !== undefined) {
      const link = `<button type="button" class="rv-flag-reason-link" data-flag-use="${escapeAttr(
        key
      )}" data-flag-value="${escapeAttr(JSON.stringify(e.value))}" tabindex="-1">${escapeHtml(formatFlagValue(e.value))}</button>`;
      const wasText = e.primary_value !== undefined ? escapeHtml(formatFlagValue(e.primary_value)) : "the current value";
      return `pass ${e.pass} read ${link} instead of ${wasText}`;
    }
    return escapeHtml(e.reason);
  });
  return `⚠ ${parts.join("; ")}`;
}

function flagActionsHtml(key, entries) {
  if (!entries || entries.length === 0) return "";
  return `
    <div class="rv-flag-actions">
      <button type="button" class="rv-flag-action rv-flag-approve" data-flag-approve="${escapeAttr(key)}" tabindex="-1">Approve current value</button>
    </div>`;
}

// Applies an alternate value to whatever input represents `key` -- a plain
// field, a boolean toggle, a whole string-array field, or one line item's
// sub-field/nested-array (see readArrayField/wireArrayEditors for the same
// DOM shape read back on Save). Exactly like typing the value in by hand:
// doesn't touch flagged_fields itself, doesn't save.
function setFieldValue(key, value) {
  const m = FLAG_KEY_ITEM_RE.exec(key);
  if (m) {
    setLineItemValue(m[1], Number(m[2]), m[3], value);
    return;
  }
  const node = document.getElementById(`field-${key}`);
  if (!node) return;
  if (node.dataset.boolToggle !== undefined) {
    const strVal = value === true || value === "true" ? "true" : "false";
    node.dataset.value = strVal;
    node.querySelectorAll("[data-bool-set]").forEach((b) => b.classList.toggle("active", b.dataset.boolSet === strVal));
    return;
  }
  if (node.dataset.arrayField !== undefined) {
    // Whole-array disagreement -- only possible for plain string arrays
    // (diagnosis_codes, etc.); object arrays (service_lines, ...) are
    // always compared line-by-line, so their flags are always the
    // per-line-item case above instead. See collect_disagreement_flags.
    const rowsEl = node.querySelector(":scope > .rv-array-rows");
    rowsEl.innerHTML = "";
    (Array.isArray(value) ? value : []).forEach((v) => {
      const row = el(stringArrayRowHtml(typeof v === "string" ? v : String(v ?? "")));
      rowsEl.appendChild(row);
      row.querySelector("[data-array-remove]")?.addEventListener("click", () => row.remove());
    });
    return;
  }
  node.value = value == null ? "" : String(value);
}

function setLineItemValue(arrayKey, index, subKey, value) {
  const container = document.getElementById(`field-${arrayKey}`);
  if (!container) return;
  const row = container.querySelectorAll(":scope > .rv-array-rows > [data-array-row]")[index];
  if (!row) return;
  const input = row.querySelector(`[data-item-key="${subKey}"]`);
  if (input) {
    input.value = value == null ? "" : String(value);
    return;
  }
  const nested = row.querySelector(`[data-nested-array][data-nested-key="${subKey}"]`);
  if (!nested) return;
  const rowsEl = nested.querySelector(".rv-nested-rows");
  rowsEl.innerHTML = "";
  (Array.isArray(value) ? value : []).forEach((v) => {
    const chip = el(nestedArrayChipHtml(v));
    rowsEl.appendChild(chip);
    chip.querySelector("[data-nested-remove]")?.addEventListener("click", () => chip.remove());
  });
}

// "Approve current value" -- saves the whole form exactly like a routine
// autosave (so no edits elsewhere on the page are lost) and dismisses every
// flag on `key` at the same time. See main.js's claims-dismiss-flag.
async function dismissFlag(key) {
  // Cancel any pending debounced autosave -- its own upcoming save would be
  // redundant with (and could otherwise land right after and re-render
  // over) this one.
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  await flushAutosave(); // let any already-in-flight autosave land first
  const { fields, errors } = readFormFields();
  if (errors.length) {
    state.reviewError = "Fix invalid JSON before approving this flag:\n" + errors.map((e) => e.message).join("\n");
    render();
    return;
  }
  state.busy = true;
  render();
  const record = await window.api.dismissFlag(state.currentClaim.record.claim_id, fields, key);
  state.currentClaim.record = record;
  state.reviewError = null;
  state.saveStatus = "Saved";
  syncQueueEntry(record);
  state.busy = false;
  render();
}

async function openClaim(index) {
  const summary = state.pendingList[index];
  if (!summary) return;
  const result = await window.api.getClaim(summary.claim_id);
  state.currentClaim = result;
  state.selectedIndex = index;
  state.view = "review";
  state.reviewError = null;
  state.saveStatus = null;
  render();
  // Save right on open (per Kevin's ask) -- a no-op content-wise unless
  // something about the recompute (missing/validation flags) differs from
  // what's already on disk; existing flags aren't touched (no dismissKey).
  scheduleAutosave(0);
}

function readFormFields() {
  const formType = state.currentClaim.record.form_type;
  const fieldSpecs = state.schema?.[formType]?.fields || {};
  const fields = {};
  const errors = [];
  for (const key of Object.keys(fieldSpecs)) {
    if (key === "form_type") continue;
    const node = document.getElementById(`field-${key}`);
    if (!node) continue;
    if (isArrayField(formType, key)) {
      // A real add/remove list, not JSON text to parse -- see
      // renderArrayField/wireArrayEditors/readArrayField.
      fields[key] = readArrayField(formType, key, node);
    } else if (isBooleanField(formType, key)) {
      // A real boolean, not whatever a text input's .value string would
      // give -- see wireBooleanToggles/renderReviewView.
      fields[key] = node.dataset.value === "true";
    } else {
      const raw = node.value;
      fields[key] = raw.trim() === "" ? null : raw;
    }
  }
  return { fields, errors };
}

async function navigateClaim(delta) {
  await flushAutosave();
  const next = state.selectedIndex + delta;
  if (next < 0 || next >= state.pendingList.length) return;
  await openClaim(next);
}

// --- Autosave -------------------------------------------------------------
// Everything here replaces what used to be a single "Save" button: opening
// a claim, typing in a field, toggling a checkbox, adding/removing a line
// item, or picking a flag's alternate value all schedule an autosave --
// there's nothing left for a person to remember to click.
//
// Two things make this safe rather than glitchy:
//
// 1. Typing is debounced (AUTOSAVE_DEBOUNCE_MS after the last keystroke, or
//    immediately on blur/any discrete action) instead of firing on every
//    keystroke -- a save spawns a Python subprocess (validate_fields.py) on
//    every call, so per-character saves would both lag noticeably and race
//    each other. runAutosave()/flushAutosave() below coalesce any autosaves
//    requested while one is already in flight into a single follow-up
//    (using whatever's newest at the time it actually runs), rather than
//    piling up one call per keystroke.
//
// 2. performAutosave() only calls the full render() -- which is what
//    refreshes flag/missing-field indicators -- when NOTHING has changed
//    since the fields it's about to save were read from the DOM (no
//    pending debounce, nothing queued up behind this save). That's the
//    difference between "safe" and "glitchy": render() rebuilds every
//    input from `record.fields`, so rendering while the round-trip is still
//    in flight and the user has kept typing would revert those newer,
//    not-yet-saved keystrokes right back out of the DOM. Skipping the
//    render in that case doesn't lose anything -- the DOM already shows
//    whatever's newest; it's *rendering* here that would be destructive,
//    not skipping it. Whichever save eventually settles with nothing
//    pending behind it is the one that renders.
const AUTOSAVE_DEBOUNCE_MS = 700;
let autosaveTimer = null;
let autosaveInFlight = null;
let autosavePending = false;

function scheduleAutosave(delayMs = AUTOSAVE_DEBOUNCE_MS) {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    runAutosave();
  }, delayMs);
}

function runAutosave() {
  if (autosaveInFlight) {
    autosavePending = true;
    return autosaveInFlight;
  }
  autosaveInFlight = performAutosave().finally(() => {
    autosaveInFlight = null;
    if (autosavePending) {
      autosavePending = false;
      runAutosave();
    }
  });
  return autosaveInFlight;
}

// Cancels any pending debounce and waits for a save to actually land --
// used before anything that could otherwise lose an edit: switching
// claims, Approve/Discard, and (see main.js/preload.js) closing the window
// or quitting the app.
async function flushAutosave() {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    runAutosave();
  }
  while (autosaveInFlight) await autosaveInFlight;
}

function patchSaveStatus() {
  const node = document.getElementById("save-status");
  if (node) node.textContent = state.saveStatus || "";
}

async function performAutosave() {
  if (!state.currentClaim) return;
  const claimId = state.currentClaim.record.claim_id;
  const { fields, errors } = readFormFields();
  if (errors.length) return; // readFormFields never actually produces these today; guard anyway
  state.saveStatus = "Saving…";
  patchSaveStatus();
  const record = await window.api.saveClaim(claimId, fields);
  // The reviewer may have already navigated away (or the claim left the
  // queue via Approve/Discard) by the time this resolves -- don't apply a
  // stale result on top of whatever's showing now.
  if (!state.currentClaim || state.currentClaim.record.claim_id !== claimId) return;
  state.currentClaim.record = record;
  syncQueueEntry(record);
  state.saveStatus = "Saved";
  if (!autosaveTimer && !autosavePending) {
    render();
  } else {
    patchSaveStatus();
  }
}

function syncQueueEntry(record) {
  const idx = state.pendingList.findIndex((c) => c.claim_id === record.claim_id);
  if (idx === -1) return;
  const f = record.fields || {};
  state.pendingList[idx] = {
    ...state.pendingList[idx],
    missing_required_fields: record.missing_required_fields || [],
    patient_name: [f.patient_first_name, f.patient_last_name].filter(Boolean).join(" "),
    total_charge: f.total_charge ?? f.total_charges ?? null,
  };
}

async function doApprove() {
  await flushAutosave(); // no in-flight/pending autosave should be able to land after this one
  const { fields, errors } = readFormFields();
  if (errors.length) {
    state.reviewError = "Fix invalid JSON before approving:\n" + errors.map((e) => e.message).join("\n");
    render();
    return;
  }
  // Save first so missing_required_fields is authoritative before we decide whether to confirm.
  state.busy = true;
  render();
  const record = await window.api.saveClaim(state.currentClaim.record.claim_id, fields);
  state.currentClaim.record = record;
  syncQueueEntry(record);

  if ((record.missing_required_fields || []).length > 0) {
    const proceed = window.confirm(
      `This claim is still missing: ${record.missing_required_fields.join(", ")}.\n\n` +
        "Approving now will fail to build an 837 until these are filled in. Approve anyway?"
    );
    if (!proceed) {
      state.busy = false;
      render();
      return;
    }
  }

  const result = await window.api.approveClaim(record.claim_id, fields);
  state.busy = false;
  if (!result.ok) {
    state.reviewError = result.missingFields ? `Missing required fields: ${result.message}` : `Could not build 837: ${result.message}`;
    render();
    return;
  }

  state.pendingList.splice(state.selectedIndex, 1);
  state.counts.pending = Math.max(0, state.counts.pending - 1);
  state.counts.approved += 1;
  state.counts.output += 1;
  await afterClaimLeavesQueue();
}

async function doDiscard() {
  if (!window.confirm("Discard this claim? It will be moved aside (not deleted) and removed from the queue.")) return;
  await flushAutosave(); // no in-flight/pending autosave should be able to land after this one
  state.busy = true;
  render();
  await window.api.discardClaim(state.currentClaim.record.claim_id);
  state.pendingList.splice(state.selectedIndex, 1);
  state.counts.pending = Math.max(0, state.counts.pending - 1);
  state.busy = false;
  await afterClaimLeavesQueue();
}

async function afterClaimLeavesQueue() {
  if (state.pendingList.length === 0) {
    state.view = "queue";
    state.currentClaim = null;
  } else {
    const nextIndex = Math.min(state.selectedIndex, state.pendingList.length - 1);
    await openClaim(nextIndex);
    return;
  }
  render();
}

function renderReviewView() {
  const { record, imagePath, imageUrl } = state.currentClaim;
  const fieldSpecs = state.schema?.[record.form_type]?.fields || {};
  const missing = new Set(record.missing_required_fields || []);
  const flagged = record.flagged_fields || {};
  const fields = record.fields || {};

  const formRows = Object.keys(fieldSpecs)
    .filter((key) => key !== "form_type")
    .map((key) => {
      const desc = fieldSpecs[key];
      const isArr = isArrayField(record.form_type, key);
      const isBool = isBooleanField(record.form_type, key);
      const value = fields[key];
      const isMissing = missing.has(key);
      const flagEntries = flagged[key];
      let inputHtml;
      if (isArr) {
        inputHtml = renderArrayField(record.form_type, key, value, flagged);
      } else if (isBool) {
        // A real boolean, not a text input -- direct DOM manipulation on
        // click (see wireBooleanToggles), no render(), same "uncontrolled
        // until Save" philosophy as every other field (see file header).
        // Storing "true"/"false" as a string only in data-value (read back
        // by readFormFields()) keeps the *actual* claim data a real JS
        // boolean the whole time, unlike the old bare <input> that forced
        // it through a string round-trip -- see field_validation.py and
        // x12_837.py, which both rely on ssn_box_checked/ein_box_checked's truthiness.
        const options = BOOLEAN_FIELD_OPTIONS[key] || DEFAULT_BOOLEAN_OPTIONS;
        const buttonsHtml = options
          .map((opt) => {
            const isActive = value === opt.value;
            return `<button class="bm-theme-toggle-btn ${isActive ? "active" : ""}" data-bool-set="${opt.value}" type="button" tabindex="-1">${escapeHtml(opt.label)}</button>`;
          })
          .join("");
        inputHtml = `
          <div class="bm-theme-toggle" id="field-${key}" data-bool-toggle data-value="${value === true ? "true" : "false"}">
            ${buttonsHtml}
          </div>`;
      } else {
        inputHtml = `<input class="bm-input" id="field-${key}" value="${escapeAttr(value == null ? "" : value)}" />`;
      }
      const flagHtml = flagEntries
        ? `<span class="rv-field-flag-reason">${flagReasonHtml(key, flagEntries)}</span>${flagActionsHtml(key, flagEntries)}`
        : "";
      return `
        <div class="bm-field rv-field ${isMissing ? "missing" : ""} ${flagEntries ? "flagged" : ""}">
          <span class="bm-field-label">${escapeHtml(key)}${isMissing ? " — required" : ""}</span>
          ${inputHtml}
          <span class="rv-field-hint">${escapeHtml(desc)}</span>
          ${flagHtml}
        </div>`;
    })
    .join("");

  const main = el(`
    <div class="rv-main">
      <div class="rv-review">
        <div class="rv-review-topbar">
          <button class="bm-btn bm-btn-ghost bm-btn-sm" id="back-to-queue">${ICONS.chevronLeft} Queue</button>
          <span class="rv-review-counter">${state.selectedIndex + 1} of ${state.pendingList.length}</span>
          <div class="rv-review-nav">
            <button class="bm-btn bm-btn-secondary bm-btn-sm" id="prev-claim" ${state.selectedIndex <= 0 ? "disabled" : ""}>${ICONS.chevronLeft}</button>
            <button class="bm-btn bm-btn-secondary bm-btn-sm" id="next-claim" ${state.selectedIndex >= state.pendingList.length - 1 ? "disabled" : ""}>${ICONS.chevronRight}</button>
          </div>
        </div>
        ${schemaWarningBanner()}
        ${state.reviewError ? `<div class="rv-review-warning">${escapeHtml(state.reviewError)}</div>` : ""}
        ${record.used_thinking_fallback ? `<div class="rv-review-warning">Recovered from the model's "thinking" field — double-check every value against the image.</div>` : ""}
        <div class="rv-review-layout" id="review-layout">
          <div class="rv-review-image-pane" id="image-pane" style="width: ${state.settings?.imagePaneWidth || DEFAULT_IMAGE_PANE_WIDTH}px">
            ${
              imageUrl
                ? `<img id="claim-image" src="${escapeAttr(imageUrl)}" alt="Source scan" draggable="false" />
                   <div class="rv-zoom-controls">
                     <button class="rv-zoom-btn" id="zoom-out" title="Zoom out">&minus;</button>
                     <button class="rv-zoom-btn rv-zoom-label" id="zoom-reset" title="Reset to fit">Fit</button>
                     <button class="rv-zoom-btn" id="zoom-in" title="Zoom in">+</button>
                     <button class="rv-zoom-btn" id="open-image" title="Open image file">${ICONS.folder}</button>
                   </div>`
                : "<span>No image</span>"
            }
          </div>
          <div class="rv-resize-handle" id="resize-handle" title="Drag to resize"></div>
          <div class="rv-review-form-pane">${formRows}</div>
        </div>
        <div class="rv-review-actions">
          <button class="bm-btn bm-btn-danger" id="discard-claim" ${state.busy ? "disabled" : ""}>Discard</button>
          <span class="bm-btn-ghost-spacer"></span>
          <span class="rv-review-counter" id="save-status">${state.saveStatus || ""}</span>
          <button class="bm-btn bm-btn-primary" id="approve-claim" ${state.busy ? "disabled" : ""}>Approve &amp; build 837</button>
        </div>
      </div>
    </div>
  `);

  main.querySelector("#back-to-queue").addEventListener("click", () => switchView("queue"));
  main.querySelector("#prev-claim").addEventListener("click", () => navigateClaim(-1));
  main.querySelector("#next-claim").addEventListener("click", () => navigateClaim(1));
  main.querySelector("#discard-claim").addEventListener("click", doDiscard);
  main.querySelector("#approve-claim").addEventListener("click", doApprove);
  wireBooleanToggles(main);
  wireArrayEditors(main, record.form_type);

  wireImagePane(main, imagePath, record.claim_id);
  wireResizeHandle(main);
  wireFormPaneScroll(main);

  main.querySelectorAll("[data-flag-approve]").forEach((btn) => {
    btn.addEventListener("click", () => dismissFlag(btn.dataset.flagApprove));
  });
  main.querySelectorAll("[data-flag-use]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setFieldValue(btn.dataset.flagUse, JSON.parse(btn.dataset.flagValue));
      scheduleAutosave(0);
    });
  });

  // Autosave triggers -- delegated so every text input/textarea (including
  // ones inside dynamically added line items) is covered without wiring
  // each one individually. "input" debounces (typing); "focusout" (blur,
  // unlike "blur" itself, bubbles) saves right away, so tabbing/clicking to
  // the next field doesn't wait out the full debounce.
  main.addEventListener("input", (e) => {
    if (e.target.matches("input, textarea")) scheduleAutosave();
  });
  main.addEventListener("focusout", (e) => {
    if (e.target.matches("input, textarea")) scheduleAutosave(0);
  });

  return main;
}

// Boolean claim fields (see isBooleanField), same "direct DOM, no render()"
// approach as wireImagePane below -- toggling one shouldn't blow away
// whatever the reviewer is mid-typing in every other field on the form.
// readFormFields() reads the result back from data-value.
function wireBooleanToggles(root) {
  root.querySelectorAll("[data-bool-toggle]").forEach((toggle) => {
    toggle.querySelectorAll("[data-bool-set]").forEach((btn) => {
      btn.addEventListener("click", () => {
        toggle.dataset.value = btn.dataset.boolSet;
        toggle.querySelectorAll("[data-bool-set]").forEach((b) => {
          b.classList.toggle("active", b.dataset.boolSet === btn.dataset.boolSet);
        });
        scheduleAutosave(0);
      });
    });
  });
}

// Zoom + pan + resize for the review image, all direct DOM manipulation
// (not going through state/render()) so dragging/scrolling stays smooth
// and doesn't fight a full-tree rebuild mid-gesture.
//
// Zoom/pan used to just reset to "Fit" on every rebuild -- fine back when
// that only happened on an explicit Save/Approve/Prev/Next click, but
// autosave now rebuilds this view every ~1s while typing, which would
// otherwise snap a zoomed-in image back to "Fit" mid-edit. persistedZoomState
// (module-level, not `state` -- it's transient UI, not claim data) survives
// across those rebuilds for the SAME claim, and is only actually reset when
// the claim itself changes (a genuinely different image, where keeping the
// old zoom/pan wouldn't make sense).
let persistedZoomState = { claimId: null, zoom: 1, scrollLeft: 0, scrollTop: 0 };

function wireImagePane(root, imagePath, claimId) {
  const pane = root.querySelector("#image-pane");
  const img = root.querySelector("#claim-image");
  if (!pane || !img) return;

  if (persistedZoomState.claimId !== claimId) {
    persistedZoomState = { claimId, zoom: 1, scrollLeft: 0, scrollTop: 0 };
  }

  const zoomLabel = root.querySelector("#zoom-reset");
  let zoom = persistedZoomState.zoom; // 1 == "fit" (CSS object-fit: contain, no inline size)

  const applyZoom = (next) => {
    zoom = Math.max(1, Math.min(6, next));
    persistedZoomState.zoom = zoom;
    if (zoom === 1) {
      img.style.maxWidth = "";
      img.style.maxHeight = "";
      img.style.width = "";
      img.style.height = "";
      pane.classList.remove("zoomed");
      zoomLabel.textContent = "Fit";
    } else {
      if (!img.dataset.baseWidth) img.dataset.baseWidth = String(img.getBoundingClientRect().width);
      const base = Number(img.dataset.baseWidth);
      img.style.maxWidth = "none";
      img.style.maxHeight = "none";
      img.style.width = `${base * zoom}px`;
      img.style.height = "auto";
      pane.classList.add("zoomed");
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    }
  };

  // Re-apply whatever zoom/pan this claim already had (a no-op at "Fit",
  // i.e. every actual claim change) -- deferred until the image both has
  // real dimensions to zoom against AND is actually attached to the live
  // document, since applyZoom's non-fit branch measures the <img>'s current
  // rendered width the first time it runs. Both matter: wireImagePane runs
  // while `root` is still a detached fragment (renderReviewView() hasn't
  // been inserted into the page yet -- see render()), so a naive "wait for
  // the image to load" check can still fire while getBoundingClientRect()
  // only ever sees an empty, unattached layout box (width 0) -- which then
  // gets cached forever in img.dataset.baseWidth, permanently breaking
  // every subsequent zoom-in until the next full render (fresh <img>, same
  // bug). requestAnimationFrame runs after layout for the live document, so
  // waiting for img.isConnected there guarantees a real measurement.
  const restorePersistedZoom = () => {
    if (persistedZoomState.zoom === 1) return;
    if (!img.isConnected) {
      requestAnimationFrame(restorePersistedZoom);
      return;
    }
    applyZoom(persistedZoomState.zoom);
    pane.scrollLeft = persistedZoomState.scrollLeft;
    pane.scrollTop = persistedZoomState.scrollTop;
  };
  if (img.complete) restorePersistedZoom();
  else img.addEventListener("load", restorePersistedZoom, { once: true });

  // Keeps persistedZoomState's pan position current as the reviewer drags,
  // so the NEXT autosave's rebuild (see restorePersistedZoom above) puts it
  // back exactly where it was, not just at the right zoom level.
  pane.addEventListener("scroll", () => {
    persistedZoomState.scrollLeft = pane.scrollLeft;
    persistedZoomState.scrollTop = pane.scrollTop;
  });

  root.querySelector("#zoom-in").addEventListener("click", () => applyZoom(zoom * 1.25));
  root.querySelector("#zoom-out").addEventListener("click", () => applyZoom(zoom / 1.25));
  zoomLabel.addEventListener("click", () => applyZoom(1));
  const openBtn = root.querySelector("#open-image");
  if (openBtn) openBtn.addEventListener("click", () => imagePath && window.api.openFolder(imagePath));
  // The toolbar sits inside the pane -- without this, a click on any of its
  // buttons bubbles up to the pane's own click-to-zoom handler below.
  root.querySelector(".rv-zoom-controls")?.addEventListener("click", (e) => e.stopPropagation());

  // Click to zoom in (matches the "zoom-in" cursor shown at fit); dragging
  // to pan takes over via pointerdown once zoomed, below.
  pane.addEventListener("click", () => {
    if (zoom === 1) applyZoom(2);
  });

  pane.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      applyZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    },
    { passive: false }
  );

  // Single click (at fit) zooms in; double-click always resets back to fit
  // regardless of current zoom, rather than the two gestures fighting over
  // what "toggle" means.
  img.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    applyZoom(1);
  });

  // Drag-to-pan once zoomed in -- pointer capture keeps move/up events
  // targeting `pane` even if the cursor leaves it mid-drag, and needs no
  // cleanup: it's released automatically when the pane is removed from the
  // DOM on the next render.
  pane.addEventListener("pointerdown", (e) => {
    if (zoom <= 1) return;
    pane.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = pane.scrollLeft;
    const startTop = pane.scrollTop;
    pane.classList.add("panning");
    const onMove = (ev) => {
      pane.scrollLeft = startLeft - (ev.clientX - startX);
      pane.scrollTop = startTop - (ev.clientY - startY);
    };
    const onUp = () => {
      pane.removeEventListener("pointermove", onMove);
      pane.removeEventListener("pointerup", onUp);
      pane.classList.remove("panning");
    };
    pane.addEventListener("pointermove", onMove);
    pane.addEventListener("pointerup", onUp);
  });
}

function wireResizeHandle(root) {
  const handle = root.querySelector("#resize-handle");
  const layout = root.querySelector("#review-layout");
  const imagePane = root.querySelector("#image-pane");
  if (!handle || !layout || !imagePane) return;

  handle.addEventListener("pointerdown", (e) => {
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = imagePane.getBoundingClientRect().width;
    const maxWidth = layout.getBoundingClientRect().width - MIN_FORM_PANE_WIDTH - handle.getBoundingClientRect().width;
    handle.classList.add("dragging");
    const onMove = (ev) => {
      const next = Math.max(MIN_IMAGE_PANE_WIDTH, Math.min(maxWidth, startWidth + (ev.clientX - startX)));
      imagePane.style.width = `${next}px`;
    };
    const onUp = async () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.classList.remove("dragging");
      state.settings = await window.api.setSettings({ imagePaneWidth: Math.round(imagePane.getBoundingClientRect().width) });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
}

// A focused (or even just hovered) <input>/<textarea>/<select> keeps its own
// wheel events to itself rather than letting them bubble up to the pane's
// scroll -- real Chromium behavior for editable form controls, not something
// this app's own code does -- so mouse-wheel scrolling .rv-review-form-pane
// silently does nothing the moment the pointer is over one of its fields
// (which, on a form that's mostly fields, is most of it). Forward the wheel
// delta onto the pane by hand whenever that's the target; everywhere else in
// the pane (labels, hints, the gaps between fields) already scrolls fine
// natively and is left alone.
function wireFormPaneScroll(root) {
  const pane = root.querySelector(".rv-review-form-pane");
  if (!pane) return;
  pane.addEventListener(
    "wheel",
    (e) => {
      if (!e.target.closest("input, textarea, select")) return;
      pane.scrollTop += e.deltaY;
      e.preventDefault();
    },
    { passive: false }
  );
}

// --- Organization settings view ---------------------------------------------

const ORG_FIELD_DEFS = [
  { key: "submitter_id", label: "Submitter ID", hint: "The ID your internal claims system knows you by as the sender (ISA06/GS02)." },
  { key: "submitter_name", label: "Submitter name", hint: "Your organization's name, as it should appear on the submitter loop." },
  { key: "submitter_contact_name", label: "Submitter contact name", hint: "Optional — shown on the PER segment in case the receiver has a question about a batch." },
  { key: "submitter_phone", label: "Submitter phone", hint: "Optional — any format, non-digits are stripped automatically." },
  { key: "receiver_id", label: "Receiver ID", hint: "The ID of the system you're sending to (ISA08/GS03)." },
  { key: "receiver_name", label: "Receiver name", hint: "Receiver's name for the NM1*40 segment." },
  { key: "claim_filing_indicator", label: "Claim filing indicator", hint: "X12 code list 1032 (SBR09), e.g. 'ZZ' Mutually Defined, '11' Other Non-Federal Programs, 'CI' Commercial Insurance, 'CH' Champus." },
  { key: "payer_name", label: "Payer name", hint: "The same payer for every claim this builds (single-payer by design) — used on the NM1*PR segment." },
  { key: "payer_id", label: "Payer ID", hint: "That payer's ID (NM1*PR, qualifier PI)." },
  { key: "payer_address", label: "Payer address", hint: "Optional — leave blank if your internal system doesn't need the payer's own mailing address." },
  { key: "payer_city", label: "Payer city", hint: "Optional." },
  { key: "payer_state", label: "Payer state", hint: "Optional — two-letter state." },
  { key: "payer_zip", label: "Payer ZIP", hint: "Optional." },
];

async function loadOrg() {
  state.org = await window.api.getOrgConfig();
}

// --- Exports (built .837/.txt files) ---------------------------------------

async function loadExports() {
  state.exports = await window.api.listExports();
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function renderExportsView() {
  if (!state.settings?.workspaceFolder) return renderNoWorkspace();
  const rows = state.exports || [];
  const main = el(`
    <div class="rv-main">
      <div class="rv-main-header">
        <div class="rv-main-title">Built .837 files</div>
        <span class="rv-main-sub">${rows.length} file${rows.length === 1 ? "" : "s"}</span>
      </div>
      ${
        rows.length === 0
          ? `<div class="rv-empty"><div class="rv-empty-title">Nothing built yet</div><div>Approved claims land here as .txt files, ready to view or hand off.</div></div>`
          : `<div class="rv-queue-list">
              ${rows
                .map(
                  (r) => `
                <div class="rv-claim-row rv-export-row" data-file="${escapeAttr(r.name)}">
                  <span class="rv-claim-name">${escapeHtml(r.name)}</span>
                  <span class="rv-claim-meta">${formatBytes(r.size)}</span>
                  <span class="rv-claim-meta">${new Date(r.mtimeMs).toLocaleString()}</span>
                </div>`
                )
                .join("")}
            </div>`
      }
    </div>
  `);
  main.querySelectorAll("[data-file]").forEach((node) => {
    node.addEventListener("click", () => window.api.openExportViewer(node.getAttribute("data-file")));
  });
  return main;
}

// No-op when usesBundledPipeline -- there's no separate Python path to
// check in a packaged build (see main.js's PIPELINE_CLI_PATH).
async function checkPython(pythonPath) {
  if (state.usesBundledPipeline) return;
  state.pythonCheck = null;
  render();
  state.pythonCheck = await window.api.checkPython(pythonPath);
  state.schema = await window.api.getSchema();
  render();
}

function schemaWarningBanner() {
  if (state.schema) return "";
  const hint = state.usesBundledPipeline
    ? "Couldn't load the claim field schema (needed to show/edit claim fields) — try restarting the app; if this keeps happening, reinstall it."
    : "Couldn't load the claim field schema (needed to show/edit claim fields) — check the Python path under Organization Settings.";
  return `<div class="rv-review-warning">${hint}</div>`;
}

function renderOrgView() {
  if (!state.settings?.workspaceFolder) return renderNoWorkspace();
  if (!state.org) {
    return el(`<div class="rv-main"><div class="rv-empty"><div class="rv-empty-title">No org_config.json yet</div><div>Choose a workspace folder — one gets created from the template automatically.</div></div></div>`);
  }
  const org = state.org;
  const main = el(`
    <div class="rv-main">
      <div class="rv-main-header"><div class="rv-main-title">Organization Settings</div></div>
      ${state.orgSeededNotice ? `<div class="rv-review-warning">A new org_config.json was created from the template in this workspace — fill in your real values below.</div>` : ""}
      <div class="rv-settings-form">
        <div class="rv-settings-group">
          ${
            state.usesBundledPipeline
              ? `<div class="bm-field">
                  <span class="bm-field-label">Python</span>
                  <span class="rv-field-hint">Bundled with this app — nothing to install separately.</span>
                </div>`
              : `<div class="bm-field">
                  <span class="bm-field-label">Python path</span>
                  <input class="bm-input" id="app-python-path" value="${escapeAttr(state.settings?.pythonPath)}" placeholder="python3" />
                  <span class="rv-field-hint">${
                    state.pythonCheck === null
                      ? "Checking…"
                      : state.pythonCheck.ok
                        ? `Found: ${escapeHtml(state.pythonCheck.version)}`
                        : `Not found: ${escapeHtml(state.pythonCheck.error || "")}`
                  }</span>
                </div>`
          }
          <div class="bm-field">
            <span class="bm-field-label">Theme</span>
            <div class="bm-theme-toggle" role="group" id="theme-toggle">
              ${THEME_CHOICES.map(
                (choice) =>
                  `<button class="bm-theme-toggle-btn ${state.theme === choice.value ? "active" : ""}" data-theme-choice="${choice.value}" type="button">${choice.label}</button>`
              ).join("")}
            </div>
          </div>
        </div>
        <div class="rv-settings-group">
          ${ORG_FIELD_DEFS.filter((f) => f.key.startsWith("submitter"))
            .map((f) => orgFieldHtml(f, org))
            .join("")}
        </div>
        <div class="rv-settings-group">
          ${ORG_FIELD_DEFS.filter((f) => f.key.startsWith("receiver"))
            .map((f) => orgFieldHtml(f, org))
            .join("")}
        </div>
        <div class="rv-settings-group">
          <div class="bm-field">
            <span class="bm-field-label">Usage indicator</span>
            <div class="bm-theme-toggle">
              <button class="bm-theme-toggle-btn ${org.usage_indicator !== "P" ? "active" : ""}" id="usage-test" type="button">Test</button>
              <button class="bm-theme-toggle-btn ${org.usage_indicator === "P" ? "active" : ""}" id="usage-prod" type="button">Production</button>
            </div>
            <span class="rv-field-hint">Leave on Test until you've confirmed real files should start flowing to your internal system — switching to Production is the signal that these are no longer test transactions.</span>
          </div>
          ${orgFieldHtml(ORG_FIELD_DEFS.find((f) => f.key === "claim_filing_indicator"), org)}
        </div>
        <div class="rv-settings-group">
          ${orgFieldHtml(ORG_FIELD_DEFS.find((f) => f.key === "payer_name"), org)}
          ${orgFieldHtml(ORG_FIELD_DEFS.find((f) => f.key === "payer_id"), org)}
          ${orgFieldHtml(ORG_FIELD_DEFS.find((f) => f.key === "payer_address"), org)}
          ${orgFieldHtml(ORG_FIELD_DEFS.find((f) => f.key === "payer_city"), org)}
          ${orgFieldHtml(ORG_FIELD_DEFS.find((f) => f.key === "payer_state"), org)}
          ${orgFieldHtml(ORG_FIELD_DEFS.find((f) => f.key === "payer_zip"), org)}
        </div>
        <div class="rv-save-row">
          <button class="bm-btn bm-btn-primary" id="save-org">Save</button>
          <span class="rv-save-status">${state.orgStatus || ""}</span>
        </div>
      </div>
    </div>
  `);

  main.querySelector("#app-python-path")?.addEventListener("change", async (e) => {
    state.settings = await window.api.setSettings({ pythonPath: e.target.value });
    checkPython(state.settings.pythonPath);
  });
  main.querySelectorAll("#theme-toggle [data-theme-choice]").forEach((btn) =>
    btn.addEventListener("click", () => setTheme(btn.dataset.themeChoice))
  );
  main.querySelector("#usage-test").addEventListener("click", () => {
    state.org.usage_indicator = "T";
    render();
  });
  main.querySelector("#usage-prod").addEventListener("click", () => {
    state.org.usage_indicator = "P";
    render();
  });
  main.querySelector("#save-org").addEventListener("click", async () => {
    for (const f of ORG_FIELD_DEFS) {
      const node = main.querySelector(`#org-${f.key}`);
      if (node) state.org[f.key] = node.value;
    }
    await window.api.saveOrgConfig(state.org);
    state.orgStatus = "Saved.";
    state.orgSeededNotice = false;
    render();
  });
  return main;
}

function orgFieldHtml(f, org) {
  return `
    <label class="bm-field">
      <span class="bm-field-label">${f.label}</span>
      <input class="bm-input" id="org-${f.key}" value="${escapeAttr(org[f.key] ?? "")}" />
      <span class="rv-field-hint">${f.hint}</span>
    </label>`;
}

// --- About view --------------------------------------------------------------

function renderAboutView() {
  const main = el(`
    <div class="rv-main">
      <div class="rv-about">
        <div class="rv-main-title">BillOCR Review</div>
        <div class="rv-main-sub" id="about-version"></div>
        <p>Reviews claims extracted by BillOCR Intake, and builds X12 837I/837P files on approval.</p>
        <p>A person reviews every claim before it becomes a finished 837 (.txt) file — nothing here auto-approves anything.</p>
      </div>
    </div>
  `);
  window.api.getAppVersion().then((v) => {
    const n = main.querySelector("#about-version");
    if (n) n.textContent = `Version ${v}`;
  });
  return main;
}

// --- Render dispatch ---------------------------------------------------------

function render() {
  const app = document.getElementById("app");

  // Same full teardown/rebuild as Intake's renderer -- preserve scroll and
  // focus across it (e.g. an autosave's re-render while the form pane is
  // scrolled, or a field still has focus) rather than resetting to the top.
  // Two separate scrollable containers matter here, not just one: .rv-main
  // is the outer content area (queue/org/about views scroll here), but the
  // review view's own field list scrolls *inside* it, in .rv-review-form-pane
  // -- missing that one was the actual cause of "autosave jumps back to the
  // top" (that pane's scrollTop was never captured, only ever reset to 0 by
  // the rebuild, regardless of what .rv-main's own scroll was doing).
  const prevScrollEl = document.querySelector(".rv-main");
  const prevScrollTop = prevScrollEl ? prevScrollEl.scrollTop : 0;
  const prevFormPaneEl = document.querySelector(".rv-review-form-pane");
  const prevFormPaneScrollTop = prevFormPaneEl ? prevFormPaneEl.scrollTop : 0;
  // Prefer data-focus-key over a plain id: line-item sub-field inputs
  // (service_lines[i].cpt_hcpcs_code, etc.) have no unique id of their own,
  // only this key -- without it, autosave's frequent re-renders would kick
  // focus/cursor position out of a line-item field on every save, which
  // (unlike the old explicit Save button) now happens continuously while
  // typing. See objectArrayItemHtml.
  const active = document.activeElement;
  const focusKey = active && app.contains(active) ? active.dataset.focusKey || active.id || null : null;
  const selection =
    focusKey && typeof active.selectionStart === "number" ? { start: active.selectionStart, end: active.selectionEnd } : null;

  app.innerHTML = "";
  const frag = document.createDocumentFragment();
  frag.appendChild(renderTitlebar());
  const body = el(`<div class="rv-body"></div>`);
  body.appendChild(renderRail());
  let main;
  if (state.view === "review" && state.currentClaim) main = renderReviewView();
  else if (state.view === "org") main = renderOrgView();
  else if (state.view === "about") main = renderAboutView();
  else if (state.view === "exports") main = renderExportsView();
  else if (state.view === "approved-detail" && state.currentApprovedClaim) main = renderApprovedDetailView();
  else if (state.view === "approved" || state.view === "approved-detail") main = renderApprovedListView();
  else main = renderQueueView();
  body.appendChild(main);
  frag.appendChild(body);
  app.appendChild(frag);

  const newScrollEl = document.querySelector(".rv-main");
  if (newScrollEl) newScrollEl.scrollTop = prevScrollTop;
  const newFormPaneEl = document.querySelector(".rv-review-form-pane");
  if (newFormPaneEl) newFormPaneEl.scrollTop = prevFormPaneScrollTop;
  if (focusKey) {
    const restored = document.querySelector(`[data-focus-key="${focusKey}"]`) || document.getElementById(focusKey);
    if (restored) {
      restored.focus();
      if (selection && typeof restored.setSelectionRange === "function") {
        restored.setSelectionRange(selection.start, selection.end);
      }
    }
  }
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
  state.usesBundledPipeline = await window.api.usesBundledPipeline();
  state.schema = await window.api.getSchema();
  if (!state.usesBundledPipeline) {
    state.pythonCheck = await window.api.checkPython(state.settings.pythonPath);
  }
  await loadQueue();
  await loadOrg();
  render();

  window.api.onUpdateStatus((status) => setUpdateStatus(status));
  checkForUpdates(); // not awaited -- a startup check shouldn't hold up opening the queue

  // main.js intercepts the window's close (and app quit) to give autosave
  // a chance to flush first -- see its "close" handler's comment.
  window.api.onBeforeClose(async () => {
    await flushAutosave();
    window.api.notifyFlushedBeforeClose();
  });
})();
