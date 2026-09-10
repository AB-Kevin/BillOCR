import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import type { Claim, Address, Name, ServiceLine, Diagnosis } from '../../model/claim.js';
import {
  PAGE_WIDTH,
  PAGE_HEIGHT,
  TITLE_RECT,
  HEADER_FIELD_BOXES,
  GRID_TABLE,
  GRID_COLUMNS,
  GRID_COLUMN_X,
  FOOTER_Y,
  toPdfRect,
} from './layout.js';
import type { FieldBox, Rect, GridColumn } from './layout.js';
import { safeText, orDash, fitText, formatMoney, rightAlignX, composeName, composeAddressLine, EM_DASH, embedUnicodeFonts } from '../pdfText.js';

/**
 * Renders a normalized Claim as a UB-04 (CMS-1450) facsimile PDF, following
 * the structure of the approved design (docs/design/ClaimViewer_v2.dc.html,
 * `isUb` block): FL1/2 billing+pay-to provider, FL3a-3b/4/5/6/7 control
 * numbers and bill/statement info, FL8-11 patient identity, FL12-17
 * admission, FL18-28 condition codes, FL31-36 occurrence codes/spans paired
 * with FL39-41 value codes, the FL42-49 shaded-header revenue-line grid
 * with a TOTALS row, FL50/51 payer + FL54/55 payment summary, FL58/59/60/62
 * insured info, FL66/67 diagnoses + FL69/70 admitting/reason diagnosis,
 * FL74 principal procedure, FL76/77/80 attending/operating/remarks, and a
 * CMS-1500-style footer. See layout.ts for the full coordinate map and the
 * design-mapping notes on each section.
 *
 * Same conventions as the CMS-1500 renderer (src/render/cms1500/renderCms1500.ts):
 * self-authored black-and-white facsimile grid, the bundled Unicode TTFs
 * (falling back to StandardFonts) routed through safeText(), fixed
 * metadata/creation date for byte-reproducible output, and "—" for any
 * missing value. See text.ts for the embed/fallback details.
 */

const PRODUCER = 'claim-viewer/ub04-renderer';
const CREATOR = 'claim-viewer';
/** Fixed epoch date so the same claim always produces byte-identical PDFs. */
const FIXED_DATE = new Date(0);
const FIXED_DATE_ISO = '1970-01-01';

const BLACK = rgb(0, 0, 0);
const GRAY = rgb(0.35, 0.35, 0.35);
/** Grid header shade (design: #e3e3e3), matching the CMS-1500 box-24 header shade. */
const SHADE_HEADER = rgb(0.89, 0.89, 0.89);
/** Grid TOTALS-row shade (design: #f0f0f0). */
const SHADE_TOTAL = rgb(0.94, 0.94, 0.94);

const BORDER_WIDTH = 0.75;
const LABEL_SIZE = 5.5;
const LABEL_PAD_TOP = 3;
const LABEL_PAD_X = 3;
const VALUE_TOP_OFFSET = 13; // distance from box top to the first value line's baseline area
const VALUE_LINE_GAP = 9.5; // baseline-to-baseline spacing for multi-line values
const VALUE_MAX_SIZE = 7.5;
const VALUE_MIN_SIZE = 6;

/** Revenue code + description used for the FL42-49 summary row on the last page. */
const TOTAL_LINE_REVENUE_CODE = '0001';

// Tokens-per-line heuristics for the wrapped token lists (condition codes,
// occurrence codes/spans, value codes, diagnoses) — tuned per token length
// for readability. These only affect how content is grouped into lines;
// wrapWithOverflow (below) is what actually guarantees the box never
// overflows regardless of how these are tuned.
const CONDITION_CODES_PER_LINE = 6;
const OCCURRENCE_TOKENS_PER_LINE = 4;
const VALUE_CODES_PER_LINE = 4;
const DIAGNOSES_PER_LINE = 3;

interface Fonts {
  label: PDFFont; // DejaVu Sans (falls back to Helvetica)
  value: PDFFont; // DejaVu Sans Mono (falls back to Courier)
}

