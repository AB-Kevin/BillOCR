import { ClaimParseError } from '../claimSource.js';

/**
 * Delimiter-complete X12 lexer for 837 (and any other X12) interchanges.
 *
 * The ISA segment is a fixed 106-byte record whose byte positions declare
 * every delimiter the rest of the file uses. Those positions are read
 * POSITIONALLY here and never hardcoded (`* ~ : >` are common defaults, not
 * guarantees) — see BUILD_PLAN.md §2.2.
 */

export interface Delimiters {
  /** ISA byte index 3 — separates elements within a segment. */
  element: string;
  /** ISA11 (byte index 82) — separates repeated values within one element. */
  repetition: string;
  /** ISA16 (byte index 104) — separates components within a composite element. */
  component: string;
  /** Byte index 105 — terminates a segment. */
  segment: string;
}

/** One parsed segment: its ID (e.g. "NM1") and its elements (NM101, NM102, ...). */
export interface Segment {
  id: string;
  elements: string[];
}

const ISA_LENGTH = 106;

/** Reads the four X12 delimiters positionally from a fixed 106-byte ISA record. */
export function parseDelimiters(text: string): Delimiters {
  if (text.length < ISA_LENGTH) {
    throw new ClaimParseError(
      'The ISA header is unreadable (a valid ISA segment is exactly 106 bytes).',
      `Got ${text.length} byte(s) before running out of input.`,
    );
  }
  return {
    element: text[3]!,
    repetition: text[82]!,
    component: text[104]!,
    segment: text[105]!,
  };
}

/** Trims CR/LF/whitespace surrounding a segment, then splits it into id + elements. */
function toSegment(raw: string, delimiters: Delimiters): Segment {
  const clean = raw.replace(/^[\r\n\s]+|[\r\n\s]+$/g, '');
  const parts = clean.split(delimiters.element);
  const id = parts[0] ?? '';
  return { id, elements: parts.slice(1) };
}

/**
 * Splits an X12 interchange into delimiters + an ordered list of segments.
 * The final segment is flushed even if the file has no trailing terminator
 * (a truncated-file guard, not a parse gate).
 */
export function tokenize(text: string): { delimiters: Delimiters; segments: Segment[] } {
  const delimiters = parseDelimiters(text);
  const segments: Segment[] = [];
  let buf = '';
  for (const ch of text) {
    if (ch === delimiters.segment) {
      const seg = buf.trim();
      if (seg !== '') segments.push(toSegment(seg, delimiters));
      buf = '';
    } else {
      buf += ch;
    }
  }
  const tail = buf.trim();
  if (tail !== '') segments.push(toSegment(tail, delimiters));
  return { delimiters, segments };
}

/** Splits a composite element (e.g. "ABK:M545") into its components; '' / undefined -> []. */
export function components(element: string | undefined, delimiters: Delimiters): string[] {
  if (element === undefined || element === '') return [];
  return element.split(delimiters.component);
}

/** Serializes a segment back to X12 text using the interchange's own delimiters (for `raw`). */
export function segmentToString(segment: Segment, delimiters: Delimiters): string {
  return [segment.id, ...segment.elements].join(delimiters.element);
}
