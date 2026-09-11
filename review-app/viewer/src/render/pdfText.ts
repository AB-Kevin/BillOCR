import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import type { PDFDocument, PDFFont } from 'pdf-lib';

/**
 * Shared text helpers for the PDF renderers: embedding Unicode TTFs so
 * claim-derived text (including non-cp1252 PHI, e.g. "Núñez") renders as
 * itself instead of via ASCII fallback, making arbitrary strings safe to
 * hand to whichever font ends up embedded, and fitting/truncating text to a
 * box width.
 *
 * Unicode embed: `embedUnicodeFonts` registers @pdf-lib/fontkit and embeds
 * the bundled DejaVu Sans / DejaVu Sans Bold / DejaVu Sans Mono TrueType
 * fonts (permissively licensed — Bitstream Vera Fonts License, see
 * ./fonts/DEJAVU-LICENSE.txt), subsetted to only the glyphs actually drawn
 * (`{ subset: true }`) so the exported PDF stays small despite the ~1.8MB
 * of source TTF data. Each renderer calls this first and falls back to the
 * base-14 WinAnsi StandardFonts (Helvetica/Courier, via pdf-lib directly)
 * only if the bundled font files can't be read/embedded — e.g. a stripped
 * deployment that didn't ship src/render/fonts/. safeText() stays in place
 * as a last-resort guard for that fallback path (and for any codepoint
 * outside DejaVu's own coverage).
 */

const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fonts');

export interface UnicodeFonts {
  /** DejaVu Sans — replaces Helvetica for box labels/headers. */
  sans: PDFFont;
  /** DejaVu Sans Bold — replaces Helvetica-Bold for titles. */
  sansBold: PDFFont;
  /** DejaVu Sans Mono — replaces Courier for claim-derived data values. */
  mono: PDFFont;
}

interface FontBytes {
  sans: Uint8Array;
  sansBold: Uint8Array;
  mono: Uint8Array;
}

// Read once per process; a missing/unreadable font directory is cached as
// `null` so every renderer call after the first failure skips straight to
// the StandardFonts fallback instead of retrying a doomed readFileSync.
let fontBytesCache: FontBytes | null | undefined;

function loadFontBytes(): FontBytes | null {
  if (fontBytesCache !== undefined) return fontBytesCache;
  try {
    fontBytesCache = {
      sans: readFileSync(join(FONTS_DIR, 'DejaVuSans.ttf')),
      sansBold: readFileSync(join(FONTS_DIR, 'DejaVuSans-Bold.ttf')),
      mono: readFileSync(join(FONTS_DIR, 'DejaVuSansMono.ttf')),
    };
  } catch {
    fontBytesCache = null;
  }
  return fontBytesCache;
}

/**
 * Registers fontkit on `doc` and embeds the bundled Unicode TTF set,
 * subsetted to the glyphs actually used. Returns `null` (never throws) if
 * the font files can't be read or fontkit can't embed them, so callers can
 * fall back to `doc.embedFont(StandardFonts.*)` unconditionally.
 */
export async function embedUnicodeFonts(doc: PDFDocument): Promise<UnicodeFonts | null> {
  const bytes = loadFontBytes();
  if (!bytes) return null;
  try {
    doc.registerFontkit(fontkit);
    const [sans, sansBold, mono] = await Promise.all([
      doc.embedFont(bytes.sans, { subset: true }),
      doc.embedFont(bytes.sansBold, { subset: true }),
      doc.embedFont(bytes.mono, { subset: true }),
    ]);
    return { sans, sansBold, mono };
  } catch {
    return null;
  }
}

/** Character to print for a missing/blank field. Never a blank that looks like data loss. */
export const EM_DASH = '—';

/**
 * Unicode combining diacritical marks (U+0300-U+036F) left behind by NFKD
 * decomposition, e.g. "c" + COMBINING CARON -> "c". Built from numeric
 * char codes (rather than a literal regex range) so this source file never
 * has to contain an actual combining-mark character.
 */
const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g');

// Per-font membership cache: whether a single character can be encoded by a
// given font without pdf-lib throwing. Keyed on the actual font object (not
// the font name) so it stays correct if callers embed the same font more
// than once.
//
// Note the asymmetry between the two font kinds this renderer uses:
// StandardFontEmbedder (WinAnsi/cp1252) throws for any out-of-encoding
// codepoint, so this probe does real transliteration work on the
// StandardFonts fallback path. CustomFontEmbedder (the embedded DejaVu
// Unicode fonts) does not throw for an unmapped codepoint — fontkit lays it
// out as a ".notdef" glyph instead — so on the Unicode-font path this probe
// reports "encodable" for nearly everything and safeText() becomes a
// pass-through, which is exactly what's wanted: accented PHI like "Núñez"
// should reach the page unchanged, not get NFKD-transliterated away.
const encodableCache = new WeakMap<PDFFont, Map<string, boolean>>();

