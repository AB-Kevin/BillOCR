import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import type { Claim, Address, Name, ServiceLine } from '../../model/claim.js';
import {
  PAGE_WIDTH,
  PAGE_HEIGHT,
  HEADER_TAG_RECT,
  HEADER_TITLE_Y,
  HEADER_NUCC_NOTE_Y,
  PAYER_BLOCK,
  PICA_LEFT,
  PICA_RIGHT,
  BOX1,
  BOX1A,
  BAND1_LABEL_RECT,
  FIELD_BOXES,
  BOX3_SEX,
  BOX6_RELATIONSHIP,
  BOX10A_EMPLOYMENT,
  BOX10B_AUTO,
  BOX11A_SEX,
  BOX11D_OTHER_PLAN,
  BAND2_LABEL_RECT,
  READBACK_RECT,
  BOX12_SIGNATURE,
  BOX13_SIGNATURE,
  SIG_ROW_LABEL_STRIP,
  BAND3_HEADER_BOXES,
  DIAG_BOX,
  DIAG_CELLS,
  BOX22,
  BOX23,
  BOX24_TABLE,
  BOX24_COLUMNS,
  BOX24_COLUMN_X,
  BOX24_SHADED_ROW_H,
  BOX24_MAIN_ROW_H,
  BOX25_TAXID,
  BOX26_ACCOUNT,
  BOX27_ASSIGNMENT,
  BOX28_TOTAL,
  BOX29_PAID,
  BOX30_BALANCE,
  BOX31_RENDERING,
  BOX32_FACILITY,
  BOX33_BILLING,
  BAND3_LABEL_RECT,
  FOOTER_Y,
  toPdfRect,
} from './layout.js';
import type { FieldBox, Rect, Box24Column } from './layout.js';
import { safeText, orDash, fitText, formatMoney, formatPhone, rightAlignX, composeName, EM_DASH, embedUnicodeFonts } from '../pdfText.js';

/**
 * Renders a normalized Claim as a CMS-1500 facsimile PDF, following the
 * structure of the approved design (docs/design/ClaimViewer_v2.dc.html,
 * `isCms` block): the "1500" mark + title, a carrier/payer block, PICA
 * boxes, three vertical bands with rotated section labels, boxes 1-13 in a
 * checkbox-annotated two/three-column layout, boxes 14-23, the box-24
 * shaded+detail service grid, boxes 25-30, and the 31/32/33 provider
 * blocks. See layout.ts for the full coordinate map and the design-mapping
 * notes on each section.
 *
 * Fonts: embeds the bundled Unicode TTFs (DejaVu Sans for labels, DejaVu
 * Sans Mono for data) via @pdf-lib/fontkit so non-cp1252 claim-derived text
 * (e.g. "Núñez") renders as itself; falls back to the base-14 WinAnsi
 * StandardFonts (Helvetica/Courier) if the bundled fonts can't be embedded.
 * All claim-derived text is still routed through safeText() as a
 * last-resort guard — see text.ts.
 */

const PRODUCER = 'claim-viewer/cms1500-renderer';
const CREATOR = 'claim-viewer';
/** Fixed epoch date so the same claim always produces byte-identical PDFs. */
const FIXED_DATE = new Date(0);

const BLACK = rgb(0, 0, 0);
const GRAY = rgb(0.35, 0.35, 0.35);
/** Box-24 column-header shade (design: #e3e3e3). */
const SHADE_HEADER = rgb(0.89, 0.89, 0.89);
/** Box-24 per-line supplemental-row shade (design: the shaded strip above each detail row). */
const SHADE_LINE = rgb(0.93, 0.93, 0.93);

const BORDER_WIDTH = 0.75;
const LABEL_SIZE = 5.5;
const LABEL_PAD_TOP = 2;
const LABEL_PAD_X = 3;
// The design's boxes are much shorter (single-line, ~17pt) than the prior
// layout's (~22-24pt); these were re-tuned so the label + first value line
// both fit inside the shortest FIELD_BOXES row (17pt) with margin to spare.
const VALUE_TOP_OFFSET = 9; // distance from box top to the first value line's baseline area
const VALUE_LINE_GAP = 7; // baseline-to-baseline spacing for multi-line values
const VALUE_MAX_SIZE = 6.5;
const VALUE_MIN_SIZE = 5;
// Checkbox rows (sex/relationship/yes-no) need clearance BELOW the box's
// number+label line, which sits higher (smaller baseline offset) than a
// plain value line — reusing VALUE_TOP_OFFSET put the checkbox glyphs'
// ascenders right on top of the label's descenders. This offset + the
// smaller glyph/option sizes below were sized to clear the label with
// margin while still fitting inside the shortest checkbox box (17-20pt).
const CHECKBOX_ROW_TOP_OFFSET = 15;
const CHECKBOX_OPTION_MAX_SIZE = 5.5;
const CHECKBOX_OPTION_MIN_SIZE = 4.5;
const CHECKBOX_GLYPH_SIZE = 5;

