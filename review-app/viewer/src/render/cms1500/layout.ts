/**
 * Self-authored CMS-1500 coordinate map.
 *
 * This is OUR OWN clean, readable, black-and-white facsimile grid — it does
 * NOT reproduce the official CMS-1500 form geometry pixel-for-pixel. Its
 * structure follows the approved design (docs/design/ClaimViewer_v2.dc.html,
 * the `isCms` block): the "1500" mark + title, a carrier/payer block
 * top-right, PICA boxes, three vertical bands with rotated section labels
 * ("CARRIER", "PATIENT AND INSURED INFORMATION", "PHYSICIAN OR SUPPLIER
 * INFORMATION"), boxes 1-13 in a two/three-column layout with checkbox rows
 * for 1/3/6/10/11a/11d, boxes 14-23, the box-24 service grid (a shaded
 * supplemental sub-row above each of 6 detail rows), boxes 25-30, and the
 * 31/32/33 provider blocks, plus a footer.
 *
 * The design canvas is 816x1056px (US-Letter @96dpi); this page is 612x792pt
 * (US-Letter @72dpi) — the same physical page. Coordinates below were
 * re-derived in points (not pixel-copied) to reproduce the design's
 * structure and proportions cleanly; see the inline comments at each
 * section for the design element they correspond to.
 *
 * Coordinates are TOP-LEFT origin (y grows downward) because that's how a
 * form is easiest to reason about and tune. `toPdfRect` converts a box to
 * pdf-lib's bottom-left origin only at draw time, so nothing outside this
 * module needs to think about the flip.
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
  /** CMS-1500 box number, e.g. "1a", "24E". '' for boxes with no official number (e.g. the payer block). */
  number: string;
  label: string;
  rect: Rect;
  /** Value text alignment inside the box; defaults to left. */
  align?: 'left' | 'right';
}

// ---------------------------------------------------------------------------
// Page frame — margins, the two vertical bands' shared content/label split.
// ---------------------------------------------------------------------------

const MARGIN_X = 14;
const TOP_MARGIN = 12;
export const FULL_W = PAGE_WIDTH - 2 * MARGIN_X; // 584
/** Width of the rotated section-label strip that runs along the right edge of each band (design: the order:2 14px column). */
export const LABEL_STRIP_W = 10;
/** Width available to band content, left of the label strip. */
const CONTENT_W = FULL_W - LABEL_STRIP_W; // 574
const LEFT_X = MARGIN_X;
const LABEL_STRIP_X = MARGIN_X + CONTENT_W; // 588

// ---------------------------------------------------------------------------
// Header — "1500" mark, title, NUCC note (left) + carrier/payer block (right).
// ---------------------------------------------------------------------------

export const HEADER_TAG_RECT: Rect = { x: LEFT_X, y: TOP_MARGIN, width: 30, height: 12 };
// Gap below the "1500" tag box large enough that the title's own ascenders
// (drawn at 8pt) clear the tag box's bottom edge with margin, rather than
// just clearing its own baseline.
export const HEADER_TITLE_Y = TOP_MARGIN + HEADER_TAG_RECT.height + 9;
export const HEADER_NUCC_NOTE_Y = HEADER_TITLE_Y + 9;
const HEADER_H = 48;
export const PAYER_BLOCK: Rect = { x: PAGE_WIDTH - MARGIN_X - 220, y: TOP_MARGIN, width: 220, height: HEADER_H };
const headerBottom = TOP_MARGIN + HEADER_H;

// --- PICA boxes ---------------------------------------------------------
const PICA_TOP = headerBottom + 3;
const PICA_H = 9;
export const PICA_LEFT: Rect = { x: LEFT_X, y: PICA_TOP, width: 26, height: PICA_H };
export const PICA_RIGHT: Rect = { x: LABEL_STRIP_X + LABEL_STRIP_W - 26, y: PICA_TOP, width: 26, height: PICA_H };
const bandsTop = PICA_TOP + PICA_H + 2;

// ---------------------------------------------------------------------------
// Band 1 — "CARRIER": box 1 (insurance type, structural only — the Claim
// model carries no payer-program-type field) + box 1a (insured ID).
// ---------------------------------------------------------------------------

const BAND1_H = 26;
export const BAND1_TOP = bandsTop;
const band1Bottom = BAND1_TOP + BAND1_H;
export const BOX1: Rect = { x: LEFT_X, y: BAND1_TOP, width: 386, height: BAND1_H };
export const BOX1A: FieldBox = {
  key: 'insured.memberId',
  number: '1a',
  label: "INSURED'S I.D. NUMBER (For Program in Item 1)",
  rect: { x: LEFT_X + 386, y: BAND1_TOP, width: CONTENT_W - 386, height: BAND1_H },
};
export const BAND1_LABEL_RECT: Rect = { x: LABEL_STRIP_X, y: BAND1_TOP, width: LABEL_STRIP_W, height: BAND1_H };

