/**
 * UB-04 Patient Discharge Status codes (FL17), a.k.a. "patient status".
 *
 * Source: NUBC Patient Discharge Status code set, as republished by CMS in
 * the Medicare Claims Processing Manual (Pub 100-04, Ch. 25) and CMS's own
 * "Condition Code / Patient Discharge Status" quick-reference. Public,
 * freely redistributable short labels only.
 *
 * To refresh: CMS periodically adds new discharge-status codes (most
 * recently the "planned acute care readmission" 81–95 series, added to
 * distinguish a planned readmission from an unplanned one) — check the
 * current Medicare Claims Processing Manual chapter and add any new codes
 * below, keyed by the plain 2-digit code.
 */
export const DISCHARGE_STATUS: Record<string, string> = {
  '01': 'Discharged to home or self-care',
  '02': 'Discharged/transferred to a short-term general hospital for inpatient care',
  '03': 'Discharged/transferred to a skilled nursing facility (SNF)',
  '04': 'Discharged/transferred to an intermediate care facility (ICF)',
  '05': 'Discharged/transferred to a designated cancer center or children’s hospital',
  '06': 'Discharged/transferred to home under care of an organized home health service',
  '07': 'Left against medical advice',
  '09': 'Admitted as an inpatient to this hospital (from outpatient)',
  '20': 'Expired',
  '21': 'Discharged/transferred to court/law enforcement',
  '30': 'Still a patient',
  '40': 'Expired at home (hospice)',
  '41': 'Expired in a medical facility (hospice)',
  '42': 'Expired — place unknown (hospice)',
  '43': 'Discharged/transferred to a federal healthcare facility',
  '50': 'Discharged to hospice — home',
  '51': 'Discharged to hospice — medical facility',
  '61': 'Discharged/transferred to a hospital-based Medicare-approved swing bed',
  '62': 'Discharged/transferred to an inpatient rehabilitation facility (IRF)',
  '63': 'Discharged/transferred to a long-term care hospital (LTCH)',
  '64': 'Discharged/transferred to a Medicaid-certified nursing facility',
  '65': 'Discharged/transferred to a psychiatric hospital or unit',
  '66': 'Discharged/transferred to a critical access hospital (CAH)',
  '69': 'Discharged/transferred to a designated disaster alternative care site',
  '70': 'Discharged/transferred to another type of healthcare institution',
  '81': 'Discharged to home or self-care, with planned acute care hospital readmission',
  '82': 'Discharged/transferred to a short-term general hospital, with planned readmission',
  '83': 'Discharged/transferred to a skilled nursing facility, with planned readmission',
  '84': 'Discharged/transferred to an intermediate care facility, with planned readmission',
  '85': 'Discharged/transferred to a designated cancer center or children’s hospital, with planned readmission',
  '86': 'Discharged/transferred to home under organized home health service, with planned readmission',
  '88': 'Discharged/transferred to a federal healthcare facility, with planned readmission',
  '89': 'Discharged/transferred to a hospital-based Medicare-approved swing bed, with planned readmission',
  '90': 'Discharged/transferred to an inpatient rehabilitation facility, with planned readmission',
  '91': 'Discharged/transferred to a long-term care hospital, with planned readmission',
  '92': 'Discharged/transferred to a Medicaid-certified nursing facility, with planned readmission',
  '93': 'Discharged/transferred to a psychiatric hospital or unit, with planned readmission',
  '94': 'Discharged/transferred to a critical access hospital, with planned readmission',
  '95': 'Discharged/transferred to another type of healthcare institution, with planned readmission',
};
