"""
Deterministic X12 5010 837 (Institutional 837I / Professional 837P) segment
builder. Takes a plain dict of claim fields (the "fields" object out of a
reviewed/approved JSON from extract_claim_fields.py) plus your
organization's own submitter/billing info, and produces raw EDI text.

SCOPE: this covers a single claim per file, a single payer (no COB/
secondary insurance), and the common provider loops (billing provider,
subscriber, payer, and one rendering/attending provider). It does NOT
implement every situational segment in the 5010 implementation guide --
see README.md for what's covered and what to extend before relying on this
for anything beyond an internal system that tolerates a simplified feed.

This module does not call Ollama or touch the filesystem beyond what's
passed to it -- it's pure data-in, text-out, so it can be unit tested and
reasoned about without a model in the loop.
"""

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

SEGMENT_TERMINATOR = "~"
ELEMENT_SEPARATOR = "*"
SUBELEMENT_SEPARATOR = ":"
REPETITION_SEPARATOR = "^"


class ClaimDataError(ValueError):
    """Raised when the claim JSON is missing something the builder needs."""


def _seg(*elements) -> str:
    """Join elements into one segment with the terminator. None -> empty element."""
    parts = ["" if e is None else str(e) for e in elements]
    return ELEMENT_SEPARATOR.join(parts) + SEGMENT_TERMINATOR


def _composite(*parts) -> str:
    return SUBELEMENT_SEPARATOR.join("" if p is None else str(p) for p in parts)


def _digits(value) -> str:
    return re.sub(r"\D", "", str(value or ""))


def _money(value) -> str:
    return f"{float(value or 0):.2f}"


def _date8(value: Optional[str]) -> Optional[str]:
    """Accepts 'YYYY-MM-DD' (or already-CCYYMMDD) and returns CCYYMMDD."""
    if not value:
        return None
    value = str(value).strip()
    if re.fullmatch(r"\d{8}", value):
        return value
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m-%d-%Y"):
        try:
            return datetime.strptime(value, fmt).strftime("%Y%m%d")
        except ValueError:
            continue
    raise ClaimDataError(f"could not parse date: {value!r}")


def _require(fields: dict, key: str):
    value = fields.get(key)
    if value is None or value == "" or value == []:
        raise ClaimDataError(f"required field '{key}' is missing or empty")
    return value


class ControlNumbers:
    """
    Persists the last-used ISA/GS/ST control numbers in a small JSON file
    next to it, so every generated file gets a unique, incrementing number.
    Trading partners generally expect these never to repeat.
    """

    def __init__(self, state_path: Path):
        self.state_path = state_path
        if state_path.exists():
            self._state = json.loads(state_path.read_text())
        else:
            self._state = {"isa": 0, "gs": 0, "st": 0}

    def next_isa(self) -> str:
        self._state["isa"] += 1
        self._save()
        return str(self._state["isa"]).zfill(9)

    def next_gs(self) -> str:
        self._state["gs"] += 1
        self._save()
        return str(self._state["gs"])

    def next_st(self) -> str:
        self._state["st"] += 1
        self._save()
        return str(self._state["st"]).zfill(4)

    def _save(self):
        self.state_path.write_text(json.dumps(self._state, indent=2))


def _isa_segment(control_number: str, org: dict, now: datetime) -> str:
    # ISA has fixed-width elements padded with spaces -- unlike every other
    # segment in X12. Getting these widths wrong breaks parsers immediately.
    sender_id = org["submitter_id"].ljust(15)[:15]
    receiver_id = org["receiver_id"].ljust(15)[:15]
    return (
        "ISA*00*" + " " * 10 +
        "*00*" + " " * 10 +
        "*ZZ*" + sender_id +
        "*ZZ*" + receiver_id +
        "*" + now.strftime("%y%m%d") +
        "*" + now.strftime("%H%M") +
        "*" + REPETITION_SEPARATOR +
        "*00501" +
        "*" + control_number +
        "*0*" + org.get("usage_indicator", "T") +  # T=test, P=production -- see README
        "*" + SUBELEMENT_SEPARATOR +
        SEGMENT_TERMINATOR
    )


