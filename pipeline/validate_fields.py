#!/usr/bin/env python3
"""
Thin CLI around field_validation.validate_fields(), for the Review app.
Review has no Ollama/model dependency of its own (that's Intake's job), so
it can't import extract_claim_fields.py's world -- but it still needs
fresh validation flags every time a claim is saved (an edit could fix a
flagged field, or introduce a new problem in one that was fine before).
This lets it get that from a plain subprocess call instead of
reimplementing the checks in JS, keeping field_validation.py the one
source of truth for both apps.

Usage:
    echo '{"form_type": "CMS1500", "fields": {...}}' | python3 validate_fields.py

Reads the request JSON from stdin, prints {"flags": {...}} to stdout.
"""

import json
import sys

from field_validation import validate_fields


def main() -> None:
    try:
        request = json.loads(sys.stdin.read())
    except json.JSONDecodeError as exc:
        sys.exit(f"could not parse request JSON from stdin: {exc}")

    form_type = request.get("form_type", "")
    fields = request.get("fields") or {}
    print(json.dumps({"flags": validate_fields(form_type, fields)}))


if __name__ == "__main__":
    main()
