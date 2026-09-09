// BillOCR Review — renderer. Single vanilla-JS file, same pattern as
// BillManager/Intake: one `state` object, `render()` tears down and
// rebuilds #app. Form inputs are uncontrolled (read from the DOM only on
// Save/Approve/navigate) rather than synced into state on every keystroke,
// so typing doesn't trigger a full-tree rebuild.

const state = {
  settings: null,
  schema: null, // {CMS1500:{fields,required}, UB04:{...}} | null
  view: "queue", // "queue" | "review" | "org" | "about"
  pendingList: [],
  counts: { pending: 0, approved: 0, output: 0 },
  selectedIndex: -1,
  currentClaim: null, // {record, imagePath}
  reviewError: null,
  saveStatus: null,
  busy: false,
  org: null,
  orgStatus: null,
  orgSeededNotice: false,
  pythonCheck: null, // {ok, version} | {ok:false, error} | null (checking)
};

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
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
};

// --- Titlebar --------------------------------------------------------------

function renderTitlebar() {
  const bar = el(`
    <div class="bm-titlebar">
      <div class="bm-titlebar-brand"><span class="bm-titlebar-title">BillOCR Review</span></div>
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
        <div class="bm-rail-footer-row"><span>Approved</span><span>${state.counts.approved}</span></div>
        <div class="bm-rail-footer-row"><span>Built .837</span><span>${state.counts.output}</span></div>
      </div>
    </div>
  `);
  rail.querySelectorAll("[data-view]").forEach((node) => {
    node.addEventListener("click", () => switchView(node.getAttribute("data-view")));
  });
  rail.querySelector("#choose-folder-btn").addEventListener("click", onChooseWorkspace);
  return rail;
}

async function switchView(view) {
  if (state.view === "review" && !(await confirmDiscardUnsavedChanges())) return;
  state.view = view;
  if (view === "queue") await loadQueue();
  if (view === "org") await loadOrg();
  render();
}

// --- Queue view ----------------------------------------------------------

function claimBadge(summary) {
  const n = (summary.missing_required_fields || []).length;
  if (n === 0) return `<span class="rv-badge rv-badge-ok">Ready</span>`;
  return `<span class="rv-badge rv-badge-missing">${n} missing</span>`;
}

