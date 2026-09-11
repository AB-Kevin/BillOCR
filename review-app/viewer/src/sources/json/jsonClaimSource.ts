import type { Claim, Diagnosis, FormType, Name, Address, ServiceLine, ClaimWarning } from '../../model/claim.js';
import { type ClaimSource, ClaimParseError } from '../claimSource.js';

/**
 * Maps the flat clearinghouse claim JSON (one object = one claim) into the
 * normalized Claim model. Field names are taken verbatim from the real feed
 * (see docs/PLAN_REVISION_v2_JSON.md §5). All five observed samples are
 * claim_form "1500" (professional / CMS-1500).
 */

type Flat = Record<string, unknown>;

/** A charge line as it appears in the source `charge` array. */
interface RawCharge {
  from_date?: string;
  thru_date?: string;
  place_of_service?: string;
  proc_code?: string;
  mod1?: string;
  mod2?: string;
  mod3?: string;
  mod4?: string;
  diag_ref?: string;
  charge?: string;
  units?: string;
  chgid?: string;
  patient_responsibility?: string;
}

const EMPTY_DATE = '0000-00-00';

/** Trim; treat the feed's sentinel empty date as blank. */
function s(v: unknown): string {
  if (v === null || v === undefined) return '';
  const t = String(v).trim();
  return t === EMPTY_DATE ? '' : t;
}