export async function renderUb04(claim: Claim): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setProducer(PRODUCER);
  doc.setCreator(CREATOR);
  doc.setTitle(`UB-04 - ${claim.claimId}`);
  doc.setSubject('UB-04 claim facsimile');
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);

  const unicodeFonts = await embedUnicodeFonts(doc);
  const label = unicodeFonts?.sans ?? (await doc.embedFont(StandardFonts.Helvetica));
  const value = unicodeFonts?.mono ?? (await doc.embedFont(StandardFonts.Courier));
  const fonts: Fonts = { label, value };

  const pages = paginateServiceLines(claim.serviceLines);
  const drawnLineCount = pages.reduce((sum, p) => sum + p.length, 0);
  if (drawnLineCount !== claim.serviceLines.length) {
    throw new Error(`UB-04 pagination would drop service lines: paginated ${drawnLineCount} of ${claim.serviceLines.length}.`);
  }

  const totalPages = pages.length;
  let lineNumberOffset = 1; // 1-based line number, running across pages so LN stays continuous.
  pages.forEach((lines, pageIndex) => {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    drawPage(page, fonts, claim, lines, pageIndex, totalPages, lineNumberOffset);
    lineNumberOffset += lines.length;
  });

  return doc.save();
}

// ---------------------------------------------------------------------------
// Pagination — the revenue-line grid has a fixed number of row slots per
// page (GRID_MAX_ROWS); the last page reserves one slot for the 0001 total
// line, so its usable data capacity is one row less than earlier pages.
// ---------------------------------------------------------------------------

function paginateServiceLines(lines: ServiceLine[]): ServiceLine[][] {
  const perPage = GRID_TABLE.maxRowsPerPage;
  const lastPageCapacity = perPage - 1; // one row reserved for the 0001 total line
  const n = lines.length;

  if (n <= lastPageCapacity) return [lines]; // single page, room for the total row too

  const pages: ServiceLine[][] = [];
  let idx = 0;
  // How many full (non-last) pages of `perPage` rows are needed before the
  // remainder fits within the last page's reduced capacity?
  const totalPages = Math.ceil((n - lastPageCapacity) / perPage) + 1;
  for (let p = 0; p < totalPages - 1; p++) {
    pages.push(lines.slice(idx, idx + perPage));
    idx += perPage;
  }
  pages.push(lines.slice(idx)); // remainder, guaranteed <= lastPageCapacity
  return pages;
}

// ---------------------------------------------------------------------------
// Page drawing
// ---------------------------------------------------------------------------

function drawPage(
  page: PDFPage,
  fonts: Fonts,
  claim: Claim,
  lines: ServiceLine[],
  pageIndex: number,
  totalPages: number,
  lineNumberOffset: number,
): void {
  const isLastPage = pageIndex === totalPages - 1;

  drawTitle(page, fonts, claim);

  // The "header" FLs repeat on every page.
  for (const box of HEADER_FIELD_BOXES) {
    drawFieldBox(page, fonts, box, getUb04BoxLines(claim, box));
  }

  drawGridTable(page, fonts, claim, lines, isLastPage, pageIndex, totalPages, lineNumberOffset);
  drawFooter(page, fonts, claim, pageIndex, totalPages, lineNumberOffset + lines.length - 1);
}

function drawTitle(page: PDFPage, fonts: Fonts, claim: Claim): void {
  const claimId = safeText(fonts.label, orDash(claim.claimId));
  const title = `UB-04 (FACSIMILE) ${EM_DASH} CLAIM ${claimId}`;
  page.drawText(title, {
    x: TITLE_RECT.x,
    y: PAGE_HEIGHT - TITLE_RECT.y - TITLE_RECT.height + 2,
    size: 8,
    font: fonts.label,
    color: BLACK,
  });
}