// ---------------------------------------------------------------------------
// Band 2 — "PATIENT AND INSURED INFORMATION": boxes 2-11d in a 3-column
// grid, the "READ BACK OF FORM" bar, and boxes 12/13 (unbordered-label row,
// no signature fields in the Claim model).
// ---------------------------------------------------------------------------

// 20pt (not the tightest fit) so the checkbox-row boxes in this grid (sex,
// relationship, employment/auto-accident, other-health-plan) have room for
// their number+label line AND a clearly separated checkbox row beneath it.
const ROW_H = 20;
const COL1_X = LEFT_X;
const COL1_W = 240;
const COL2_X = COL1_X + COL1_W;
const COL2_W = 146;
const COL3_X = COL2_X + COL2_W;
const COL3_W = CONTENT_W - COL1_W - COL2_W; // 188

/** col1 has 7 rows (2, 5, city/state/zip+phone, 9, 9a, 9b, 9d); col3 carries an extra 8th row (11c) the design's mock omits but the JSON field map still needs a home for. */
const COL1_ROWS = 7;
const COL2_ROWS = 6;
const COL3_ROWS = 8;
const gridBottom = bandsTop + BAND1_H + Math.max(COL1_ROWS, COL2_ROWS, COL3_ROWS) * ROW_H;
const GRID_TOP = band1Bottom;

function colRow(x: number, width: number, rowIndex: number): Rect {
  return { x, y: GRID_TOP + rowIndex * ROW_H, width, height: ROW_H };
}

/** Plain (non-checkbox) boxes drawn via the generic label+value renderer. */
export const FIELD_BOXES: FieldBox[] = [
  { key: 'patient.name', number: '2', label: "PATIENT'S NAME (Last, First, Middle Initial)", rect: colRow(COL1_X, COL1_W, 0) },
  { key: 'patient.addressStreet', number: '5', label: "PATIENT'S ADDRESS (No., Street)", rect: colRow(COL1_X, COL1_W, 1) },
  { key: 'patient.cityStateZipPhone', number: '', label: 'CITY / STATE / ZIP / TELEPHONE', rect: colRow(COL1_X, COL1_W, 2) },
  { key: 'otherInsurance.name', number: '9', label: "OTHER INSURED'S NAME (Last, First, Middle Initial)", rect: colRow(COL1_X, COL1_W, 3) },
  { key: 'otherInsurance.policyOrGroup', number: '9a', label: "OTHER INSURED'S POLICY OR GROUP NUMBER", rect: colRow(COL1_X, COL1_W, 4) },
  { key: 'reserved9b', number: '9b', label: 'RESERVED FOR NUCC USE', rect: colRow(COL1_X, COL1_W, 5) },
  { key: 'otherInsurance.plan', number: '9d', label: 'INSURANCE PLAN NAME OR PROGRAM NAME', rect: colRow(COL1_X, COL1_W, 6) },

  { key: 'reserved10c', number: '10c', label: 'OTHER ACCIDENT?', rect: colRow(COL2_X, COL2_W, 4) },
  { key: 'reserved10d', number: '10d', label: 'CLAIM CODES (Designated by NUCC)', rect: colRow(COL2_X, COL2_W, 5) },

  { key: 'insured.name', number: '4', label: "INSURED'S NAME (Last, First, Middle Initial)", rect: colRow(COL3_X, COL3_W, 0) },
  { key: 'insured.addressStreet', number: '7', label: "INSURED'S ADDRESS (No., Street)", rect: colRow(COL3_X, COL3_W, 1) },
  { key: 'insured.cityStateZip', number: '', label: 'CITY / STATE / ZIP', rect: colRow(COL3_X, COL3_W, 2) },
  { key: 'insured.group', number: '11', label: "INSURED'S POLICY GROUP OR FECA NUMBER", rect: colRow(COL3_X, COL3_W, 3) },
  // The Claim model has no "other claim ID" field from the JSON feed (see
  // docs/PLAN_REVISION_v2_JSON.md §5, which maps 11b -> ins_employer); the
  // label reflects the value actually drawn here rather than the NUCC
  // default, so the two stay consistent instead of mismatched.
  { key: 'insured.employer', number: '11b', label: "INSURED'S EMPLOYER NAME", rect: colRow(COL3_X, COL3_W, 5) },
  { key: 'insured.plan', number: '11c', label: 'INSURANCE PLAN NAME OR PROGRAM NAME', rect: colRow(COL3_X, COL3_W, 6) },
];

