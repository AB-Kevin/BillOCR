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
      "CMS1500": {"fields": {<key>: <description>, ...}, "required": [<key>, ...]},
      "UB04":    {"fields": {<key>: <description>, ...}, "required": [<key>, ...]}
    }
"""

import json

from claim_schemas import CMS1500_FIELDS, CMS1500_REQUIRED, UB04_FIELDS, UB04_REQUIRED


def main() -> None:
    print(json.dumps({
        "CMS1500": {"fields": CMS1500_FIELDS, "required": CMS1500_REQUIRED},
        "UB04": {"fields": UB04_FIELDS, "required": UB04_REQUIRED},
    }))


if __name__ == "__main__":
    main()