/** Draws a bordered box: number + label at top, then one or more value lines. */
function drawFieldBox(page: PDFPage, fonts: Fonts, box: FieldBox, lines: string[]): void {
  drawFrame(page, box.rect);

  const labelText = safeText(fonts.label, `${box.number ? box.number + ' ' : ''}${box.label}`.trim());
  const labelFit = fitText(fonts.label, labelText, box.rect.width - 2 * LABEL_PAD_X, { maxSize: LABEL_SIZE, minSize: 4 });
  const labelBaselineTopY = box.rect.y + LABEL_PAD_TOP + labelFit.size;
  page.drawText(labelFit.text, {
    x: box.rect.x + LABEL_PAD_X,
    y: PAGE_HEIGHT - labelBaselineTopY,
    size: labelFit.size,
    font: fonts.label,
    color: GRAY,
  });

  const maxWidth = box.rect.width - 2 * LABEL_PAD_X;
  lines.forEach((rawLine, i) => {
    const line = safeText(fonts.value, rawLine);
    const fit = fitText(fonts.value, line, maxWidth, { maxSize: VALUE_MAX_SIZE, minSize: VALUE_MIN_SIZE });
    const baselineTopY = box.rect.y + VALUE_TOP_OFFSET + i * VALUE_LINE_GAP + fit.size;
    // Overflow guard: a box that's too short for all of `lines` (shouldn't
    // happen — every caller sizes its box via maxLinesForHeight — but this
    // is the load-bearing backstop) drops the excess rather than drawing
    // past its own bottom border into whatever sits below it.
    if (baselineTopY > box.rect.y + box.rect.height - 1) return;
    const x =
      box.align === 'right'
        ? rightAlignX(fonts.value, fit.text, fit.size, box.rect.x + box.rect.width, LABEL_PAD_X)
        : box.rect.x + LABEL_PAD_X;
    page.drawText(fit.text, { x, y: PAGE_HEIGHT - baselineTopY, size: fit.size, font: fonts.value, color: BLACK });
  });
}

function drawFrame(page: PDFPage, rect: Rect): void {
  const pdfRect = toPdfRect(rect, PAGE_HEIGHT);
  page.drawRectangle({
    x: pdfRect.x,
    y: pdfRect.y,
    width: pdfRect.width,
    height: pdfRect.height,
    borderColor: BLACK,
    borderWidth: BORDER_WIDTH,
  });
}

// ---------------------------------------------------------------------------
// FL42-49 — revenue-code service line grid
// ---------------------------------------------------------------------------

function drawGridTable(
  page: PDFPage,
  fonts: Fonts,
  claim: Claim,
  lines: ServiceLine[],
  isLastPage: boolean,
  pageIndex: number,
  totalPages: number,
  lineNumberOffset: number,
): void {
  const table = GRID_TABLE;
  const outer: Rect = {
    x: table.x,
    y: table.y,
    width: table.width,
    height: table.headerHeight + table.rowHeight * table.maxRowsPerPage,
  };
  drawFrame(page, outer);

  // Header row (shaded, like the design's #e3e3e3 column-header strip).
  const headerRect: Rect = { x: table.x, y: table.y, width: table.width, height: table.headerHeight };
  page.drawRectangle({ ...toPdfRect(headerRect, PAGE_HEIGHT), color: SHADE_HEADER });
  drawFrame(page, headerRect);
  GRID_COLUMNS.forEach((col, i) => {
    const x = GRID_COLUMN_X[i]!;
    if (i > 0) drawVLine(page, x, table.y, table.y + outer.height);
    const headerText = safeText(fonts.label, col.header);
    const fit = fitText(fonts.label, headerText, col.width - 2 * LABEL_PAD_X, { maxSize: 5.5, minSize: 4.5 });
    page.drawText(fit.text, {
      x: x + LABEL_PAD_X,
      y: PAGE_HEIGHT - (table.y + table.headerHeight - 4),
      size: fit.size,
      font: fonts.label,
      color: GRAY,
    });
  });

  // Body rows: a fixed maxRowsPerPage grid is drawn on every page; unused
  // slots stay blank. The 0001 total line occupies the first slot after the
  // last data row, but only on the last page.
  for (let r = 0; r < table.maxRowsPerPage; r++) {
    const rowTop = table.y + table.headerHeight + r * table.rowHeight;
    const rowRect: Rect = { x: table.x, y: rowTop, width: table.width, height: table.rowHeight };
    const isTotalRow = isLastPage && r === lines.length;
    if (isTotalRow) {
      page.drawRectangle({ ...toPdfRect(rowRect, PAGE_HEIGHT), color: SHADE_TOTAL });
    }
    drawFrame(page, rowRect);
    GRID_COLUMNS.forEach((_col, i) => {
      const x = GRID_COLUMN_X[i]!;
      if (i > 0) drawVLine(page, x, rowTop, rowTop + table.rowHeight);
    });

    const line = lines[r];
    const cells = line ? gridCellValues(line, lineNumberOffset + r) : isTotalRow ? totalRowValues(claim) : null;
    if (!cells) continue; // blank row slot — no data, not a "missing field"

    if (isTotalRow) {
      drawTotalsDescriptionCell(page, fonts, rowTop, table.rowHeight, pageIndex, totalPages);
    }

    GRID_COLUMNS.forEach((col, i) => {
      if (isTotalRow && col.key === 'description') return; // drawn separately above — see drawTotalsDescriptionCell
      const x = GRID_COLUMN_X[i]!;
      const raw = cells[col.key];
      if (raw === '') return; // empty cell for this row (e.g. blank cells on the TOTALS row) — left visually blank, not "—"
      const text = safeText(fonts.value, raw);
      const maxWidth = col.width - 2 * LABEL_PAD_X;
      const fit = fitText(fonts.value, text, maxWidth, { maxSize: VALUE_MAX_SIZE, minSize: VALUE_MIN_SIZE });
      const baselineTopY = rowTop + table.rowHeight / 2 + fit.size / 2 - 1;
      const drawX = col.align === 'right' ? rightAlignX(fonts.value, fit.text, fit.size, x + col.width, LABEL_PAD_X) : x + LABEL_PAD_X;
      page.drawText(fit.text, { x: drawX, y: PAGE_HEIGHT - baselineTopY, size: fit.size, font: fonts.value, color: BLACK });
    });
  }
}

