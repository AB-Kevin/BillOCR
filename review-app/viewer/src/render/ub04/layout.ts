/**
 * Self-authored UB-04 (CMS-1450) coordinate map.
 *
 * Like the CMS-1500 layout (src/render/cms1500/layout.ts), this is OUR OWN
 * clean, readable, black-and-white facsimile grid — it does NOT reproduce
 * the official UB-04 form geometry pixel-for-pixel. Its structure follows
 * the approved design (docs/design/ClaimViewer_v2.dc.html, the `isUb`
 * block): FL1/2 billing+pay-to provider, FL3a/3b/5 control numbers, FL4/6/7
 * type-of-bill + statement period, FL8-11 patient identity, FL12-17
 * admission, FL18-28 condition codes, FL31-36 occurrence codes/spans (paired
 * with FL39-41 value codes on one row, mirroring the design), the FL42-49
 * revenue-line grid (with a leading LN column and a shaded header/totals
 * row), FL50/51 payer + FL54/55 payment summary, FL58/59/60/62 insured
 * info, FL66/67 diagnoses + FL69/70 admitting/reason diagnosis, FL74
 * principal procedure, and FL76/77/80 attending/operating/remarks.
 *
 * Several design boxes fold more than one form-locator into a single
 * bordered box with multiple prefixed value lines (e.g. "3a/3b/5") rather
 * than one tiny box per FL — the Claim model doesn't carry a distinct field
 * for every FL (pay-to address, medical record #, operating provider, ...),
 * and one-box-per-FL would blow the US-Letter page budget once the FL42-49
 * grid's fixed 22-row capacity is accounted for. See the design-mapping
 * comments in renderUb04.ts's getUb04BoxLines for exactly which FLs share a
 * box and why.
 *
 * Coordinates are TOP-LEFT origin (see cms1500/layout.ts for the
 * rationale); `toPdfRect` flips to pdf-lib's bottom-left origin at draw
 * time so nothing outside this module needs to think about the flip.
 */

export const PAGE_WIDTH = 612; // US Letter, points
export const PAGE_HEIGHT = 792;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Converts a top-left-origin rect to pdf-lib's bottom-left-origin rect. */
export function toPdfRect(rect: Rect, pageHeight: number = PAGE_HEIGHT): Rect {
  return { x: rect.x, y: pageHeight - rect.y - rect.height, width: rect.width, height: rect.height };
}

/** A single labeled, bordered field box on the form. `key` identifies the Claim-derived value the renderer draws inside it. */
export interface FieldBox {
  key: string;
  /** UB-04 form-locator number(s), e.g. "4", "67 / 69". '' for boxes with no official number. */
  number: string;
  label: string;
  rect: Rect;
  align?: 'left' | 'right';
}

// ---------------------------------------------------------------------------
// Layout constants — tune these and the whole page reflows.
// ---------------------------------------------------------------------------

const MARGIN = 24;
const ROW_GAP = 2;
const FULL_W = PAGE_WIDTH - 2 * MARGIN; // 564
const COL_GAP = 12;
const COL_W = (FULL_W - COL_GAP) / 2; // 276
const LEFT_X = MARGIN;
const RIGHT_X = MARGIN + COL_W + COL_GAP;

// A small top title ("UB-04 (FACSIMILE) — CLAIM x") — not part of the
// design (the isUb mock starts directly at FL1) but a practical addition
// (matches the CMS-1500 renderer's masthead) so a printed/scrolled page is
// still identifiable. Kept deliberately short: the FL42-49 grid's fixed
// 22-row capacity already claims most of the page height budget, and page
// number now lives solely in the footer (see FOOTER_Y) rather than being
// duplicated up here too.
const TITLE_Y = 14;
export const TITLE_RECT: Rect = { x: MARGIN, y: TITLE_Y, width: FULL_W, height: 10 };

// A small cursor-based builder so row Y positions are computed, not
// hand-copied — keeps the layout easy to re-tune without arithmetic drift.
let cursor = TITLE_Y + 10;
function takeRow(height: number): number {
  const top = cursor;
  cursor += height + ROW_GAP;
  return top;
}

