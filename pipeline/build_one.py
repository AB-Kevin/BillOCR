#!/usr/bin/env python3
"""
One-shot single-claim 837 build: takes exactly one approved claim JSON and
writes exactly one .837 file, then exits. This is what the Review app's
"Approve" button calls (build_one.py, not build_837.py) so approval is a
synchronous, immediate action -- no watcher/background process needed on
the approval machine. build_837.py's own continuous watcher is unrelated
and still works standalone if anyone wants to run the pipeline from a
terminal instead.

Usage:
    python3 build_one.py --claim claim.json --org org_config.json \\
        --control-state control_numbers.json --out claim.837

On success: writes --out, prints its resolved path to stdout, exits 0.
On a data problem (a required field is missing/invalid): writes nothing,
prints "MISSING_FIELDS: <details>" to stderr, exits 1 -- the caller should
leave the source JSON in place so it can be fixed and retried, exactly
like build_837.py's watcher does when it hits the same error.
Any other unexpected error also exits 1, with a plain message on stderr
(no MISSING_FIELDS prefix, so callers can tell the two apart).
"""

import argparse
import json
import sys
from pathlib import Path

from x12_837 import ClaimDataError, ControlNumbers, build_837


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a single .837 from one approved claim JSON.")
    parser.add_argument("--claim", required=True, help="Path to the claim JSON (as produced by extract_claim_fields.py, possibly hand-edited)")
    parser.add_argument("--org", required=True, help="Path to org_config.json")
    parser.add_argument("--control-state", required=True, help="Path to control_numbers.json (created if it doesn't exist)")
    parser.add_argument("--out", required=True, help="Path to write the finished .837 to")
    args = parser.parse_args()

    try:
        record = json.loads(Path(args.claim).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        sys.exit(f"could not read claim JSON {args.claim}: {exc}")

    try:
        org = json.loads(Path(args.org).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        sys.exit(f"could not read org config {args.org}: {exc}")

    control_numbers = ControlNumbers(Path(args.control_state))

    try:
        edi_text = build_837(record, org, control_numbers)
    except ClaimDataError as exc:
        sys.exit(f"MISSING_FIELDS: {exc}")

    out_path = Path(args.out)
    out_path.write_text(edi_text, encoding="utf-8")
    print(str(out_path.resolve()))


if __name__ == "__main__":
    main()
