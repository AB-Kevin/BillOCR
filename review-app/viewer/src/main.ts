// BillOCR Review's claim viewer — Phase 1 (structured field list only; the
// pixel-accurate CMS-1500/UB-04 paper-form preview, ported from
// 837-claim-viewer's src/render/cms1500 & ub04, is a follow-up pass -- see
// that repo's docs and this app's own README note on the port).
//
// Reuses 837-claim-viewer's own decode/model/X12-parsing layers verbatim
// (src/model, src/data, src/sources here) -- only this file and viewer.css
// are new, matching BillOCR Review's plain-DOM renderer.js conventions
// (build one string of HTML, wire listeners after) rather than a framework.

import { X12ClaimSource } from "./sources/x12/x12ClaimSource.js";
import {
  decodePlaceOfService,
  decodeModifier,
  decodeTypeOfBill,
  decodeDischargeStatus,
  decodeConditionCode,
  decodeOccurrenceCode,
  decodeOccurrenceSpanCode,
  decodeValueCode,
  decodeRevenueCode,
} from "./model/decode.js";
import { composeName, composeAddressLine } from "./render/text.js";
import type { Claim, Name, Address } from "./model/claim.js";

declare global {
  interface Window {
    viewerApi: {
      windowMinimize: () => void;
      windowMaximizeToggle: () => void;
      windowClose: () => void;
      readClaimFile: (path: string) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
    };
  }
}

function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild as HTMLElement;
}

