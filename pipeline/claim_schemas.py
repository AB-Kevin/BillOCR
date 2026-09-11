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

from typing import Optional

CMS1500_FIELDS = {
    "form_type": "Always the literal string 'CMS1500'",
    "insured_id_number": "Box 1a - insured's ID number / member ID",
    "patient_last_name": "Box 2 - patient's last name",
    "patient_first_name": "Box 2 - patient's first name",
    "patient_dob": "Box 3 - patient's date of birth, exactly as printed (do not reformat or reorder it)",
    "patient_sex": "Box 3 - M or F",
    "insured_last_name": "Box 4 - insured's last name (if different from patient, else same as patient)",
    "insured_first_name": "Box 4 - insured's first name",
    "patient_address": "Box 5 - street address",
    "patient_city": "Box 5 - city",
    "patient_state": "Box 5 - two-letter state",
    "patient_zip": "Box 5 - ZIP code",
    "patient_phone": "Box 5 - patient's phone number, digits only (the parentheses printed around the area code are part of the form, not the number), if present else null",
    "patient_relationship_to_insured": "Box 6 - one of Self, Spouse, Child, Other",
    # Box 9/9a/9d -- a genuinely separate ("other") insured, for coordination
    # of benefits when the patient has a second insurance plan -- not to be
    # confused with box 11's insured_group_number below, which is the
    # CURRENT (primary) insured's own group number. Captured for Review
    # visibility only: build_837.py has no COB loop (2320/2330) to put this
    # in yet, so it's extracted but not (currently) reflected in the built
    # 837 -- see x12_837.py's SCOPE note.
    "other_insured_last_name": "Box 9 - other insured's last name, if present else null",
    "other_insured_first_name": "Box 9 - other insured's first name, if present else null",
    "other_insured_group_number": "Box 9a - other insured's policy or group number, if present else null",
    "other_insured_plan_name": "Box 9d - other insurance plan name or program name, if present else null",
    "employment_related": "Box 10a - true if 'Employment (Current or Previous)' is marked Yes, else false",
    "auto_accident": "Box 10b - true if 'Auto Accident' is marked Yes, else false",
    "auto_accident_state": "Box 10b - the two-letter state box next to Auto Accident, if present else null",
    # NOT the same field as other_insured_group_number above -- this is the
    # CURRENT (primary) insured's own group number, box 11 (previously
    # misleadingly named "other_insured_group_number" itself, back when box
    # 9's real "other insured" fields didn't exist yet to claim that name).
    "insured_group_number": "Box 11 - insured's policy/group number",
    "insured_dob": "Box 11a - insured's date of birth, exactly as printed -- only present if different from the patient (box 3); else null",
    "insured_sex": "Box 11a - insured's sex, M or F -- only present if different from the patient; else null",
    "insured_employer_name": "Box 11b - insured's employer or school name, if present else null",
    "insured_plan_name": "Box 11c - insurance plan or program name, if present else null",
    "referring_provider_last_name": (
        "Box 17 - referring provider's last name, else null. Box 17 has its own small qualifier box "
        "printed immediately to its left (codes like 'DN' Referring Provider, 'DK' Ordering, 'DQ' "
        "Supervising) -- that qualifier is part of the form, not the name; report only the name itself, "
        "e.g. a box reading 'DN Aurora Bell' means last name 'Bell', not 'DN Aurora' or 'DN Bell'."
    ),
    "referring_provider_first_name": "Box 17 - referring provider's first name, if present else null (see referring_provider_last_name's note on the qualifier box)",
    "referring_provider_id": "Box 17a - referring provider's other ID (e.g. state license number), if present else null",
    "referring_provider_npi": "Box 17b - referring provider NPI, else null",
    "hospitalization_date_from": "Box 18 - hospitalization dates related to current services, from date, exactly as printed, else null",
    "hospitalization_date_to": "Box 18 - hospitalization dates related to current services, through date, exactly as printed, else null",
    "claim_narrative": "Box 19 - additional claim information, if present else null",
    "outside_lab": "Box 20 - true if 'YES' is marked, false if 'NO' is marked (or neither is marked)",
    "outside_lab_charges": (
        "Box 20 - $ CHARGES, printed as dollars and cents in two boxes divided by a line, same as box "
        "24F -- only meaningful when outside_lab is true; 0 if not present."
    ),
    "diagnosis_codes": "Box 21 - list of ICD-10 diagnosis codes in order A, B, C... as a JSON array of strings, e.g. ['M54.5', 'R51']",
    "prior_authorization_number": "Box 23, if present, else null",
    "service_lines": (
        "Box 24 - a JSON array of service line objects, one per row actually filled in, each with: "
        "date_from (box 24A, exactly as printed -- do not reformat or reorder it), "
        "date_to (box 24A, same as date_from if one day, exactly as printed), "
        "place_of_service (2-digit code from box 24B), "
        "emg (box 24C -- true if the small EMG checkbox is marked, else false; rarely filled but always "
        "worth checking), "
        "cpt_hcpcs_code (box 24D, the procedure code only -- typically 5 characters, e.g. '99213' -- do "
        "not include any modifier codes printed after it), "
        "modifiers (box 24D, printed to the right of the procedure code in the same box, in smaller "
        "print that's easy to miss -- up to 4 short modifier codes, e.g. box 24D showing '99213 25' "
        "means cpt_hcpcs_code '99213' and modifiers ['25']; look carefully even when the row looks like "
        "it's just one code -- JSON array of strings, use an empty array only if truly none are printed), "
        "diagnosis_pointer (box 24E, e.g. 'A' or 'A,B'), "
        "charge_amount_dollars (box 24F, the wider/left box of the two boxes divided by a line -- "
        "whole-dollar digits only, exactly as printed, no decimal point, no cents, no $ sign, no commas), "
        "charge_amount_cents (box 24F, the narrower/right box of the two -- the two-digit cents amount "
        "only, exactly as printed -- report these two boxes separately, do not add them together or "
        "combine them into one number yourself), "
        "units (box 24G, as an integer), "
        "rendering_provider_npi (box 24J's BOTTOM half only -- the row printed next to box 24I's own "
        "pre-printed \"NPI\" label -- the National Provider Identifier, if present else null; some filled-in "
        "forms print a second qualifier+ID pair in the TOP half of 24I/24J instead (commonly qualifier "
        "\"ZZ\" with a taxonomy code in 24J's top half) -- that top pair is a different identifier, not the "
        "NPI, and must never be read into this field even when the bottom half is blank), "
        "rendering_provider_taxonomy (box 24I/24J's TOP half only, if a qualifier+ID pair is printed there "
        "-- report ONLY 24J's top ID value, if present else null; 24I's own qualifier letters (almost "
        "always \"ZZ\") are part of the form, not the code, and must NOT be included -- a top half "
        "reading \"ZZ 207Q00000X\" means '207Q00000X', not 'ZZ207Q00000X'; this is a separate, optional "
        "field from rendering_provider_npi above, never the same value as it)"
    ),
    "federal_tax_id": (
        "Box 25 - billing provider's federal tax ID: exactly 9 digits, no dashes. Box 25 has two small "
        "checkboxes printed left to right, SSN then EIN, right next to the digit boxes -- report each "
        "one's own state separately (see ssn_box_checked/ein_box_checked below), don't try to resolve "
        "them into one answer yourself. Neither checkbox nor its mark is part of the number; do not let "
        "them shift or replace the first couple of digits. If the box shows a printed dash (format "
        "XX-XXXXXXX), skip the dash but keep all 9 digits in order -- the two digits before the dash are "
        "ordinary digit boxes like the rest, not a checkbox."
    ),
    "ssn_box_checked": "Box 25 - true if the SSN checkbox (the first of the two) is marked, else false. Report exactly what's marked, even if EIN is also (or isn't) marked -- do not resolve the two into a single answer yourself.",
    "ein_box_checked": "Box 25 - true if the EIN checkbox (the second of the two) is marked, else false. Report exactly what's marked, even if SSN is also (or isn't) marked -- do not resolve the two into a single answer yourself.",
    "patient_account_number": "Box 26",
    "accept_assignment": "Box 27 - true if 'YES' is marked, false if 'NO' is marked, else false",
    "total_charge": (
        "Box 28 - total charge, printed as dollars and cents in two boxes divided by a line, same as "
        "box 24F (a wider box for whole dollars, a narrower box for cents)."
    ),
    "service_facility_name": "Box 32 - service facility location name, if present and different from the billing provider, else null",
    "service_facility_address": "Box 32 - service facility street address, if present else null",
    "service_facility_city": "Box 32 - service facility city, if present else null",
    "service_facility_state": "Box 32 - service facility two-letter state, if present else null",
    "service_facility_zip": "Box 32 - service facility ZIP code, if present else null",
    "service_facility_npi": "Box 32a - service facility NPI, if present else null",
    "billing_provider_name": "Box 33 - billing provider or group name",
    "billing_provider_address": "Box 33 - street address",
    "billing_provider_city": "Box 33 - city",
    "billing_provider_state": "Box 33 - two-letter state",
    "billing_provider_zip": "Box 33 - ZIP code",
    "billing_provider_phone": "Box 33 - phone number printed near the provider name/address, digits only (the parentheses printed around the area code are part of the form, not the number), if present else null",
    "billing_provider_npi": "Box 33a - billing provider NPI",
    "billing_provider_taxonomy": "Box 33b - taxonomy code, if present else null",
}