interface Fonts {
  label: PDFFont; // DejaVu Sans (falls back to Helvetica)
  value: PDFFont; // DejaVu Sans Mono (falls back to Courier)
}

export async function renderCms1500(claim: Claim): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setProducer(PRODUCER);
  doc.setCreator(CREATOR);
  doc.setTitle(`CMS-1500 - ${claim.claimId}`);
  doc.setSubject('CMS-1500 claim facsimile');
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);

  const unicodeFonts = await embedUnicodeFonts(doc);
  const label = unicodeFonts?.sans ?? (await doc.embedFont(StandardFonts.Helvetica));
  const value = unicodeFonts?.mono ?? (await doc.embedFont(StandardFonts.Courier));
  const fonts: Fonts = { label, value };

  const maxRows = BOX24_TABLE.maxRowsPerPage;
  const totalPages = Math.max(1, Math.ceil(claim.serviceLines.length / maxRows));

  // Slice service lines per page up front so pagination can be asserted
  // independently of the drawing code below.
  const pages: ServiceLine[][] = [];
  for (let i = 0; i < totalPages; i++) {
    pages.push(claim.serviceLines.slice(i * maxRows, i * maxRows + maxRows));
  }
  const drawnLineCount = pages.reduce((sum, p) => sum + p.length, 0);
  if (drawnLineCount !== claim.serviceLines.length) {
    throw new Error(
      `CMS-1500 pagination would drop service lines: paginated ${drawnLineCount} of ${claim.serviceLines.length}.`,
    );
  }

  pages.forEach((lines, pageIndex) => {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    drawPage(page, fonts, claim, lines, pageIndex, totalPages);
  });

  return doc.save();
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
): void {
  const isLastPage = pageIndex === totalPages - 1;

  drawHeader(page, fonts, claim);
  drawPica(page, fonts);
  drawBand1(page, fonts, claim);
  drawBandLabel(page, fonts, BAND2_LABEL_RECT, 'PATIENT AND INSURED INFORMATION');
  drawBandLabel(page, fonts, BAND3_LABEL_RECT, 'PHYSICIAN OR SUPPLIER INFORMATION');

  for (const box of FIELD_BOXES) {
    drawFieldBox(page, fonts, box, getBoxLines(claim, box.key));
  }
  drawSexBox(page, fonts, BOX3_SEX, claim.patient.dob, claim.patient.sex);
  drawSexBox(page, fonts, BOX11A_SEX, claim.insured.dob, claim.insured.sex);
  drawRelationshipBox(page, fonts, BOX6_RELATIONSHIP, claim.patient.relationshipToInsured);
  drawYesNoBox(page, fonts, BOX10A_EMPLOYMENT, claim.flags.employmentRelated);
  drawYesNoBox(
    page,
    fonts,
    BOX10B_AUTO,
    claim.flags.autoAccident,
    claim.flags.autoAccident && claim.flags.autoAccidentState !== '' ? claim.flags.autoAccidentState : undefined,
  );
  drawYesNoBox(page, fonts, BOX11D_OTHER_PLAN, claim.otherInsurance !== null);
  drawYesNoBox(page, fonts, BOX27_ASSIGNMENT, claim.flags.acceptAssignment);

  drawFrame(page, READBACK_RECT);
  drawCenteredText(page, fonts.label, "READ BACK OF FORM BEFORE COMPLETING & SIGNING THIS FORM", READBACK_RECT, 5.5, GRAY);
  drawFieldBox(page, fonts, BOX12_SIGNATURE, getBoxLines(claim, BOX12_SIGNATURE.key));
  drawFieldBox(page, fonts, BOX13_SIGNATURE, getBoxLines(claim, BOX13_SIGNATURE.key));
  drawFrame(page, SIG_ROW_LABEL_STRIP);

  for (const box of BAND3_HEADER_BOXES) {
    drawFieldBox(page, fonts, box, getBoxLines(claim, box.key));
  }
  drawDiagnoses(page, fonts, claim);
  drawFieldBox(page, fonts, BOX22, getBoxLines(claim, BOX22.key));
  drawFieldBox(page, fonts, BOX23, getBoxLines(claim, BOX23.key));

  drawBox24Table(page, fonts, claim, lines);

  drawFieldBox(page, fonts, BOX25_TAXID, getBoxLines(claim, BOX25_TAXID.key));
  drawFieldBox(page, fonts, BOX26_ACCOUNT, getBoxLines(claim, BOX26_ACCOUNT.key));
  // Boxes 28-30 are claim-level money totals that only make sense once every
  // line is counted, so the VALUES are suppressed on non-last pages — but
  // the frame + number/label chrome is drawn on every page so the 25-30
  // grid row is never left incomplete on an intermediate page.
  for (const box of [BOX28_TOTAL, BOX29_PAID, BOX30_BALANCE]) {
    drawFieldBox(page, fonts, box, isLastPage ? getBoxLines(claim, box.key) : []);
  }

  drawFieldBox(page, fonts, BOX31_RENDERING, getBoxLines(claim, BOX31_RENDERING.key));
  drawFieldBox(page, fonts, BOX32_FACILITY, getBoxLines(claim, BOX32_FACILITY.key));
  drawFieldBox(page, fonts, BOX33_BILLING, getBoxLines(claim, BOX33_BILLING.key));

  drawFooter(page, fonts, claim, pageIndex, totalPages);
}

