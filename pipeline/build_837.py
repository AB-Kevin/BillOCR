#!/usr/bin/env python3
"""
837 builder: watches an "approved" folder for reviewed claim JSON files
(produced by extract_claim_fields.py, then hand-corrected and moved here
by a person) and writes a corresponding X12 837 EDI file for each one, saved
with a .txt extension (the content is still 837, just plain-text-named).

This does NOT talk to Ollama and does NOT do any OCR -- it's a pure,
deterministic transform from structured data to X12 text, using
x12_837.py. See README.md for the pipeline this fits into, and its
"Claims pipeline" section for what this does and doesn't cover.

Usage:
    python3 build_837.py --approved ./approved --out ./output_837 --org org_config.json

Run `python3 build_837.py --help` for all options.
"""

import argparse
import json
import shutil
import time
from pathlib import Path

from common import build_logger, wait_until_stable
from x12_837 import ClaimDataError, ControlNumbers, build_837


def process_one(json_path: Path, out_dir: Path, built_dir: Path, errors_dir: Path,
                 org: dict, control_numbers: ControlNumbers, logger) -> None:
    if not wait_until_stable(json_path):
        logger.warning("%s never stabilized -- will retry next pass", json_path.name)
        return

    try:
        record = json.loads(json_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        logger.exception("%s is not valid JSON: %s", json_path.name, exc)
        shutil.move(str(json_path), str(errors_dir / json_path.name))
        return

    claim_id = record.get("claim_id", json_path.stem)
    try:
        edi_text = build_837(record, org, control_numbers)
        out_path = out_dir / f"{claim_id}.txt"
        out_path.write_text(edi_text, encoding="utf-8")
        shutil.move(str(json_path), str(built_dir / json_path.name))
        logger.info("%s -> %s", json_path.name, out_path.name)
    except ClaimDataError as exc:
        # A required field is missing/invalid -- this is a data problem, not a bug.
        # Leave it for the person to fix in the JSON and re-approve.
        logger.warning("%s: cannot build 837 yet -- %s. Leaving in place for correction.",
                        json_path.name, exc)
    except Exception as exc:  # noqa: BLE001 -- keep the watcher alive no matter what
        logger.exception("Unexpected error building %s: %s", json_path.name, exc)
        shutil.move(str(json_path), str(errors_dir / json_path.name))


def run(approved, out, org_path="org_config.json", built=None, errors=None,
        control_state="control_numbers.json", poll_interval: float = 2.0,
        log_file=None, logger=None) -> None:
    """
    Run the approved-claim-JSON -> .837 watch loop. Blocks until interrupted.
    Pulled out of main() so billocr.py can run this alongside
    extract_claim_fields.run() in one process; calling this directly is
    equivalent to running `python3 build_837.py` with the same arguments.
    """
    org_path = Path(org_path)
    if not org_path.exists():
        raise SystemExit(
            f"Org config not found: {org_path}\n"
            f"Copy org_config.example.json to {org_path} and fill in your real values first."
        )
    org = json.loads(org_path.read_text(encoding="utf-8"))

    approved_dir = Path(approved)
    out_dir = Path(out)
    built_dir = Path(built) if built else approved_dir / "_built"
    errors_dir = Path(errors) if errors else approved_dir / "_errors"
    for d in (approved_dir, out_dir, built_dir, errors_dir):
        d.mkdir(parents=True, exist_ok=True)

    if logger is None:
        logger = build_logger("build_837", log_file)
    control_numbers = ControlNumbers(Path(control_state))

    logger.info("Watching approved claims in: %s", approved_dir.resolve())
    logger.info("Writing 837 (.txt) files to: %s", out_dir.resolve())
    logger.info("Org config: %s (usage_indicator=%s)", org_path.resolve(), org.get("usage_indicator"))

    try:
        while True:
            candidates = sorted(
                p for p in approved_dir.iterdir()
                if p.is_file() and p.suffix.lower() == ".json"
            )
            for path in candidates:
                process_one(path, out_dir, built_dir, errors_dir, org, control_numbers, logger)
            time.sleep(poll_interval)
    except KeyboardInterrupt:
        logger.info("Stopped by user.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build X12 837I/837P files from approved, reviewed claim JSON.")
    parser.add_argument("--approved", default="approved", help="Folder to watch for approved claim JSON (default: ./approved)")
    parser.add_argument("--out", default="output_837", help="Folder to write .837 files into (default: ./output_837)")
    parser.add_argument("--built", default=None, help="Where to move consumed JSON after a successful build (default: <approved>/_built)")
    parser.add_argument("--errors", default=None, help="Where to move JSON that failed to build (default: <approved>/_errors)")
    parser.add_argument("--org", default="org_config.json", help="Path to your organization's submitter/receiver config (default: ./org_config.json)")
    parser.add_argument("--control-state", default="control_numbers.json", help="Where to persist ISA/GS/ST control numbers (default: ./control_numbers.json)")
    parser.add_argument("--poll-interval", type=float, default=2.0)
    parser.add_argument("--log-file", default=None)
    args = parser.parse_args()

    run(
        approved=args.approved, out=args.out, org_path=args.org, built=args.built,
        errors=args.errors, control_state=args.control_state,
        poll_interval=args.poll_interval, log_file=args.log_file,
    )


if __name__ == "__main__":
    main()