def _envelope(transaction_type: str, version: str, segments: list, org: dict,
              control_numbers: ControlNumbers, now: datetime) -> str:
    """Wraps a list of already-built segment strings in ISA/GS/ST..SE/GE/IEA."""
    isa_control = control_numbers.next_isa()
    gs_control = control_numbers.next_gs()
    st_control = control_numbers.next_st()

    out = [_isa_segment(isa_control, org, now)]
    out.append(_seg("GS", "HC", org["submitter_id"], org["receiver_id"],
                     now.strftime("%Y%m%d"), now.strftime("%H%M"), gs_control, "X", version))
    out.append(_seg("ST", transaction_type, st_control, version))
    out.extend(segments)
    # SE segment count includes ST and SE themselves.
    se_count = len(segments) + 2
    out.append(_seg("SE", se_count, st_control))
    out.append(_seg("GE", "1", gs_control))
    out.append(_seg("IEA", "1", isa_control))
    return "".join(out)


def _common_header_segments(fields: dict, org: dict, now: datetime) -> list:
    segs = []
    ref_id = fields.get("patient_account_number") or fields.get("patient_control_number") or "1"
    segs.append(_seg("BHT", "0019", "00", ref_id, now.strftime("%Y%m%d"), now.strftime("%H%M"), "CH"))

    # Loop 1000A - Submitter
    segs.append(_seg("NM1", "41", "2", org["submitter_name"], "", "", "", "", "46", org["submitter_id"]))
    if org.get("submitter_contact_name") or org.get("submitter_phone"):
        segs.append(_seg("PER", "IC", org.get("submitter_contact_name", ""), "TE", _digits(org.get("submitter_phone"))))

    # Loop 1000B - Receiver
    segs.append(_seg("NM1", "40", "2", org["receiver_name"], "", "", "", "", "46", org["receiver_id"]))
    return segs


def _billing_provider_loop(hl_id: str, next_hl_id: str, org: dict, fields: dict, prefix: str) -> list:
    """Loop 2000A / 2010AA - Billing Provider."""
    segs = [_seg("HL", hl_id, "", "20", "1")]
    npi = _require(fields, f"{prefix}billing_provider_npi")
    segs.append(_seg("NM1", "85", "2", fields[f"{prefix}billing_provider_name"], "", "", "", "", "XX", npi))
    if fields.get(f"{prefix}billing_provider_address"):
        segs.append(_seg("N3", fields[f"{prefix}billing_provider_address"]))
    if fields.get(f"{prefix}billing_provider_city"):
        segs.append(_seg("N4", fields.get(f"{prefix}billing_provider_city"),
                          fields.get(f"{prefix}billing_provider_state"),
                          fields.get(f"{prefix}billing_provider_zip")))
    tax_id = fields.get("federal_tax_id")
    if tax_id:
        qualifier = "SY" if fields.get("tax_id_is_ssn") else "EI"
        segs.append(_seg("REF", qualifier, _digits(tax_id)))
    return segs


def _subscriber_loop(hl_id: str, parent_hl_id: str, fields: dict, org: dict, sbr_relationship: str = "18") -> list:
    """Loop 2000B / 2010BA (subscriber) + 2010BB (payer). Assumes patient == subscriber (relationship 18=self)."""
    segs = [_seg("HL", hl_id, parent_hl_id, "22", "0")]
    # SBR09 = Claim Filing Indicator Code (X12 code list 1032). This varies by who you're
    # actually billing -- e.g. "11" Other Non-Federal Programs, "CI" Commercial Insurance,
    # "ZZ" Mutually Defined. Set claim_filing_indicator in org_config.json to match your
    # situation; "ZZ" is a safe-but-vague default, not a guess at your specific payer type.
    claim_filing_code = fields.get("claim_filing_indicator") or org.get("claim_filing_indicator", "ZZ")
    segs.append(_seg("SBR", "P", sbr_relationship, "", "", "", "", "", "", claim_filing_code))

    last = _require(fields, "insured_last_name")
    first = fields.get("insured_first_name", "")
    member_id = _require(fields, "insured_id_number")
    segs.append(_seg("NM1", "IL", "1", last, first, "", "", "", "MI", member_id))
    if fields.get("patient_address"):
        segs.append(_seg("N3", fields["patient_address"]))
    if fields.get("patient_city"):
        segs.append(_seg("N4", fields.get("patient_city"), fields.get("patient_state"), fields.get("patient_zip")))
    dob = _date8(fields.get("patient_dob"))
    sex = fields.get("patient_sex")
    if dob:
        segs.append(_seg("DMG", "D8", dob, sex))

    payer_name = fields.get("payer_name") or "UNKNOWN PAYER"
    segs.append(_seg("NM1", "PR", "2", payer_name, "", "", "", "", "PI", fields.get("payer_id", "UNKNOWN")))
    return segs


