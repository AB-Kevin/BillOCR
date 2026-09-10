import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Claim } from '../model/claim.js';
import { renderCms1500 } from './cms1500/renderCms1500.js';
import { renderUb04 } from './ub04/renderUb04.js';

/**
 * Main-process entry point for the ported paper-form renderer. This file
 * (and everything it imports -- renderCms1500/renderUb04, layout.ts,
 * pdfText.ts, model/claim.ts) is bundled by scripts/build-main-render.mjs
 * into a standalone ESM module under dist-main/, loaded via dynamic
 * import() from review-app/main.js (see main.js's `viewer-render-pdf` IPC
 * handler) -- NOT part of the viewer/dist browser bundle Vite builds,
 * which is why this lives in its own entry file rather than being called
 * directly from src/main.ts. Reasons this must run in the main process,
 * not the sandboxed viewer renderer: pdfText.ts's embedUnicodeFonts()
 * needs node:fs to read the bundled DejaVu TTFs.
 *
 * Ported from 837-claim-viewer's src/app/claimService.ts: same dispatch-by-
 * formType logic and the same calm placeholder page for claim types this
 * port doesn't render (dental is out of BillOCR's ported scope -- see
 * claim_viewer_port memory -- and 'unsupported' covers anything the
 * decoder itself couldn't classify). Never throws for a recognized Claim;
 * the placeholder means the preview flow never dead-ends even when a form
 * has no renderer, and the claim's data is still visible in the Inspector
 * panel alongside.
 */
export async function renderClaimPdf(claim: Claim): Promise<Uint8Array> {
  switch (claim.formType) {
    case 'cms1500':
      return renderCms1500(claim);
    case 'ub04':
      return renderUb04(claim);
    case 'dental':
    case 'unsupported':
      return renderUnsupportedPlaceholder(claim);
  }
}

const PRODUCER = 'billocr-review/viewer';
// Fixed epoch date, matching the form renderers' own convention, so output is byte-reproducible.
const FIXED_DATE = new Date(0);
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

async function renderUnsupportedPlaceholder(claim: Claim): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setProducer(PRODUCER);
  doc.setCreator(PRODUCER);
  doc.setTitle(`Unsupported claim form - ${claim.claimId}`);
  doc.setSubject('Claim data has no form renderer');
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  const lines = [
    { text: 'Cannot display this claim as a form.', size: 16 },
    { text: '', size: 12 },
    { text: `Claim ID: ${claim.claimId || '(none)'}`, size: 12 },
    { text: `Source form type: ${claim.claimFormRaw || '(unknown)'}`, size: 12 },
    { text: '', size: 12 },
    { text: 'This claim parsed successfully, but BillOCR Review has no', size: 12 },
    { text: 'paper-form renderer for it. Its data is still available in', size: 12 },
    { text: 'the field list alongside.', size: 12 },
  ];

  let y = PAGE_HEIGHT - 120;
  for (const line of lines) {
    if (line.text !== '') {
      page.drawText(line.text, { x: 72, y, size: line.size, font, color: rgb(0, 0, 0) });
    }
    y -= line.size + 8;
  }

  return doc.save();
}