// ---------------------------------------------------------------------------
// Header — "1500" mark, title, NUCC note, carrier/payer block.
// ---------------------------------------------------------------------------

function drawHeader(page: PDFPage, fonts: Fonts, claim: Claim): void {
  drawFrame(page, HEADER_TAG_RECT);
  page.drawText('1500', {
    x: HEADER_TAG_RECT.x + 5,
    y: PAGE_HEIGHT - HEADER_TAG_RECT.y - HEADER_TAG_RECT.height + 3,
    size: 8,
    font: fonts.label,
    color: BLACK,
  });

  page.drawText('HEALTH INSURANCE CLAIM FORM', {
    x: HEADER_TAG_RECT.x,
    y: PAGE_HEIGHT - HEADER_TITLE_Y,
    size: 8,
    font: fonts.label,
    color: BLACK,
  });

  page.drawText('APPROVED BY NATIONAL UNIFORM CLAIM COMMITTEE (NUCC) 02/12', {
    x: HEADER_TAG_RECT.x,
    y: PAGE_HEIGHT - HEADER_NUCC_NOTE_Y,
    size: 4.5,
    font: fonts.label,
    color: GRAY,
  });

  // Carrier / payer block — driven by claim.payer, never the design's static sample.
  page.drawText('CARRIER — PAYER NAME AND ADDRESS', {
    x: PAYER_BLOCK.x,
    y: PAGE_HEIGHT - PAYER_BLOCK.y - 4.5,
    size: 4.5,
    font: fonts.label,
    color: BLACK,
  });
  const payerLines = [
    orDash(claim.payer.name),
    addressStreetLine(claim.payer.address),
    [cityStateZipLine(claim.payer.address), claim.payer.id !== '' ? `ID ${claim.payer.id}` : ''].filter((l) => l !== '').join('   '),
  ].filter((l) => l !== '');
  const maxWidth = PAYER_BLOCK.width;
  payerLines.forEach((raw, i) => {
    const text = safeText(fonts.value, raw === '' ? EM_DASH : raw);
    const fit = fitText(fonts.value, text, maxWidth, { maxSize: 7, minSize: 5.5 });
    const baselineTopY = PAYER_BLOCK.y + 14 + i * 9.5;
    page.drawText(fit.text, { x: PAYER_BLOCK.x, y: PAGE_HEIGHT - baselineTopY, size: fit.size, font: fonts.value, color: BLACK });
  });
}

function drawPica(page: PDFPage, fonts: Fonts): void {
  for (const rect of [PICA_LEFT, PICA_RIGHT]) {
    drawFrame(page, rect);
    page.drawText('PICA', {
      x: rect.x + 3,
      y: PAGE_HEIGHT - rect.y - rect.height + 2,
      size: 6,
      font: fonts.label,
      color: BLACK,
    });
  }
}

// ---------------------------------------------------------------------------
// Band 1 — "CARRIER": box 1 (insurance type — structural only, no source
// field) + box 1a (insured ID).
// ---------------------------------------------------------------------------

function drawBand1(page: PDFPage, fonts: Fonts, claim: Claim): void {
  drawFrame(page, BOX1);
  page.drawText('1. MEDICARE  MEDICAID  TRICARE  CHAMPVA  GROUP HEALTH PLAN  FECA BLK LUNG  OTHER', {
    x: BOX1.x + LABEL_PAD_X,
    y: PAGE_HEIGHT - BOX1.y - LABEL_PAD_TOP - LABEL_SIZE,
    size: LABEL_SIZE,
    font: fonts.label,
    color: GRAY,
  });
  const options = ['Medicare', 'Medicaid', 'Tricare', 'ChampVA', 'Group', 'FECA', 'Other'];
  // The Claim model carries no payer-program-type field, so every option is drawn unchecked (structural only).
  drawCheckRow(
    page,
    fonts,
    BOX1.x + LABEL_PAD_X,
    BOX1.y + CHECKBOX_ROW_TOP_OFFSET,
    options.map((text) => ({ text, checked: false })),
    BOX1.width - 2 * LABEL_PAD_X,
  );
  drawFieldBox(page, fonts, BOX1A, getBoxLines(claim, BOX1A.key));
  drawBandLabel(page, fonts, BAND1_LABEL_RECT, 'CARRIER');
}