/** Parse a decimal string to a number; blank/garbage -> 0. */
function num(v: unknown): number {
  const t = s(v);
  if (t === '') return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

function name(f: Flat, prefix: string): Name {
  return {
    last: s(f[`${prefix}_name_l`]),
    first: s(f[`${prefix}_name_f`]),
    middle: s(f[`${prefix}_name_m`]),
  };
}

function address(f: Flat, prefix: string): Address {
  return {
    line1: s(f[`${prefix}_addr_1`]),
    line2: s(f[`${prefix}_addr_2`]),
    city: s(f[`${prefix}_city`]),
    state: s(f[`${prefix}_state`]),
    zip: s(f[`${prefix}_zip`]),
  };
}

/** Box-21 pointer letter for a 1-based diagnosis ordinal (1->A .. 12->L); '' beyond 12. */
export function pointerLetter(ordinal: number): string {
  return ordinal >= 1 && ordinal <= 12 ? String.fromCharCode(64 + ordinal) : '';
}

function diagnoses(f: Flat): Diagnosis[] {
  const out: Diagnosis[] = [];
  for (let i = 1; i <= 24; i++) {
    const code = s(f[`diag_${i}`]);
    if (code === '') continue;
    out.push({
      pointer: pointerLetter(i),
      ordinal: i,
      code,
      poa: s(f[`diag_${i}_poa`]),
    });
  }
  return out;
}

function modifiers(c: RawCharge): string[] {
  return [c.mod1, c.mod2, c.mod3, c.mod4].map(s).filter((m) => m !== '');
}

/** "AB" -> ['A','B']; keeps only A–L letters. */
export function splitPointers(diagRef: unknown): string[] {
  return s(diagRef)
    .toUpperCase()
    .split('')
    .filter((ch) => ch >= 'A' && ch <= 'L');
}

function serviceLines(f: Flat): ServiceLine[] {
  const raw = f['charge'];
  if (!Array.isArray(raw)) return [];
  return (raw as RawCharge[]).map((c) => ({
    fromDate: s(c.from_date),
    thruDate: s(c.thru_date),
    placeOfService: s(c.place_of_service),
    procCode: s(c.proc_code),
    modifiers: modifiers(c),
    diagPointers: splitPointers(c.diag_ref),
    charge: num(c.charge),
    units: s(c.units),
    chargeId: s(c.chgid),
    patientResponsibility: num(c.patient_responsibility),
  }));
}

function mapFormType(claimForm: string): FormType {
  switch (claimForm) {
    case '1500':
      return 'cms1500';
    // Institutional / dental values are not yet observed in the JSON feed.
    // '1450' / 'UB' and dental would map here once a real sample defines them.
    default:
      return 'unsupported';
  }
}

function bool(v: unknown): boolean {
  return s(v).toUpperCase() === 'Y';
}

function hasAny(f: Flat, keys: string[]): boolean {
  return keys.some((k) => s(f[k]) !== '');
}

/** True for the feed's "no provider" NPI sentinel: blank, or all zeros (e.g. "0", "0000000000"). */
function isSentinelNpi(v: unknown): boolean {
  const t = s(v);
  return t === '' || /^0+$/.test(t);
}

/**
 * Like hasAny, but any key ending in "_npi" only counts as "present" when
 * its value is a real (non-sentinel) NPI — mirrors the npi==='0' exemption
 * already applied to the rendering provider in validateClaim(). Without
 * this, a facility/referring block that carries only the feed's "0" NPI
 * sentinel (name/id fields blank) would be treated as present and render a
 * phantom, all-blank provider on the form.
 */
function hasAnyExceptSentinelNpi(f: Flat, keys: string[]): boolean {
  return keys.some((k) => {
    const v = s(f[k]);
    if (v === '') return false;
    if (k.endsWith('_npi') && isSentinelNpi(v)) return false;
    return true;
  });
}

export class JsonClaimSource implements ClaimSource {
  readonly kind = 'json' as const;

  canParse(text: string): boolean {
    const t = text.trimStart();
    if (!t.startsWith('{') && !t.startsWith('[')) return false;
    try {
      const v = JSON.parse(t) as unknown;
      const obj = Array.isArray(v) ? v[0] : v;
      return !!obj && typeof obj === 'object' && 'claim_form' in (obj as Flat);
    } catch {
      return false;
    }
  }

  parse(text: string): Claim[] {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new ClaimParseError('This file is not valid JSON.', (e as Error).message);
    }
    const objects = Array.isArray(data) ? data : [data];
    if (objects.length === 0) throw new ClaimParseError('The JSON file contains no claims.');
    return objects.map((o, i) => {
      if (!o || typeof o !== 'object') {
        throw new ClaimParseError(`Claim ${i + 1} is not a JSON object.`);
      }
      return this.mapOne(o as Flat);
    });
  }

  private mapOne(f: Flat): Claim {
    const claimFormRaw = s(f['claim_form']);
    const diags = diagnoses(f);
    const lines = serviceLines(f);
    const totalCharge = num(f['total_charge']);

    const claim: Claim = {
      claimId: s(f['claimid']),
      formType: mapFormType(claimFormRaw),
      claimFormRaw,
      patient: {
        name: name(f, 'pat'),
        dob: s(f['pat_dob']),
        sex: s(f['pat_sex']),
        address: address(f, 'pat'),
        phone: s(f['pat_phone']),
        relationshipToInsured: s(f['pat_rel']),
        accountNumber: s(f['pcn']),
      },
      insured: {
        name: name(f, 'ins'),
        memberId: s(f['ins_number']),
        group: s(f['ins_group']),
        plan: s(f['ins_plan']),
        dob: s(f['ins_dob']),
        sex: s(f['ins_sex']),
        address: address(f, 'ins'),
        phone: s(f['ins_phone']),
        employer: s(f['ins_employer']),
      },
      payer: {
        name: s(f['payer_name']),
        id: s(f['payerid']),
        address: address(f, 'payer'),
        order: s(f['payer_order']),
      },
      otherInsurance: hasAny(f, ['other_ins_name_l', 'other_ins_number', 'other_payerid'])
        ? {
            name: name(f, 'other_ins'),
            policyOrGroup: s(f['other_ins_group']),
            memberId: s(f['other_ins_number']),
            plan: s(f['other_ins_plan']),
            patientRelationship: s(f['other_pat_rel']),
          }
        : null,
      billingProvider: {
        name: s(f['bill_name']),
        npi: s(f['bill_npi']),
        taxId: s(f['bill_taxid']),
        taxIdType: s(f['bill_taxid_type']),
        address: address(f, 'bill'),
        phone: s(f['bill_phone']),
        taxonomy: s(f['bill_taxonomy']),
      },
      renderingProvider: {
        name: name(f, 'prov'),
        npi: s(f['prov_npi']),
        taxonomy: s(f['prov_taxonomy']),
      },
      referringProvider: hasAnyExceptSentinelNpi(f, ['ref_name_l', 'ref_npi', 'ref_id'])
        ? { name: name(f, 'ref'), npi: s(f['ref_npi']), id: s(f['ref_id']) }
        : null,
      facility: hasAnyExceptSentinelNpi(f, ['facility_name', 'facility_npi'])
        ? { name: s(f['facility_name']), npi: s(f['facility_npi']), address: address(f, 'facility') }
        : null,
      diagnoses: diags,
      serviceLines: lines,
      totals: { totalCharge, amountPaid: num(f['amount_paid']) },
      flags: {
        acceptAssignment: bool(f['accept_assign']),
        autoAccident: bool(f['auto_accident']),
        autoAccidentState: s(f['auto_accident_state']),
        employmentRelated: bool(f['employment_related']),
        priorAuth: s(f['prior_auth']),
      },
      hospitalization:
        s(f['hosp_from_date']) !== '' || s(f['hosp_thru_date']) !== ''
          ? { from: s(f['hosp_from_date']), thru: s(f['hosp_thru_date']) }
          : null,
      narrative: s(f['narrative']),
      cliaNumber: s(f['clia_number']),
      raw: f,
      warnings: [],
    };

    claim.warnings = validateClaim(claim);
    return claim;
  }
}