UB04_FIELDS = {
    "form_type": "Always the literal string 'UB04'",
    "billing_provider_name": "FL1 - billing provider/facility name",
    "billing_provider_address": "FL1 - street address",
    "billing_provider_city": "FL1 - city",
    "billing_provider_state": "FL1 - two-letter state",
    "billing_provider_zip": "FL1 - ZIP code",
    "billing_provider_phone": "FL1 - phone number printed near the provider name/address, digits only (the parentheses printed around the area code are part of the form, not the number), if present else null",
    "patient_control_number": "FL3a - patient control number",
    "type_of_bill": "FL4 - 3 or 4 digit type of bill code",
    "federal_tax_id": "FL5 - federal tax number, digits only",
    "statement_date_from": "FL6 - statement covers period, from date, exactly as printed (do not reformat or reorder it)",
    "statement_date_to": "FL6 - statement covers period, through date, exactly as printed (do not reformat or reorder it)",
    "patient_last_name": "FL8 - patient last name",
    "patient_first_name": "FL8 - patient first name",
    "patient_address": "FL9 - street address",
    "patient_city": "FL9 - city",
    "patient_state": "FL9 - two-letter state",
    "patient_zip": "FL9 - ZIP code",
    "patient_dob": "FL10 - date of birth, exactly as printed (do not reformat or reorder it)",
    "patient_sex": "FL11 - M or F",
    "admission_date": "FL12 - admission date, exactly as printed, else null if outpatient/not applicable",
    # FL13/16 -- admission/discharge hour, printed as a 2-digit military-time
    # hour (00-23, or 99 if unknown) right next to their respective dates.
    # Timestamps of patient arrival and discharge respectively -- kept as a
    # pair even though FL16 alone is rarely filled in practice, since one
    # without the other tells an incomplete story.
    "admission_hour": "FL13 - admission hour, 2-digit military time (00-23), if present else null",
    "admission_type": "FL14 - 1-digit admission type code, else null",
    "admission_source": "FL15 - 1-digit admission source code, else null",
    "discharge_hour": "FL16 - discharge hour, 2-digit military time (00-23), if present else null",
    "patient_status": "FL17 - 2-digit patient discharge status code",
    "condition_codes": "FL18-28 - JSON array of condition codes actually present, else empty array",
    "occurrence_codes": (
        "FL31-34 - JSON array of {code, date} objects for occurrence codes actually present, else empty "
        "array. code is the 2-digit occurrence code, date is exactly as printed."
    ),
    "occurrence_span_codes": (
        "FL35-36 - JSON array of {code, date_from, date_to} objects for occurrence span codes actually "
        "present, else empty array. code is the 2-digit occurrence span code, date_from/date_to are "
        "exactly as printed."
    ),
    "value_codes": (
        "FL39-41 - JSON array of {code, amount_dollars, amount_cents} objects for value codes actually "
        "present, else empty array. Each of these boxes prints dollars and cents in two boxes divided by "
        "a line -- amount_dollars is the wider/left whole-dollar box (digits only, exactly as printed, no "
        "decimal point, no cents, no $ sign, no commas), amount_cents is the narrower/right box (the "
        "two-digit cents amount only, exactly as printed) -- report these two boxes separately, do not "
        "add them together or combine them into one number yourself."
    ),
    "revenue_lines": (
        "FL42-49 - a JSON array of revenue line objects, one per row actually filled in, each with: "
        "revenue_code (FL42, 4-digit code), "
        "hcpcs_code (FL44, if present else null), "
        "service_date (FL45, exactly as printed, else null), "
        "units (FL46, as an integer), "
        "total_charge_dollars (FL47, the wider/left box of the two boxes divided by a line -- "
        "whole-dollar digits only, exactly as printed, no decimal point, no cents, no $ sign, no commas), "
        "total_charge_cents (FL47, the narrower/right box of the two -- the two-digit cents amount only, "
        "exactly as printed), "
        "non_covered_charge_dollars (FL48, same two-box layout as FL47 -- whole-dollar digits only, 0 if "
        "none), "
        "non_covered_charge_cents (FL48, the cents box, 0 if none) -- "
        "report every one of these _dollars/_cents pairs as two separate boxes, do not add them together "
        "or combine them into one number yourself"
    ),
    "total_charges": (
        "FL47 total line - grand total charges, printed as dollars and cents in two boxes divided by a "
        "line, same as revenue_lines' total_charge."
    ),
    "billing_provider_npi": "FL56 - billing provider NPI",
    "insured_last_name": "FL58 - insured's last name",
    "insured_first_name": "FL58 - insured's first name",
    "patient_relationship_to_insured": "FL59 - 2-digit patient/insured relationship code",
    # FL50 (payer name) is deliberately not extracted -- x12_837.py's own
    # SCOPE note says this pipeline is single-payer by design, so payer
    # name/ID are org_config.json settings (payer_name/payer_id), the same
    # for every claim, not something worth asking the model to read per claim.
    "insured_id_number": "FL60 - insured's unique ID",
    "insured_group_name": "FL61 - insurance group name, if present else null",
    "insured_group_number": "FL62 - insurance group number, if present else null",
    "treatment_authorization_code": "FL63, if present else null",
    "employer_name": "FL65 - employer name, if present else null",
    "principal_diagnosis_code": "FL67 - principal diagnosis code (ICD-10-CM), no decimal point removed -- keep as printed",
    "principal_diagnosis_poa": "FL67 - present-on-admission indicator for the principal diagnosis (Y, N, U, W, or 1), if present else null",
    "other_diagnosis_codes": "FL67 A-Q - JSON array of secondary diagnosis codes actually present, else empty array",
    "admitting_diagnosis_code": "FL69, if present else null",
    "principal_procedure_code": "FL74 - principal procedure code (ICD-10-PCS), if present else null",
    "principal_procedure_date": "FL74 - date of principal procedure, exactly as printed, if present else null",
    "drg_code": "Diagnosis-Related Group code, if present on the form else null",
    "attending_provider_npi": "FL76 - attending provider NPI",
    "attending_provider_last_name": "FL76 - attending provider last name (printed in its own LAST box, separate from FIRST)",
    "attending_provider_first_name": "FL76 - attending provider first name (printed in its own FIRST box, separate from LAST), if present else null",
    "operating_provider_npi": "FL77 - operating physician NPI, if present else null",
    "operating_provider_last_name": "FL77 - operating physician last name (printed in its own LAST box, separate from FIRST), if present else null",
    "operating_provider_first_name": "FL77 - operating physician first name (printed in its own FIRST box, separate from LAST), if present else null",
    # FL78/79 -- two generic "Other" provider slots, each with its own small
    # QUAL box (easy to miss) that says which role this provider fills --
    # e.g. "DN" for a referring provider -- rather than the box itself
    # naming a fixed role the way FL76/77 do. That qualifier is read
    # verbatim into *_qualifier and used as-is when building the 837 (see
    # x12_837.py) as the provider's X12 entity-identifier code, so read it
    # carefully: an empty/illegible qualifier means this provider can't be
    # placed on the built 837 at all, even with a valid NPI.
    "other_provider_1_qualifier": "FL78 - the small QUAL code identifying this provider's role (e.g. 'DN' for a referring provider), if present else null",
    "other_provider_1_npi": "FL78 - NPI, if present else null",
    "other_provider_1_last_name": "FL78 - last name (printed in its own LAST box, separate from FIRST), if present else null",
    "other_provider_1_first_name": "FL78 - first name (printed in its own FIRST box, separate from LAST), if present else null",
    "other_provider_2_qualifier": "FL79 - the small QUAL code identifying this provider's role (e.g. 'DN' for a referring provider), if present else null",
    "other_provider_2_npi": "FL79 - NPI, if present else null",
    "other_provider_2_last_name": "FL79 - last name (printed in its own LAST box, separate from FIRST), if present else null",
    "other_provider_2_first_name": "FL79 - first name (printed in its own FIRST box, separate from LAST), if present else null",
    "remarks": "FL80 - remarks, if present else null",
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

# Which fields hold dates, for common.normalize_claim_dates(). Deliberately
# asked of the model as "exactly as printed" rather than a target format
# (see build_extraction_prompt) -- Qwen reliably transcribes the digits it
# sees, but reliably swaps month/day when also asked to reorder them into
# YYYY-MM-DD itself. Converting to ISO is instead done deterministically in
# Python, after extraction, from whatever US date format actually came back
# (see common.normalize_date). Top-level date fields vs. one-per-line-item
# fields are tracked separately since the latter live inside a list value.
CMS1500_DATE_FIELDS = ["patient_dob", "insured_dob", "hospitalization_date_from", "hospitalization_date_to"]
CMS1500_LINE_DATE_FIELDS = {"service_lines": ["date_from", "date_to"]}

UB04_DATE_FIELDS = ["statement_date_from", "statement_date_to", "patient_dob",
                     "admission_date", "principal_procedure_date"]
UB04_LINE_DATE_FIELDS = {"revenue_lines": ["service_date"], "occurrence_codes": ["date"],
                          "occurrence_span_codes": ["date_from", "date_to"]}

# Which fields hold a two-box (dollars/cents) charge amount, for
# common.combine_claim_money() -- same "ask the model to transcribe, not
# reformat" reasoning as *_DATE_FIELDS above (see common.combine_money's
# docstring): the model is asked for "<base>_dollars"/"<base>_cents" as two
# separate raw digit reads (see the field descriptions above and
# build_extraction_prompt's handling of money_fields), and Python combines
# them into a single "<base>" field deterministically, after extraction.
# Top-level fields vs. one-per-line-item fields are tracked separately, same
# split as the date fields.
CMS1500_MONEY_FIELDS = ["total_charge", "outside_lab_charges"]
CMS1500_LINE_MONEY_FIELDS = {"service_lines": ["charge_amount"]}

UB04_MONEY_FIELDS = ["total_charges"]
UB04_LINE_MONEY_FIELDS = {
    "revenue_lines": ["total_charge", "non_covered_charge"],
    "value_codes": ["amount"],
}

# Which fields hold a phone number, for common.normalize_claim_phones() --
# same "ask the model to transcribe, then normalize deterministically"
# pattern as *_DATE_FIELDS/*_MONEY_FIELDS above. CMS-1500/UB-04 print each
# phone box as "( ___ ) ___-____" with the parentheses as part of the box's
# own artwork right where the digits go, so "transcribe exactly what's
# printed" can end up copying those printed parens (or whatever stray
# spacing sits inside them) as if they were part of the entered number.
# Stripped to digits-only after extraction instead (see normalize_phone),
# so display formatting (Review, the 837 viewer) has one clean shape to
# work from, and two verification passes that only disagree on cosmetic
# spacing/punctuation no longer register as a real disagreement. No
# per-line phone fields exist on either form's line-item grid.
CMS1500_PHONE_FIELDS = ["patient_phone", "billing_provider_phone"]
UB04_PHONE_FIELDS = ["billing_provider_phone"]

# Which fields are at risk of a small form-printed qualifier CODE bleeding
# into the transcribed value, for common.normalize_claim_qualifier_fields()
# -- same "ask nicely, then normalize deterministically" pattern as
# *_PHONE_FIELDS above, confirmed for real on two boxes: box 17's own
# qualifier box (DN/DK/DQ, printed immediately next to the referring
# provider's name -- see referring_provider_last_name's description) and
# box 24I's own qualifier (almost always "ZZ", printed directly above
# 24J's top-half taxonomy code -- see service_lines' rendering_provider_taxonomy
# description). Top-level fields vs. one-per-line-item fields are tracked
# separately, same split as *_DATE_FIELDS/*_MONEY_FIELDS.
CMS1500_QUALIFIER_FIELDS = {
    "referring_provider_last_name": ["DN", "DK", "DQ"],
    "referring_provider_first_name": ["DN", "DK", "DQ"],
}
CMS1500_LINE_QUALIFIER_FIELDS = {"service_lines": {"rendering_provider_taxonomy": ["ZZ"]}}
UB04_QUALIFIER_FIELDS: dict = {}
UB04_LINE_QUALIFIER_FIELDS: dict = {}

# Which fields are booleans, for dump_schema.py/review-app's renderer.js:
# Review renders these as a toggle rather than a bare text input, and needs
# to know which fields those are without depending on the wording of each
# field's description (dump_schema.py rewrites boolean descriptions for
# Review into something that describes the form, not JSON true/false -- see
# BOOLEAN_REVIEW_HINTS there -- so sniffing prose for "true if...else false"
# the way review-app's renderer.js used to sniff "JSON array" for array
# fields would break the moment that rewording changed, which is exactly
# what happened once already for booleans, and happened again for arrays
# the day ARRAY_REVIEW_HINTS (see dump_schema.py) first shipped -- see
# *_STRING_ARRAY_FIELDS below, added for the same reason as this list).
CMS1500_BOOLEAN_FIELDS = ["ssn_box_checked", "ein_box_checked", "employment_related", "auto_accident", "accept_assignment", "outside_lab"]
UB04_BOOLEAN_FIELDS: list = []

# Which top-level fields are a plain string array (as opposed to an
# object-array/line-item field -- see *_ARRAY_ITEMS below, which already
# gives dump_schema.py/renderer.js an explicit, description-independent way
# to know THOSE), for the same "don't sniff the description" reason as
# *_BOOLEAN_FIELDS above. review-app's renderer.js combines this with
# *_ARRAY_ITEMS' own keys into one "which fields render as an array editor
# at all" list -- see its own isArrayField().
CMS1500_STRING_ARRAY_FIELDS = ["diagnosis_codes"]
UB04_STRING_ARRAY_FIELDS = ["condition_codes", "other_diagnosis_codes"]

# Sub-field schemas for array-of-object fields (service_lines, revenue_lines,
# value_codes), for dump_schema.py/review-app's renderer.js: Review renders
# each line item as its own set of labeled inputs -- one per row, with
# add/remove -- instead of one JSON-array-in-a-textarea blob. These are
# short field labels for that UI only; the model never sees this dict, and
# the actual extraction instructions for these same sub-fields live in the
# parent array field's own prose description in *_FIELDS above (unchanged,
# still the one source of truth for what the model extracts).
#
# array_subfields: which of an item's own fields are themselves a string
# array (currently just service_lines' modifiers) -- rendered as a nested
# add/remove chip list rather than a plain text input.
# numeric_subfields: which fields should round-trip as a JSON number
# (rather than a string) when Review saves -- deliberately explicit rather
# than guessed from the value, since e.g. revenue_code's leading zeros
# ("0250") would be silently destroyed by Number("0250") -- see
# review-app/renderer.js's readFormFields().
# boolean_subfields: which fields are a real per-line checkbox (currently
# just service_lines' emg, box 24C) -- rendered as the same real Yes/No
# toggle top-level boolean fields get (see CMS1500_BOOLEAN_FIELDS above),
# not a free-text "true"/"false" box.
CMS1500_SERVICE_LINE_FIELDS = {
    "date_from": "Date from (box 24A)",
    "date_to": "Date to (box 24A)",
    "place_of_service": "Place of service (box 24B)",
    "emg": "Emergency (box 24C)",
    "cpt_hcpcs_code": "CPT/HCPCS code (box 24D)",
    "modifiers": "Modifiers (box 24D, up to 4)",
    "diagnosis_pointer": "Diagnosis pointer (box 24E)",
    "charge_amount": "Charge amount (box 24F)",
    "units": "Units (box 24G)",
    "rendering_provider_npi": "Rendering provider NPI (box 24J, bottom half only)",
    "rendering_provider_taxonomy": "Rendering provider taxonomy (box 24I/24J, top half, optional)",
}
CMS1500_ARRAY_ITEMS = {
    "service_lines": {
        "item_fields": CMS1500_SERVICE_LINE_FIELDS,
        "array_subfields": ["modifiers"],
        "numeric_subfields": ["charge_amount", "units"],
        "boolean_subfields": ["emg"],
    },
}

UB04_REVENUE_LINE_FIELDS = {
    "revenue_code": "Revenue code (FL42)",
    "hcpcs_code": "HCPCS code (FL44)",
    "service_date": "Service date (FL45)",
    "units": "Units (FL46)",
    "total_charge": "Total charge (FL47)",
    "non_covered_charge": "Non-covered charge (FL48)",
}
UB04_VALUE_CODE_FIELDS = {
    "code": "Value code (FL39-41)",
    "amount": "Amount",
}
UB04_OCCURRENCE_CODE_FIELDS = {
    "code": "Occurrence code (FL31-34)",
    "date": "Date",
}
UB04_OCCURRENCE_SPAN_CODE_FIELDS = {
    "code": "Occurrence span code (FL35-36)",
    "date_from": "From date",
    "date_to": "Through date",
}
UB04_ARRAY_ITEMS = {
    "revenue_lines": {
        "item_fields": UB04_REVENUE_LINE_FIELDS,
        "array_subfields": [],
        "numeric_subfields": ["units", "total_charge", "non_covered_charge"],
    },
    "value_codes": {
        "item_fields": UB04_VALUE_CODE_FIELDS,
        "array_subfields": [],
        "numeric_subfields": ["amount"],
    },
    "occurrence_codes": {
        "item_fields": UB04_OCCURRENCE_CODE_FIELDS,
        "array_subfields": [],
        "numeric_subfields": [],
    },
    "occurrence_span_codes": {
        "item_fields": UB04_OCCURRENCE_SPAN_CODE_FIELDS,
        "array_subfields": [],
        "numeric_subfields": [],
    },
}


def build_extraction_prompt(fields: dict, form_label: str, money_fields: Optional[list] = None) -> str:
    """
    money_fields: top-level keys (see *_MONEY_FIELDS) whose single
    description in `fields` covers a two-box dollars/cents amount --
    rendered as two separate "<key>_dollars"/"<key>_cents" keys for the
    model to fill in instead of one "<key>" line, so the model is never
    asked to combine or place a decimal point itself (see
    common.combine_money's docstring for why: that combination step is
    exactly where it goes wrong). Fields that already describe their own
    dollars/cents split inline (service_lines, revenue_lines, value_codes --
    see their prose in CMS1500_FIELDS/UB04_FIELDS above) don't need to be
    listed here; this is only for a plain top-level field.
    """
    money_field_set = set(money_fields or [])
    lines = [
        f"You are extracting structured data from a scanned {form_label} claim form image.",
        "Return ONLY a single JSON object (no markdown fences, no commentary) with exactly these keys:",
        "",
    ]
    for key, desc in fields.items():
        if key in money_field_set:
            lines.append(f'  "{key}_dollars": {desc} Report ONLY the whole-dollar box: digits exactly '
                          "as printed, no decimal point, no cents, no $ sign, no commas.")
            lines.append(f'  "{key}_cents": {desc} Report ONLY the cents box: the two-digit cents amount '
                          "exactly as printed.")
        else:
            lines.append(f'  "{key}": {desc}')
    lines.append("")
    lines.append(
        "If a field is not present or not legible on the form, use null (or an empty array/string "
        "as appropriate for that field's type) rather than guessing. Do not invent values. "
        "Copy codes, numbers, and dates exactly as printed -- do not reformat or 'correct' them. "
        "In particular, for any field marked \"exactly as printed\": transcribe the date digit-for-digit "
        "in whatever order and punctuation the form shows (e.g. a form printed as 03/07/2024 must come "
        "back as \"03/07/2024\", not \"2024-03-07\" or \"07/03/2024\") -- do not convert it to a "
        "different format and do not swap the month and day. Likewise, for any field name ending in "
        "\"_dollars\" or \"_cents\": these are two separate boxes on the form for one amount, divided by "
        "a printed line, and are sometimes spaced apart and sometimes not -- report ONLY the digits "
        "actually printed inside that one box. Do not add the two boxes together, do not combine them "
        "into a decimal number yourself, and do not repeat one box's digits in the other -- a $150.00 "
        "charge is a dollars box showing '150' and a cents box showing '00', never a dollars box showing "
        "'15000'."
    )
    return "\n".join(lines)


CMS1500_PROMPT = build_extraction_prompt(CMS1500_FIELDS, "CMS-1500 (professional)", money_fields=CMS1500_MONEY_FIELDS)
UB04_PROMPT = build_extraction_prompt(UB04_FIELDS, "UB-04 (institutional)", money_fields=UB04_MONEY_FIELDS)