/**
 * The TOTALS row's description cell (design: "PAGE 1 OF 1  CREATION DATE
 * 06/08/26" left, bold "TOTALS" right, justify-content:space-between)
 * needs two independently-sized text runs, not one long fitText() string —
 * a single concatenated string long enough to include both pieces gets
 * shrunk/truncated by fitText well before "TOTALS" would fit, silently
 * dropping the word entirely. Drawing "TOTALS" first at a fixed size and
 * then fitting the left info into whatever width remains guarantees
 * "TOTALS" is always legible.
 */
function drawTotalsDescriptionCell(page: PDFPage, fonts: Fonts, rowTop: number, rowHeight: number, pageIndex: number, totalPages: number): void {
  const colIndex = GRID_COLUMNS.findIndex((c) => c.key === 'description');
  const col = GRID_COLUMNS[colIndex]!;
  const x = GRID_COLUMN_X[colIndex]!;
  const baselineTopY = rowTop + rowHeight / 2 + VALUE_MAX_SIZE / 2 - 1;
  const y = PAGE_HEIGHT - baselineTopY;

  const totalsLabel = 'TOTALS';
  const totalsSize = 6.5;
  const totalsX = rightAlignX(fonts.label, totalsLabel, totalsSize, x + col.width, LABEL_PAD_X);
  page.drawText(totalsLabel, { x: totalsX, y, size: totalsSize, font: fonts.label, color: BLACK });

  const creationDate = formatDateShort(FIXED_DATE_ISO);
  const leftText = safeText(fonts.value, `PAGE ${pageIndex + 1} OF ${totalPages}  CREATION DATE ${creationDate}`);
  const leftMaxWidth = totalsX - LABEL_PAD_X - (x + LABEL_PAD_X);
  const leftFit = fitText(fonts.value, leftText, leftMaxWidth, { maxSize: VALUE_MAX_SIZE, minSize: VALUE_MIN_SIZE });
  page.drawText(leftFit.text, { x: x + LABEL_PAD_X, y, size: leftFit.size, font: fonts.value, color: BLACK });
}

function drawVLine(page: PDFPage, xTop: number, yTopStart: number, yTopEnd: number): void {
  page.drawLine({
    start: { x: xTop, y: PAGE_HEIGHT - yTopStart },
    end: { x: xTop, y: PAGE_HEIGHT - yTopEnd },
    thickness: BORDER_WIDTH,
    color: BLACK,
  });
}

function gridCellValues(line: ServiceLine, lineNumber: number): Record<GridColumn['key'], string> {
  const hcpcs = [line.procCode, ...line.modifiers].filter((p) => p !== '').join(' ');
  return {
    ln: String(lineNumber),
    revCode: orDash(line.revenueCode ?? ''),
    description: orDash(line.revenueDescription ?? ''),
    hcpcs: orDash(hcpcs),
    date: line.fromDate === '' ? EM_DASH : formatDateShort(line.fromDate),
    units: orDash(line.units),
    charges: formatMoney(line.charge),
    // FL48 Non-Covered Charges: the Claim model carries no dedicated
    // "non-covered" amount, so this reuses ServiceLine.patientResponsibility
    // (the per-line amount the patient — not the payer — is responsible
    // for), the closest available field. It's currently always 0 for
    // 837I-sourced claims (the X12 reader doesn't populate it), so this
    // column reads $0.00 until that source gains real data for it.
    nonCovered: formatMoney(line.patientResponsibility),
  };
}