def _diagnosis_hi_segment(codes: list, qualifier_first: str, qualifier_rest: str) -> Optional[str]:
    codes = [c for c in (codes or []) if c]
    if not codes:
        return None
    composites = [_composite(qualifier_first, codes[0])]
    for code in codes[1:12]:
        composites.append(_composite(qualifier_rest, code))
    return _seg("HI", *composites)


def build_837p(fields: dict, org: dict, control_numbers: ControlNumbers, now: Optional[datetime] = None) -> str:
    """Build a single-claim 837P (Professional) transaction, e.g. from a CMS-1500."""
    now = now or datetime.now()
    for key in ("patient_last_name", "patient_dob", "patient_sex", "insured_id_number",
                "diagnosis_codes", "service_lines", "billing_provider_name",
                "billing_provider_npi", "total_charge"):
        _require(fields, key)

    segs = _common_header_segments(fields, org, now)
    segs += _billing_provider_loop("1", None, org, fields, prefix="")
    segs += _subscriber_loop("2", "1", fields, org)

    # Loop 2300 - Claim
    claim_id = fields.get("patient_account_number") or fields.get("claim_id") or "1"
    place_of_service = (fields.get("service_lines") or [{}])[0].get("place_of_service", "11")
    segs.append(_seg("CLM", claim_id, _money(fields["total_charge"]), "", "",
                      _composite(place_of_service, "B", "1"), "Y", "A", "Y", "Y"))
    if fields.get("prior_authorization_number"):
        segs.append(_seg("REF", "G1", fields["prior_authorization_number"]))

    hi = _diagnosis_hi_segment(fields["diagnosis_codes"], "ABK", "ABF")
    if hi:
        segs.append(hi)

    if fields.get("referring_provider_npi"):
        segs.append(_seg("NM1", "DN", "1", fields.get("referring_provider_name", ""), "", "", "", "",
                          "XX", fields["referring_provider_npi"]))

    # Loop 2400 - Service lines
    for i, line in enumerate(fields["service_lines"], start=1):
        segs.append(_seg("LX", i))
        proc_composite = _composite("HC", line.get("cpt_hcpcs_code"), *(line.get("modifiers") or []))
        segs.append(_seg("SV1", proc_composite, _money(line.get("charge_amount")), "UN",
                          line.get("units", 1), line.get("place_of_service", place_of_service), "",
                          line.get("diagnosis_pointer", "A")))
        date_from = _date8(line.get("date_from"))
        date_to = _date8(line.get("date_to")) or date_from
        if date_from:
            date_range = date_from if date_from == date_to else f"{date_from}-{date_to}"
            segs.append(_seg("DTP", "472", "D8" if date_from == date_to else "RD8", date_range))
        if line.get("rendering_provider_npi"):
            segs.append(_seg("NM1", "82", "1", "", "", "", "", "", "XX", line["rendering_provider_npi"]))

    return _envelope("837", "005010X222A1", segs, org, control_numbers, now)