/** Checkbox-style boxes — drawn with a dedicated helper in the renderer rather than the generic value renderer. */
export const BOX3_SEX: FieldBox = { key: 'patient.dobSex', number: '3', label: "PATIENT'S BIRTH DATE / SEX", rect: colRow(COL2_X, COL2_W, 0) };
export const BOX6_RELATIONSHIP: FieldBox = { key: 'patient.relationship', number: '6', label: 'PATIENT RELATIONSHIP TO INSURED', rect: colRow(COL2_X, COL2_W, 1) };
export const BOX10A_EMPLOYMENT: FieldBox = { key: 'flags.employmentRelated', number: '10a', label: "IS PATIENT'S CONDITION RELATED TO: EMPLOYMENT?", rect: colRow(COL2_X, COL2_W, 2) };
export const BOX10B_AUTO: FieldBox = { key: 'flags.autoAccident', number: '10b', label: 'AUTO ACCIDENT? (PLACE)', rect: colRow(COL2_X, COL2_W, 3) };
export const BOX11A_SEX: FieldBox = { key: 'insured.dobSex', number: '11a', label: "INSURED'S DATE OF BIRTH / SEX", rect: colRow(COL3_X, COL3_W, 4) };
export const BOX11D_OTHER_PLAN: FieldBox = { key: 'otherInsurance.present', number: '11d', label: 'IS THERE ANOTHER HEALTH BENEFIT PLAN?', rect: colRow(COL3_X, COL3_W, 7) };

export const BAND2_LABEL_RECT: Rect = { x: LABEL_STRIP_X, y: GRID_TOP, width: LABEL_STRIP_W, height: gridBottom - GRID_TOP };

// --- "READ BACK OF FORM" bar + boxes 12/13 --------------------------------
export const READBACK_RECT: Rect = { x: LEFT_X, y: gridBottom, width: FULL_W, height: 9 };
const sigTop = gridBottom + 9;
const SIG_H = 22;
export const BOX12_SIGNATURE: FieldBox = { key: 'reserved12', number: '12', label: "PATIENT'S OR AUTHORIZED PERSON'S SIGNATURE", rect: { x: LEFT_X, y: sigTop, width: CONTENT_W - COL3_W, height: SIG_H } };
export const BOX13_SIGNATURE: FieldBox = { key: 'reserved13', number: '13', label: "INSURED'S OR AUTHORIZED PERSON'S SIGNATURE", rect: { x: COL3_X, y: sigTop, width: COL3_W, height: SIG_H } };
export const SIG_ROW_LABEL_STRIP: Rect = { x: LABEL_STRIP_X, y: sigTop, width: LABEL_STRIP_W, height: SIG_H };
const band2Bottom = sigTop + SIG_H;

// ---------------------------------------------------------------------------
// Band 3 — "PHYSICIAN OR SUPPLIER INFORMATION": boxes 14-23, the box-24
// service grid, boxes 25-30, and the 31/32/33 provider blocks.
// ---------------------------------------------------------------------------

export const BAND3_TOP = band2Bottom;

const ROW3_H = 18;
const B3_COL_A_X = LEFT_X;
const B3_COL_A_W = 239;
const B3_COL_B_X = B3_COL_A_X + B3_COL_A_W;
const B3_COL_B_W = 147;
const B3_COL_C_X = B3_COL_B_X + B3_COL_B_W;
const B3_COL_C_W = CONTENT_W - B3_COL_A_W - B3_COL_B_W; // 188

function b3Row3(y: number): [Rect, Rect, Rect] {
  return [
    { x: B3_COL_A_X, y, width: B3_COL_A_W, height: ROW3_H },
    { x: B3_COL_B_X, y, width: B3_COL_B_W, height: ROW3_H },
    { x: B3_COL_C_X, y, width: B3_COL_C_W, height: ROW3_H },
  ];
}

const row1416Y = BAND3_TOP;
const row1718Y = row1416Y + ROW3_H;
const row1920Y = row1718Y + ROW3_H;
const [box14Rect, box15Rect, box16Rect] = b3Row3(row1416Y);
const [box17Rect, box17abRect, box18Rect] = b3Row3(row1718Y);