function escapeHtml(str: unknown): string {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function money(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function nameText(n: Name): string {
  const s = composeName(n);
  return s === "" ? "—" : s;
}
function addrText(a: Address): string {
  const s = composeAddressLine(a);
  return s === "" ? "—" : s;
}
function val(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

// One label/value row -- optionally with the code's decoded label appended
// in parentheses, for the many NUBC/X12 code fields (place of service,
// modifiers, type of bill, etc.) where the raw code alone isn't
// self-explanatory. Matches review-app's own .bm-field-label/value rhythm.
function row(label: string, value: string, decoded?: string | null): string {
  const suffix = decoded ? ` <span class="viewer-decoded">(${escapeHtml(decoded)})</span>` : "";
  return `<div class="viewer-row"><span class="viewer-row-label">${escapeHtml(label)}</span><span class="viewer-row-value">${escapeHtml(value)}${suffix}</span></div>`;
}

function section(title: string, bodyHtml: string, badge?: string): string {
  return `
    <div class="bm-field viewer-section">
      <div class="viewer-section-head">
        <span class="bm-field-label">${escapeHtml(title)}</span>
        ${badge ? `<span class="viewer-section-badge">${escapeHtml(badge)}</span>` : ""}
      </div>
      ${bodyHtml}
    </div>`;
}

function renderClaim(claim: Claim): string {
  const tob = claim.institutional ? decodeTypeOfBill(claim.institutional.typeOfBill) : null;
  const status = claim.institutional ? decodeDischargeStatus(claim.institutional.patientStatus) : null;

  const patient = section(
    "Patient",
    [
      row("Name", nameText(claim.patient.name)),
      row("Date of birth", val(claim.patient.dob)),
      row("Sex", val(claim.patient.sex)),
      row("Address", addrText(claim.patient.address)),
      row("Phone", val(claim.patient.phone)),
      row("Rel. to insured", val(claim.patient.relationshipToInsured)),
      row("Account no.", val(claim.patient.accountNumber)),
    ].join("")
  );

  const insured = section(
    "Insured",
    [
      row("Name", nameText(claim.insured.name)),
      row("Member ID", val(claim.insured.memberId)),
      row("Group", val(claim.insured.group)),
      row("Plan", val(claim.insured.plan)),
      row("Date of birth", val(claim.insured.dob)),
      row("Sex", val(claim.insured.sex)),
      row("Address", addrText(claim.insured.address)),
      row("Employer", val(claim.insured.employer)),
    ].join("")
  );

  const payer = section(
    "Payer",
    [row("Name", val(claim.payer.name)), row("ID", val(claim.payer.id)), row("Address", addrText(claim.payer.address)), row("Order", val(claim.payer.order))].join(
      ""
    )
  );

  const billing = section(
    "Billing provider",
    [
      row("Name", val(claim.billingProvider.name)),
      row("NPI", val(claim.billingProvider.npi)),
      row("Tax ID", val(claim.billingProvider.taxId), claim.billingProvider.taxIdType || null),
      row("Address", addrText(claim.billingProvider.address)),
      row("Phone", val(claim.billingProvider.phone)),
      row("Taxonomy", val(claim.billingProvider.taxonomy)),
    ].join("")
  );

  const rendering = section(
    "Rendering provider",
    [row("Name", nameText(claim.renderingProvider.name)), row("NPI", val(claim.renderingProvider.npi)), row("Taxonomy", val(claim.renderingProvider.taxonomy))].join("")
  );

  const referring = claim.referringProvider
    ? section("Referring provider", [row("Name", nameText(claim.referringProvider.name)), row("NPI", val(claim.referringProvider.npi)), row("ID", val(claim.referringProvider.id))].join(""))
    : "";

  const facility = claim.facility
    ? section("Service facility", [row("Name", val(claim.facility.name)), row("NPI", val(claim.facility.npi)), row("Address", addrText(claim.facility.address))].join(""))
    : "";

  const otherInsurance = claim.otherInsurance
    ? section(
        "Other insurance",
        [
          row("Name", nameText(claim.otherInsurance.name)),
          row("Policy/group", val(claim.otherInsurance.policyOrGroup)),
          row("Member ID", val(claim.otherInsurance.memberId)),
          row("Plan", val(claim.otherInsurance.plan)),
          row("Relationship", val(claim.otherInsurance.patientRelationship)),
        ].join("")
      )
    : "";

  const diagnoses = section(
    "Diagnoses",
    claim.diagnoses.length
      ? claim.diagnoses
          .map((d) => row(d.pointer ? `${d.pointer} (#${d.ordinal})` : `#${d.ordinal}`, d.code, d.poa ? `POA ${d.poa}` : null))
          .join("")
      : `<div class="viewer-empty">None</div>`,
    String(claim.diagnoses.length)
  );

  const lines = section(
    "Service / revenue lines",
    claim.serviceLines.length
      ? claim.serviceLines
          .map((l, i) => {
            const pos = l.placeOfService ? decodePlaceOfService(l.placeOfService) : null;
            const mods = l.modifiers.map((m) => {
              const d = decodeModifier(m);
              return d.decoded ? `${m} (${d.decoded})` : m;
            });
            const rev = l.revenueCode ? decodeRevenueCode(l.revenueCode) : null;
            return `<div class="viewer-line">
              <div class="viewer-line-head">Line ${i + 1}${
                l.revenueCode ? ` — rev ${escapeHtml(l.revenueCode)} (${escapeHtml(rev?.decoded ?? l.revenueDescription ?? "?")})` : ""
              }</div>
              ${row("Dates", [l.fromDate, l.thruDate].filter(Boolean).join(" – ") || "—")}
              ${l.procCode ? row("Procedure", l.procCode) : ""}
              ${mods.length ? row("Modifiers", mods.join(", ")) : ""}
              ${l.diagPointers.length ? row("Diag. pointers", l.diagPointers.join(", ")) : ""}
              ${l.placeOfService ? row("Place of service", l.placeOfService, pos?.decoded ?? null) : ""}
              ${row("Units", val(l.units))}
              ${row("Charge", money(l.charge))}
              ${l.patientResponsibility ? row("Patient responsibility", money(l.patientResponsibility)) : ""}
              ${l.chargeId ? row("Charge/control ID", l.chargeId) : ""}
              ${l.toothNumbers ? row("Tooth #", l.toothNumbers) : ""}
            </div>`;
          })
          .join("")
      : `<div class="viewer-empty">None</div>`,
    String(claim.serviceLines.length)
  );

  const totals = section("Totals", [row("Total charge", money(claim.totals.totalCharge)), row("Amount paid", money(claim.totals.amountPaid))].join(""));

  const flags = section(
    "Flags",
    [
      row("Accept assignment", claim.flags.acceptAssignment ? "Yes" : "No"),
      row("Auto accident", claim.flags.autoAccident ? `Yes (${val(claim.flags.autoAccidentState)})` : "No"),
      row("Employment related", claim.flags.employmentRelated ? "Yes" : "No"),
      row("Prior auth", val(claim.flags.priorAuth)),
    ].join("")
  );

  const hospitalization = claim.hospitalization
    ? section("Hospitalization", row("Dates", [claim.hospitalization.from, claim.hospitalization.thru].filter(Boolean).join(" – ") || "—"))
    : "";

  const institutional = claim.institutional
    ? section(
        "Institutional (UB-04)",
        [
          row("Type of bill", claim.institutional.typeOfBill, tob?.combined ?? null),
          row("Statement period", [claim.institutional.statementFrom, claim.institutional.statementThrough].filter(Boolean).join(" – ") || "—"),
          row("Admission date", val(claim.institutional.admissionDate)),
          row("Admission type", val(claim.institutional.admissionType)),
          row("Admission source", val(claim.institutional.admissionSource)),
          row("Patient status", claim.institutional.patientStatus, status?.decoded ?? null),
          claim.institutional.conditionCodes.length
            ? row("Condition codes", claim.institutional.conditionCodes.map((c) => `${c} (${decodeConditionCode(c).decoded ?? "?"})`).join(", "))
            : "",
          claim.institutional.occurrenceCodes.length
            ? row(
                "Occurrence codes",
                claim.institutional.occurrenceCodes.map((o) => `${o.code} ${o.date} (${decodeOccurrenceCode(o.code).decoded ?? "?"})`).join("; ")
              )
            : "",
          claim.institutional.occurrenceSpans.length
            ? row(
                "Occurrence spans",
                claim.institutional.occurrenceSpans
                  .map((o) => `${o.code} ${o.from}–${o.through} (${decodeOccurrenceSpanCode(o.code).decoded ?? "?"})`)
                  .join("; ")
              )
            : "",
          claim.institutional.valueCodes.length
            ? row(
                "Value codes",
                claim.institutional.valueCodes.map((v) => `${v.code} (${decodeValueCode(v.code).decoded ?? "?"}): ${money(v.amount)}`).join("; ")
              )
            : "",
          row("Admitting diagnosis", val(claim.institutional.admittingDiagnosis)),
          row(
            "Principal procedure",
            claim.institutional.principalProcedure ? `${claim.institutional.principalProcedure.code} (${claim.institutional.principalProcedure.date})` : "—"
          ),
          row("DRG", val(claim.institutional.drg)),
        ].join("")
      )
    : "";

  const narrative = claim.narrative || claim.cliaNumber
    ? section("Other", [claim.narrative ? row("Narrative", claim.narrative) : "", claim.cliaNumber ? row("CLIA number", claim.cliaNumber) : ""].join(""))
    : "";

  const warnings = claim.warnings.length
    ? section(
        "Data warnings",
        claim.warnings.map((w) => `<div class="viewer-warning">${escapeHtml(w.message)}</div>`).join(""),
        String(claim.warnings.length)
      )
    : "";

  return `
    <div class="viewer-claim-header">
      <div class="viewer-claim-title">Claim ${escapeHtml(claim.claimId || "(no ID)")}</div>
      <span class="rv-badge ${claim.formType === "unsupported" ? "rv-badge-missing" : "rv-badge-ok"}">${escapeHtml(claim.formType.toUpperCase())}</span>
    </div>
    ${warnings}
    ${patient}${insured}${payer}${otherInsurance}${billing}${rendering}${referring}${facility}
    ${diagnoses}${lines}${totals}${flags}${hospitalization}${institutional}${narrative}
  `;
}

function renderTitlebar(title: string): HTMLElement {
  const bar = el(`
    <div class="bm-titlebar">
      <div class="bm-titlebar-brand"><span class="bm-titlebar-title">${escapeHtml(title)}</span></div>
      <div class="bm-titlebar-controls">
        <button class="bm-titlebar-btn" id="win-minimize" title="Minimize"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
        <button class="bm-titlebar-btn" id="win-maximize" title="Maximize"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="5" width="14" height="14" rx="1"/></svg></button>
        <button class="bm-titlebar-btn bm-titlebar-close" id="win-close" title="Close"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg></button>
      </div>
    </div>
  `);
  bar.querySelector("#win-minimize")!.addEventListener("click", () => window.viewerApi.windowMinimize());
  bar.querySelector("#win-maximize")!.addEventListener("click", () => window.viewerApi.windowMaximizeToggle());
  bar.querySelector("#win-close")!.addEventListener("click", () => window.viewerApi.windowClose());
  return bar;
}

async function init() {
  const app = document.getElementById("app")!;
  const params = new URLSearchParams(location.search);
  const filePath = params.get("file") || "";
  const fileName = filePath.split(/[/\\]/).pop() || "Claim Viewer";

  app.appendChild(renderTitlebar(fileName));
  const main = el(`<div class="rv-main viewer-main"><div class="viewer-loading">Loading…</div></div>`);
  app.appendChild(main);

  const result = await window.viewerApi.readClaimFile(filePath);
  if (!result.ok) {
    main.innerHTML = `<div class="rv-empty"><div class="rv-empty-title">Couldn't open this file</div><div>${escapeHtml(result.error)}</div></div>`;
    return;
  }

  try {
    const source = new X12ClaimSource();
    if (!source.canParse(result.text)) {
      main.innerHTML = `<div class="rv-empty"><div class="rv-empty-title">Not an X12 837 file</div><div>Expected the file to start with an ISA segment.</div></div>`;
      return;
    }
    const claims = source.parse(result.text);
    main.innerHTML = `<div class="viewer-claims">${claims.map(renderClaim).join('<hr class="viewer-claim-divider" />')}</div>`;
  } catch (err) {
    main.innerHTML = `<div class="rv-empty"><div class="rv-empty-title">Couldn't decode this claim</div><div>${escapeHtml((err as Error).message)}</div></div>`;
  }
}

init();
