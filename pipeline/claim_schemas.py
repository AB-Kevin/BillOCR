"""
Field schemas and extraction prompts for CMS-1500 (professional) and
UB-04 (institutional) claim forms.

Each schema is a flat dict of field name -> short description. The
extraction prompt asks Qwen to return exactly these keys as JSON. Field
names are deliberately close to the form's own box/FL numbers so it's easy
to look at a claim image and check a value by hand.

IMPORTANT: this covers the fields needed for a single-payer, no-COB,
single-claim 837 -- the common case. It does NOT attempt to capture every
box on either form (e.g. secondary insurance info, employer details).
Extend REQUIRED_FIELDS / the prompts if your claims need more.
"""

CMS1500_FIELDS = {
    "form_type": "Always the literal string 'CMS1500'",
    "patient_last_name": "Box 2 - patient's last name",
    "patient_first_name": "Box 2 - patient's first name",
    "patient_dob": "Box 3 - patient's date of birth, as YYYY-MM-DD",
    "patient_sex": "Box 3 - M or F",
    "patient_address": "Box 5 - street address",
    "patient_city": "Box 5 - city",
    "patient_state": "Box 5 - two-letter state",
    "patient_zip": "Box 5 - ZIP code",
    "insured_id_number": "Box 1a - insured's ID number / member ID",
    "insured_last_name": "Box 4 - insured's last name (if different from patient, else same as patient)",
    "insured_first_name": "Box 4 - insured's first name",
    "patient_relationship_to_insured": "Box 6 - one of Self, Spouse, Child, Other",
    "other_insured_group_number": "Box 11 - insured's policy/group number",
    "diagnosis_codes": "Box 21 - list of ICD-10 diagnosis codes in order A, B, C... as a JSON array of strings, e.g. ['M54.5', 'R51']",
    "prior_authorization_number": "Box 23, if present, else null",
    "service_lines": (
        "Box 24 - a JSON array of service line objects, one per row actually filled in, each with: "
        "date_from (YYYY-MM-DD), date_to (YYYY-MM-DD, same as date_from if one day), "
        "place_of_service (2-digit code from box 24B), "
        "cpt_hcpcs_code (box 24D, the procedure code only, no modifiers), "
        "modifiers (box 24D, JSON array of up to 4 modifier codes, empty array if none), "
        "diagnosis_pointer (box 24E, e.g. 'A' or 'A,B'), "
        "charge_amount (box 24F, as a plain number like 150.00), "
        "units (box 24G, as an integer), "
        "rendering_provider_npi (box 24J, the NPI number if present else null)"
    ),
    "federal_tax_id": "Box 25 - billing provider's federal tax ID (EIN), digits only",
    "tax_id_is_ssn": "Box 25 - true if the SSN box is checked instead of EIN, else false",
    "patient_account_number": "Box 26",
    "total_charge": "Box 28 - total charge as a plain number",
    "billing_provider_name": "Box 33 - billing provider or group name",
    "billing_provider_npi": "Box 33a - billing provider NPI",
    "billing_provider_address": "Box 33 - street address",
    "billing_provider_city": "Box 33 - city",
    "billing_provider_state": "Box 33 - two-letter state",
    "billing_provider_zip": "Box 33 - ZIP code",
    "referring_provider_name": "Box 17 - referring provider name, else null",
    "referring_provider_npi": "Box 17b - referring provider NPI, else null",
}