// ---------------------------------------------------------------------------
// Rotated vertical section-band labels.
// ---------------------------------------------------------------------------

function drawBandLabel(page: PDFPage, fonts: Fonts, rect: Rect, text: string): void {
  drawFrame(page, rect);
  const size = 6;
  const label = safeText(fonts.label, text);
  const textWidth = fonts.label.widthOfTextAtSize(label, size);
  const startTopY = rect.y + rect.height / 2 + textWidth / 2;
  page.drawText(label, {
    x: rect.x + rect.width / 2 - size * 0.35,
    y: PAGE_HEIGHT - startTopY,
    size,
    font: fonts.label,
    color: BLACK,
    rotate: degrees(90),
  });
}

// ---------------------------------------------------------------------------
// Checkbox-style boxes: sex (M/F), relationship, yes/no.
// ---------------------------------------------------------------------------

interface CheckOption {
  text: string;
  checked: boolean;
}

/** Draws box frame + number/label header, matching drawFieldBox's chrome (shared so checkbox boxes look identical to plain boxes). */
function drawBoxChrome(page: PDFPage, fonts: Fonts, box: FieldBox): void {
  drawFrame(page, box.rect);
  const labelText = safeText(fonts.label, `${box.number ? box.number + '. ' : ''}${box.label}`.trim());
  const fit = fitText(fonts.label, labelText, box.rect.width - 2 * LABEL_PAD_X, { maxSize: LABEL_SIZE, minSize: 4 });
  page.drawText(fit.text, {
    x: box.rect.x + LABEL_PAD_X,
    y: PAGE_HEIGHT - (box.rect.y + LABEL_PAD_TOP + LABEL_SIZE),
    size: fit.size,
    font: fonts.label,
    color: GRAY,
  });
}

/**
 * A row of small checkbox+label pairs, shrinking to fit `maxWidth` if the
 * options don't fit at the default size. `rowTopY` is the row's own
 * baseline (top-origin) — callers are responsible for leaving clearance
 * above it for the box's number+label line. Returns the x position just
 * past the last option, so a caller can append more text on the same line.
 */
function drawCheckRow(page: PDFPage, fonts: Fonts, x: number, rowTopY: number, options: CheckOption[], maxWidth: number): number {
  const boxSize = CHECKBOX_GLYPH_SIZE;
  const gap = 2.5;
  const optGap = 6;

  const widthAt = (size: number): number =>
    options.reduce((sum, o, i) => sum + boxSize + gap + fonts.value.widthOfTextAtSize(safeText(fonts.value, o.text), size) + (i < options.length - 1 ? optGap : 0), 0);

  let size = CHECKBOX_OPTION_MAX_SIZE;
  while (size > CHECKBOX_OPTION_MIN_SIZE && widthAt(size) > maxWidth) {
    size = Math.round((size - 0.5) * 100) / 100;
  }

  let curX = x;
  const boxTopY = rowTopY - boxSize + 1;
  for (const opt of options) {
    const boxRect: Rect = { x: curX, y: boxTopY, width: boxSize, height: boxSize };
    drawFrame(page, boxRect);
    if (opt.checked) {
      page.drawText('X', {
        x: curX + 0.6,
        y: PAGE_HEIGHT - (boxTopY + boxSize - 0.6),
        size: boxSize - 0.8,
        font: fonts.value,
        color: BLACK,
      });
    }
    curX += boxSize + gap;
    const label = safeText(fonts.value, opt.text);
    page.drawText(label, { x: curX, y: PAGE_HEIGHT - rowTopY, size, font: fonts.value, color: BLACK });
    curX += fonts.value.widthOfTextAtSize(label, size) + optGap;
  }
  return curX;
}

function drawSexBox(page: PDFPage, fonts: Fonts, box: FieldBox, dob: string, sex: string): void {
  drawBoxChrome(page, fonts, box);
  // DOB text shares the checkbox row's baseline (same line, to its left) so
  // the whole row — DOB + M/F checkboxes — sits on one line clear of the
  // box's number+label line above it.
  const rowTopY = box.rect.y + CHECKBOX_ROW_TOP_OFFSET;
  const dobText = safeText(fonts.value, orDash(formatDateShort(dob)));
  const dobFit = fitText(fonts.value, dobText, box.rect.width * 0.42, { maxSize: CHECKBOX_OPTION_MAX_SIZE, minSize: CHECKBOX_OPTION_MIN_SIZE });
  page.drawText(dobFit.text, { x: box.rect.x + LABEL_PAD_X, y: PAGE_HEIGHT - rowTopY, size: dobFit.size, font: fonts.value, color: BLACK });

  const dobWidth = fonts.value.widthOfTextAtSize(dobFit.text, dobFit.size);
  const checkX = box.rect.x + LABEL_PAD_X + dobWidth + 6;
  const maxWidth = box.rect.x + box.rect.width - LABEL_PAD_X - checkX;
  drawCheckRow(
    page,
    fonts,
    checkX,
    rowTopY,
    [
      { text: 'M', checked: sex === 'M' },
      { text: 'F', checked: sex === 'F' },
    ],
    maxWidth,
  );
}

