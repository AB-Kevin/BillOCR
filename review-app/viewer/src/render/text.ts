// Ported from 837-claim-viewer's src/render/text.ts -- deliberately just the
// two pure, dependency-free helpers the BROWSER-side code needs
// (composeName/composeAddressLine, used by x12ClaimSource.ts and this app's
// own Inspector view), not that file's PDF-export text-fitting/font-embedding
// code (node:fs + pdf-lib/@pdf-lib/fontkit -- fine in Electron's main
// process, where the real version now lives, see ./pdfText.ts, but would
// break Vite's browser bundle here). renderCms1500.ts/renderUb04.ts import
// from ./pdfText.js instead, not this file.

export function composeName(name: { last: string; first: string; middle: string }): string {
  const parts: string[] = [];
  if (name.last !== "") parts.push(name.last);
  const firstMiddle = [name.first, name.middle].filter((p) => p !== "").join(" ");
  if (parts.length > 0 && firstMiddle !== "") {
    return `${parts[0]}, ${firstMiddle}`;
  }
  if (parts.length > 0) return parts[0]!;
  return firstMiddle;
}

/** Composes a single-line "line1 line2, city, state zip" address, skipping missing parts. */
export function composeAddressLine(addr: { line1: string; line2: string; city: string; state: string; zip: string }): string {
  const streetParts = [addr.line1, addr.line2].filter((p) => p !== "");
  const cityStateZip = [addr.city, [addr.state, addr.zip].filter((p) => p !== "").join(" ")]
    .filter((p) => p !== "")
    .join(", ");
  return [streetParts.join(" "), cityStateZip].filter((p) => p !== "").join(", ");
}

/**
 * Formats a phone number for display: "(XXX) XXX-XXXX" for a 10-digit US
 * number, "1 (XXX) XXX-XXXX" for 11 digits with a leading country code, or
 * "XXX-XXXX" for a bare 7-digit local number.
 *
 * Always strips non-digit characters first rather than trusting whatever
 * punctuation the source already has: the OCR pipeline now normalizes its
 * own phone fields to digits-only (see pipeline/common.py's
 * normalize_phone -- CMS-1500/UB-04 print each phone box as
 * "( ___ ) ___-____" with the parentheses as part of the box's own
 * artwork, not the number, so a raw transcription can end up with those
 * printed parens baked in as if they were data), but an X12 837 source's
 * PER segment (see x12ClaimSource.ts's findPhone) is read verbatim with no
 * such normalization and could contain anything. Any digit count other
 * than 10/11/7 (an extension, a garbled/truncated OCR read, an
 * international number) is returned unchanged rather than force-formatted
 * into a shape that would misrepresent it.
 */
export function formatPhone(raw: string): string {
  if (raw === "") return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 7) {
    return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  }
  return raw;
}