UB04_FIELDS = {
    "form_type": "Always the literal string 'UB04'",
    "patient_control_number": "FL3a - patient control number",
    "type_of_bill": "FL4 - 3 or 4 digit type of bill code",
    "federal_tax_id": "FL5 - federal tax number, digits only",
    "statement_date_from": "FL6 - statement covers period, from date, as YYYY-MM-DD",
    "statement_date_to": "FL6 - statement covers period, through date, as YYYY-MM-DD",
    "patient_last_name": "FL8 - patient last name",
    "patient_first_name": "FL8 - patient first name",
    "patient_address": "FL9 - street address",
    "patient_city": "FL9 - city",
    "patient_state": "FL9 - two-letter state",
    "patient_zip": "FL9 - ZIP code",
    "patient_dob": "FL10 - date of birth, as YYYY-MM-DD",
    "patient_sex": "FL11 - M or F",
    "admission_date": "FL12 - admission date, as YYYY-MM-DD, else null if outpatient/not applicable",
    "admission_type": "FL14 - 1-digit admission type code, else null",
    "admission_source": "FL15 - 1-digit admission source code, else null",
    "patient_status": "FL17 - 2-digit patient discharge status code",
    "condition_codes": "FL18-28 - JSON array of condition codes actually present, else empty array",
    "value_codes": (
        "FL39-41 - JSON array of {code, amount} objects for value codes actually present, "
        "else empty array. amount as a plain number."
    ),
    "revenue_lines": (
        "FL42-49 - a JSON array of revenue line objects, one per row actually filled in, each with: "
        "revenue_code (FL42, 4-digit code), "
        "hcpcs_code (FL44, if present else null), "
        "service_date (FL45, YYYY-MM-DD, else null), "
        "units (FL46, as an integer), "
        "total_charge (FL47, as a plain number), "
        "non_covered_charge (FL48, as a plain number, 0 if none)"
    ),
    "payer_name": "FL50 - payer name (line A)",
    "insured_id_number": "FL60 - insured's unique ID",
    "insured_last_name": "FL58 - insured's last name",
    "insured_first_name": "FL58 - insured's first name",
    "treatment_authorization_code": "FL63, if present else null",
    "principal_diagnosis_code": "FL67 - principal diagnosis code (ICD-10-CM), no decimal point removed -- keep as printed",
    "other_diagnosis_codes": "FL67 A-Q - JSON array of secondary diagnosis codes actually present, else empty array",
    "admitting_diagnosis_code": "FL69, if present else null",
    "principal_procedure_code": "FL74 - principal procedure code (ICD-10-PCS), if present else null",
    "principal_procedure_date": "FL74 - date of principal procedure, YYYY-MM-DD, if present else null",
    "attending_provider_npi": "FL76 - attending provider NPI",
    "attending_provider_name": "FL76 - attending provider name",
    "billing_provider_name": "FL1 - billing provider/facility name",
    "billing_provider_address": "FL1 - street address",
    "billing_provider_city": "FL1 - city",
    "billing_provider_state": "FL1 - two-letter state",
    "billing_provider_zip": "FL1 - ZIP code",
    "billing_provider_npi": "FL56 - billing provider NPI",
    "total_charges": "FL47 total line - grand total charges as a plain number",
}

# Fields that must be present and non-null for build_837.py to proceed.
# Kept intentionally short -- most fields are situational in real claims,
# but these are load-bearing for a minimally valid 837.
CMS1500_REQUIRED = [
    "patient_last_name", "patient_first_name", "patient_dob", "patient_sex",
    "insured_id_number", "diagnosis_codes", "service_lines",
    "billing_provider_name", "billing_provider_npi", "total_charge",
]

UB04_REQUIRED = [
    "patient_control_number", "type_of_bill", "patient_last_name", "patient_first_name",
    "patient_dob", "patient_sex", "insured_id_number", "principal_diagnosis_code",
    "revenue_lines", "billing_provider_name", "billing_provider_npi", "total_charges",
]


def build_extraction_prompt(fields: dict, form_label: str) -> str:
    lines = [
        f"You are extracting structured data from a scanned {form_label} claim form image.",
        "Return ONLY a single JSON object (no markdown fences, no commentary) with exactly these keys:",
        "",
    ]
    for key, desc in fields.items():
        lines.append(f'  "{key}": {desc}')
    lines.append("")
    lines.append(
        "If a field is not present or not legible on the form, use null (or an empty array/string "
        "as appropriate for that field's type) rather than guessing. Do not invent values. "
        "Copy codes and numbers exactly as printed -- do not reformat or 'correct' them."
    )
    return "\n".join(lines)


CMS1500_PROMPT = build_extraction_prompt(CMS1500_FIELDS, "CMS-1500 (professional)")
UB04_PROMPT = build_extraction_prompt(UB04_FIELDS, "UB-04 (institutional)")
