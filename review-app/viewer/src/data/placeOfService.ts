/**
 * CMS Place of Service (POS) codes — CMS-1500 Box 24B.
 *
 * Source: CMS "Place of Service Code Set" (public domain, freely
 * redistributable — https://www.cms.gov/medicare/coding-billing/place-of-
 * service-codes/code-sets). Two-digit numeric codes only; no CPT/HCPCS
 * descriptor text is included anywhere in this file.
 *
 * To refresh: re-download the current code list from the URL above (CMS
 * updates it a few times a year — new codes are occasionally added, e.g.
 * telehealth codes 02/10 in recent years) and update the entries below.
 * Codes CMS marks "unassigned" are deliberately omitted — an omitted code
 * falls back to showing the raw value alone (never "Unknown"), which is the
 * correct behavior for a code CMS hasn't defined yet.
 */
export const PLACE_OF_SERVICE: Record<string, string> = {
  '01': 'Pharmacy',
  '02': 'Telehealth — provided other than in patient’s home',
  '03': 'School',
  '04': 'Homeless shelter',
  '05': 'Indian Health Service free-standing facility',
  '06': 'Indian Health Service provider-based facility',
  '07': 'Tribal 638 free-standing facility',
  '08': 'Tribal 638 provider-based facility',
  '09': 'Prison/correctional facility',
  '10': 'Telehealth — provided in patient’s home',
  '11': 'Office',
  '12': 'Home',
  '13': 'Assisted living facility',
  '14': 'Group home',
  '15': 'Mobile unit',
  '16': 'Temporary lodging',
  '17': 'Walk-in retail health clinic',
  '18': 'Place of employment — worksite',
  '19': 'Off-campus, outpatient hospital',
  '20': 'Urgent care facility',
  '21': 'Inpatient hospital',
  '22': 'On-campus, outpatient hospital',
  '23': 'Emergency room — hospital',
  '24': 'Ambulatory surgical center',
  '25': 'Birthing center',
  '26': 'Military treatment facility',
  '27': 'Outreach site/street',
  '31': 'Skilled nursing facility',
  '32': 'Nursing facility',
  '33': 'Custodial care facility',
  '34': 'Hospice',
  '41': 'Ambulance — land',
  '42': 'Ambulance — air or water',
  '49': 'Independent clinic',
  '50': 'Federally qualified health center',
  '51': 'Inpatient psychiatric facility',
  '52': 'Psychiatric facility — partial hospitalization',
  '53': 'Community mental health center',
  '54': 'Intermediate care facility — individuals with intellectual disabilities',
  '55': 'Residential substance abuse treatment facility',
  '56': 'Psychiatric residential treatment center',
  '57': 'Non-residential substance abuse treatment facility',
  '58': 'Non-residential opioid treatment facility',
  '60': 'Mass immunization center',
  '61': 'Comprehensive inpatient rehabilitation facility',
  '62': 'Comprehensive outpatient rehabilitation facility',
  '65': 'End-stage renal disease treatment facility',
  '71': 'Public health clinic',
  '72': 'Rural health clinic',
  '81': 'Independent laboratory',
  '99': 'Other place of service',
};
