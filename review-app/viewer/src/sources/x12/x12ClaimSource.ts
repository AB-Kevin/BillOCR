import type {
  Claim,
  Name,
  Address,
  Diagnosis,
  ServiceLine,
  BillingProvider,
  RenderingProvider,
  Payer,
  Institutional,
  ValueCode,
  OccurrenceCode,
  OccurrenceSpan,
  Dental,
} from '../../model/claim.js';
import { type ClaimSource, ClaimParseError } from '../claimSource.js';
import { validateClaim, pointerLetter } from '../json/jsonClaimSource.js';
import { composeName } from '../../render/text.js';
import { tokenize, components, segmentToString } from './tokenize.js';
import type { Delimiters, Segment } from './tokenize.js';
import { splitTransactions, splitHlBlocks, hasPatientChild, firstClmOnward, splitClaims, splitLines, loopTail } from './segments.js';
import type { Transaction, HlBlock } from './segments.js';

/**
 * Maps an X12 837 5010 batch into the normalized Claim model.
 *
 * **Scope: 837P (professional, 005010X222), 837I (institutional,
 * 005010X223), and 837D (dental, 005010X224) are fully mapped.** An
 * unrecognized version (GS08/ST03 doesn't match any of the three) still
 * produces a minimal Claim tagged `formType: 'unsupported'`.
 *
 * Envelope: ISA -> GS[] -> ST[] -> claims. Loop state resets per ST.
 * HL01/HL02/HL03 (id/parent/level) drive the provider/subscriber/patient
 * tree — never segment order (a file can legally interleave HL branches).
 */

// ---------------------------------------------------------------------------
// Small model-shaped value helpers
// ---------------------------------------------------------------------------

function emptyName(): Name {
  return { last: '', first: '', middle: '' };
}

function emptyAddress(): Address {
  return { line1: '', line2: '', city: '', state: '', zip: '' };
}

function emptyBillingProvider(): BillingProvider {
  return { name: '', npi: '', taxId: '', taxIdType: '', address: emptyAddress(), phone: '', taxonomy: '' };
}

function emptyRenderingProvider(): RenderingProvider {
  return { name: emptyName(), npi: '', taxonomy: '' };
}

function emptyPayer(): Payer {
  return { name: '', id: '', address: emptyAddress(), order: '' };
}