function renderQueueView() {
  if (!state.settings?.workspaceFolder) return renderNoWorkspace();
  if (state.pendingList.length === 0) {
    return el(`
      <div class="rv-main">
        <div class="rv-main-header"><div class="rv-main-title">Review Queue</div></div>
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
      ${schemaWarningBanner()}
      <div class="rv-queue-list">
        ${state.pendingList
          .map(
            (c, i) => `
          <div class="rv-claim-row" data-index="${i}">
            <div class="rv-claim-name">${escapeHtml(c.patient_name || c.claim_id)}</div>
            <div class="rv-claim-meta">${escapeHtml(c.form_type)}</div>
            <div class="rv-claim-charge">${c.total_charge != null ? "$" + c.total_charge : "—"}</div>
            <div>${claimBadge(c)}</div>
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

// --- Review view -----------------------------------------------------------

function isArrayField(description) {
  return /JSON array/i.test(description || "");
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
}

async function confirmDiscardUnsavedChanges() {
  if (state.view !== "review" || !state.currentClaim) return true;
  const read = readFormFields();
  if (read.errors.length) return true; // can't compare cleanly; let them navigate away from broken JSON
  const changed = JSON.stringify(read.fields) !== JSON.stringify(state.currentClaim.record.fields);
  if (!changed) return true;
  return window.confirm("You have unsaved changes to this claim. Discard them?");
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
    if (isArrayField(fieldSpecs[key])) {
      const raw = node.value.trim();
      try {
        fields[key] = raw ? JSON.parse(raw) : [];
      } catch (err) {
        errors.push({ key, message: `${key}: invalid JSON (${err.message})` });
      }
    } else {
      const raw = node.value;
      fields[key] = raw.trim() === "" ? null : raw;
    }
  }
  return { fields, errors };
}

async function navigateClaim(delta) {
  if (!(await confirmDiscardUnsavedChanges())) return;
  const next = state.selectedIndex + delta;
  if (next < 0 || next >= state.pendingList.length) return;
  await openClaim(next);
}

async function doSave() {
  const { fields, errors } = readFormFields();
  if (errors.length) {
    state.reviewError = "Fix invalid JSON before saving:\n" + errors.map((e) => e.message).join("\n");
    render();
    return;
  }
  state.busy = true;
  render();
  const record = await window.api.saveClaim(state.currentClaim.record.claim_id, fields);
  state.currentClaim.record = record;
  state.reviewError = null;
  state.saveStatus = "Saved.";
  syncQueueEntry(record);
  state.busy = false;
  render();
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
  const { record, imagePath } = state.currentClaim;
  const fieldSpecs = state.schema?.[record.form_type]?.fields || {};
  const missing = new Set(record.missing_required_fields || []);
  const fields = record.fields || {};

  const formRows = Object.keys(fieldSpecs)
    .filter((key) => key !== "form_type")
    .map((key) => {
      const desc = fieldSpecs[key];
      const isArr = isArrayField(desc);
      const value = fields[key];
      const isMissing = missing.has(key);
      const inputHtml = isArr
        ? `<textarea id="field-${key}" rows="3">${escapeHtml(JSON.stringify(value ?? [], null, 2))}</textarea>`
        : `<input class="bm-input" id="field-${key}" value="${escapeAttr(value == null ? "" : value)}" />`;
      return `
        <div class="bm-field rv-field ${isMissing ? "missing" : ""}">
          <span class="bm-field-label">${escapeHtml(key)}${isMissing ? " — required" : ""}</span>
          ${inputHtml}
          <span class="rv-field-hint">${escapeHtml(desc)}</span>
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
        <div class="rv-review-layout">
          <div class="rv-review-image-pane" id="image-pane">
            ${imagePath ? `<img src="file://${encodeURI(imagePath)}" alt="Source scan" />` : "<span>No image</span>"}
          </div>
          <div class="rv-review-form-pane">${formRows}</div>
        </div>
        <div class="rv-review-actions">
          <button class="bm-btn bm-btn-secondary" id="save-claim" ${state.busy ? "disabled" : ""}>Save</button>
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
  main.querySelector("#save-claim").addEventListener("click", doSave);
  main.querySelector("#discard-claim").addEventListener("click", doDiscard);
  main.querySelector("#approve-claim").addEventListener("click", doApprove);
  const imgEl = main.querySelector("#image-pane img");
  if (imgEl) imgEl.addEventListener("click", () => imagePath && window.api.openFolder(imagePath));

  return main;
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
];

async function loadOrg() {
  state.org = await window.api.getOrgConfig();
}

async function checkPython(pythonPath) {
  state.pythonCheck = null;
  render();
  state.pythonCheck = await window.api.checkPython(pythonPath);
  state.schema = await window.api.getSchema();
  render();
}

function schemaWarningBanner() {
  if (state.schema) return "";
  return `<div class="rv-review-warning">Couldn't load the claim field schema (needed to show/edit claim fields) — check the Python path under Organization Settings.</div>`;
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
          <div class="bm-field">
            <span class="bm-field-label">Python path</span>
            <input class="bm-input" id="app-python-path" value="${escapeAttr(state.settings?.pythonPath)}" placeholder="python3" />
            <span class="rv-field-hint">${
              state.pythonCheck === null
                ? "Checking…"
                : state.pythonCheck.ok
                  ? `Found: ${escapeHtml(state.pythonCheck.version)}`
                  : `Not found: ${escapeHtml(state.pythonCheck.error || "")}`
            }</span>
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
        <div class="rv-save-row">
          <button class="bm-btn bm-btn-primary" id="save-org">Save</button>
          <span class="rv-save-status">${state.orgStatus || ""}</span>
        </div>
      </div>
    </div>
  `);

  main.querySelector("#app-python-path").addEventListener("change", async (e) => {
    state.settings = await window.api.setSettings({ pythonPath: e.target.value });
    checkPython(state.settings.pythonPath);
  });
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
        <p>A person reviews every claim before it becomes a .837 file — nothing here auto-approves anything.</p>
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
  app.innerHTML = "";
  const frag = document.createDocumentFragment();
  frag.appendChild(renderTitlebar());
  const body = el(`<div class="rv-body"></div>`);
  body.appendChild(renderRail());
  let main;
  if (state.view === "review" && state.currentClaim) main = renderReviewView();
  else if (state.view === "org") main = renderOrgView();
  else if (state.view === "about") main = renderAboutView();
  else main = renderQueueView();
  body.appendChild(main);
  frag.appendChild(body);
  app.appendChild(frag);
}

(async function init() {
  state.settings = await window.api.getSettings();
  state.schema = await window.api.getSchema();
  state.pythonCheck = await window.api.checkPython(state.settings.pythonPath);
  await loadQueue();
  await loadOrg();
  render();
})();