// --- Row A: FL1/2/56 billing+pay-to provider | FL3a/3b/5 control numbers | FL4/6/7 bill type + statement period ---
const ROW_A_H = 42; // tallest box in this row (provider + control numbers) needs 3 value lines; see maxLinesForHeight.
const rowA = takeRow(ROW_A_H);
const ROW_A_COL1_W = 260; // provider
const ROW_A_COL2_W = 140; // control numbers
const ROW_A_COL3_W = FULL_W - ROW_A_COL1_W - ROW_A_COL2_W - 2 * COL_GAP; // 144 — bill type + statement period
const ROW_A_COL2_X = LEFT_X + ROW_A_COL1_W + COL_GAP;
const ROW_A_COL3_X = ROW_A_COL2_X + ROW_A_COL2_W + COL_GAP;

// --- Row B: FL8 patient name | FL9 patient address | FL10 birthdate | FL11 sex (all single-line) ---
const ROW_B_H = 22;
const rowB = takeRow(ROW_B_H);
const ROW_B_DOB_W = 70;
const ROW_B_SEX_W = 40;
const ROW_B_ADDR_W = 180;
const ROW_B_NAME_W = FULL_W - ROW_B_ADDR_W - ROW_B_DOB_W - ROW_B_SEX_W - 3 * COL_GAP; // 244
const ROW_B_ADDR_X = LEFT_X + ROW_B_NAME_W + COL_GAP;
const ROW_B_DOB_X = ROW_B_ADDR_X + ROW_B_ADDR_W + COL_GAP;
const ROW_B_SEX_X = ROW_B_DOB_X + ROW_B_DOB_W + COL_GAP;

// --- Row C: admission date/type/source/status (FL12-17), full width ---
const rowC = takeRow(22);
// --- Row D: condition codes (FL18-28) | accident state (FL29) + reserved (FL30) alongside, mirroring the real form's layout ---
const rowD = takeRow(22);
const ROW_D_ACDT_W = 70;
const ROW_D_CONDITION_W = FULL_W - ROW_D_ACDT_W - COL_GAP;
const ROW_D_ACDT_X = LEFT_X + ROW_D_CONDITION_W + COL_GAP;
// --- Row E: occurrence codes/spans (FL31-36) | value codes (FL39-41) — side by side, mirroring the design's single-row grouping ---
// Taller than the single-line rows above: these two boxes hold a variable,
// unbounded-on-a-real-837I list of codes (see the height-clamping note on
// getUb04BoxLines/wrapWithOverflow in renderUb04.ts) — the extra height
// buys a genuine 2-line capacity with real margin, rather than clamping
// straight down to 1 line for every claim that has more than a couple of
// codes.
const OCCURRENCE_VALUE_ROW_H = 38;
const rowE = takeRow(OCCURRENCE_VALUE_ROW_H);

// ---------------------------------------------------------------------------
// FL42-49 — revenue-code service line grid.
// ---------------------------------------------------------------------------

const GRID_HEADER_H = 16;
export const GRID_ROW_H = 18;
/** Data rows drawn per page. On the last page, one of these slots is reserved for the 0001 total line. */
export const GRID_MAX_ROWS = 22;
const gridTop = takeRow(GRID_HEADER_H + GRID_ROW_H * GRID_MAX_ROWS);

export interface GridColumn {
  key: 'ln' | 'revCode' | 'description' | 'hcpcs' | 'date' | 'units' | 'charges' | 'nonCovered';
  header: string;
  width: number;
  align?: 'left' | 'right';
}

// Column widths mirror the design's LN/42/43/44/45/46/47/48 proportions,
// scaled to this page's content width (FULL_W).
export const GRID_COLUMNS: GridColumn[] = [
  { key: 'ln', header: 'LN', width: 22 },
  { key: 'revCode', header: '42 REV CD', width: 42 },
  { key: 'description', header: '43 DESCRIPTION', width: 154 },
  { key: 'hcpcs', header: '44 HCPCS / RATE', width: 94 },
  { key: 'date', header: '45 SERV DATE', width: 58 },
  { key: 'units', header: '46 SERV UNITS', width: 40, align: 'right' },
  { key: 'charges', header: '47 TOTAL CHARGES', width: 82, align: 'right' },
  { key: 'nonCovered', header: '48 NON-COVERED', width: 72, align: 'right' },
];

