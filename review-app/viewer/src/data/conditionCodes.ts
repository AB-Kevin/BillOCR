/**
 * UB-04 Condition codes (FL18–28).
 *
 * Source: NUBC Condition Code set, as republished by CMS in the Medicare
 * Claims Processing Manual (Pub 100-04, Ch. 25). Public, freely
 * redistributable short labels only. This is a curated subset of the
 * commonly-seen numeric (01–99) codes — the alpha-prefixed payer-specific
 * series (AA–DR etc.) is not covered; an un-listed code shows the raw value
 * alone (never "Unknown"), which is correct for a code this table hasn't
 * been extended to cover.
 *
 * To refresh: check the current Medicare Claims Processing Manual chapter
 * 25 condition-code table and add any new/changed codes below, keyed by the
 * plain 2-character code.
 */
export const CONDITION_CODES: Record<string, string> = {
  '01': 'Military service related',
  '02': 'Condition is employment related',
  '03': 'Patient covered by insurance not reflected here',
  '04': 'Information only bill (HMO)',
  '05': 'Lien has been filed',
  '06': 'ESRD patient in first 30 months of Medicare eligibility, EGHP is primary',
  '07': 'Treatment for a non-terminal condition for a hospice patient',
  '08': 'Beneficiary would not provide information concerning other insurance',
  '09': 'Neither patient nor spouse employed',
  '10': 'Patient/spouse employed, but no employer group health plan exists',
  '11': 'Disabled beneficiary, but no large group health plan',
  '17': 'Patient is homeless',
  '18': 'Maiden name retained',
  '19': 'Child retains mother’s name',
  '20': 'Beneficiary requested billing',
  '21': 'Billing for denial notice',
  '25': 'Patient is a non-U.S. resident',
  '26': 'VA-eligible patient chooses to receive services in a Medicare-certified facility',
  '27': 'Patient referred to a sole community hospital for a diagnostic laboratory test',
  '28': 'Patient and/or spouse’s employer group health plan is secondary to Medicare',
  '29': 'Disabled beneficiary and/or family member’s large group health plan is secondary to Medicare',
  '31': 'Patient is a student — full-time, day',
  '32': 'Patient is a student — cooperative/work-study program',
  '33': 'Patient is a student — full-time, night',
  '34': 'Patient is a student — part-time',
  '36': 'General care patient in a special unit',
  '37': 'Ward accommodation at patient request',
  '38': 'Semi-private room not available',
  '39': 'Private room medically necessary',
  '40': 'Same-day transfer',
  '41': 'Partial hospitalization',
  '42': 'Continuing care not related to inpatient admission',
  '43': 'Continuing care not provided within the prescribed post-discharge window',
  '44': 'Inpatient admission changed to outpatient',
  '46': 'Non-availability statement on file',
  '55': 'SNF bed not available',
  '56': 'Medical appropriateness',
  '57': 'SNF readmission',
  '60': 'Operating cost day outlier',
  '61': 'Operating cost outlier',
  // 62 (PIP bill, recorded by the payer's system and never submitted by a
  // provider) is omitted rather than carrying a bare "Payer code" placeholder.
  '66': 'Provider does not wish cost outlier payment',
  '70': 'Self-administered anemia management drug',
  '71': 'Full care in unit',
  '72': 'Self-care in unit',
  '73': 'Self-care training',
  '74': 'Home',
  '75': 'Home — 100% reimbursement',
  '76': 'Back-up in facility dialysis',
  '77': 'Provider accepts or is obligated to accept payment by a primary payer as payment in full',
  '78': 'New coverage not implemented by managed care plan',
  '79': 'CORF services provided off-site',
  '80': 'Home dialysis — nursing facility',
  // 81–83 are the gestational-age attestation series for C-sections and
  // inductions. Build 2 shipped 81 as "Cost outlier — IPPS", which both
  // collided with 61 and put a reimbursement concept on a maternity claim.
  '81': 'C-section or induction at less than 39 weeks gestation — medical necessity',
  '82': 'C-section or induction at less than 39 weeks gestation — elective',
  '83': 'C-section or induction at 39 weeks gestation or later',
  '84': 'Dialysis for acute kidney injury',
  '87': 'ESRD self-care retraining',
  '90': 'Service provided under an Expanded Access approval',
  '91': 'Service provided under an Emergency Use Authorization',
  '92': 'Services provided under an Intensive Outpatient Program care plan',
};