export const BAND3_HEADER_BOXES: FieldBox[] = [
  { key: 'reserved14', number: '14', label: 'DATE OF CURRENT ILLNESS, INJURY, OR PREGNANCY (LMP)', rect: box14Rect },
  { key: 'reserved15', number: '15', label: 'OTHER DATE', rect: box15Rect },
  { key: 'reserved16', number: '16', label: 'DATES PATIENT UNABLE TO WORK', rect: box16Rect },

  { key: 'referringProvider.name', number: '17', label: 'NAME OF REFERRING PROVIDER OR OTHER SOURCE', rect: box17Rect },
  { key: 'referringProvider.idNpi', number: '17a / 17b', label: 'OTHER ID / NPI', rect: box17abRect },
  { key: 'hospitalization', number: '18', label: 'HOSPITALIZATION DATES RELATED TO CURRENT SERVICES', rect: box18Rect },

  { key: 'narrative', number: '19', label: 'ADDITIONAL CLAIM INFORMATION (Designated by NUCC)', rect: { x: B3_COL_A_X, y: row1920Y, width: CONTENT_W - B3_COL_C_W, height: ROW3_H } },
  { key: 'reserved20', number: '20', label: 'OUTSIDE LAB? / $ CHARGES', rect: { x: B3_COL_C_X, y: row1920Y, width: B3_COL_C_W, height: ROW3_H } },
];

// --- Box 21 diagnoses (single box, label + 4x3 code grid, no per-cell borders) + 22/23 ---
const diagTop = row1920Y + ROW3_H;
const DIAG_H = 54;
export const DIAG_BOX: Rect = { x: B3_COL_A_X, y: diagTop, width: CONTENT_W - B3_COL_C_W, height: DIAG_H };
const DIAG_LABEL_H = 9;
const DIAG_COL_W = DIAG_BOX.width / 4;
const DIAG_ROW_H = (DIAG_H - DIAG_LABEL_H) / 3;

export interface DiagCell {
  letter: string; // 'A'..'L'
  rect: Rect; // text-anchor rect; no frame is drawn around individual cells
}

export const DIAG_CELLS: DiagCell[] = (() => {
  const cells: DiagCell[] = [];
  for (let i = 0; i < 12; i++) {
    const row = Math.floor(i / 4);
    const col = i % 4;
    cells.push({
      letter: String.fromCharCode(65 + i), // A..L
      rect: {
        x: DIAG_BOX.x + col * DIAG_COL_W,
        y: DIAG_BOX.y + DIAG_LABEL_H + row * DIAG_ROW_H,
        width: DIAG_COL_W,
        height: DIAG_ROW_H,
      },
    });
  }
  return cells;
})();

export const BOX22: FieldBox = { key: 'reserved22', number: '22', label: 'RESUBMISSION CODE / ORIGINAL REF. NO.', rect: { x: B3_COL_C_X, y: diagTop, width: B3_COL_C_W, height: DIAG_H / 2 } };
export const BOX23: FieldBox = { key: 'flags.priorAuth', number: '23', label: 'PRIOR AUTHORIZATION NUMBER', rect: { x: B3_COL_C_X, y: diagTop + DIAG_H / 2, width: B3_COL_C_W, height: DIAG_H / 2 } };

// --- Box 24 service-line table -------------------------------------------------
const BOX24_HEADER_H = 14;
/** Each service line draws a shaded supplemental sub-row (NDC/notes area) above its main data sub-row — mirrors the design's per-line shaded strip. */
export const BOX24_SHADED_ROW_H = 7;
export const BOX24_MAIN_ROW_H = 13;
export const BOX24_ROW_H = BOX24_SHADED_ROW_H + BOX24_MAIN_ROW_H; // 20 — unchanged from the prior layout, so pagination (6 rows/page) is untouched.
export const BOX24_MAX_ROWS = 6;
const box24Top = diagTop + DIAG_H + 2;

export interface Box24Column {
  key: 'date' | 'pos' | 'emg' | 'proc' | 'dxPtr' | 'charges' | 'units' | 'epsdt' | 'idQual' | 'npi';
  header: string;
  width: number;
  align?: 'left' | 'right';
}

// Column widths mirror the design's A-J column proportions (150/34/28/168/40/92/44/32/30/flex at 816px canvas width), scaled to this page's content width.
export const BOX24_COLUMNS: Box24Column[] = [
  { key: 'date', header: 'A. DATE(S) OF SERVICE', width: 112 },
  { key: 'pos', header: 'B. POS', width: 26 },
  { key: 'emg', header: 'C. EMG', width: 21 },
  { key: 'proc', header: 'D. PROCEDURES / MODIFIERS', width: 126 },
  { key: 'dxPtr', header: 'E. DX PTR', width: 30 },
  { key: 'charges', header: 'F. $ CHARGES', width: 69, align: 'right' },
  // G/H/I headers abbreviated (and H widened slightly) so they fit fully at
  // the fitText floor (4pt) instead of ellipsis-truncating — verified
  // against Helvetica.widthOfTextAtSize; data cells are unaffected.
  { key: 'units', header: 'G. DAYS', width: 33 },
  { key: 'epsdt', header: 'H. EPSDT', width: 28 },
  { key: 'idQual', header: 'I. QUAL', width: 22 },
  { key: 'npi', header: 'J. RENDERING PROVIDER ID #', width: CONTENT_W - (112 + 26 + 21 + 126 + 30 + 69 + 33 + 28 + 22) },
];