function totalRowValues(claim: Claim): Record<GridColumn['key'], string> {
  const totalNonCovered = claim.serviceLines.reduce((sum, l) => sum + l.patientResponsibility, 0);
  return {
    ln: '',
    revCode: TOTAL_LINE_REVENUE_CODE,
    description: '', // drawn separately — see drawTotalsDescriptionCell
    hcpcs: '',
    date: '',
    units: '',
    charges: formatMoney(claim.totals.totalCharge),
    nonCovered: formatMoney(totalNonCovered),
  };
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function drawFooter(page: PDFPage, fonts: Fonts, claim: Claim, pageIndex: number, totalPages: number, lastLineOnPage: number): void {
  const y = PAGE_HEIGHT - FOOTER_Y;
  const size = 5.5;
  page.drawText('UB-04  CMS-1450  ·  APPROVED OMB NO. 0938-0997', { x: 14, y, size, font: fonts.label, color: GRAY });

  const claimId = safeText(fonts.label, orDash(claim.claimId));
  const rendered = Math.min(lastLineOnPage, claim.serviceLines.length);
  const center = `CLAIM ${claimId}  ·  Service lines: ${rendered} of ${claim.serviceLines.length} rendered  ·  PAGE ${pageIndex + 1} OF ${totalPages}`;
  const centerFit = fitText(fonts.label, center, PAGE_WIDTH - 300, { maxSize: size, minSize: 4.5 });
  const centerWidth = fonts.label.widthOfTextAtSize(centerFit.text, centerFit.size);
  page.drawText(centerFit.text, { x: PAGE_WIDTH / 2 - centerWidth / 2, y, size: centerFit.size, font: fonts.label, color: GRAY });

  const right = 'UNVERIFIED FACSIMILE — NOT AN OFFICIAL FORM';
  const rightX = rightAlignX(fonts.label, right, size, PAGE_WIDTH - 14, 0);
  page.drawText(right, { x: rightX, y, size, font: fonts.label, color: GRAY });
}

// ---------------------------------------------------------------------------
// Claim -> box value mapping
// ---------------------------------------------------------------------------

function formatDateShort(iso: string): string {
  if (iso === '') return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]!.slice(2)}`;
}

function addressLine(addr: Address): string {
  const composed = composeAddressLine(addr);
  return composed === '' ? EM_DASH : composed;
}

function nameOrDash(name: Name): string {
  const composed = composeName(name);
  return composed === '' ? EM_DASH : composed;
}

/** Groups an array of strings into space-padded lines of `perLine` tokens each (simple fixed-count wrap, not width-measured). */
function wrapTokens(tokens: string[], perLine: number): string[] {
  if (tokens.length === 0) return [];
  const lines: string[] = [];
  for (let i = 0; i < tokens.length; i += perLine) {
    lines.push(tokens.slice(i, i + perLine).join('  '));
  }
  return lines;
}

/**
 * A drawn value line's baseline sits at (box.rect.y + VALUE_TOP_OFFSET + i *
 * VALUE_LINE_GAP + fit.size) — see drawFieldBox. This is the inverse of
 * that: the largest number of lines whose LAST line's baseline (at the
 * worst case fit.size, VALUE_MAX_SIZE — fitText only shrinks below that
 * when a line is too wide, never too numerous) still clears the box's
 * bottom border by at least BOTTOM_MARGIN. Always >= 1 so a box is never
 * asked to draw zero lines — a single, possibly-truncated line is always
 * preferable to silently drawing nothing.
 */
const BOTTOM_MARGIN = 2;
export function maxLinesForHeight(height: number): number {
  return Math.max(1, Math.floor((height - VALUE_TOP_OFFSET - VALUE_MAX_SIZE - BOTTOM_MARGIN) / VALUE_LINE_GAP) + 1);
}

/**
 * Wraps `tokens` into lines of `perLine` items, the same as wrapTokens, but
 * NEVER returns more than `maxLines` lines. If the tokens don't fit, the
 * tail is clipped and a visible "+N more" indicator is appended to the last
 * shown line — per the project's overflow policy, an overflow must be
 * visible, never silently dropped or drawn past its box (see the box-height
 * overflow this fixes: FL18-28 / FL31-36 / FL39-41 / FL66-67 can each carry
 * an unbounded number of codes on a real 837I, and every one of those boxes
 * has a small, fixed height).
 */
export function wrapWithOverflow(tokens: string[], perLine: number, maxLines: number): string[] {
  if (tokens.length === 0) return [];
  const capacity = perLine * maxLines;
  if (tokens.length <= capacity) return wrapTokens(tokens, perLine);

  // Reserve one token slot on the last visible line for the "+N more" marker
  // itself, so appending it can never push the line count past maxLines.
  const shownCount = Math.max(1, capacity - 1);
  const shown = tokens.slice(0, shownCount);
  const hidden = tokens.length - shown.length;
  const lines = wrapTokens(shown, perLine);
  const lastIndex = lines.length - 1;
  lines[lastIndex] = `${lines[lastIndex]}  +${hidden} more`;
  return lines;
}

function diagnosisToken(d: Diagnosis): string {
  const poa = d.poa !== '' ? `(${d.poa})` : '';
  const label = d.ordinal === 1 ? 'PRIN' : d.pointer !== '' ? d.pointer : String(d.ordinal);
  return `${label}:${d.code}${poa}`;
}

/** Returns the value line(s) to draw inside a header FieldBox — never more lines than the box's own height can hold (see wrapWithOverflow). */
export function getUb04BoxLines(claim: Claim, box: FieldBox): string[] {
  const inst = claim.institutional;
  const key = box.key;
  const maxLines = maxLinesForHeight(box.rect.height);

  switch (key) {
    // FL1/2/56 — billing provider name/address/phone + NPI. The Claim model
    // has no separate pay-to address (FL2), so it's represented in the
    // label only (real UB-04 billing systems commonly leave pay-to
    // defaulted to the billing provider absent a distinct source field).
    case 'provider': {
      const addrPhone = [addressLine(claim.billingProvider.address), claim.billingProvider.phone !== '' ? `PH: ${claim.billingProvider.phone}` : '']
        .filter((l) => l !== '')
        .join('  ');
      return [orDash(claim.billingProvider.name), addrPhone === '' ? EM_DASH : addrPhone, `NPI: ${orDash(claim.billingProvider.npi)}`];
    }

    // FL3a/3b/5 — patient control #, medical record # (no source field),
    // federal tax ID.
    case 'controlNumbers':
      return [`PCN: ${orDash(claim.patient.accountNumber)}`, `MRN: ${EM_DASH}`, `TAX: ${orDash(claim.billingProvider.taxId)}`];

    // FL4/6/7 — type of bill + statement covers period. FL7 has no source
    // field and no fixed real-world usage either, so it's omitted rather
    // than padded with a bare dash line.
    case 'billInfo': {
      if (!inst) return [EM_DASH];
      const from = formatDateShort(inst.statementFrom);
      const through = formatDateShort(inst.statementThrough);
      const period = from === '' && through === '' ? EM_DASH : `${orDash(from)} - ${orDash(through)}`;
      return [`TOB: ${orDash(inst.typeOfBill)}`, `PERIOD: ${period}`];
    }

    case 'patientName':
      return [nameOrDash(claim.patient.name)];
    case 'patientAddress':
      return [addressLine(claim.patient.address)];
    case 'patientDob':
      return [orDash(formatDateShort(claim.patient.dob))];
    case 'patientSex':
      return [orDash(claim.patient.sex)];

    case 'admission': {
      if (!inst) return [EM_DASH];
      const date = inst.admissionDate === '' ? EM_DASH : formatDateShort(inst.admissionDate);
      return [`ADM: ${date}   TYPE: ${orDash(inst.admissionType)}   SOURCE: ${orDash(inst.admissionSource)}   STATUS: ${orDash(inst.patientStatus)}`];
    }

    case 'conditionCodes': {
      if (!inst || inst.conditionCodes.length === 0) return [EM_DASH];
      return wrapWithOverflow(inst.conditionCodes, CONDITION_CODES_PER_LINE, maxLines);
    }

    case 'occurrence': {
      if (!inst) return [EM_DASH];
      const codes = inst.occurrenceCodes.map((o) => `${o.code}:${formatDateShort(o.date)}`);
      const spans = inst.occurrenceSpans.map((o) => `${o.code}:${formatDateShort(o.from)}-${formatDateShort(o.through)}`);
      // Codes and spans share this one box's line budget — wrap them as a
      // single token stream so the combined line count is clamped together,
      // not clamped independently (which could still add up past maxLines).
      const tokens = [...codes, ...spans];
      return tokens.length > 0 ? wrapWithOverflow(tokens, OCCURRENCE_TOKENS_PER_LINE, maxLines) : [EM_DASH];
    }

    case 'valueCodes': {
      if (!inst || inst.valueCodes.length === 0) return [EM_DASH];
      const tokens = inst.valueCodes.map((v) => `${v.code}:${formatMoney(v.amount)}`);
      return wrapWithOverflow(tokens, VALUE_CODES_PER_LINE, maxLines);
    }

    // FL50/51 — payer name + health plan ID. The design's UB-04 box shows
    // neither payer address nor "Primary/Secondary" order (unlike the
    // CMS-1500 carrier block, which does) — address stays available in the
    // CMS-1500 view and the inspector.
    case 'payer': {
      const idPart = claim.payer.id !== '' ? ` (ID: ${claim.payer.id})` : '';
      return [`${orDash(claim.payer.name)}${idPart}`];
    }

    // FL54/55 — prior payments + est. amount due. The Claim model has no
    // distinct "prior payments" concept; totals.amountPaid is the closest
    // available field (same reuse the CMS-1500 renderer makes for its own
    // BOX29_PAID). Est. amount due is the same total-minus-paid formula the
    // CMS-1500 renderer uses for BOX30_BALANCE.
    case 'paymentSummary': {
      const due = claim.totals.totalCharge - claim.totals.amountPaid;
      return [`PRIOR PMT: ${formatMoney(claim.totals.amountPaid)}`, `EST DUE: ${formatMoney(due)}`];
    }

    // FL58/59/60/62 — insured's name / relationship-to-insured / unique ID
    // (member ID) / group number, combined into one box (see layout.ts's
    // header comment on why several FLs share a box here).
    case 'insuredGroup': {
      const rel = orDash(claim.patient.relationshipToInsured);
      const id = orDash(claim.insured.memberId);
      const grp = orDash(claim.insured.group);
      return [nameOrDash(claim.insured.name), `REL: ${rel}   ID: ${id}   GRP: ${grp}`];
    }

    // FL66/67 — the ICD indicator (FL66) is a fixed "this claim uses
    // ICD-10" assumption baked into the box label (the design does the
    // equivalent for CMS-1500's box 21, "ICD Ind. 0"), not claim data. The
    // admitting diagnosis used to be folded into this same token stream;
    // it now has its own box (admitReasonDx below), matching the design's
    // separate FL69/70 box.
    case 'diagnoses': {
      const tokens = claim.diagnoses.map(diagnosisToken);
      return tokens.length > 0 ? wrapWithOverflow(tokens, DIAGNOSES_PER_LINE, maxLines) : [EM_DASH];
    }

    // FL69/70 — admitting diagnosis + patient-reason-for-visit diagnosis.
    // The Claim model has no patient-reason-diagnosis field, so FL70 always
    // shows "—".
    case 'admitReasonDx': {
      const admit = inst && inst.admittingDiagnosis !== '' ? inst.admittingDiagnosis : EM_DASH;
      return [`69: ${admit}   70: ${EM_DASH}`];
    }

    // FL76/77 — attending + operating provider. The Claim model has no
    // distinct attending-physician field (the 837I reader parses an NM1*71
    // loop but doesn't map it into the model), so this reuses
    // renderingProvider — the same stand-in the CMS-1500 renderer uses for
    // its own box 31 "signature of physician or supplier". Operating
    // provider (FL77) has no fallback field at all and always shows "—".
    case 'attendingOperating': {
      const att = `ATT: ${nameOrDash(claim.renderingProvider.name)}  NPI: ${orDash(claim.renderingProvider.npi)}`;
      return [att, `OPR: ${EM_DASH}`];
    }

    // FL80 — remarks.
    case 'remarks':
      return [orDash(claim.narrative)];

    case 'principalProcedure': {
      if (!inst || !inst.principalProcedure) return [EM_DASH];
      const { code, date } = inst.principalProcedure;
      return [`${orDash(code)} (${date === '' ? EM_DASH : formatDateShort(date)})`];
    }

    default:
      return [EM_DASH];
  }
}