/** X12 CCYYMMDD -> model's "YYYY-MM-DD"; anything else -> ''. */
function x12Date(v: string | undefined): string {
  if (!v) return '';
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/** Like x12Date, but also accepts DT-format CCYYMMDDHHMM (e.g. DTP*435 admission date/time) by taking just the date part. */
function x12DateFlexible(v: string | undefined): string {
  if (!v) return '';
  return x12Date(v.length >= 8 ? v.slice(0, 8) : v);
}

/** X12 monetary/numeric elements are plain decimal strings; blank/garbage -> 0. */
function numX12(v: string | undefined): number {
  if (v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function orderLabel(code: string): string {
  switch (code) {
    case 'P':
      return 'Primary';
    case 'S':
      return 'Secondary';
    case 'T':
      return 'Tertiary';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// NM1 (name loop) helpers — shared by every entity loop (2010AA/BA/CA/BB/2310*)
// ---------------------------------------------------------------------------

interface Nm1Info {
  /** NM101 — entity identifier code (e.g. "85" billing, "IL" subscriber, "82" rendering). */
  entityId: string;
  /** NM102 === '1' (person); '2' = non-person/organization. */
  isPerson: boolean;
  last: string;
  first: string;
  middle: string;
  /** NM108 — identification code qualifier (e.g. "XX" = NPI, "MI" = member id). */
  idQualifier: string;
  /** NM109 — identification code value. */
  idValue: string;
}

function parseNm1(seg: Segment): Nm1Info {
  const e = seg.elements;
  return {
    entityId: e[0] ?? '',
    isPerson: e[1] === '1',
    last: e[2] ?? '',
    first: e[3] ?? '',
    middle: e[4] ?? '',
    idQualifier: e[7] ?? '',
    idValue: e[8] ?? '',
  };
}

function nm1Name(info: Nm1Info): Name {
  return info.isPerson ? { last: info.last, first: info.first, middle: info.middle } : { last: info.last, first: '', middle: '' };
}

function nm1Npi(info: Nm1Info): string {
  return info.idQualifier === 'XX' ? info.idValue : '';
}

function findNm1(segs: Segment[], entityId: string): { seg: Segment; info: Nm1Info } | null {
  const seg = segs.find((s) => s.id === 'NM1' && s.elements[0] === entityId);
  return seg ? { seg, info: parseNm1(seg) } : null;
}

function findAddress(tail: Segment[]): Address {
  const n3 = tail.find((s) => s.id === 'N3');
  const n4 = tail.find((s) => s.id === 'N4');
  return {
    line1: n3?.elements[0] ?? '',
    line2: n3?.elements[1] ?? '',
    city: n4?.elements[0] ?? '',
    state: n4?.elements[1] ?? '',
    zip: n4?.elements[2] ?? '',
  };
}

/** First REF in `tail` whose REF01 is in `qualifiers` (or any REF if `qualifiers` is null). */
function findRef(tail: Segment[], qualifiers: string[] | null): { qualifier: string; value: string } | null {
  for (const seg of tail) {
    if (seg.id !== 'REF') continue;
    const q = seg.elements[0] ?? '';
    if (qualifiers && !qualifiers.includes(q)) continue;
    return { qualifier: q, value: seg.elements[1] ?? '' };
  }
  return null;
}

function findPhone(tail: Segment[]): string {
  const per = tail.find((s) => s.id === 'PER');
  if (!per) return '';
  const e = per.elements;
  // PER03/04, PER05/06, PER07/08 are repeating (qualifier, number) pairs.
  for (let i = 2; i < e.length; i += 2) {
    if (e[i] === 'TE') return e[i + 1] ?? '';
  }
  return '';
}

/** PRV03 (taxonomy) when PRV02 is 'PXC' — checks the segment right before NM1, then the tail. */
function findTaxonomy(all: Segment[], nm1Index: number, tail: Segment[]): string {
  const before = all[nm1Index - 1];
  if (before && before.id === 'PRV' && before.elements[1] === 'PXC') return before.elements[2] ?? '';
  const prv = tail.find((s) => s.id === 'PRV' && s.elements[1] === 'PXC');
  return prv?.elements[2] ?? '';
}

// ---------------------------------------------------------------------------
// Entity-loop extraction (2010AA billing / 2010BA+2010BB subscriber+payer / 2010CA patient)
// ---------------------------------------------------------------------------

function extractBilling(segs: Segment[]): BillingProvider {
  const nm1 = findNm1(segs, '85');
  if (!nm1) return emptyBillingProvider();
  const idx = segs.indexOf(nm1.seg);
  const tail = loopTail(segs, idx);
  const ref = findRef(tail, ['EI', 'SY']);
  return {
    name: composeName(nm1Name(nm1.info)),
    npi: nm1Npi(nm1.info),
    taxId: ref?.value ?? '',
    taxIdType: ref?.qualifier === 'EI' ? 'E' : ref?.qualifier === 'SY' ? 'S' : '',
    address: findAddress(tail),
    phone: findPhone(tail),
    taxonomy: findTaxonomy(segs, idx, tail),
  };
}

interface SubscriberIdentity {
  name: Name;
  memberId: string;
  group: string;
  plan: string;
  dob: string;
  sex: string;
  address: Address;
}

interface SubscriberEntry {
  subscriber: SubscriberIdentity;
  payer: Payer;
  /** SBR02 — only meaningful when this subscriber has no 2000C child (canonical patient rule). */
  relationshipIfSelf: string;
}

/** Loop 2000B: SBR (order/group/plan) + 2010BA (subscriber, NM1*IL) + 2010BB (payer, NM1*PR). */
function extractSubscriberAndPayer(segs: Segment[]): SubscriberEntry {
  const sbr = segs.find((s) => s.id === 'SBR');
  const sbrE = sbr?.elements ?? [];

  const il = findNm1(segs, 'IL');
  const ilTail = il ? loopTail(segs, segs.indexOf(il.seg)) : [];
  const dmg = ilTail.find((s) => s.id === 'DMG');

  const pr = findNm1(segs, 'PR');
  const prTail = pr ? loopTail(segs, segs.indexOf(pr.seg)) : [];

  return {
    subscriber: {
      name: il ? nm1Name(il.info) : emptyName(),
      memberId: il?.info.idValue ?? '',
      group: sbrE[2] ?? '',
      plan: sbrE[3] ?? '',
      dob: dmg ? x12Date(dmg.elements[1]) : '',
      sex: dmg?.elements[2] ?? '',
      address: findAddress(ilTail),
    },
    payer: {
      name: pr?.info.last ?? '',
      id: pr?.info.idValue ?? '',
      address: findAddress(prTail),
      order: orderLabel(sbrE[0] ?? ''),
    },
    relationshipIfSelf: sbrE[1] ?? '',
  };
}

interface PatientIdentity {
  name: Name;
  dob: string;
  sex: string;
  address: Address;
  phone: string;
}

/** Loop 2000C: PAT (relationship) + 2010CA (patient, NM1*QC). Only present when patient != subscriber. */
function extractPatient(segs: Segment[]): { patient: PatientIdentity; relationship: string } {
  const pat = segs.find((s) => s.id === 'PAT');
  const qc = findNm1(segs, 'QC');
  const tail = qc ? loopTail(segs, segs.indexOf(qc.seg)) : [];
  const dmg = tail.find((s) => s.id === 'DMG');
  return {
    patient: {
      name: qc ? nm1Name(qc.info) : emptyName(),
      dob: dmg ? x12Date(dmg.elements[1]) : '',
      sex: dmg?.elements[2] ?? '',
      address: findAddress(tail),
      phone: findPhone(tail),
    },
    relationship: pat?.elements[0] ?? '',
  };
}

/** Canonical patient rule: no 2000C -> patient := subscriber, relationship := self ('18'). */
function subscriberAsPatient(subscriber: SubscriberIdentity): PatientIdentity {
  return { name: subscriber.name, dob: subscriber.dob, sex: subscriber.sex, address: subscriber.address, phone: '' };
}

// ---------------------------------------------------------------------------
// 2300 claim-level (diagnoses, referring/rendering/facility, flags) + 2400 lines
// ---------------------------------------------------------------------------

/** HI segments' ABK (principal) / ABF (other) diagnosis codes, in order, as A..L pointers. */
function extractDiagnoses(claimLevel: Segment[], comp: (el: string | undefined) => string[]): Diagnosis[] {
  const out: Diagnosis[] = [];
  let ordinal = 0;
  for (const seg of claimLevel) {
    if (seg.id !== 'HI') continue;
    for (const el of seg.elements) {
      const parts = comp(el);
      const qualifier = parts[0] ?? '';
      if (qualifier !== 'ABK' && qualifier !== 'ABF') continue;
      ordinal++;
      out.push({ pointer: pointerLetter(ordinal), ordinal, code: parts[1] ?? '', poa: '' });
    }
  }
  return out;
}

/** DTP*472 — a single D8 date or an RD8 "from-thru" range. */
function parseServiceDate(dtp472: Segment | undefined): { from: string; thru: string } {
  if (!dtp472) return { from: '', thru: '' };
  const fmt = dtp472.elements[1] ?? '';
  const value = dtp472.elements[2] ?? '';
  if (fmt === 'RD8') {
    const [a, b] = value.split('-');
    return { from: x12Date(a), thru: x12Date(b ?? a) };
  }
  const d = x12Date(value);
  return { from: d, thru: d };
}

/** LX + SV1 (SV101 "HC:proc:mod1..mod4", SV107 diagnosis-pointer composite) + DTP*472. */
function extractServiceLine(lineSegs: Segment[], comp: (el: string | undefined) => string[]): ServiceLine {
  const lx = lineSegs.find((s) => s.id === 'LX');
  const sv1 = lineSegs.find((s) => s.id === 'SV1');
  const dtp472 = lineSegs.find((s) => s.id === 'DTP' && s.elements[0] === '472');
  const e = sv1?.elements ?? [];
  const procComposite = comp(e[0]);
  const diagComposite = comp(e[6]);
  const { from, thru } = parseServiceDate(dtp472);

  return {
    fromDate: from,
    thruDate: thru,
    placeOfService: e[4] ?? '',
    procCode: procComposite[1] ?? '',
    // Bounded to indices 2-5 (mod1..mod4), matching the institutional SV2
    // extractor below — an unbounded slice(2) would capture an optional
    // C003-7 description component as a spurious 5th modifier.
    modifiers: procComposite.slice(2, 6).filter((m) => m !== ''),
    diagPointers: diagComposite.map((p) => pointerLetter(Number(p))).filter((p) => p !== ''),
    charge: numX12(e[1]),
    units: e[3] ?? '',
    chargeId: lx?.elements[0] ?? '',
    // 837 is the original claim submission, not an 835 remit — patient
    // responsibility isn't carried at the line level here.
    patientResponsibility: 0,
  };
}

// ---------------------------------------------------------------------------
// 837I-only: institutional (UB-04) claim-level extraction
// ---------------------------------------------------------------------------

/** CLM05 composite ("facility-type+bill-class : qualifier : frequency", e.g. "11:A:1") -> the 3-char UB-04 Type of Bill ("111"). */
function extractTypeOfBill(clm: Segment, comp: (el: string | undefined) => string[]): string {
  const parts = comp(clm.elements[4]);
  const facilityAndClass = parts[0] ?? ''; // first 2 digits of the TOB
  const frequency = parts[2] ?? ''; // 3rd digit of the TOB
  return `${facilityAndClass}${frequency}`;
}

/** DTP*434 — RD8 statement-covers-period range (or, rarely, a single D8 date used for both ends). */
function parseStatementPeriod(dtp434: Segment | undefined): { from: string; through: string } {
  if (!dtp434) return { from: '', through: '' };
  const fmt = dtp434.elements[1] ?? '';
  const value = dtp434.elements[2] ?? '';
  if (fmt === 'RD8') {
    const [a, b] = value.split('-');
    return { from: x12Date(a), through: x12Date(b ?? a) };
  }
  const d = x12Date(value);
  return { from: d, through: d };
}

/** DTP*435 — admission date, D8 or DT format. */
function parseAdmissionDate(claimLevel: Segment[]): string {
  const dtp435 = claimLevel.find((s) => s.id === 'DTP' && s.elements[0] === '435');
  return dtp435 ? x12DateFlexible(dtp435.elements[2]) : '';
}

/** CL1 — CL101 admission type, CL102 admission source, CL103 patient status. */
function extractCl1(claimLevel: Segment[]): { admissionType: string; admissionSource: string; patientStatus: string } {
  const cl1 = claimLevel.find((s) => s.id === 'CL1');
  const e = cl1?.elements ?? [];
  return { admissionType: e[0] ?? '', admissionSource: e[1] ?? '', patientStatus: e[2] ?? '' };
}

interface HiExtraction {
  diagnoses: Diagnosis[];
  admittingDiagnosis: string;
  principalProcedure: { code: string; date: string } | null;
  valueCodes: ValueCode[];
  occurrenceCodes: OccurrenceCode[];
  occurrenceSpans: OccurrenceSpan[];
  conditionCodes: string[];
  drg: string;
}

/**
 * A single pass over every HI segment's composite elements, fanning each one
 * out by its qualifier (first component) into the institutional code family
 * it belongs to. HI qualifiers used here (005010X223):
 *   ABK principal diagnosis, ABF other diagnosis (both -> claim.diagnoses,
 *     POA in the composite's 9th/last component), ABJ admitting diagnosis,
 *   BBR/BR principal procedure (code + D8 date), BE value code (code +
 *     amount), BH occurrence code (code + D8 date), BI occurrence span
 *     (code + RD8 range), BG condition code (code only), DR DRG.
 * Unhandled qualifiers (APR, ABN, BBQ, ...) are intentionally ignored — out
 * of scope for this viewer's field map.
 */
function extractHi(claimLevel: Segment[], comp: (el: string | undefined) => string[]): HiExtraction {
  const diagnoses: Diagnosis[] = [];
  let admittingDiagnosis = '';
  let principalProcedure: { code: string; date: string } | null = null;
  const valueCodes: ValueCode[] = [];
  const occurrenceCodes: OccurrenceCode[] = [];
  const occurrenceSpans: OccurrenceSpan[] = [];
  const conditionCodes: string[] = [];
  let drg = '';
  let diagOrdinal = 0;

  for (const seg of claimLevel) {
    if (seg.id !== 'HI') continue;
    for (const el of seg.elements) {
      const parts = comp(el);
      const qualifier = parts[0] ?? '';
      const code = parts[1] ?? '';
      if (code === '') continue;

      switch (qualifier) {
        case 'ABK': // principal diagnosis
        case 'ABF': // other diagnosis
          diagOrdinal++;
          diagnoses.push({ pointer: pointerLetter(diagOrdinal), ordinal: diagOrdinal, code, poa: parts[8] ?? '' });
          break;
        case 'ABJ': // admitting diagnosis
          admittingDiagnosis = code;
          break;
        case 'BBR': // principal procedure
        case 'BR':
          if (principalProcedure === null) principalProcedure = { code, date: x12Date(parts[3]) };
          break;
        case 'BE': // value code: code + monetary amount (5th component)
          valueCodes.push({ code, amount: numX12(parts[4]) });
          break;
        case 'BH': // occurrence code: code + D8 date
          occurrenceCodes.push({ code, date: x12Date(parts[3]) });
          break;
        case 'BI': { // occurrence span: code + RD8 from-through range
          const [a, b] = (parts[3] ?? '').split('-');
          occurrenceSpans.push({ code, from: x12Date(a), through: x12Date(b ?? a) });
          break;
        }
        case 'BG': // condition code
          conditionCodes.push(code);
          break;
        case 'DR': // DRG
          drg = code;
          break;
        default:
          break; // out-of-scope qualifier (APR, ABN, BBQ, ...) — not mapped.
      }
    }
  }

  return { diagnoses, admittingDiagnosis, principalProcedure, valueCodes, occurrenceCodes, occurrenceSpans, conditionCodes, drg };
}

/** LX + SV2 (SV201 revenue code, SV202 "HC:proc:mod1..mod4:description" composite, SV203 charge, SV205 units) + DTP*472. */
function extractInstitutionalServiceLine(lineSegs: Segment[], comp: (el: string | undefined) => string[]): ServiceLine {
  const lx = lineSegs.find((s) => s.id === 'LX');
  const sv2 = lineSegs.find((s) => s.id === 'SV2');
  const dtp472 = lineSegs.find((s) => s.id === 'DTP' && s.elements[0] === '472');
  const e = sv2?.elements ?? [];
  const procComposite = comp(e[1]);
  const { from, thru } = parseServiceDate(dtp472);

  return {
    fromDate: from,
    thruDate: thru,
    placeOfService: '', // institutional lines carry no place-of-service.
    procCode: procComposite[1] ?? '',
    modifiers: procComposite.slice(2, 6).filter((m) => m !== ''),
    diagPointers: [], // institutional lines aren't tied to a diagnosis pointer.
    charge: numX12(e[2]),
    units: e[4] ?? '',
    chargeId: lx?.elements[0] ?? '',
    patientResponsibility: 0,
    revenueCode: e[0] ?? '',
    revenueDescription: procComposite[6] ?? '',
  };
}

// ---------------------------------------------------------------------------
// 837D-only: dental (ADA) claim-level + line extraction
// ---------------------------------------------------------------------------

/**
 * DN1 — Orthodontic Total Months of Treatment. Per the 005010X224 element
 * dictionary: DN101 = total treatment months, DN102 = months *remaining*,
 * DN104 = Y/N "appliance already placed" indicator. The model's single
 * `monthsRemaining` field prefers DN102 (the literal "remaining" count) and
 * falls back to DN101 (total) only when DN102 is blank — better one
 * plausible number than none. DN1 carries no date element, so
 * `appliancePlacedDate` is only ever non-blank if a future fixture pairs it
 * with an appliance-placement DTP this corpus doesn't have; it stays '' here.
 */
function extractOrthodontics(claimLevel: Segment[]): Dental['orthodontics'] {
  const dn1 = claimLevel.find((s) => s.id === 'DN1');
  if (!dn1) return null;
  const e = dn1.elements;
  const monthsRemaining = (e[1] ?? '') !== '' ? e[1]! : (e[0] ?? '');
  return { monthsRemaining, appliancePlacedDate: '' };
}

/**
 * DN2 — Tooth Status. DN201 = tooth number, DN202 = tooth status code.
 * Only status 'M' (Missing) is treated as a missing tooth for ADA box 33 —
 * other status values (e.g. 'E') are out of scope for this field.
 */
function extractMissingTeeth(claimLevel: Segment[]): string[] {
  const out: string[] = [];
  for (const seg of claimLevel) {
    if (seg.id !== 'DN2') continue;
    const toothNumber = seg.elements[0] ?? '';
    const status = seg.elements[1] ?? '';
    if (toothNumber !== '' && status === 'M') out.push(toothNumber);
  }
  return out;
}

/**
 * TOO — Tooth Information, zero or more per 2400 line. TOO02 = tooth
 * number, TOO03 = composite of surface codes. Multiple TOO segments on one
 * line (the corpus has this) are accumulated into comma-joined strings —
 * ServiceLine models each as a single display string, not a list.
 */
function extractToothInfo(lineSegs: Segment[], comp: (el: string | undefined) => string[]): { toothNumbers: string; toothSurfaces: string } {
  const toos = lineSegs.filter((s) => s.id === 'TOO');
  const numbers = toos.map((s) => s.elements[1] ?? '').filter((n) => n !== '');
  const surfaces = toos.map((s) => comp(s.elements[2]).filter((p) => p !== '').join('')).filter((s) => s !== '');
  return { toothNumbers: numbers.join(', '), toothSurfaces: surfaces.join(', ') };
}

/**
 * LX + SV3 (SV301 "AD:CDTcode:mod1..mod4" composite, SV302 charge, SV304
 * oral-cavity-area composite, SV306 quantity — see extractDentalServiceLine's
 * unit-test-facing report note on the SV305/SV306 numbering ambiguity) + TOO.
 *
 * `diagPointers` is intentionally left empty: SV3 has no element documented
 * (by this task or the fixture) as a reliable analog to SV1's SV107
 * diagnosis-pointer composite, and guessing one risks drawing a fabricated
 * ADA box-29a pointer. An empty array renders as "—", which is honest.
 */
function extractDentalServiceLine(lineSegs: Segment[], comp: (el: string | undefined) => string[]): ServiceLine {
  const lx = lineSegs.find((s) => s.id === 'LX');
  const sv3 = lineSegs.find((s) => s.id === 'SV3');
  const dtp472 = lineSegs.find((s) => s.id === 'DTP' && s.elements[0] === '472'); // rare at 2400 for dental; falls back to '' below via parseServiceDate.
  const e = sv3?.elements ?? [];
  const procComposite = comp(e[0]);
  const areaComposite = comp(e[3]);
  const { from, thru } = parseServiceDate(dtp472);
  const { toothNumbers, toothSurfaces } = extractToothInfo(lineSegs, comp);

  return {
    fromDate: from,
    thruDate: thru,
    placeOfService: '', // ADA has no per-line POS box; box 38 (claim-level place of treatment) covers this instead.
    procCode: procComposite[1] ?? '',
    // Bounded to indices 2-5 (mod1..mod4), matching the institutional SV2
    // extractor — an unbounded slice(2) would capture an optional
    // description/trailing component as a spurious 5th modifier.
    modifiers: procComposite.slice(2, 6).filter((m) => m !== ''),
    diagPointers: [],
    charge: numX12(e[1]),
    // SV306 (index 5) is used here, not SV305 (index 4): in the corpus SV305
    // holds a single-letter prognosis-style code ("R") while SV306 is a
    // clean repeated "1" on every line — the plausible quantity. Reported as
    // a judgment call since neither the task text nor the IG element name at
    // this position is unambiguous from the fixture alone.
    units: e[5] ?? '',
    chargeId: lx?.elements[0] ?? '',
    patientResponsibility: 0,
    toothNumbers,
    toothSurfaces,
    oralCavityArea: areaComposite.filter((p) => p !== '').join('-'),
  };
}

// ---------------------------------------------------------------------------
// Transaction-type resolution (GS08, ST03 fallback)
// ---------------------------------------------------------------------------

type X12Kind = 'P' | 'I' | 'D' | null;

function resolveKind(gs08: string, st03: string): X12Kind {
  const ref = gs08 !== '' ? gs08 : st03;
  if (ref.startsWith('005010X222')) return 'P';
  if (ref.startsWith('005010X223')) return 'I';
  if (ref.startsWith('005010X224')) return 'D';
  return null;
}

// ---------------------------------------------------------------------------
// Claim assembly
// ---------------------------------------------------------------------------

interface ClaimCtx {
  kind: X12Kind;
  claimFormRaw: string;
  billing: BillingProvider;
  subscriber: SubscriberIdentity;
  payer: Payer;
  patient: PatientIdentity;
  relationship: string;
}

function buildClaim(ctx: ClaimCtx, claimSegs: Segment[], delimiters: Delimiters): Claim {
  const comp = (el: string | undefined) => components(el, delimiters);
  const clm = claimSegs[0]!; // splitClaims() guarantees this is the CLM segment
  const claimId = clm.elements[0] ?? '';
  const totalCharge = numX12(clm.elements[1]);
  const { claimLevel, lines } = splitLines(claimSegs);

  const claim: Claim = {
    claimId,
    formType: ctx.kind === 'P' ? 'cms1500' : ctx.kind === 'I' ? 'ub04' : ctx.kind === 'D' ? 'dental' : 'unsupported',
    claimFormRaw: ctx.claimFormRaw,
    patient: {
      name: ctx.patient.name,
      dob: ctx.patient.dob,
      sex: ctx.patient.sex,
      address: ctx.patient.address,
      phone: ctx.patient.phone,
      relationshipToInsured: ctx.relationship,
      // CLM01 (Patient Control Number) IS box 26 on the CMS-1500 — the same
      // value the task maps to claimId, since X12 has no separate concept
      // of a clearinghouse-assigned claim id.
      accountNumber: claimId,
    },
    insured: {
      name: ctx.subscriber.name,
      memberId: ctx.subscriber.memberId,
      group: ctx.subscriber.group,
      plan: ctx.subscriber.plan,
      dob: ctx.subscriber.dob,
      sex: ctx.subscriber.sex,
      address: ctx.subscriber.address,
      employer: '',
    },
    payer: ctx.payer,
    otherInsurance: null, // 2320/2330 COB loops not mapped — see report.
    billingProvider: ctx.billing,
    renderingProvider: emptyRenderingProvider(),
    referringProvider: null,
    facility: null,
    diagnoses: [],
    serviceLines: [],
    totals: { totalCharge, amountPaid: 0 }, // 837 carries no paid amount (that's an 835 concept).
    flags: { acceptAssignment: false, autoAccident: false, autoAccidentState: '', employmentRelated: false, priorAuth: '' },
    hospitalization: null,
    narrative: '',
    cliaNumber: '',
    raw: { segments: claimSegs.map((s) => segmentToString(s, delimiters)) },
    warnings: [],
  };

  // An unrecognized version (kind === null) stays minimal; validateClaim
  // adds its own 'unsupported-form' warning for that case via formType.
  if (ctx.kind === null) {
    claim.warnings = validateClaim(claim);
    return claim;
  }

  // --- 837P / 837I / 837D shared mapping ---
  // Diagnoses and service lines differ by kind (SV1 vs SV2 vs SV3, HI vs
  // plain ABK/ABF); everything else below (referring/rendering/facility,
  // CLM07/CLM11 flags, REF/NTE claim-level notes) is identical.
  let hi: HiExtraction | null = null;
  if (ctx.kind === 'I') {
    hi = extractHi(claimLevel, comp);
    claim.diagnoses = hi.diagnoses;
    claim.serviceLines = lines.map((l) => extractInstitutionalServiceLine(l, comp));
  } else if (ctx.kind === 'D') {
    claim.diagnoses = extractDiagnoses(claimLevel, comp); // 837D reuses the same HI ABK/ABF shape as 837P.
    claim.serviceLines = lines.map((l) => extractDentalServiceLine(l, comp));
  } else {
    claim.diagnoses = extractDiagnoses(claimLevel, comp);
    claim.serviceLines = lines.map((l) => extractServiceLine(l, comp));
  }

  const referring = findNm1(claimLevel, 'DN');
  if (referring) {
    const tail = loopTail(claimLevel, claimLevel.indexOf(referring.seg));
    const ref = findRef(tail, null);
    claim.referringProvider = { name: nm1Name(referring.info), npi: nm1Npi(referring.info), id: ref?.value ?? '' };
  }

  const rendering = findNm1(claimLevel, '82');
  if (rendering) {
    const idx = claimLevel.indexOf(rendering.seg);
    const tail = loopTail(claimLevel, idx);
    claim.renderingProvider = { name: nm1Name(rendering.info), npi: nm1Npi(rendering.info), taxonomy: findTaxonomy(claimLevel, idx, tail) };
  }

  const facility = findNm1(claimLevel, '77');
  if (facility) {
    const tail = loopTail(claimLevel, claimLevel.indexOf(facility.seg));
    claim.facility = { name: facility.info.last, npi: nm1Npi(facility.info), address: findAddress(tail) };
  }

  // CLM07 — Provider Accept Assignment Code ('A' assigned, 'B' clinical-lab-only, 'C' not assigned).
  const clm07 = clm.elements[6];
  claim.flags.acceptAssignment = clm07 === 'A' || clm07 === 'B';

  // CLM11 — Related Causes composite, e.g. "AA:EM:FL" (auto accident : employment : state).
  const causes = comp(clm.elements[10]);
  claim.flags.autoAccident = causes.includes('AA');
  claim.flags.employmentRelated = causes.includes('EM');
  if (claim.flags.autoAccident) {
    claim.flags.autoAccidentState = causes.find((c) => c !== 'AA' && c !== 'EM' && c !== 'OA' && /^[A-Z]{2}$/.test(c)) ?? '';
  }

  claim.flags.priorAuth = claimLevel.find((s) => s.id === 'REF' && s.elements[0] === 'G1')?.elements[1] ?? '';
  claim.narrative = claimLevel.find((s) => s.id === 'NTE' && s.elements[0] === 'ADD')?.elements[1] ?? '';
  claim.cliaNumber = claimLevel.find((s) => s.id === 'REF' && s.elements[0] === 'X4')?.elements[1] ?? '';

  // --- 837I-only: institutional (UB-04) claim-level data ---
  if (ctx.kind === 'I' && hi) {
    const { from: statementFrom, through: statementThrough } = parseStatementPeriod(
      claimLevel.find((s) => s.id === 'DTP' && s.elements[0] === '434'),
    );
    const { admissionType, admissionSource, patientStatus } = extractCl1(claimLevel);
    const institutional: Institutional = {
      typeOfBill: extractTypeOfBill(clm, comp),
      statementFrom,
      statementThrough,
      admissionDate: parseAdmissionDate(claimLevel),
      admissionType,
      admissionSource,
      patientStatus,
      conditionCodes: hi.conditionCodes,
      occurrenceCodes: hi.occurrenceCodes,
      occurrenceSpans: hi.occurrenceSpans,
      valueCodes: hi.valueCodes,
      admittingDiagnosis: hi.admittingDiagnosis,
      principalProcedure: hi.principalProcedure,
      drg: hi.drg,
    };
    claim.institutional = institutional;
  }

  // --- 837D-only: dental (ADA) claim-level data ---
  if (ctx.kind === 'D') {
    const dental: Dental = {
      // Not derivable from this corpus: 837D has no segment/element this
      // task or the 005010X224 IG documents as "Statement of Actual
      // Services" vs "Request for Predetermination" (there's no CLM19 in
      // this fixture's CLM, and inferring it from REF*G3's mere presence
      // would be guessing at intent, not reading data) — stays '' with an
      // info warning below rather than a fabricated guess.
      transactionType: '',
      // REF*G3 (claim-level, before the first LX) — Predetermination of
      // Benefits Identification.
      predeterminationNumber: findRef(claimLevel, ['G3'])?.value ?? '',
      // CLM05-1 — facility type/place-of-service code.
      placeOfTreatment: comp(clm.elements[4])[0] ?? '',
      missingTeeth: extractMissingTeeth(claimLevel),
      orthodontics: extractOrthodontics(claimLevel),
      // Same NM1*82 rendering-provider loop already mapped to renderingProvider above.
      treatingDentist: claim.renderingProvider.name,
    };
    claim.dental = dental;
    if (dental.transactionType === '') {
      claim.warnings.push({
        code: 'dental-transaction-type-unknown',
        severity: 'info',
        message: 'ADA box 1 (transaction type) could not be derived from this 837D — no CLM19 or equivalent qualifier was present.',
      });
    }
  }

  claim.warnings = [...claim.warnings, ...validateClaim(claim)];
  return claim;
}

// ---------------------------------------------------------------------------
// HL tree walk (per ST transaction)
// ---------------------------------------------------------------------------

function parseTransaction(tx: Transaction, delimiters: Delimiters): Claim[] {
  const kind = resolveKind(tx.gs08, tx.st03);
  const claimFormRaw = tx.gs08 || tx.st03;
  const blocks = splitHlBlocks(tx.segments);

  const billingById = new Map<string, BillingProvider>();
  const subscriberEntryById = new Map<string, SubscriberEntry & { billingId: string }>();
  const claims: Claim[] = [];

  for (const block of blocks) {
    if (block.level === '20') {
      billingById.set(block.id, extractBilling(block.segments));
      continue;
    }

    if (block.level === '22') {
      const entry = extractSubscriberAndPayer(block.segments);
      subscriberEntryById.set(block.id, { ...entry, billingId: block.parentId });

      // Canonical patient rule: only build claims here when this subscriber
      // has no 2000C (patient) child — otherwise the 2000C block below does it.
      if (!hasPatientChild(blocks, block.id)) {
        const billing = billingById.get(block.parentId) ?? emptyBillingProvider();
        const ctx: ClaimCtx = {
          kind,
          claimFormRaw,
          billing,
          subscriber: entry.subscriber,
          payer: entry.payer,
          patient: subscriberAsPatient(entry.subscriber),
          relationship: entry.relationshipIfSelf || '18',
        };
        for (const claimSegs of splitClaims(firstClmOnward(block.segments))) {
          claims.push(buildClaim(ctx, claimSegs, delimiters));
        }
      }
      continue;
    }

    if (block.level === '23') {
      const parentEntry = subscriberEntryById.get(block.parentId);
      if (!parentEntry) continue; // malformed HL tree (orphan patient level) — skip rather than throw.
      const billing = billingById.get(parentEntry.billingId) ?? emptyBillingProvider();
      const { patient, relationship } = extractPatient(block.segments);
      const ctx: ClaimCtx = {
        kind,
        claimFormRaw,
        billing,
        subscriber: parentEntry.subscriber,
        payer: parentEntry.payer,
        patient,
        relationship,
      };
      for (const claimSegs of splitClaims(firstClmOnward(block.segments))) {
        claims.push(buildClaim(ctx, claimSegs, delimiters));
      }
    }
  }

  return claims;
}

// ---------------------------------------------------------------------------
// ClaimSource
// ---------------------------------------------------------------------------

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export class X12ClaimSource implements ClaimSource {
  readonly kind = 'x12' as const;

  canParse(text: string): boolean {
    return stripBom(text).trim().startsWith('ISA');
  }

  parse(text: string): Claim[] {
    const trimmed = stripBom(text).trim();
    if (!trimmed.startsWith('ISA')) {
      throw new ClaimParseError('This does not look like an X12 EDI file (expected it to start with "ISA").');
    }

    const { delimiters, segments } = tokenize(trimmed); // throws ClaimParseError if the ISA is < 106 bytes.
    const transactions = splitTransactions(segments).filter((tx) => tx.st01 === '837');
    if (transactions.length === 0) {
      throw new ClaimParseError('No 837 transaction (ST*837) was found in this file.');
    }

    const claims: Claim[] = [];
    for (const tx of transactions) {
      claims.push(...parseTransaction(tx, delimiters));
    }
    if (claims.length === 0) {
      throw new ClaimParseError('The 837 transaction(s) in this file contain no claims (no CLM segment found).');
    }
    return claims;
  }
}
