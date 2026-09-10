/**
 * UB-04 Value codes (FL39–41).
 *
 * Source: NUBC Value Code set as republished by CMS and its Medicare
 * Administrative Contractors (Noridian JE/JF Part A "Value Codes" reference
 * table, mirroring the Medicare Claims Processing Manual, Pub 100-04,
 * Ch. 25). Public, freely redistributable short labels only. This is a
 * curated subset of the commonly-seen numeric codes; an un-listed code shows
 * the raw value alone (never "Unknown").
 *
 * Codes the payer populates internally and a provider never submits (62, 63
 * and the reserved 73–75 range) are deliberately omitted rather than carrying
 * a placeholder label. A wrong label here renders inline beside a real dollar
 * figure on a claim used for negotiation, so "no decode" is strictly better
 * than "a plausible decode".
 *
 * To refresh: re-derive a whole contiguous block from ONE aligned source in a
 * single pass rather than patching individual keys — Build 2 shipped an
 * off-by-one key run through 67/68 plus a duplicated label on 62, which
 * key-by-key patching would have left half-corrected. test/decodeTables.test.ts
 * pins the corrected codes and mechanically rejects duplicate labels.
 */
export const VALUE_CODES: Record<string, string> = {
  '01': 'Most common semi-private room rate',
  '02': 'Hospital has no semi-private rooms',
  '04': 'Inpatient professional component charges, combined billing',
  '05': 'Professional component included in charges, also billed separately to carrier',
  '06': 'Medicare blood deductible',
  '08': 'Medicare lifetime reserve amount — first calendar year',
  '09': 'Medicare coinsurance amount — first calendar year',
  '10': 'Medicare lifetime reserve amount — second calendar year',
  '11': 'Medicare coinsurance amount — second calendar year',
  '12': 'Working-aged beneficiary/spouse with employer group health plan',
  '13': 'ESRD beneficiary in Medicare coordination period with employer group health plan',
  '14': 'No-fault insurance, including auto/other',
  '15': 'Workers’ compensation',
  '16': 'Public Health Service or other federal agency',
  '17': 'Operating outlier amount',
  '21': 'Catastrophic',
  '22': 'Surplus',
  '23': 'Recurring monthly income',
  '24': 'Medicaid rate code',
  '30': 'Pre-admission testing',
  '31': 'Patient liability amount',
  '37': 'Pints of blood furnished',
  '38': 'Blood deductible pints',
  '39': 'Pints of blood replaced',
  '40': 'New coverage not implemented by HMO (rural health clinic)',
  '41': 'Black lung',
  '42': 'Veterans Affairs',
  '43': 'Disabled beneficiary under age 65 with large group health plan',
  '44': 'Amount provider agreed to accept from primary payer, less than charges but higher than payment received',
  '45': 'Accident hour',
  '46': 'Number of grace days',
  '47': 'Any liability insurance',
  '48': 'Hemoglobin reading',
  '49': 'Hematocrit reading',
  '50': 'Physical therapy visits',
  '51': 'Occupational therapy visits',
  '52': 'Speech therapy visits',
  '53': 'Cardiac rehabilitation visits',
  '54': 'Newborn birth weight, in grams',
  '55': 'Eligibility threshold for charity care',
  '56': 'Skilled nurse — home visit hours',
  '58': 'Arterial blood gas',
  '59': 'Oxygen saturation',
  '61': 'Location where service is furnished (HHA/hospice)',
  // 62 and 63 (home health visits, Part A and Part B) are populated by the
  // payer internally, never submitted by a provider, and are omitted per the
  // policy above. Build 2 shipped 62 carrying a verbatim duplicate of 42's
  // "Veterans Affairs" label — two codes decoding to one string.
  '66': 'Medicaid spend-down amount',
  '67': 'Peritoneal dialysis hours',
  '68': 'EPO units administered or supplied',
  '69': 'State charity care percent',
  '70': 'Replacement of prosthetic device',
  '71': 'Funding source of ESRD network',
  // 73–75 are reserved for internal third-party payer use and are omitted.
  // Build 2 shipped 73 and a bare "Days" label on 74.
  '76': 'Provider spend-down',
  '77': 'New EPO (ESRD) number',
  '80': 'Covered days',
  '81': 'Non-covered days',
  '82': 'Coinsurance days',
  '83': 'Lifetime reserve days',
  '85': 'Delay reason code',
};