/** NPI = 10 digits with a valid Luhn check over the 80840-prefixed value. */
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = ('80840' + npi).split('').map(Number);
  let sum = 0;
  // Validate over the full value: the rightmost (check) digit is NOT doubled.
  for (let i = digits.length - 1, alt = false; i >= 0; i--, alt = !alt) {
    let d = digits[i]!;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Non-blocking, inspector-surfaced data checks. */
export function validateClaim(claim: Claim): ClaimWarning[] {
  const w: ClaimWarning[] = [];

  // Reconcile Σ line charges vs the stated total (compare in integer cents).
  const sumCents = claim.serviceLines.reduce((a, l) => a + Math.round(l.charge * 100), 0);
  const totalCents = Math.round(claim.totals.totalCharge * 100);
  if (claim.serviceLines.length > 0 && sumCents !== totalCents) {
    w.push({
      code: 'charge-total-mismatch',
      severity: 'warning',
      message: `Line charges (${fmtCents(sumCents)}) don't match the claim total (${fmtCents(totalCents)}).`,
    });
  }

  // Diagnosis pointers that reference a position with no diagnosis.
  const present = new Set(claim.diagnoses.map((d) => d.pointer).filter((p) => p !== ''));
  for (const line of claim.serviceLines) {
    for (const p of line.diagPointers) {
      if (!present.has(p)) {
        w.push({
          code: 'dangling-diag-pointer',
          severity: 'warning',
          message: `Diagnosis pointer ${p} on a service line has no matching diagnosis.`,
        });
      }
    }
  }

  // NPI sanity (billing + rendering).
  if (claim.billingProvider.npi !== '' && !isValidNpi(claim.billingProvider.npi)) {
    w.push({ code: 'billing-npi-invalid', severity: 'warning', message: `Billing NPI ${claim.billingProvider.npi} fails the NPI check.` });
  }
  if (claim.renderingProvider.npi !== '' && !isSentinelNpi(claim.renderingProvider.npi) && !isValidNpi(claim.renderingProvider.npi)) {
    w.push({ code: 'rendering-npi-invalid', severity: 'warning', message: `Rendering NPI ${claim.renderingProvider.npi} fails the NPI check.` });
  }

  // More than 12 diagnoses can't all be pointed to on a paper CMS-1500.
  if (claim.diagnoses.some((d) => d.ordinal > 12)) {
    w.push({ code: 'diag-overflow', severity: 'info', message: 'Claim has more than 12 diagnoses; CMS-1500 shows A–L only.' });
  }

  if (claim.formType === 'unsupported') {
    w.push({ code: 'unsupported-form', severity: 'warning', message: `claim_form "${claim.claimFormRaw}" has no form renderer yet.` });
  }

  return w;
}

function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