function canEncode(font: PDFFont, ch: string): boolean {
  let cache = encodableCache.get(font);
  if (!cache) {
    cache = new Map();
    encodableCache.set(font, cache);
  }
  const cached = cache.get(ch);
  if (cached !== undefined) return cached;
  let ok: boolean;
  try {
    // widthOfTextAtSize throws for a codepoint outside the font's encoding
    // on the StandardFonts fallback path; a safe, side-effect-free probe.
    font.widthOfTextAtSize(ch, 1);
    ok = true;
  } catch {
    ok = false;
  }
  cache.set(ch, ok);
  return ok;
}

/**
 * Makes `text` safe to draw with `font`: any character the font can't
 * encode is transliterated (via Unicode NFKD de-accenting, e.g. "č" -> "c")
 * or, failing that, replaced with "?". Route ALL claim-derived text through
 * this before drawing it — a bad glyph must never throw and abort a render.
 */
export function safeText(font: PDFFont, text: string): string {
  if (text === '') return '';
  let out = '';
  for (const ch of Array.from(text)) {
    if (canEncode(font, ch)) {
      out += ch;
      continue;
    }
    // Strip Unicode combining diacritical marks (U+0300-U+036F) left behind
    // by NFKD decomposition, e.g. "c" + COMBINING CARON -> "c".
    const decomposed = ch.normalize('NFKD').replace(COMBINING_MARKS, '');
    if (decomposed !== '' && Array.from(decomposed).every((c) => canEncode(font, c))) {
      out += decomposed;
      continue;
    }
    out += '?';
  }
  return out;
}

/** A blank/absent value rendered as the em dash placeholder, otherwise the value unchanged. */
export function orDash(value: string): string {
  return value === '' ? EM_DASH : value;
}

export interface FitResult {
  text: string;
  size: number;
}

/**
 * Picks the largest font size in [minSize, maxSize] at which `text` fits in
 * `maxWidth`, shrinking in 0.5pt steps. If it still doesn't fit at the
 * floor size, truncates with an ellipsis so it does.
 */
export function fitText(
  font: PDFFont,
  text: string,
  maxWidth: number,
  opts: { maxSize?: number; minSize?: number } = {},
): FitResult {
  const maxSize = opts.maxSize ?? 8;
  const minSize = opts.minSize ?? 6;
  if (text === '' || maxWidth <= 0) return { text, size: maxSize };

  let size = maxSize;
  while (size > minSize && font.widthOfTextAtSize(text, size) > maxWidth) {
    size = Math.round((size - 0.5) * 100) / 100;
  }
  if (size < minSize) size = minSize;
  if (font.widthOfTextAtSize(text, size) <= maxWidth) {
    return { text, size };
  }

  const ellipsis = '...';
  let truncated = text;
  while (truncated.length > 0 && font.widthOfTextAtSize(truncated + ellipsis, size) > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return { text: truncated.length > 0 ? truncated + ellipsis : ellipsis, size };
}

/** Formats a dollar amount as "$xx.xx" ("-$xx.xx" if negative). */
export function formatMoney(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

/** X coordinate to draw `text` at `size` right-aligned to `boxRightX` (with a small padding). */
export function rightAlignX(font: PDFFont, text: string, size: number, boxRightX: number, paddingRight = 3): number {
  return boxRightX - font.widthOfTextAtSize(text, size) - paddingRight;
}

/** Composes a "Last, First Middle" name, skipping missing parts (no dangling ", "). */
export function composeName(name: { last: string; first: string; middle: string }): string {
  const parts: string[] = [];
  if (name.last !== '') parts.push(name.last);
  const firstMiddle = [name.first, name.middle].filter((p) => p !== '').join(' ');
  if (parts.length > 0 && firstMiddle !== '') {
    return `${parts[0]}, ${firstMiddle}`;
  }
  if (parts.length > 0) return parts[0]!;
  return firstMiddle;
}

/** Composes a single-line "line1 line2, city, state zip" address, skipping missing parts. */
export function composeAddressLine(addr: { line1: string; line2: string; city: string; state: string; zip: string }): string {
  const streetParts = [addr.line1, addr.line2].filter((p) => p !== '');
  const cityStateZip = [addr.city, [addr.state, addr.zip].filter((p) => p !== '').join(' ')]
    .filter((p) => p !== '')
    .join(', ');
  return [streetParts.join(' '), cityStateZip].filter((p) => p !== '').join(', ');
}

/**
 * Formats a phone number for display: "(XXX) XXX-XXXX" for a 10-digit US
 * number, "1 (XXX) XXX-XXXX" for 11 digits with a leading country code, or
 * "XXX-XXXX" for a bare 7-digit local number. Mirrors ./text.ts's
 * formatPhone (that copy is for the browser bundle; this one for the PDF
 * renderers) -- see its comment for why non-digit characters are always
 * stripped before reformatting rather than trusted from the source, and why
 * an unrecognized digit count is returned unchanged instead of mangled.
 */
export function formatPhone(raw: string): string {
  if (raw === '') return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 7) {
    return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  }
  return raw;
}