const RELATIONSHIP_OPTIONS: { code: string; text: string }[] = [
  { code: '18', text: 'Self' },
  { code: '01', text: 'Spouse' },
  { code: '19', text: 'Child' },
  { code: '', text: 'Other' }, // catch-all: checked when a code is present but not one of the above
];

function drawRelationshipBox(page: PDFPage, fonts: Fonts, box: FieldBox, code: string): void {
  drawBoxChrome(page, fonts, box);
  const known = new Set(['18', '01', '19']);
  const isOther = code !== '' && !known.has(code);
  const options: CheckOption[] = RELATIONSHIP_OPTIONS.map((o) => ({
    text: o.text,
    checked: o.code === '' ? isOther : o.code === code,
  }));
  drawCheckRow(page, fonts, box.rect.x + LABEL_PAD_X, box.rect.y + CHECKBOX_ROW_TOP_OFFSET, options, box.rect.width - 2 * LABEL_PAD_X);
}

function drawYesNoBox(page: PDFPage, fonts: Fonts, box: FieldBox, value: boolean, extra?: string): void {
  drawBoxChrome(page, fonts, box);
  const rowTopY = box.rect.y + CHECKBOX_ROW_TOP_OFFSET;
  const options: CheckOption[] = [
    { text: 'YES', checked: value },
    { text: 'NO', checked: !value },
  ];
  const endX = drawCheckRow(page, fonts, box.rect.x + LABEL_PAD_X, rowTopY, options, box.rect.width - 2 * LABEL_PAD_X);
  // `extra` (e.g. box 10b's auto-accident state) is appended on the SAME
  // line, right after the YES/NO checkboxes — not stacked as a third line —
  // so it never has to compete for vertical room in an already-tight box.
  if (extra !== undefined && extra !== '') {
    const text = safeText(fonts.value, extra);
    const remainingWidth = box.rect.x + box.rect.width - LABEL_PAD_X - endX;
    if (remainingWidth > 4) {
      const fit = fitText(fonts.value, text, remainingWidth, { maxSize: CHECKBOX_OPTION_MAX_SIZE, minSize: CHECKBOX_OPTION_MIN_SIZE });
      page.drawText(fit.text, { x: endX, y: PAGE_HEIGHT - rowTopY, size: fit.size, font: fonts.value, color: BLACK });
    }
  }
}

// ---------------------------------------------------------------------------
// Generic field box (frame + number/label header + one or more value lines).
// ---------------------------------------------------------------------------