export const GRID_TABLE = {
  x: LEFT_X,
  y: gridTop,
  width: FULL_W,
  headerHeight: GRID_HEADER_H,
  rowHeight: GRID_ROW_H,
  maxRowsPerPage: GRID_MAX_ROWS,
};

/** Left X of each grid column, in table order. */
export const GRID_COLUMN_X: number[] = (() => {
  const xs: number[] = [];
  let x = GRID_TABLE.x;
  for (const col of GRID_COLUMNS) {
    xs.push(x);
    x += col.width;
  }
  return xs;
})();

// --- Row F: FL50/51 payer name + health plan ID | FL54/55 prior payments + est. amount due ---
const ROW_F_H = 32;
const rowF = takeRow(ROW_F_H);
const ROW_F_COL2_W = 222;
const ROW_F_COL1_W = FULL_W - ROW_F_COL2_W - COL_GAP; // 330
const ROW_F_COL2_X = LEFT_X + ROW_F_COL1_W + COL_GAP;

// --- Row G: FL58/59/60/62 insured's name / relationship / unique ID / group no. — one full-width box ---
const ROW_G_H = 32;
const rowG = takeRow(ROW_G_H);

// --- Row H: FL66/67 diagnoses | FL69/70 admitting + patient-reason diagnosis ---
const ROW_H_H = 40;
const rowH = takeRow(ROW_H_H);
const ROW_H_COL2_W = 220;
const ROW_H_GAP = 14;
const ROW_H_COL1_W = FULL_W - ROW_H_COL2_W - ROW_H_GAP; // 330
const ROW_H_COL2_X = LEFT_X + ROW_H_COL1_W + ROW_H_GAP;

// --- Row I: FL76/77 attending + operating provider | FL80 remarks ---
const ROW_I_H = 32;
const rowI = takeRow(ROW_I_H);
const ROW_I_GAP = 14;
const ROW_I_COL2_W = 270;
const ROW_I_COL1_W = FULL_W - ROW_I_COL2_W - ROW_I_GAP; // 280
const ROW_I_COL2_X = LEFT_X + ROW_I_COL1_W + ROW_I_GAP;

// --- Row J: principal procedure (FL74), full width ---
const rowJ = takeRow(22);

