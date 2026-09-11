"""
Deterministic, zero-inference-cost field checks: catches a real class of
OCR misreads (a flipped digit in an NPI, a garbled date, a charge that
doesn't match its own line items) without asking the model anything.
Complements extract_claim_fields.py's verification-pass disagreement
flagging (see its module docstring) -- these two mechanisms feed the same
"flagged_fields" structure on a claim record, tagged by "type" so callers
can tell which kind of flag they're looking at.

Used directly (in-process) by extract_claim_fields.py on the OCR machine,
and via validate_fields.py's thin CLI wrapper by the Review app (which has
no Ollama/model dependency of its own, so it needs a subprocess call
rather than importing this module from Python it doesn't otherwise run).

Nothing here does real code-list validation (e.g. "is M54.5 an ICD-10 code
that actually exists") -- that would need the real, versioned ICD-10-CM/
CPT/HCPCS code sets, which is a much bigger undertaking. These are shape/
checksum/arithmetic checks only: cheap, deterministic, and still useful,
but not a substitute for a human reviewing the claim.
"""

import re
from datetime import date, datetime
from typing import Any, Optional

NPI_RE = re.compile(r"\D")
# ICD-10-CM: 1 letter + 2 digits, then up to 4 more alphanumeric characters
# -- optionally preceded by a decimal point, since claim forms/EDI often
# print the code without one (e.g. "S52502A" for what a code lookup would
# show as "S52.502A") -- claim_schemas.py's own field description notes
# this ("no decimal point removed -- keep as printed"), so the shape check
# has to accept both.
ICD10_RE = re.compile(r"^[A-Z][0-9]{2}(\.?[0-9A-Z]{1,4})?$")
CPT_HCPCS_RE = re.compile(r"^(\d{5}|[A-Z]\d{4})$")
ZIP_RE = re.compile(r"^\d{5}(-?\d{4})?$")
TAX_ID_RE = re.compile(r"^\d{9}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

MONEY_TOLERANCE = 0.01  # cents-level rounding slack for sum-of-lines checks
MIN_SANE_YEAR = 1900
MAX_SANE_YEAR = date.today().year + 1  # allow next year (e.g. dates entered just before/after New Year's)


def is_valid_npi(npi: Any) -> bool:
    """
    The real NPI check-digit algorithm (CMS's documented method): prepend
    the fixed prefix "80840" to the 10-digit NPI, then run the standard
    Luhn checksum over the resulting 15 digits. A misread digit almost
    always fails this, unlike a plain "is it 10 digits" check.
    """
    digits = NPI_RE.sub("", str(npi or ""))
    if len(digits) != 10:
        return False
    full = "80840" + digits
    total = 0
    for i, ch in enumerate(reversed(full)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def tax_id_issue(tax_id: Any, is_ssn: bool) -> Optional[str]:
    """
    Structural problems with a federal tax ID beyond "is it 9 digits" --
    catches shapes the SSA/IRS never actually issue. Unlike an NPI, neither
    an SSN nor an EIN carries a checksum digit, so this can't catch a
    misread that happens to land on another plausible-looking number (e.g.
    a flipped digit that's still a valid shape) -- only shapes that are
    flatly impossible, which a human still has to actually confirm.

    SSN rules (SSA-published, stable): the area (first 3 digits) is never
    000, 666, or 900-999 (900-999 is reserved for ITINs, which aren't
    SSNs); the group (digits 4-5) is never 00; the serial (last 4) is
    never 0000.

    EIN rule: the IRS has never assigned a prefix (first 2 digits) of 00.
    Deliberately not checking against the full historical list of
    IRS-campus prefixes here -- which two-digit prefixes are valid has
    expanded over time as the IRS opened up new ranges, so a hardcoded
    list would eventually start flagging perfectly real EINs as invalid.
    """
    digits = str(tax_id)
    if not TAX_ID_RE.match(digits):
        return f"'{digits}' isn't 9 digits"
    if is_ssn:
        area, group, serial = digits[:3], digits[3:5], digits[5:]
        if area == "000" or area == "666" or area[0] == "9":
            return f"'{digits}' isn't a valid SSN (area number {area} is never issued)"
        if group == "00":
            return f"'{digits}' isn't a valid SSN (group number can't be 00)"
        if serial == "0000":
            return f"'{digits}' isn't a valid SSN (serial number can't be 0000)"
    elif digits[:2] == "00":
        return f"'{digits}' isn't a valid EIN (no IRS prefix starts with 00)"
    return None


def is_sane_date(value: Any, *, allow_future: bool = True) -> bool:
    if not value or not DATE_RE.match(str(value)):
        return False
    try:
        parsed = datetime.strptime(str(value), "%Y-%m-%d").date()
    except ValueError:
        return False
    if not (MIN_SANE_YEAR <= parsed.year <= MAX_SANE_YEAR):
        return False
    if not allow_future and parsed > date.today():
        return False
    return True


def as_float(value: Any) -> Optional[float]:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def values_equivalent(a: Any, b: Any) -> bool:
    """
    Equality that tolerates formatting differences a plain == would trip
    on: "150.00" vs 150.0, whitespace, list/dict structure compared
    element-wise rather than requiring identical JSON text. Used both for
    validation here and for comparing a field across verification passes
    in extract_claim_fields.py, so neither produces false-positive flags
    over pure formatting noise.
    """
    if a is None or b is None:
        return a == b
    if isinstance(a, (int, float)) or isinstance(b, (int, float)):
        fa, fb = as_float(a), as_float(b)
        if fa is not None and fb is not None:
            return abs(fa - fb) < MONEY_TOLERANCE
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(values_equivalent(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(values_equivalent(a[k], b[k]) for k in a)
    if isinstance(a, str) and isinstance(b, str):
        # Tolerate one being a numeric string and the other a number-as-string
        fa, fb = as_float(a), as_float(b)
        if fa is not None and fb is not None:
            return abs(fa - fb) < MONEY_TOLERANCE
        return a.strip() == b.strip()
    return a == b


def _flag(flags: dict, key: str, reason: str) -> None:
    flags.setdefault(key, []).append({"type": "validation", "reason": reason})


def _check_money_sum(flags: dict, total_key: str, fields: dict, lines_key: str, line_amount_key: str, label: str) -> None:
    total = as_float(fields.get(total_key))
    lines = fields.get(lines_key)
    if total is None or not isinstance(lines, list) or not lines:
        return
    line_sum = 0.0
    for line in lines:
        amount = as_float(line.get(line_amount_key)) if isinstance(line, dict) else None
        if amount is None:
            return  # a line is missing/unreadable its own amount -- don't compound that into a misleading sum mismatch
        line_sum += amount
    if abs(total - line_sum) >= MONEY_TOLERANCE:
        _flag(flags, total_key, f"{label} (${total:,.2f}) doesn't match the sum of its line items (${line_sum:,.2f})")


def _validate_cms1500(fields: dict) -> dict:
    flags: dict = {}

    npi = fields.get("billing_provider_npi")
    if npi and not is_valid_npi(npi):
        _flag(flags, "billing_provider_npi", "failed NPI checksum")
    ref_npi = fields.get("referring_provider_npi")
    if ref_npi and not is_valid_npi(ref_npi):
        _flag(flags, "referring_provider_npi", "failed NPI checksum")
    facility_npi = fields.get("service_facility_npi")
    if facility_npi and not is_valid_npi(facility_npi):
        _flag(flags, "service_facility_npi", "failed NPI checksum")

    for code in fields.get("diagnosis_codes") or []:
        if code and not ICD10_RE.match(str(code)):
            _flag(flags, "diagnosis_codes", f"'{code}' doesn't look like a valid ICD-10 code shape")
            break

    for i, line in enumerate(fields.get("service_lines") or []):
        if not isinstance(line, dict):
            continue
        # Flagged per line + per sub-field ("service_lines[i].<subfield>"),
        # not the whole service_lines array -- review-app's renderer.js
        # highlights the exact input this points at instead of leaving a
        # reviewer to guess which of several lines (and which field in it)
        # actually has the problem.
        code = line.get("cpt_hcpcs_code")
        if code and not CPT_HCPCS_RE.match(str(code)):
            _flag(flags, f"service_lines[{i}].cpt_hcpcs_code", f"'{code}' doesn't look like a valid CPT/HCPCS code shape")
        for date_key in ("date_from", "date_to"):
            if line.get(date_key) and not is_sane_date(line.get(date_key)):
                _flag(flags, f"service_lines[{i}].{date_key}", f"'{line.get(date_key)}' isn't a plausible date")
        rendering_npi = line.get("rendering_provider_npi")
        if rendering_npi and not is_valid_npi(rendering_npi):
            _flag(flags, f"service_lines[{i}].rendering_provider_npi", f"'{rendering_npi}' failed NPI checksum")
        # Box 24I/24J's TOP half (a qualifier+ID pair, e.g. "ZZ" + taxonomy
        # code) is a different identifier from the NPI printed in the
        # BOTTOM half next to 24I's pre-printed "NPI" label -- see
        # claim_schemas.py's rendering_provider_npi/rendering_provider_taxonomy
        # descriptions. If what landed in the taxonomy field actually passes
        # the NPI checksum, that's a strong sign the two halves got swapped
        # (or the top pair's qualifier wasn't "ZZ" but an NPI look-alike),
        # not that this genuinely is a taxonomy code -- taxonomy codes are
        # alphanumeric and never satisfy is_valid_npi on their own.
        taxonomy = line.get("rendering_provider_taxonomy")
        if taxonomy and is_valid_npi(taxonomy):
            _flag(flags, f"service_lines[{i}].rendering_provider_taxonomy",
                  f"'{taxonomy}' looks like an NPI, not a taxonomy code -- check whether box 24I/24J's top and bottom halves were swapped")

    if fields.get("patient_dob") and not is_sane_date(fields["patient_dob"], allow_future=False):
        _flag(flags, "patient_dob", "isn't a plausible date")

    for zip_key in ("patient_zip", "billing_provider_zip", "service_facility_zip"):
        z = fields.get(zip_key)
        if z and not ZIP_RE.match(str(z)):
            _flag(flags, zip_key, f"'{z}' doesn't look like a valid ZIP code")

    if fields.get("auto_accident") and not fields.get("auto_accident_state"):
        _flag(flags, "auto_accident_state", "box 10b is marked Auto Accident, but no state was given")

    # Box 25's SSN and EIN checkboxes are reported independently (see
    # claim_schemas.py's ssn_box_checked/ein_box_checked) rather than
    # collapsed into a single is-it-an-SSN boolean -- that's the only way
    # to actually catch the form itself being ambiguous (both marked, or
    # neither), which a forced single answer could never represent.
    ssn_checked = bool(fields.get("ssn_box_checked"))
    ein_checked = bool(fields.get("ein_box_checked"))
    if ssn_checked and ein_checked:
        reason = "both the SSN and EIN checkboxes appear checked -- exactly one should be"
        _flag(flags, "ssn_box_checked", reason)
        _flag(flags, "ein_box_checked", reason)
    elif not ssn_checked and not ein_checked:
        reason = "neither the SSN nor EIN checkbox appears checked -- exactly one should be"
        _flag(flags, "ssn_box_checked", reason)
        _flag(flags, "ein_box_checked", reason)

    tax_id = fields.get("federal_tax_id")
    if tax_id:
        # Only meaningful once exactly one checkbox is confirmed checked --
        # the ambiguous cases are already flagged above regardless, so
        # treating an ambiguous read as "not SSN" here just picks *a*
        # answer for this shape check to run, not a claim about which one
        # is actually correct.
        issue = tax_id_issue(tax_id, is_ssn=(ssn_checked and not ein_checked))
        if issue:
            _flag(flags, "federal_tax_id", issue)

    _check_money_sum(flags, "total_charge", fields, "service_lines", "charge_amount", "Total charge")

    return flags


def _validate_ub04(fields: dict) -> dict:
    flags: dict = {}

    npi = fields.get("billing_provider_npi")
    if npi and not is_valid_npi(npi):
        _flag(flags, "billing_provider_npi", "failed NPI checksum")
    attending_npi = fields.get("attending_provider_npi")
    if attending_npi and not is_valid_npi(attending_npi):
        _flag(flags, "attending_provider_npi", "failed NPI checksum")
    operating_npi = fields.get("operating_provider_npi")
    if operating_npi and not is_valid_npi(operating_npi):
        _flag(flags, "operating_provider_npi", "failed NPI checksum")
    for prefix in ("other_provider_1_", "other_provider_2_"):
        other_npi = fields.get(f"{prefix}npi")
        if other_npi and not is_valid_npi(other_npi):
            _flag(flags, f"{prefix}npi", "failed NPI checksum")

    for code_key in ("principal_diagnosis_code", "admitting_diagnosis_code"):
        code = fields.get(code_key)
        if code and not ICD10_RE.match(str(code)):
            _flag(flags, code_key, f"'{code}' doesn't look like a valid ICD-10 code shape")
    for code in fields.get("other_diagnosis_codes") or []:
        if code and not ICD10_RE.match(str(code)):
            _flag(flags, "other_diagnosis_codes", f"'{code}' doesn't look like a valid ICD-10 code shape")
            break

    poa = fields.get("principal_diagnosis_poa")
    if poa and str(poa).upper() not in ("Y", "N", "U", "W", "1"):
        _flag(flags, "principal_diagnosis_poa", f"'{poa}' isn't a recognized present-on-admission indicator (Y, N, U, W, or 1)")

    for i, line in enumerate(fields.get("revenue_lines") or []):
        if not isinstance(line, dict):
            continue
        # Flagged per line + per sub-field, same reasoning as
        # _validate_cms1500's service_lines loop above.
        code = line.get("hcpcs_code")
        if code and not CPT_HCPCS_RE.match(str(code)):
            _flag(flags, f"revenue_lines[{i}].hcpcs_code", f"'{code}' doesn't look like a valid CPT/HCPCS code shape")
        if line.get("service_date") and not is_sane_date(line.get("service_date")):
            _flag(flags, f"revenue_lines[{i}].service_date", f"'{line.get('service_date')}' isn't a plausible date")

    if fields.get("patient_dob") and not is_sane_date(fields["patient_dob"], allow_future=False):
        _flag(flags, "patient_dob", "isn't a plausible date")

    date_from, date_to = fields.get("statement_date_from"), fields.get("statement_date_to")
    if is_sane_date(date_from) and is_sane_date(date_to):
        if datetime.strptime(date_from, "%Y-%m-%d") > datetime.strptime(date_to, "%Y-%m-%d"):
            _flag(flags, "statement_date_from", f"statement period ({date_from} to {date_to}) is out of order")

    for zip_key in ("patient_zip",):
        z = fields.get(zip_key)
        if z and not ZIP_RE.match(str(z)):
            _flag(flags, zip_key, f"'{z}' doesn't look like a valid ZIP code")

    tax_id = fields.get("federal_tax_id")
    if tax_id:
        # UB04_FIELDS has no SSN/EIN split (FL5 is just "federal tax number") -- always EIN-shaped.
        issue = tax_id_issue(tax_id, is_ssn=False)
        if issue:
            _flag(flags, "federal_tax_id", issue)

    _check_money_sum(flags, "total_charges", fields, "revenue_lines", "total_charge", "Total charges")

    return flags


def validate_fields(form_type: str, fields: dict) -> dict:
    """
    Returns {field_key: [{"type": "validation", "reason": str}, ...]} for
    only the fields with a detected problem -- empty dict if everything
    checks out (or nothing was checkable).
    """
    if form_type == "CMS1500":
        return _validate_cms1500(fields)
    if form_type == "UB04":
        return _validate_ub04(fields)
    return {}
