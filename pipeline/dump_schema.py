#!/usr/bin/env python3
"""
Print claim_schemas.py's field descriptions and required-field lists as
JSON on stdout. Used by both desktop apps (Intake and Review) so their
claim-edit forms and required-field validation are generated from the
same source of truth as the extraction prompts/build_837.py, instead of
hand-duplicating those constants in JS where they could drift.

Usage:
    python3 dump_schema.py

Output shape:
    {
      "CMS1500": {"fields": {<key>: <description>, ...}, "required": [<key>, ...],
                  "booleans": [<key>, ...], "array_items": {<key>: {...}, ...}},
      "UB04":    {"fields": {<key>: <description>, ...}, "required": [<key>, ...],
                  "booleans": [<key>, ...], "array_items": {<key>: {...}, ...}}
    }
"""

import json

from claim_schemas import (
    CMS1500_ARRAY_ITEMS, CMS1500_BOOLEAN_FIELDS, CMS1500_DATE_FIELDS, CMS1500_FIELDS,
    CMS1500_LINE_DATE_FIELDS, CMS1500_REQUIRED,
    UB04_ARRAY_ITEMS, UB04_BOOLEAN_FIELDS, UB04_DATE_FIELDS, UB04_FIELDS,
    UB04_LINE_DATE_FIELDS, UB04_REQUIRED,
)


# claim_schemas.py's "true if X is marked, else false" phrasing is written
# to tell the model which JSON boolean to emit -- it reads oddly next to
# Review's actual per-checkbox toggles (see review-app/renderer.js's
# isBooleanField/BOOLEAN_FIELD_OPTIONS), which need a plain description of
# what the box on the form looks like instead. Keyed by field name since,
# unlike dates, there's no shared structural note that applies to every
# boolean field.
BOOLEAN_REVIEW_HINTS = {
    "ssn_box_checked": "Box 25 - is the SSN checkbox (printed first, before EIN) marked on the form?",
    "ein_box_checked": "Box 25 - is the EIN checkbox (printed second, after SSN) marked on the form?",
}


def _fields_for_review(fields: dict, date_fields: list, line_date_fields: dict) -> dict:
    """
    Same field descriptions the model gets, but reworded for a human
    reviewer where the raw prompt text wouldn't make sense to one -- dates
    get a note on what format Review actually displays them in (deliberately
    NOT in the text extract_claim_fields.py's prompt sends the model, see
    claim_schemas.py's "exactly as printed" fields: telling the model its
    *target* format is exactly the instruction that used to make it swap
    month and day when it tried to convert to that format itself; dates are
    transcribed as printed, then normalized to ISO in Python -- see
    common.normalize_date). A human reviewer runs no such risk reading the
    same note, and needs it to tell whether the value in the box actually
    matches the image next to it. Boolean fields (see BOOLEAN_REVIEW_HINTS)
    get their whole description swapped for one that describes the form
    instead of the JSON value Review's toggle already makes obvious.
    """
    out = dict(fields)
    for key in date_fields:
        if key in out:
            out[key] = f"{out[key]} -- shown here as YYYY-MM-DD"
    for lines_key, sub_keys in line_date_fields.items():
        if lines_key in out:
            out[lines_key] = f"{out[lines_key]} ({'/'.join(sub_keys)} shown here as YYYY-MM-DD)"
    for key, hint in BOOLEAN_REVIEW_HINTS.items():
        if key in out:
            out[key] = hint
    return out


def main() -> None:
    print(json.dumps({
        "CMS1500": {
            "fields": _fields_for_review(CMS1500_FIELDS, CMS1500_DATE_FIELDS, CMS1500_LINE_DATE_FIELDS),
            "required": CMS1500_REQUIRED,
            "booleans": CMS1500_BOOLEAN_FIELDS,
            "array_items": CMS1500_ARRAY_ITEMS,
        },
        "UB04": {
            "fields": _fields_for_review(UB04_FIELDS, UB04_DATE_FIELDS, UB04_LINE_DATE_FIELDS),
            "required": UB04_REQUIRED,
            "booleans": UB04_BOOLEAN_FIELDS,
            "array_items": UB04_ARRAY_ITEMS,
        },
    }))


if __name__ == "__main__":
    main()
