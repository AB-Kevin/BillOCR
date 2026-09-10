import type { Segment } from './tokenize.js';

/**
 * Envelope/loop-boundary helpers: pure segment-array slicing, no model
 * knowledge. `x12ClaimSource.ts` uses these to turn a flat segment stream
 * into ISA/GS/ST transactions, HL blocks (built from HL01/HL02/HL03 —
 * never segment order), 2300 claim windows, and 2400 line windows.
 */

export interface Transaction {
  /** GS08 — authoritative implementation-convention reference. */
  gs08: string;
  /** ST01 — transaction set identifier ("837" expected). */
  st01: string;
  /** ST03 — version, used as a GS08 fallback. */
  st03: string;
  /** Segments strictly between ST and SE (exclusive of both). */
  segments: Segment[];
}

/** Splits a full interchange's segments into ST...SE transactions, tracking the owning GS08. */
export function splitTransactions(segments: Segment[]): Transaction[] {
  const transactions: Transaction[] = [];
  let gs08 = '';
  let current: Segment[] | null = null;
  let st01 = '';
  let st03 = '';

  for (const seg of segments) {
    if (seg.id === 'GS') {
      gs08 = seg.elements[7] ?? '';
      continue;
    }
    if (seg.id === 'ST') {
      current = [];
      st01 = seg.elements[0] ?? '';
      st03 = seg.elements[2] ?? '';
      continue;
    }
    if (seg.id === 'SE') {
      if (current) transactions.push({ gs08, st01, st03, segments: current });
      current = null;
      continue;
    }
    if (current) current.push(seg);
  }
  // Truncated file (no closing SE) — flush what we have rather than drop it silently.
  if (current && current.length > 0) transactions.push({ gs08, st01, st03, segments: current });

  return transactions;
}

export interface HlBlock {
  /** HL01 — this level's own id. */
  id: string;
  /** HL02 — parent HL's id ('' for the top level). */
  parentId: string;
  /** HL03 — hierarchical level code (20=billing provider, 22=subscriber, 23=patient). */
  level: string;
  /** Segments between this HL and the next HL (exclusive of both). */
  segments: Segment[];
}

/** Splits a transaction's segments into HL blocks. Parent/child is by HL01/HL02, not order. */
export function splitHlBlocks(segments: Segment[]): HlBlock[] {
  const blocks: HlBlock[] = [];
  let current: HlBlock | null = null;

  for (const seg of segments) {
    if (seg.id === 'HL') {
      if (current) blocks.push(current);
      current = { id: seg.elements[0] ?? '', parentId: seg.elements[1] ?? '', level: seg.elements[2] ?? '', segments: [] };
      continue;
    }
    if (current) current.segments.push(seg);
  }
  if (current) blocks.push(current);

  return blocks;
}

/** True if any block in `blocks` is a level-23 (patient) child of `parentId`. */
export function hasPatientChild(blocks: HlBlock[], parentId: string): boolean {
  return blocks.some((b) => b.parentId === parentId && b.level === '23');
}

/** From an HL block's segments, everything from the first CLM onward (the 2300+ loops). */
export function firstClmOnward(segments: Segment[]): Segment[] {
  const idx = segments.findIndex((s) => s.id === 'CLM');
  return idx === -1 ? [] : segments.slice(idx);
}

/** Splits a run of segments (starting at a CLM) into one array per 2300 claim loop. */
export function splitClaims(segments: Segment[]): Segment[][] {
  const out: Segment[][] = [];
  let current: Segment[] | null = null;
  for (const seg of segments) {
    if (seg.id === 'CLM') {
      if (current) out.push(current);
      current = [seg];
      continue;
    }
    if (current) current.push(seg);
  }
  if (current) out.push(current);
  return out;
}

/** Splits one claim's segments into claim-level (2300, pre-LX) and per-line (2400) windows. */
export function splitLines(claimSegments: Segment[]): { claimLevel: Segment[]; lines: Segment[][] } {
  const lxIndex = claimSegments.findIndex((s) => s.id === 'LX');
  if (lxIndex === -1) return { claimLevel: claimSegments, lines: [] };

  const claimLevel = claimSegments.slice(0, lxIndex);
  const lineSegments = claimSegments.slice(lxIndex);
  const lines: Segment[][] = [];
  let current: Segment[] | null = null;
  for (const seg of lineSegments) {
    if (seg.id === 'LX') {
      if (current) lines.push(current);
      current = [seg];
      continue;
    }
    if (current) current.push(seg);
  }
  if (current) lines.push(current);

  return { claimLevel, lines };
}

/**
 * Segments belonging to the entity loop that starts at `segments[nm1Index]`
 * (its N3/N4/DMG/REF/PER/PRV, etc.): everything after it up to the next
 * segment that starts a new loop/entity.
 */
const LOOP_BOUNDARY_IDS = new Set(['NM1', 'HL', 'CLM', 'LX', 'SBR', 'PAT', 'SE']);

export function loopTail(segments: Segment[], nm1Index: number): Segment[] {
  const out: Segment[] = [];
  for (let i = nm1Index + 1; i < segments.length; i++) {
    const seg = segments[i]!;
    if (LOOP_BOUNDARY_IDS.has(seg.id)) break;
    out.push(seg);
  }
  return out;
}
