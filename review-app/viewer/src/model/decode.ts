import { PLACE_OF_SERVICE } from '../data/placeOfService.js';
import { REVENUE_CODES } from '../data/revenueCodes.js';
import {
  TOB_FACILITY_TYPE,
  TOB_BILL_CLASSIFICATION,
  TOB_CLINIC_CLASSIFICATION,
  TOB_SPECIAL_FACILITY_CLASSIFICATION,
  TOB_FREQUENCY,
} from '../data/typeOfBill.js';
import { DISCHARGE_STATUS } from '../data/dischargeStatus.js';
import { CONDITION_CODES } from '../data/conditionCodes.js';
import { OCCURRENCE_CODES, OCCURRENCE_SPAN_CODES } from '../data/occurrenceCodes.js';
import { VALUE_CODES } from '../data/valueCodes.js';
import { MODIFIERS } from '../data/modifiers.js';

/**
 * Plain-English decoding of the public CMS/NUBC code sets under
 * src/data/**, Build 2.2 (docs/BUILD_QUEUE.md). Pure, Electron-free
 * lookup functions — `electron/main.ts`'s `buildClaimDetail` is the only
 * caller in the real app (decoding happens in MAIN, per that build's
 * architecture), but keeping the logic here (rather than inline in
 * main.ts) means it's unit-testable without spinning up Electron — see
 * test/decode.test.ts.
 *
 * Every function here returns `decoded: null` for an empty or unrecognized
 * raw code — NEVER the string "Unknown" (per
 * docs/UI_REQUIREMENTS_v3_queued_features.md §2: "Where no decoding
 * exists, show the raw value alone"). The renderer decides what to do with
 * a `null` decoded value (i.e. show nothing extra); this module never makes
 * that presentation decision itself.
 */

export interface CodedValue {
  raw: string;
  decoded: string | null;
}

function lookup(table: Record<string, string>, raw: string): CodedValue {
  const key = raw.trim().toUpperCase();
  if (key === '') return { raw, decoded: null };
  return { raw, decoded: table[key] ?? null };
}

export function decodePlaceOfService(raw: string): CodedValue {
  return lookup(PLACE_OF_SERVICE, raw);
}

/**
 * Revenue codes, FL42. REVENUE_CODES is keyed on the 4-character form
 * ("0450"), but SV2-01 reaches us verbatim from the 837 and providers do
 * submit the 3-character form ("450"), which would otherwise silently lose
 * its decode. Pads a 3-digit code the same way normalizeTypeOfBill handles
 * the identical leading-zero variance on FL04. `raw` is left untouched so the
 * value still displays and copies exactly as the claim carries it.
 */
export function decodeRevenueCode(raw: string): CodedValue {
  const trimmed = raw.trim();
  const padded = trimmed.length === 3 && /^\d{3}$/.test(trimmed) ? `0${trimmed}` : raw;
  return { ...lookup(REVENUE_CODES, padded), raw };
}

export function decodeModifier(raw: string): CodedValue {
  return lookup(MODIFIERS, raw);
}

export function decodeDischargeStatus(raw: string): CodedValue {
  return lookup(DISCHARGE_STATUS, raw);
}

export function decodeConditionCode(raw: string): CodedValue {
  return lookup(CONDITION_CODES, raw);
}

/** Occurrence codes, FL31–34. Occurrence SPAN codes are a separate NUBC list — use decodeOccurrenceSpanCode. */
export function decodeOccurrenceCode(raw: string): CodedValue {
  return lookup(OCCURRENCE_CODES, raw);
}

/**
 * Occurrence span codes, FL35–36. Deliberately a different table from
 * decodeOccurrenceCode: the two NUBC lists do not share a numeric range, so
 * decoding one field against the other's table yields confident wrong labels
 * rather than a harmless miss.
 */
export function decodeOccurrenceSpanCode(raw: string): CodedValue {
  return lookup(OCCURRENCE_SPAN_CODES, raw);
}

export function decodeValueCode(raw: string): CodedValue {
  return lookup(VALUE_CODES, raw);
}

export interface TypeOfBillDecoded {
  /** The raw FL04 value exactly as the claim carries it (3 or 4 characters — see normalizeTypeOfBill). */
  raw: string;
  facilityType: CodedValue;
  billClassification: CodedValue;
  frequency: CodedValue;
  /**
   * A single human-readable phrase combining all three components, e.g.
   * raw "0131" -> "Hospital, outpatient, admit through discharge claim".
   * `null` when the raw value can't be reduced to 3 significant digits at
   * all (so there's nothing to combine); a partial decode (e.g. an
   * unrecognized facility-type digit) still combines whatever pieces DID
   * decode.
   */
  combined: string | null;
}

/**
 * Reduces a Type-of-Bill value to its 3 significant characters (facility
 * type, bill classification, frequency). Accepts both the 3-character X12
 * form with no leading zero (e.g. "131", as `src/sources/x12/x12ClaimSource.ts`'s
 * `extractTypeOfBill` produces) and the classic 4-character UB-04 form with
 * a leading zero (e.g. "0131"). Returns `null` for anything else — a blank
 * value, or one that isn't exactly 3 or 4 characters — rather than guessing.
 */
function normalizeTypeOfBill(raw: string): [string, string, string] | null {
  const trimmed = raw.trim();
  let three = trimmed;
  if (three.length === 4 && three[0] === '0') three = three.slice(1);
  if (three.length !== 3) return null;
  return [three[0]!, three[1]!, three[2]!];
}

export function decodeTypeOfBill(raw: string): TypeOfBillDecoded {
  const digits = normalizeTypeOfBill(raw);
  const empty: CodedValue = { raw: '', decoded: null };
  if (!digits) {
    return { raw, facilityType: empty, billClassification: empty, frequency: empty, combined: null };
  }
  const [facilityDigit, classDigit, freqDigit] = digits;
  const facilityType = lookup(TOB_FACILITY_TYPE, facilityDigit);
  const classificationTable =
    facilityDigit === '7' ? TOB_CLINIC_CLASSIFICATION : facilityDigit === '8' ? TOB_SPECIAL_FACILITY_CLASSIFICATION : TOB_BILL_CLASSIFICATION;
  const billClassification = lookup(classificationTable, classDigit);
  const frequency = lookup(TOB_FREQUENCY, freqDigit);

  const head = [facilityType.decoded, billClassification.decoded].filter((p): p is string => p !== null).join(', ');
  const combinedParts = [head, frequency.decoded].filter((p): p is string => !!p);
  const combined = combinedParts.length > 0 ? combinedParts.join(', ') : null;

  return { raw, facilityType, billClassification, frequency, combined };
}
