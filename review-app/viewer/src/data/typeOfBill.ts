/**
 * UB-04 Type of Bill (FL04) component code sets.
 *
 * FL04 is a 3- or 4-digit code (a leading '0' is sometimes shown, sometimes
 * dropped — X12 837I's CLM05 composite carries it without the leading
 * zero). Each significant digit is its own NUBC code set:
 *   digit 1 — Type of Facility
 *   digit 2 — Bill Classification (meaning depends on the facility type —
 *             clinics (facility type 7) and special facilities (type 8)
 *             use a different classification list than hospitals/SNF/HHA/
 *             ICF, types 1–6)
 *   digit 3 — Claim Frequency (a.k.a. "bill sequence")
 *
 * Source: NUBC Type of Bill code set, as republished by CMS in the Medicare
 * Claims Processing Manual (Pub 100-04) and the 837I companion guide.
 * Public, freely redistributable short labels only.
 *
 * To refresh: check the current Medicare Claims Processing Manual chapter
 * on UB-04 billing (or the X12 837I 005010X223 implementation guide's
 * CLM05/CL1 code lists) and add any new digit values below.
 */

/** FL04 digit 1 — Type of Facility. */
export const TOB_FACILITY_TYPE: Record<string, string> = {
  '1': 'Hospital',
  '2': 'Skilled nursing facility',
  '3': 'Home health agency',
  '4': 'Religious non-medical health care institution — hospital',
  '5': 'Religious non-medical health care institution — extended care',
  '6': 'Intermediate care',
  '7': 'Clinic or special facility',
  '8': 'Special facility',
  '9': 'Reserved for national assignment',
};

/** FL04 digit 2 — Bill Classification, for facility types 1–6 (hospital / SNF / HHA / religious non-medical / intermediate care). */
export const TOB_BILL_CLASSIFICATION: Record<string, string> = {
  '1': 'Inpatient (Part A)',
  '2': 'Inpatient (Part B only)',
  '3': 'Outpatient',
  '4': 'Other (Part B)',
  '5': 'Intermediate care — level I',
  '6': 'Intermediate care — level II',
  '7': 'Subacute inpatient (revenue code 019X)',
  '8': 'Swing bed',
};

/** FL04 digit 2 — Bill Classification, for facility type 7 (clinic). */
export const TOB_CLINIC_CLASSIFICATION: Record<string, string> = {
  '1': 'Rural health clinic',
  '2': 'Hospital-based or independent renal dialysis facility',
  '3': 'Free-standing provider-based federally qualified health center',
  '4': 'Other rehabilitation facility (ORF)',
  '5': 'Comprehensive outpatient rehabilitation facility (CORF)',
  '6': 'Community mental health center',
  '9': 'Other',
};

/** FL04 digit 2 — Bill Classification, for facility type 8 (special facility). */
export const TOB_SPECIAL_FACILITY_CLASSIFICATION: Record<string, string> = {
  '1': 'Hospice — non-hospital based',
  '2': 'Hospice — hospital based',
  '3': 'Ambulatory surgery center',
  '4': 'Free-standing birthing center',
  '5': 'Critical access hospital',
  '6': 'Residential facility',
  '9': 'Other',
};

/** FL04 digit 3 — Claim Frequency (bill sequence). */
export const TOB_FREQUENCY: Record<string, string> = {
  '0': 'Non-payment/zero claim',
  '1': 'Admit through discharge claim',
  '2': 'Interim — first claim',
  '3': 'Interim — continuing claim',
  '4': 'Interim — last claim',
  '5': 'Late charge(s) only claim',
  '6': 'Adjustment of prior claim',
  '7': 'Replacement of prior claim',
  '8': 'Void/cancel of prior claim',
  '9': 'Final claim for a home health PPS episode',
  'A': 'Admission/election notice (hospice)',
  'B': 'Termination/revocation notice (hospice/home health)',
  'C': 'Change of provider notice (hospice/home health)',
  'D': 'Void/cancel (hospice/home health)',
  'E': 'Change of ownership (hospice)',
  'F': 'Beneficiary-initiated adjustment claim',
  'G': 'CWF-initiated adjustment claim',
  'H': 'CMS-initiated adjustment claim',
  'I': 'Intermediary-initiated adjustment claim',
  'J': 'Initiated adjustment claim — other',
  // K/M/P complete the adjustment-source series above. Build 2 shipped an
  // invented "QIM" acronym on both M and P; the frequency string is folded
  // into `combined` (src/model/decode.ts) and rendered on the headline
  // "Type of bill" row, so a bill type ending in M showed a category that
  // does not exist instead of Medicare Secondary Payer.
  'K': 'OIG-initiated adjustment claim',
  'M': 'MSP-initiated adjustment claim',
  'P': 'QIO adjustment claim',
};
