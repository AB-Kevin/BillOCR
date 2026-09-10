#!/usr/bin/env python3
"""
Single entrypoint bundling dump_schema.py/validate_fields.py/build_one.py's
CLI behavior into one PyInstaller-frozen executable for BillOCR Review's
installer -- so the Review app needs no Python installed on the end user's
machine at all (Intake still does; it has real third-party dependencies --
ollama, pypdfium2, Pillow -- for OCR, which this one deliberately doesn't
touch). Review's own scripts are pure standard library (see their imports),
which is what makes freezing them this way straightforward.

This is a thin dispatcher, not a rewrite: each subcommand below just calls
that script's own, unmodified main() -- so there is exactly one copy of
the actual logic, and the plain "python3 <script>.py" usage documented in
each of those files' docstrings still works standalone for anyone running
the pipeline from a real Python install.

Dispatches like a git-style subcommand, matching each script's own usage
exactly except for the leading "python3 <script>.py" being replaced by
"review_cli <subcommand>" (or, frozen, the built executable's name):

    review_cli dump-schema
    review_cli validate                          (reads stdin, same as validate_fields.py)
    review_cli build-one --claim ... --org ... --control-state ... --out ...

review-app/main.js calls the frozen executable directly when packaged
(app.isPackaged), and falls back to "python3 <script>.py" in dev -- see
its PIPELINE_CLI comment.
"""

import sys

# Imported unconditionally (not inside the branches below) so PyInstaller's
# static import analysis is never the thing deciding whether a subcommand
# actually works -- all three, and everything they in turn import
# (claim_schemas, field_validation, x12_837, common), are always bundled.
import dump_schema
import validate_fields
import build_one

COMMANDS = {
    "dump-schema": dump_schema.main,
    "validate": validate_fields.main,
    "build-one": build_one.main,
}


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        sys.exit(f"usage: review_cli <{'|'.join(COMMANDS)}> [args...]")
    command = sys.argv[1]
    # Each script's own main() reads sys.argv/argparse itself, expecting
    # argv[0] to be its own name and the real arguments after it -- same
    # shape as if it had been invoked directly.
    sys.argv = [command] + sys.argv[2:]
    COMMANDS[command]()


if __name__ == "__main__":
    main()