/** Boxes redrawn on every page (the UB-04 "header" — everything except the revenue-line grid and its 0001 total). */
export const HEADER_FIELD_BOXES: FieldBox[] = [
  { key: 'provider', number: '1 / 2 / 56', label: 'BILLING PROVIDER (PAY-TO SAME) / ADDRESS / PHONE / NPI', rect: { x: LEFT_X, y: rowA, width: ROW_A_COL1_W, height: ROW_A_H } },
  { key: 'controlNumbers', number: '3a / 3b / 5', label: 'PAT. CNTL # / MED. REC. # / FED. TAX NO.', rect: { x: ROW_A_COL2_X, y: rowA, width: ROW_A_COL2_W, height: ROW_A_H } },
  { key: 'billInfo', number: '4 / 6 / 7', label: 'TYPE OF BILL / STATEMENT COVERS PERIOD', rect: { x: ROW_A_COL3_X, y: rowA, width: ROW_A_COL3_W, height: ROW_A_H } },

  { key: 'patientName', number: '8', label: 'PATIENT NAME', rect: { x: LEFT_X, y: rowB, width: ROW_B_NAME_W, height: ROW_B_H } },
  { key: 'patientAddress', number: '9', label: 'PATIENT ADDRESS', rect: { x: ROW_B_ADDR_X, y: rowB, width: ROW_B_ADDR_W, height: ROW_B_H } },
  { key: 'patientDob', number: '10', label: 'BIRTHDATE', rect: { x: ROW_B_DOB_X, y: rowB, width: ROW_B_DOB_W, height: ROW_B_H } },
  { key: 'patientSex', number: '11', label: 'SEX', rect: { x: ROW_B_SEX_X, y: rowB, width: ROW_B_SEX_W, height: ROW_B_H } },

  { key: 'admission', number: '12-17', label: 'ADMISSION DATE / TYPE / SOURCE / PATIENT STATUS', rect: { x: LEFT_X, y: rowC, width: FULL_W, height: 22 } },

  { key: 'conditionCodes', number: '18-28', label: 'CONDITION CODES', rect: { x: LEFT_X, y: rowD, width: ROW_D_CONDITION_W, height: 22 } },
  // FL29/30 — accident state + reserved. claim.flags.autoAccidentState
  // already exists (used by the CMS-1500 renderer's own box 10b) but had no
  // home on the UB-04 facsimile at all; FL30 has no source field and is
  // drawn reserved, matching the 9b/10c/10d treatment on the CMS-1500 side.
  { key: 'acdtStateReserved', number: '29 / 30', label: 'ACDT STATE / RESERVED', rect: { x: ROW_D_ACDT_X, y: rowD, width: ROW_D_ACDT_W, height: 22 } },

  { key: 'occurrence', number: '31-36', label: 'OCCURRENCE CODES / SPANS', rect: { x: LEFT_X, y: rowE, width: COL_W, height: OCCURRENCE_VALUE_ROW_H } },
  { key: 'valueCodes', number: '39-41', label: 'VALUE CODES', rect: { x: RIGHT_X, y: rowE, width: COL_W, height: OCCURRENCE_VALUE_ROW_H } },

  { key: 'payer', number: '50 / 51', label: 'PAYER NAME / HEALTH PLAN ID', rect: { x: LEFT_X, y: rowF, width: ROW_F_COL1_W, height: ROW_F_H } },
  { key: 'paymentSummary', number: '54 / 55', label: 'PRIOR PAYMENTS / EST. AMOUNT DUE', rect: { x: ROW_F_COL2_X, y: rowF, width: ROW_F_COL2_W, height: ROW_F_H }, align: 'right' },

  { key: 'insuredGroup', number: '58 / 59 / 60 / 62', label: "INSURED'S NAME / REL. / UNIQUE ID / GROUP NO.", rect: { x: LEFT_X, y: rowG, width: FULL_W, height: ROW_G_H } },

  { key: 'diagnoses', number: '66 / 67', label: 'DX QUALIFIER (ICD-10) · PRINCIPAL & OTHER DIAGNOSIS CODES (W/ POA)', rect: { x: LEFT_X, y: rowH, width: ROW_H_COL1_W, height: ROW_H_H } },
  { key: 'admitReasonDx', number: '69 / 70', label: 'ADMIT DX / PATIENT REASON DX', rect: { x: ROW_H_COL2_X, y: rowH, width: ROW_H_COL2_W, height: ROW_H_H } },

  { key: 'attendingOperating', number: '76 / 77', label: 'ATTENDING NPI / NAME  ·  OPERATING', rect: { x: LEFT_X, y: rowI, width: ROW_I_COL1_W, height: ROW_I_H } },
  { key: 'remarks', number: '80', label: 'REMARKS', rect: { x: ROW_I_COL2_X, y: rowI, width: ROW_I_COL2_W, height: ROW_I_H } },

  { key: 'principalProcedure', number: '74', label: 'PRINCIPAL PROCEDURE CODE / DATE', rect: { x: LEFT_X, y: rowJ, width: FULL_W, height: 22 } },
];

export const CONTENT_BOTTOM = cursor;

// --- Footer — mirrors the CMS-1500 renderer's 3-part footer (left static /
// center claim+page info / right static disclaimer), and is now the ONLY
// place page number is drawn (the old top-right page-stamp box was removed
// to make room for the design's extra FL boxes within budget). ---
export const FOOTER_Y = PAGE_HEIGHT - 20;