def build_837i(fields: dict, org: dict, control_numbers: ControlNumbers, now: Optional[datetime] = None) -> str:
    """Build a single-claim 837I (Institutional) transaction, e.g. from a UB-04."""
    now = now or datetime.now()
    for key in ("patient_control_number", "type_of_bill", "patient_last_name", "patient_dob",
                "patient_sex", "insured_id_number", "principal_diagnosis_code",
                "revenue_lines", "billing_provider_name", "billing_provider_npi", "total_charges"):
        _require(fields, key)

    segs = _common_header_segments(fields, org, now)
    segs += _billing_provider_loop("1", None, org, fields, prefix="")
    segs += _subscriber_loop("2", "1", fields, org)

    # Loop 2300 - Claim. CLM05 mirrors the UB-04 Type of Bill: CLM05-1 is its first two
    # digits (facility type + bill classification), CLM05-2 is "A" (Facility Code
    # Qualifier = Uniform Billing Claim Form Bill Type), CLM05-3 is the third digit
    # (claim frequency, e.g. 1=original, 7=replacement, 8=void).
    tob = _digits(fields.get("type_of_bill")) or "111"
    tob = tob.zfill(3)[-3:]  # tolerate a leading zero some forms include
    segs.append(_seg("CLM", fields["patient_control_number"], _money(fields["total_charges"]), "", "",
                      _composite(tob[:2], "A", tob[2]),
                      "Y", "A", "Y", "Y"))
    # CL1 - Institutional Claim Code. Element order is Admission Type, Admission
    # Source, then Patient Status (easy to get backwards -- verified against an
    # official state Medicaid 837I companion guide).
    segs.append(_seg("CL1", fields.get("admission_type"), fields.get("admission_source"), fields.get("patient_status")))

    date_from = _date8(fields.get("statement_date_from"))
    date_to = _date8(fields.get("statement_date_to")) or date_from
    if date_from:
        segs.append(_seg("DTP", "434", "RD8", f"{date_from}-{date_to}"))
    admission_date = _date8(fields.get("admission_date"))
    if admission_date:
        segs.append(_seg("DTP", "435", "D8", admission_date))

    all_dx = [fields["principal_diagnosis_code"]] + list(fields.get("other_diagnosis_codes") or [])
    hi = _diagnosis_hi_segment(all_dx, "ABK", "ABF")
    if hi:
        segs.append(hi)
    if fields.get("admitting_diagnosis_code"):
        segs.append(_seg("HI", _composite("ABJ", fields["admitting_diagnosis_code"])))
    if fields.get("principal_procedure_code"):
        # ABR = ICD-10-PCS Principal Procedure Information (confirmed against an official
        # state Medicaid 837I companion guide; mirrors the ICD-10 "A"-prefix diagnosis
        # qualifiers above -- ICD-9-CM would instead use unprefixed "BR").
        proc_date = _date8(fields.get("principal_procedure_date"))
        if proc_date:
            segs.append(_seg("HI", _composite("ABR", fields["principal_procedure_code"], "D8", proc_date)))
        else:
            segs.append(_seg("HI", _composite("ABR", fields["principal_procedure_code"])))

    for code in (fields.get("condition_codes") or []):
        segs.append(_seg("HI", _composite("BG", code)))
    for value in (fields.get("value_codes") or []):
        # C022 composite: -01 qualifier, -02 code, -03/-04 date qualifier/date (unused
        # here, left blank), -05 monetary amount (confirmed against the X12 element
        # dictionary) -- so two blank placeholders before the amount, not one.
        segs.append(_seg("HI", _composite("BE", value.get("code"), "", "", _money(value.get("amount")))))

    if fields.get("attending_provider_npi"):
        segs.append(_seg("NM1", "71", "1", fields.get("attending_provider_name", ""), "", "", "", "",
                          "XX", fields["attending_provider_npi"]))

    # Loop 2400 - Revenue/service lines
    for i, line in enumerate(fields["revenue_lines"], start=1):
        segs.append(_seg("LX", i))
        if line.get("hcpcs_code"):
            sv2 = _seg("SV2", line.get("revenue_code"), _composite("HC", line["hcpcs_code"]),
                        _money(line.get("total_charge")), "UN", line.get("units", 1))
        else:
            sv2 = _seg("SV2", line.get("revenue_code"), "", _money(line.get("total_charge")),
                        "UN", line.get("units", 1))
        segs.append(sv2)
        service_date = _date8(line.get("service_date"))
        if service_date:
            segs.append(_seg("DTP", "472", "D8", service_date))

    return _envelope("837", "005010X223A2", segs, org, control_numbers, now)


def build_837(record: dict, org: dict, control_numbers: ControlNumbers) -> str:
    """Dispatch to build_837p or build_837i based on record['form_type']."""
    form_type = record.get("form_type")
    fields = record.get("fields", {})
    if form_type == "CMS1500":
        return build_837p(fields, org, control_numbers)
    if form_type == "UB04":
        return build_837i(fields, org, control_numbers)
    raise ClaimDataError(f"unknown form_type: {form_type!r}")