function drawFieldBox(page: PDFPage, fonts: Fonts, box: FieldBox, lines: string[]): void {
  drawBoxChrome(page, fonts, box);

  const maxWidth = box.rect.width - 2 * LABEL_PAD_X;
  lines.forEach((rawLine, i) => {
    const line = safeText(fonts.value, rawLine);
    const fit = fitText(fonts.value, line, maxWidth, { maxSize: VALUE_MAX_SIZE, minSize: VALUE_MIN_SIZE });
    const baselineTopY = box.rect.y + VALUE_TOP_OFFSET + i * VALUE_LINE_GAP + fit.size;
    if (baselineTopY > box.rect.y + box.rect.height - 1) return; // overflow guard: never draw past the box's own bottom border
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

function drawCenteredText(page: PDFPage, font: PDFFont, text: string, rect: Rect, size: number, color: ReturnType<typeof rgb>): void {
  const fit = fitText(font, text, rect.width - 2 * LABEL_PAD_X, { maxSize: size, minSize: 4 });
  const width = font.widthOfTextAtSize(fit.text, fit.size);
  const x = rect.x + (rect.width - width) / 2;
  const baselineTopY = rect.y + rect.height / 2 + fit.size / 2 - 1;
  page.drawText(fit.text, { x, y: PAGE_HEIGHT - baselineTopY, size: fit.size, font, color });
}

// ---------------------------------------------------------------------------
// Box 21 — diagnoses (single bordered box; label + 4x3 code grid, no
// per-cell borders, matching the design's plain grid-of-text treatment).
// ---------------------------------------------------------------------------

function drawDiagnoses(page: PDFPage, fonts: Fonts, claim: Claim): void {
  drawFrame(page, DIAG_BOX);
  const label = safeText(fonts.label, '21. DIAGNOSIS OR NATURE OF ILLNESS OR INJURY  ·  ICD Ind. 0');
  const fit = fitText(fonts.label, label, DIAG_BOX.width - 2 * LABEL_PAD_X, { maxSize: LABEL_SIZE, minSize: 4 });
  page.drawText(fit.text, {
    x: DIAG_BOX.x + LABEL_PAD_X,
    y: PAGE_HEIGHT - (DIAG_BOX.y + LABEL_PAD_TOP + LABEL_SIZE),
    size: fit.size,
    font: fonts.label,
    color: GRAY,
  });

  const byLetter = new Map(claim.diagnoses.map((d) => [d.pointer, d.code]));
  for (const cell of DIAG_CELLS) {
    const code = byLetter.get(cell.letter);
    if (code === undefined) continue; // no per-cell border in this layout; an absent diagnosis just leaves the cell blank
    const text = safeText(fonts.value, `${cell.letter}. ${code}`);
    const maxWidth = cell.rect.width - 4;
    const cellFit = fitText(fonts.value, text, maxWidth, { maxSize: 7, minSize: 5.5 });
    const baselineTopY = cell.rect.y + cell.rect.height - 4;
    page.drawText(cellFit.text, {
      x: cell.rect.x + 2,
      y: PAGE_HEIGHT - baselineTopY,
      size: cellFit.size,
      font: fonts.value,
      color: BLACK,
    });
  }
}

// ---------------------------------------------------------------------------
// Box 24 — service-line table (shaded supplemental sub-row + main data
// sub-row per detail line).
// ---------------------------------------------------------------------------

function drawBox24Table(page: PDFPage, fonts: Fonts, claim: Claim, lines: ServiceLine[]): void {
  const table = BOX24_TABLE;
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
  BOX24_COLUMNS.forEach((col, i) => {
    const x = BOX24_COLUMN_X[i]!;
    if (i > 0) drawVLine(page, x, table.y, table.y + outer.height);
    const headerText = safeText(fonts.label, col.header);
    const fit = fitText(fonts.label, headerText, col.width - 2 * LABEL_PAD_X, { maxSize: 5, minSize: 4 });
    page.drawText(fit.text, {
      x: x + LABEL_PAD_X,
      y: PAGE_HEIGHT - (table.y + table.headerHeight - 4),
      size: fit.size,
      font: fonts.label,
      color: GRAY,
    });
  });

  // Body rows: exactly maxRowsPerPage row slots are drawn (a fixed 6-row
  // grid on every page); slots beyond this page's `lines` stay blank. Each
  // slot is split into a shaded supplemental sub-row (top) and a main data
  // sub-row (bottom).
  for (let r = 0; r < table.maxRowsPerPage; r++) {
    const rowTop = table.y + table.headerHeight + r * table.rowHeight;
    const shadedRect: Rect = { x: table.x, y: rowTop, width: table.width, height: BOX24_SHADED_ROW_H };

    page.drawRectangle({ ...toPdfRect(shadedRect, PAGE_HEIGHT), color: SHADE_LINE });
    drawFrame(page, { x: table.x, y: rowTop, width: table.width, height: table.rowHeight });
    BOX24_COLUMNS.forEach((_col, i) => {
      const x = BOX24_COLUMN_X[i]!;
      if (i > 0) drawVLine(page, x, rowTop, rowTop + table.rowHeight);
    });

    const idQualCol = BOX24_COLUMNS.find((c) => c.key === 'idQual');
    if (idQualCol) {
      const x = BOX24_COLUMN_X[BOX24_COLUMNS.indexOf(idQualCol)]!;
      drawCenteredText(page, fonts.value, 'NPI', { x, y: rowTop, width: idQualCol.width, height: BOX24_SHADED_ROW_H }, 5, GRAY);
    }

    const line = lines[r];
    const shadedText = line ? box24ShadedText(claim, r) : '';
    if (shadedText !== '') {
      const dateCol = BOX24_COLUMNS[0]!;
      const text = safeText(fonts.value, shadedText);
      const fit = fitText(fonts.value, text, dateCol.width - 2 * LABEL_PAD_X, { maxSize: 5.5, minSize: 4.5 });
      page.drawText(fit.text, {
        x: BOX24_COLUMN_X[0]! + LABEL_PAD_X,
        y: PAGE_HEIGHT - (rowTop + BOX24_SHADED_ROW_H - 1.5),
        size: fit.size,
        font: fonts.value,
        color: GRAY,
      });
    }

    if (!line) continue; // blank row slot — no data, not a "missing field"

    const cells = box24CellValues(line, claim.renderingProvider.npi);
    BOX24_COLUMNS.forEach((col, i) => {
      const x = BOX24_COLUMN_X[i]!;
      const raw = cells[col.key];
      if (raw === '') return; // H (EPSDT) / I (ID QUAL) have no source field; left visually blank like the design's static treatment
      const text = safeText(fonts.value, raw);
      const maxWidth = col.width - 2 * LABEL_PAD_X;
      const fit = fitText(fonts.value, text, maxWidth, { maxSize: VALUE_MAX_SIZE, minSize: VALUE_MIN_SIZE });
      const mainCenterTopY = rowTop + BOX24_SHADED_ROW_H + BOX24_MAIN_ROW_H / 2 + fit.size / 2 - 1;
      const drawX =
        col.align === 'right'
          ? rightAlignX(fonts.value, fit.text, fit.size, x + col.width, LABEL_PAD_X)
          : x + LABEL_PAD_X;
      page.drawText(fit.text, {
        x: drawX,
        y: PAGE_HEIGHT - mainCenterTopY,
        size: fit.size,
        font: fonts.value,
        color: BLACK,
      });
    });
  }
}

function drawVLine(page: PDFPage, xTop: number, yTopStart: number, yTopEnd: number): void {
  page.drawLine({
    start: { x: xTop, y: PAGE_HEIGHT - yTopStart },
    end: { x: xTop, y: PAGE_HEIGHT - yTopEnd },
    thickness: BORDER_WIDTH,
    color: BLACK,
  });
}

/**
 * The design's shaded supplemental row typically carries per-line NDC data;
 * ServiceLine has no such field. The JSON field map (docs/PLAN_REVISION_v2_JSON.md
 * §5) instead points claim-level `clia_number` at this area, so it's shown
 * once, on the first drawn line only, rather than repeated on every row.
 */
function box24ShadedText(claim: Claim, rowIndexOnPage: number): string {
  if (rowIndexOnPage !== 0 || claim.cliaNumber === '') return '';
  return `CLIA ${claim.cliaNumber}`;
}

function box24CellValues(line: ServiceLine, renderingNpi: string): Record<Box24Column['key'], string> {
  const from = formatDateShort(line.fromDate);
  const thru = formatDateShort(line.thruDate);
  const date = from === '' && thru === '' ? EM_DASH : thru !== '' && thru !== from ? `${from}-${thru}` : from || thru;
  const proc = [line.procCode, ...line.modifiers].filter((p) => p !== '').join(' ');
  return {
    date: date === '' ? EM_DASH : date,
    pos: orDash(line.placeOfService),
    emg: EM_DASH, // no source field on ServiceLine
    proc: orDash(proc),
    dxPtr: orDash(line.diagPointers.join('')),
    charges: formatMoney(line.charge),
    units: orDash(line.units),
    epsdt: '', // no source field; left blank like the design's static treatment
    idQual: '', // no source field; left blank like the design's static treatment
    npi: orDash(renderingNpi),
  };
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function drawFooter(page: PDFPage, fonts: Fonts, claim: Claim, pageIndex: number, totalPages: number): void {
  const y = PAGE_HEIGHT - FOOTER_Y;
  const size = 5.5;
  page.drawText('NUCC Instruction Manual available at: www.nucc.org', { x: 14, y, size, font: fonts.label, color: GRAY });

  const claimId = safeText(fonts.label, orDash(claim.claimId));
  const center = `CLAIM ${claimId}  ·  PAGE ${pageIndex + 1} OF ${totalPages}`;
  const centerWidth = fonts.label.widthOfTextAtSize(center, size);
  page.drawText(center, { x: PAGE_WIDTH / 2 - centerWidth / 2, y, size, font: fonts.label, color: GRAY });

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

function addressStreetLine(addr: Address): string {
  const line = [addr.line1, addr.line2].filter((p) => p !== '').join(' ');
  return line === '' ? EM_DASH : line;
}

function cityStateZipLine(addr: Address): string {
  const line = [addr.city, [addr.state, addr.zip].filter((p) => p !== '').join(' ')].filter((p) => p !== '').join(', ');
  return line === '' ? EM_DASH : line;
}

function nameOrDash(name: Name): string {
  const composed = composeName(name);
  return composed === '' ? EM_DASH : composed;
}

/** Returns the value line(s) to draw inside a FieldBox for the given key. */
function getBoxLines(claim: Claim, key: string): string[] {
  switch (key) {
    case 'patient.name':
      return [nameOrDash(claim.patient.name)];
    case 'insured.memberId':
      return [orDash(claim.insured.memberId)];
    case 'insured.name':
      return [nameOrDash(claim.insured.name)];
    case 'insured.group':
      return [orDash(claim.insured.group)];
    case 'patient.addressStreet':
      return [addressStreetLine(claim.patient.address)];
    case 'patient.cityStateZipPhone':
      return [
        [cityStateZipLine(claim.patient.address), claim.patient.phone !== '' ? formatPhone(claim.patient.phone) : '']
          .filter((l) => l !== '')
          .join('   ') || EM_DASH,
      ];
    case 'insured.addressStreet':
      return [addressStreetLine(claim.insured.address)];
    case 'insured.cityStateZipPhone':
      return [
        [cityStateZipLine(claim.insured.address), claim.insured.phone !== '' ? formatPhone(claim.insured.phone) : '']
          .filter((l) => l !== '')
          .join('   ') || EM_DASH,
      ];

    case 'otherInsurance.name':
      return [claim.otherInsurance ? nameOrDash(claim.otherInsurance.name) : EM_DASH];
    case 'otherInsurance.policyOrGroup': {
      if (!claim.otherInsurance) return [EM_DASH];
      const g = claim.otherInsurance.policyOrGroup;
      const m = claim.otherInsurance.memberId;
      if (g === '' && m === '') return [EM_DASH];
      return [`${orDash(g)} / ${orDash(m)}`];
    }
    case 'otherInsurance.plan':
      return [claim.otherInsurance ? orDash(claim.otherInsurance.plan) : EM_DASH];

    case 'insured.employer':
      return [orDash(claim.insured.employer)];
    case 'insured.plan':
      return [orDash(claim.insured.plan)];

    case 'referringProvider.name':
      return [claim.referringProvider ? nameOrDash(claim.referringProvider.name) : EM_DASH];
    case 'referringProvider.idNpi': {
      if (!claim.referringProvider) return [EM_DASH];
      return [`${orDash(claim.referringProvider.id)} / ${orDash(claim.referringProvider.npi)}`];
    }

    case 'hospitalization': {
      if (!claim.hospitalization) return [EM_DASH];
      const from = formatDateShort(claim.hospitalization.from);
      const thru = formatDateShort(claim.hospitalization.thru);
      if (from === '' && thru === '') return [EM_DASH];
      return [`${orDash(from)} - ${orDash(thru)}`];
    }
    case 'flags.priorAuth':
      return [orDash(claim.flags.priorAuth)];

    case 'narrative':
      return [orDash(claim.narrative)];

    case 'billingProvider.taxId': {
      if (claim.billingProvider.taxId === '') return [EM_DASH];
      const type = claim.billingProvider.taxIdType === 'E' ? 'EIN' : claim.billingProvider.taxIdType === 'S' ? 'SSN' : '';
      return [`${claim.billingProvider.taxId}${type ? ` (${type})` : ''}`];
    }
    case 'patient.accountNumber':
      return [orDash(claim.patient.accountNumber)];

    case 'totals.totalCharge':
      return [formatMoney(claim.totals.totalCharge)];
    case 'totals.amountPaid':
      return [formatMoney(claim.totals.amountPaid)];
    case 'totals.balanceDue':
      return [formatMoney(claim.totals.totalCharge - claim.totals.amountPaid)];

    case 'renderingProvider': {
      const lines = [
        nameOrDash(claim.renderingProvider.name),
        `NPI: ${orDash(claim.renderingProvider.npi)}`,
        claim.renderingProvider.taxonomy !== '' ? `TAXONOMY: ${claim.renderingProvider.taxonomy}` : '',
      ];
      return lines.filter((l) => l !== '');
    }

    case 'facility': {
      if (!claim.facility) return [EM_DASH];
      return [
        claim.facility.name !== '' ? claim.facility.name : EM_DASH,
        addressStreetLine(claim.facility.address),
        cityStateZipLine(claim.facility.address),
        `NPI: ${orDash(claim.facility.npi)}`,
      ];
    }

    case 'billingProvider': {
      // Mirrors the facility case's 4-line shape (name / street / city-state-zip
      // / NPI): box 33 was previously missing the city/state/ZIP line
      // entirely, a payment-critical NUCC field. Phone rides on the
      // city/state/zip line (same pattern as patient.cityStateZipPhone)
      // rather than being dropped.
      const cszPhone = [
        cityStateZipLine(claim.billingProvider.address),
        claim.billingProvider.phone !== '' ? `PH: ${formatPhone(claim.billingProvider.phone)}` : '',
      ]
        .filter((l) => l !== '')
        .join('   ');
      return [
        orDash(claim.billingProvider.name),
        addressStreetLine(claim.billingProvider.address),
        cszPhone === '' ? EM_DASH : cszPhone,
        `NPI: ${orDash(claim.billingProvider.npi)}${claim.billingProvider.taxonomy !== '' ? `   TAXONOMY: ${claim.billingProvider.taxonomy}` : ''}`,
      ];
    }

    default:
      // Structural boxes the Claim model has no field for (9b, 10c, 10d,
      // 12, 13, 14, 15, 16, 20, 22, ...): drawn with frame + label for
      // visual completeness, value always "—".
      return [EM_DASH];
  }
}