export const BOX24_TABLE = {
  x: LEFT_X,
  y: box24Top,
  width: CONTENT_W,
  headerHeight: BOX24_HEADER_H,
  rowHeight: BOX24_ROW_H,
  maxRowsPerPage: BOX24_MAX_ROWS,
};

/** Left X of each box-24 column, in table order. */
export const BOX24_COLUMN_X: number[] = (() => {
  const xs: number[] = [];
  let x = BOX24_TABLE.x;
  for (const col of BOX24_COLUMNS) {
    xs.push(x);
    x += col.width;
  }
  return xs;
})();

const box24Bottom = box24Top + BOX24_HEADER_H + BOX24_ROW_H * BOX24_MAX_ROWS;

// --- Boxes 25-30 -----------------------------------------------------------
const row2530Y = box24Bottom + 2;
const ROW2530_H = 19; // box 27 (ACCEPT ASSIGNMENT?) is a checkbox box; a touch taller than the plain 25/26/28-30 boxes strictly need, for checkbox-row clearance.
const col25W = 112;
const col26W = 112;
const col27W = 72;
const col28W = 84;
const col29W = 78;
const col30W = CONTENT_W - (col25W + col26W + col27W + col28W + col29W);
let x2530 = LEFT_X;
function take2530(width: number): Rect {
  const rect: Rect = { x: x2530, y: row2530Y, width, height: ROW2530_H };
  x2530 += width;
  return rect;
}
export const BOX25_TAXID: FieldBox = { key: 'billingProvider.taxId', number: '25', label: 'FEDERAL TAX I.D. NUMBER', rect: take2530(col25W) };
export const BOX26_ACCOUNT: FieldBox = { key: 'patient.accountNumber', number: '26', label: "PATIENT'S ACCOUNT NO.", rect: take2530(col26W) };
export const BOX27_ASSIGNMENT: FieldBox = { key: 'flags.acceptAssignment', number: '27', label: 'ACCEPT ASSIGNMENT?', rect: take2530(col27W) };
export const BOX28_TOTAL: FieldBox = { key: 'totals.totalCharge', number: '28', label: 'TOTAL CHARGE', rect: take2530(col28W), align: 'right' };
export const BOX29_PAID: FieldBox = { key: 'totals.amountPaid', number: '29', label: 'AMOUNT PAID', rect: take2530(col29W), align: 'right' };
export const BOX30_BALANCE: FieldBox = { key: 'totals.balanceDue', number: '30', label: 'BALANCE DUE', rect: take2530(col30W), align: 'right' };
const row2530Bottom = row2530Y + ROW2530_H;

// --- Boxes 31 / 32 / 33 -----------------------------------------------------
const row3133Y = row2530Bottom + 2;
const ROW3133_H = 40;
const col32W = 172;
const col33W = 188;
const col31W = CONTENT_W - col32W - col33W;
export const BOX31_RENDERING: FieldBox = { key: 'renderingProvider', number: '31', label: 'SIGNATURE OF PHYSICIAN OR SUPPLIER', rect: { x: LEFT_X, y: row3133Y, width: col31W, height: ROW3133_H } };
export const BOX32_FACILITY: FieldBox = { key: 'facility', number: '32 / 32a', label: 'SERVICE FACILITY LOCATION INFORMATION', rect: { x: LEFT_X + col31W, y: row3133Y, width: col32W, height: ROW3133_H } };
export const BOX33_BILLING: FieldBox = { key: 'billingProvider', number: '33 / 33a / 33b', label: 'BILLING PROVIDER INFO & PH #', rect: { x: LEFT_X + col31W + col32W, y: row3133Y, width: col33W, height: ROW3133_H } };

const band3Bottom = row3133Y + ROW3133_H;
export const BAND3_LABEL_RECT: Rect = { x: LABEL_STRIP_X, y: BAND3_TOP, width: LABEL_STRIP_W, height: band3Bottom - BAND3_TOP };

export const CONTENT_BOTTOM = band3Bottom;

// --- Footer ------------------------------------------------------------------
export const FOOTER_Y = PAGE_HEIGHT - 20;
