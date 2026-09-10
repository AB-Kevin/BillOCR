/**
 * UB-04 Occurrence codes (FL31–34) and Occurrence Span codes (FL35–36).
 *
 * Source: NUBC Occurrence Code / Occurrence Span Code sets as republished by
 * CMS and its Medicare Administrative Contractors (Noridian JE/JF Part A
 * "Occurrence Codes" and "Occurrence Span Codes" reference tables, which
 * mirror the Medicare Claims Processing Manual, Pub 100-04, Ch. 25).
 * Public, freely redistributable short labels only. An un-listed code shows
 * the raw value alone (never "Unknown").
 *
 * The two lists are SEPARATE NUBC code sets and are kept as separate tables
 * here — FL31–34 decodes against OCCURRENCE_CODES and FL35–36 against
 * OCCURRENCE_SPAN_CODES. They must never be merged: the occurrence list runs
 * 01–62 and the span list runs 70–82, so a merged table silently answers
 * "70 = qualifying stay dates" for an FL31 occurrence code and vice versa.
 * (Build 2 originally shipped them merged, with a header comment claiming the
 * approximation was "never presented as certain"; nothing in the code
 * implemented that hedge — see docs/AUDIT_BUILD2.md.)
 *
 * Codes the payer populates internally and a provider never submits (23, 48,
 * 49 and the Z0–ZZ span range) are deliberately omitted rather than given a
 * "Payer code" label that reads as a real decode on screen.
 *
 * To refresh: re-derive each table from ONE aligned source in a single pass —
 * do not patch individual keys. Build 2 shipped a three-code leftward
 * transcription shift (39/44/45 carrying the labels belonging to 44/45/46,
 * with 46 missing entirely) that patching would have left half-corrected.
 * test/decodeTables.test.ts pins the codes involved.
 */
export const OCCURRENCE_CODES: Record<string, string> = {
  '01': 'Accident/medical coverage',
  '02': 'No-fault insurance involved — including auto accident',
  '03': 'Accident/tort liability',
  '04': 'Accident/employment related',
  '05': 'Accident/no medical or liability coverage',
  '06': 'Crime victim',
  '09': 'Start of infertility treatment cycle',
  '10': 'Last menstrual period',
  '11': 'Onset of symptoms/illness',
  '12': 'Date of onset for a chronically dependent individual',
  '16': 'Date of last therapy',
  '17': 'Date outpatient occupational therapy plan established or last reviewed',
  '18': 'Date of retirement — patient/beneficiary',
  '19': 'Date of retirement — spouse',
  '20': 'Date guarantee of payment began',
  '21': 'Date utilization review notice received',
  '22': 'Date active care ended',
  '24': 'Date insurance denied',
  '25': 'Date benefits terminated by primary payer',
  '26': 'Date skilled nursing facility bed became available',
  '27': 'Date of hospice certification or recertification',
  '28': 'Date comprehensive outpatient rehabilitation plan established or last reviewed',
  '29': 'Date outpatient physical therapy plan established or last reviewed',
  '30': 'Date outpatient speech pathology plan established or last reviewed',
  '31': 'Date beneficiary notified of intent to bill (accommodations)',
  '32': 'Date beneficiary notified of intent to bill (procedures/treatments)',
  '33': 'First day of the Medicare coordination period for ESRD beneficiaries covered by an employer group health plan',
  '34': 'Date of election of extended care facilities',
  '35': 'Date treatment started for physical therapy',
  '36': 'Date of inpatient hospital discharge for a covered transplant patient',
  '37': 'Date of inpatient hospital discharge for a non-covered transplant patient',
  '38': 'Date treatment started for home IV therapy',
  '39': 'Date discharged on a continuous course of IV therapy',
  '40': 'Scheduled date of admission',
  '41': 'Date of first test for pre-admission testing',
  '42': 'Date of discharge',
  '43': 'Scheduled date of canceled surgery',
  '44': 'Date treatment started for occupational therapy',
  '45': 'Date treatment started for speech therapy',
  '46': 'Date treatment started for cardiac rehabilitation',
  '47': 'Date cost outlier status begins',
  '50': 'Assessment date',
  '51': 'Date of last Kt/V reading (dialysis)',
  '52': 'Medical certification/recertification date',
  '54': 'Physician follow-up date',
  '55': 'Date of death',
  '56': 'Original hospice election or revocation date',
  '61': 'Hospital discharge date (home health only)',
  '62': 'Other institutional discharge date (home health only)',

  // Insured/payer designation series. A1–A4 are listed verbatim by the
  // source; the B and C series are the same three codes for the second and
  // third insured/payer, which the source states explicitly rather than
  // enumerating. Re-check these against the manual on the next refresh.
  A1: 'Birthdate — insured A',
  A2: 'Effective date — insured A policy',
  A3: 'Benefits exhausted — payer A',
  A4: 'Split bill date',
  B1: 'Birthdate — insured B',
  B2: 'Effective date — insured B policy',
  B3: 'Benefits exhausted — payer B',
  C1: 'Birthdate — insured C',
  C2: 'Effective date — insured C policy',
  C3: 'Benefits exhausted — payer C',
  DR: 'Disaster related',
};

/**
 * UB-04 Occurrence Span codes (FL35–36) — a separate NUBC list from the
 * occurrence codes above. Numeric span codes run 70–82 with no overlap into
 * the 01–62 occurrence range, which is exactly why decoding one field against
 * the other's table produced confident wrong answers.
 */
export const OCCURRENCE_SPAN_CODES: Record<string, string> = {
  '70': 'Qualifying stay dates (skilled nursing facility)',
  '71': 'Prior stay dates',
  '72': 'First/last visit dates',
  '73': 'Benefit eligibility period',
  '74': 'Non-covered level of care/leave of absence dates',
  '75': 'SNF level of care dates',
  '76': 'Patient liability',
  '77': 'Provider liability period',
  '78': 'SNF prior stay dates',
  '80': 'Prior same-SNF stay dates for payment ban purposes',
  '81': 'Antepartum days at reduced level of care',
  '82': 'Hospital at home care dates',
  M0: 'QIO/UR approved stay dates',
  M1: 'Provider liability — no utilization',
  M2: 'Inpatient respite dates',
  M3: 'Intermediate care facility level of care',
  M4: 'Residential level of care',
  MR: 'Disaster related',
};
