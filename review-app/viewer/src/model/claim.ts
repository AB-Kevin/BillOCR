/**
 * Normalized, source-agnostic claim model.
 *
 * Both the JSON clearinghouse feed and the X12 837 reader map INTO this model;
 * the form renderers (CMS-1500 / UB-04 / dental) read only FROM it. Keeping the
 * model in the middle is what lets a second source (837) drop in without
 * touching the renderers, and vice-versa.
 *
 * Values are already cleaned: empty strings and sentinel "0000-00-00" dates are
 * normalized to '' by the source, so renderers can treat '' as "blank / show —".
 */

export type FormType = 'cms1500' | 'ub04' | 'dental' | 'unsupported';

export interface Name {
  last: string;
  first: string;
  middle: string;
}

export interface Address {
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
}

export interface Diagnosis {
  /** CMS-1500 box-21 pointer letter A–L for the first 12; '' for 13–24 (institutional depth). */
  pointer: string;
  /** 1-based ordinal as it appeared in the source (diag_1 -> 1). */
  ordinal: number;
  code: string;
  /** Present-on-admission indicator (institutional); '' for professional. */
  poa: string;
}

export interface ServiceLine {
  fromDate: string;
  thruDate: string;
  placeOfService: string;
  procCode: string;
  /** mod1..mod4, empties dropped. */
  modifiers: string[];
  /** Diagnosis pointer letters this line references, e.g. ['A','B'] from diag_ref "AB". */
  diagPointers: string[];
  charge: number;
  units: string;
  chargeId: string;
  patientResponsibility: number;

  // --- Institutional (UB-04) line fields; absent on professional lines. ---
  /** UB-04 FL42 revenue code. */
  revenueCode?: string;
  /** UB-04 FL43 revenue description. */
  revenueDescription?: string;

  // --- Dental (ADA) line fields; absent otherwise. ---
  /** ADA box 27 — tooth number(s)/letter(s) for this line. */
  toothNumbers?: string;
  /** ADA box 28 — tooth surface(s). */
  toothSurfaces?: string;
  /** ADA box 25 — area of oral cavity. */
  oralCavityArea?: string;
}

// --- Institutional (UB-04 / 837I) claim-level data ---

export interface ValueCode {
  code: string;
  amount: number;
}
export interface OccurrenceCode {
  code: string;
  date: string;
}
export interface OccurrenceSpan {
  code: string;
  from: string;
  through: string;
}

export interface Institutional {
  /** FL04 Type of Bill. */
  typeOfBill: string;
  /** FL06 Statement covers period. */
  statementFrom: string;
  statementThrough: string;
  /** FL12 / FL14 / FL15 / FL17. */
  admissionDate: string;
  admissionType: string;
  admissionSource: string;
  patientStatus: string;
  /** FL18–28. */
  conditionCodes: string[];
  /** FL31–34. */
  occurrenceCodes: OccurrenceCode[];
  /** FL35–36. */
  occurrenceSpans: OccurrenceSpan[];
  /** FL39–41. */
  valueCodes: ValueCode[];
  /** FL69 admitting diagnosis. */
  admittingDiagnosis: string;
  /** FL74 principal procedure. */
  principalProcedure: { code: string; date: string } | null;
  /** Diagnosis-Related Group, when present. */
  drg: string;
}

// --- Dental (ADA 2024 / 837D) claim-level data ---

export interface Dental {
  /** ADA box 1 — e.g. "Statement of Actual Services" / "Request for Predetermination". */
  transactionType: string;
  /** ADA box 2. */
  predeterminationNumber: string;
  /** ADA box 38 — place of treatment. */
  placeOfTreatment: string;
  /** ADA box 33/34 — missing teeth. */
  missingTeeth: string[];
  /** ADA boxes 40–42 — orthodontic treatment, when applicable. */
  orthodontics: { monthsRemaining: string; appliancePlacedDate: string } | null;
  /** ADA box 53 — treating dentist. */
  treatingDentist: Name;
}

export interface BillingProvider {
  name: string;
  npi: string;
  taxId: string;
  /** 'E' (EIN) | 'S' (SSN) | ''. */
  taxIdType: string;
  address: Address;
  phone: string;
  taxonomy: string;
}

export interface RenderingProvider {
  name: Name;
  npi: string;
  taxonomy: string;
}

export interface ReferringProvider {
  name: Name;
  npi: string;
  id: string;
}

export interface Facility {
  name: string;
  npi: string;
  address: Address;
}

export interface Payer {
  name: string;
  id: string;
  address: Address;
  /** e.g. 'Primary'. */
  order: string;
}

export interface OtherInsurance {
  name: Name;
  policyOrGroup: string;
  memberId: string;
  plan: string;
  patientRelationship: string;
}

export type WarningSeverity = 'info' | 'warning';

export interface ClaimWarning {
  code: string;
  severity: WarningSeverity;
  message: string;
}

export interface Claim {
  claimId: string;
  formType: FormType;
  /** Raw source value (e.g. '1500'); kept for the inspector and diagnostics. */
  claimFormRaw: string;

  patient: {
    name: Name;
    dob: string;
    sex: string;
    address: Address;
    phone: string;
    /** Relationship-to-insured code: 18=self, 01=spouse, 19=child, G8/other. */
    relationshipToInsured: string;
    /** Patient account / control number (pcn). */
    accountNumber: string;
  };

  insured: {
    name: Name;
    memberId: string;
    group: string;
    plan: string;
    dob: string;
    sex: string;
    address: Address;
    /** Box 7's telephone field -- distinct from patient.phone (box 5). */
    phone: string;
    employer: string;
  };

  payer: Payer;
  otherInsurance: OtherInsurance | null;

  billingProvider: BillingProvider;
  renderingProvider: RenderingProvider;
  referringProvider: ReferringProvider | null;
  facility: Facility | null;

  diagnoses: Diagnosis[];
  serviceLines: ServiceLine[];

  totals: {
    totalCharge: number;
    amountPaid: number;
  };

  flags: {
    acceptAssignment: boolean;
    autoAccident: boolean;
    autoAccidentState: string;
    employmentRelated: boolean;
    priorAuth: string;
  };

  hospitalization: { from: string; thru: string } | null;

  /** Present only for institutional (UB-04) claims. */
  institutional?: Institutional;
  /** Present only for dental (ADA) claims. */
  dental?: Dental;

  narrative: string;
  cliaNumber: string;

  /** Original source key/values, kept verbatim for the inspector's raw view. */
  raw: Record<string, unknown>;

  warnings: ClaimWarning[];
}
