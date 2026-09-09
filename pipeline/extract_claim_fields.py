#!/usr/bin/env python3
"""
Claim field extractor: watches two folders (one for CMS-1500 images, one
for UB-04 images), asks Qwen to pull structured field values out of each,
and writes a JSON file + a human-readable review page for each claim into
a "pending_review" folder. Nothing here talks to build_837.py directly --
a person reviews/corrects the JSON, then moves it into an "approved" folder
when it's ready. See README.md, section on the claims pipeline.

Usage:
    python3 extract_claim_fields.py \\
        --cms1500-in ./incoming_1500 --ub04-in ./incoming_ub04 \\
        --out ./pending_review

Run `python3 extract_claim_fields.py --help` for all options.
"""

import argparse
import html as html_escape_mod
import json
import shutil
import sys
import time
import uuid
from pathlib import Path
from typing import Optional

try:
    import ollama
except ImportError:
    sys.exit("The 'ollama' package is required. Install it with:\n    pip install ollama")

import field_validation
from common import IMAGE_EXTENSIONS, build_logger, chat_with_thinking_fallback, load_image_payload, wait_until_stable
from claim_schemas import (
    CMS1500_FIELDS, CMS1500_PROMPT, CMS1500_REQUIRED,
    UB04_FIELDS, UB04_PROMPT, UB04_REQUIRED,
)

FORM_SPECS = {
    "CMS1500": {"fields": CMS1500_FIELDS, "prompt": CMS1500_PROMPT, "required": CMS1500_REQUIRED},
    "UB04": {"fields": UB04_FIELDS, "prompt": UB04_PROMPT, "required": UB04_REQUIRED},
}

# Default temperature for verification (check) passes -- deliberately
# higher than the primary pass's default so repeated reads of the same
# image actually vary enough to be a useful disagreement signal, rather
# than reproducing the exact same (possibly wrong) answer every time.
# Now a --check-pass-temperature setting (see collect_disagreement_flags),
# this is just its default. The primary pass is always left at Ollama's
# own default (unset here) so turning verification off
# (--verification-passes 1) is byte-identical to before this feature
# existed, regardless of this value.
DEFAULT_CHECK_PASS_TEMPERATURE = 0.5


def extract_json_object(text: str) -> dict:
    """
    Pull a JSON object out of the model's response even if it wrapped it in
    markdown fences or added stray text around it.
    """
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("no JSON object found in model output")
    return json.loads(text[start:end + 1])


def missing_required(fields: dict, required: list) -> list:
    missing = []
    for key in required:
        value = fields.get(key)
        if value is None or value == "" or value == []:
            missing.append(key)
    return missing


def collect_disagreement_flags(client, model: str, messages: list, keep_alive,
                                primary_fields: dict, field_specs: dict, verification_passes: int,
                                logger, claim_id: str,
                                check_pass_temperature: float = DEFAULT_CHECK_PASS_TEMPERATURE) -> dict:
    """
    Runs (verification_passes - 1) additional resamples of the same
    image/prompt at check_pass_temperature and flags any field where a
    resample disagrees with the already-extracted primary read -- a
    self-consistency check (see the "OCR accuracy" plan/discussion): if
    the model reads something differently on a second or third look,
    that's a real signal worth a human's attention, independent of
    field_validation.py's separate, zero-inference-cost checks.

    Returns {field_key: [{"type": "disagreement", "reason": ...}, ...]},
    empty if verification_passes <= 1 or nothing disagreed.
    """
    flags: dict = {}
    for i in range(2, verification_passes + 1):
        try:
            raw_text, _ = chat_with_thinking_fallback(
                client, model, messages, keep_alive, response_format="json",
                options={"temperature": check_pass_temperature},
            )
            check_fields = extract_json_object(raw_text)
        except Exception as exc:  # noqa: BLE001 -- a bad check pass shouldn't break extraction
            logger.warning("claim %s: verification pass %d/%d failed to parse, skipping it: %s",
                            claim_id, i, verification_passes, exc)
            continue

        disagreed = []
        for key in field_specs:
            if key == "form_type":
                continue
            if not field_validation.values_equivalent(primary_fields.get(key), check_fields.get(key)):
                flags.setdefault(key, []).append({
                    "type": "disagreement",
                    "reason": f"pass {i} read {check_fields.get(key)!r} instead of {primary_fields.get(key)!r}",
                })
                disagreed.append(key)
        if disagreed:
            logger.warning("claim %s: verification pass %d/%d disagreed on: %s",
                            claim_id, i, verification_passes, ", ".join(disagreed))
        else:
            logger.info("claim %s: verification pass %d/%d agreed with the primary read",
                        claim_id, i, verification_passes)
    return flags


def build_review_html(claim_id: str, form_type: str, image_rel_path: str,
                       fields: dict, field_specs: dict, missing: list, flagged: dict,
                       used_thinking_fallback: bool) -> str:
    def esc(v):
        return html_escape_mod.escape(str(v))

    rows = []
    for key, desc in field_specs.items():
        value = fields.get(key, None)
        is_missing = key in missing
        is_flagged = key in flagged
        if is_missing:
            style = ' style="background:#ffe0e0;"'  # red -- required and absent
        elif is_flagged:
            style = ' style="background:#fff3cd;"'  # amber -- present, but disagreed across passes or failed validation
        else:
            style = ""
        pretty_value = json.dumps(value) if isinstance(value, (list, dict)) else esc(value)
        flag_html = ""
        if is_flagged:
            reasons = "; ".join(entry["reason"] for entry in flagged[key])
            flag_html = f'<br><small style="color:#a60;">⚠ {esc(reasons)}</small>'
        rows.append(
            f"<tr{style}><td><code>{esc(key)}</code><br><small>{esc(desc)}</small></td>"
            f"<td>{pretty_value}{flag_html}</td></tr>"
        )

    warning = ""
    if missing:
        warning += (
            f'<p style="color:#b00;font-weight:bold;">Missing required fields: '
            f'{esc(", ".join(missing))} -- fill these in the .json before approving.</p>'
        )
    if flagged:
        warning += (
            f'<p style="color:#a60;font-weight:bold;">Flagged for review (disagreed across passes or failed '
            f'a validation check): {esc(", ".join(flagged.keys()))} -- see amber rows below.</p>'
        )
    if used_thinking_fallback:
        warning += (
            '<p style="color:#a60;font-weight:bold;">Recovered from the model\'s "thinking" '
            "field -- double-check every value below against the image.</p>"
        )

    return f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Review: {esc(claim_id)}</title>
<style>
  body {{ font-family: -apple-system, Arial, sans-serif; margin: 20px; }}
  .layout {{ display: flex; gap: 20px; align-items: flex-start; }}
  .image-pane img {{ max-width: 520px; border: 1px solid #ccc; }}
  table {{ border-collapse: collapse; flex: 1; }}
  td {{ border: 1px solid #ddd; padding: 6px 10px; vertical-align: top; font-size: 13px; }}
  code {{ font-weight: bold; }}
  small {{ color: #666; }}
</style>
</head>
<body>
<h2>{esc(form_type)} claim: {esc(claim_id)}</h2>
{warning}
<div class="layout">
  <div class="image-pane"><img src="{esc(image_rel_path)}"></div>
  <table>{"".join(rows)}</table>
</div>
</body>
</html>
"""


def process_one(path: Path, form_type: str, out_dir: Path, processed_dir: Path, errors_dir: Path,
                 client, model: str, host: str, keep_alive, logger, max_dim: Optional[int],
                 verification_passes: int = 1,
                 check_pass_temperature: float = DEFAULT_CHECK_PASS_TEMPERATURE) -> None:
    if not wait_until_stable(path):
        logger.warning("%s never stabilized (still being written?) -- will retry next pass", path.name)
        return

    spec = FORM_SPECS[form_type]
    claim_id = f"{form_type.lower()}_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
    images_dir = out_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    try:
        payload = load_image_payload(path, max_dim)
        messages = [{"role": "user", "content": spec["prompt"], "images": [payload]}]
        raw_text, used_thinking_fallback = chat_with_thinking_fallback(
            client, model, messages, keep_alive, response_format="json",
        )
        try:
            fields = extract_json_object(raw_text)
        except (ValueError, json.JSONDecodeError) as parse_exc:
            raise ValueError(f"could not parse JSON from model output: {parse_exc}\n---\n{raw_text[:2000]}")

        fields.setdefault("form_type", form_type)
        missing = missing_required(fields, spec["required"])

        flagged = collect_disagreement_flags(
            client, model, messages, keep_alive, fields, spec["fields"], verification_passes, logger, claim_id,
            check_pass_temperature=check_pass_temperature,
        )
        for key, entries in field_validation.validate_fields(form_type, fields).items():
            flagged.setdefault(key, []).extend(entries)

        image_dest = images_dir / (claim_id + path.suffix.lower())
        shutil.copy2(str(path), str(image_dest))

        record = {
            "claim_id": claim_id,
            "form_type": form_type,
            "source_image": f"images/{image_dest.name}",
            "extracted_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "model": model,
            "verification_passes": verification_passes,
            "used_thinking_fallback": used_thinking_fallback,
            "missing_required_fields": missing,
            "flagged_fields": flagged,
            "fields": fields,
        }
        json_path = out_dir / f"{claim_id}.json"
        json_path.write_text(json.dumps(record, indent=2), encoding="utf-8")

        html_path = out_dir / f"{claim_id}_review.html"
        html_path.write_text(
            build_review_html(claim_id, form_type, f"images/{image_dest.name}", fields,
                               spec["fields"], missing, flagged, used_thinking_fallback),
            encoding="utf-8",
        )

        shutil.move(str(path), str(processed_dir / path.name))

        status_bits = []
        if missing:
            status_bits.append(f"MISSING required fields: {', '.join(missing)}")
        if flagged:
            status_bits.append(f"flagged for review: {', '.join(flagged.keys())}")
        if status_bits:
            logger.warning("%s -> %s : extracted with %s -- review before approving",
                            path.name, claim_id, "; ".join(status_bits))
        else:
            logger.info("%s -> %s : extracted, all required fields present and nothing flagged", path.name, claim_id)

    except Exception as exc:  # noqa: BLE001 -- keep the watcher alive no matter what
        logger.exception("Failed on %s: %s", path.name, exc)
        try:
            shutil.move(str(path), str(errors_dir / path.name))
        except Exception:
            logger.exception("Could not move failed file %s into errors folder", path.name)


def run(cms1500_in, ub04_in, out_dir, model: str = "qwen3-vl:8b-instruct",
        host: str = "http://localhost:11434", poll_interval: float = 2.0,
        keep_alive="30m", max_dim: Optional[int] = None, log_file: Optional[str] = None,
        verification_passes: int = 1, check_pass_temperature: float = DEFAULT_CHECK_PASS_TEMPERATURE,
        logger=None) -> None:
    """
    Run the CMS-1500/UB-04 extraction watch loop. Blocks until interrupted.
    Pulled out of main() so billocr.py can run this alongside build_837.run()
    in one process; calling this directly is equivalent to running
    `python3 extract_claim_fields.py` with the same arguments.

    verification_passes: 1 (default) means today's exact behavior -- one
    read per image, no extra model calls. Anything higher adds that many
    resamples per image (see collect_disagreement_flags) to flag fields
    that read differently across passes -- proportionally slower per
    image in exchange for a real signal on likely misreads.
    check_pass_temperature: sampling temperature for those resamples only
    (the primary read is unaffected); see DEFAULT_CHECK_PASS_TEMPERATURE.
    """
    cms1500_in = Path(cms1500_in)
    ub04_in = Path(ub04_in)
    out_dir = Path(out_dir)

    watch_dirs = {
        "CMS1500": {
            "in_dir": cms1500_in,
            "processed_dir": cms1500_in / "_processed",
            "errors_dir": cms1500_in / "_errors",
        },
        "UB04": {
            "in_dir": ub04_in,
            "processed_dir": ub04_in / "_processed",
            "errors_dir": ub04_in / "_errors",
        },
    }
    for spec in watch_dirs.values():
        for d in (spec["in_dir"], spec["processed_dir"], spec["errors_dir"]):
            d.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    if logger is None:
        logger = build_logger("extract_claim_fields", log_file)

    if isinstance(keep_alive, str) and keep_alive.lstrip("-").isdigit():
        keep_alive = int(keep_alive)

    client = ollama.Client(host=host)

    logger.info("Watching CMS-1500 images in: %s", cms1500_in.resolve())
    logger.info("Watching UB-04 images in: %s", ub04_in.resolve())
    logger.info("Writing extracted claims to: %s", out_dir.resolve())
    logger.info("Model: %s  |  Host: %s", model, host)

    try:
        while True:
            for form_type, spec in watch_dirs.items():
                candidates = sorted(
                    p for p in spec["in_dir"].iterdir()
                    if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
                )
                for path in candidates:
                    process_one(
                        path, form_type, out_dir, spec["processed_dir"], spec["errors_dir"],
                        client, model, host, keep_alive, logger, max_dim, verification_passes,
                        check_pass_temperature,
                    )
            time.sleep(poll_interval)
    except KeyboardInterrupt:
        logger.info("Stopped by user.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract structured claim fields from CMS-1500/UB-04 images via Qwen.")
    parser.add_argument("--cms1500-in", default="incoming_1500", help="Folder to watch for CMS-1500 images (default: ./incoming_1500)")
    parser.add_argument("--ub04-in", default="incoming_ub04", help="Folder to watch for UB-04 images (default: ./incoming_ub04)")
    parser.add_argument("--out", default="pending_review", help="Folder to write extracted JSON + review HTML into (default: ./pending_review)")
    parser.add_argument("--model", default="qwen3-vl:8b-instruct", help="Ollama model tag to use (default: qwen3-vl:8b-instruct)")
    parser.add_argument("--host", default="http://localhost:11434", help="Ollama server URL")
    parser.add_argument("--poll-interval", type=float, default=2.0, help="Seconds between folder scans (default: 2.0)")
    parser.add_argument("--keep-alive", default="30m", help="See ocr_watcher.py --help for details")
    parser.add_argument("--max-dim", type=int, default=None, help="Downscale images before sending (see ocr_watcher.py --help)")
    parser.add_argument("--verification-passes", type=int, default=1,
                         help="Total reads per image (1 = off, just the primary read). Anything higher adds that "
                              "many resamples per image and flags fields that read differently across them -- "
                              "proportionally slower per image (default: 1)")
    parser.add_argument("--check-pass-temperature", type=float, default=DEFAULT_CHECK_PASS_TEMPERATURE,
                         help="Sampling temperature for verification (check) passes -- higher means more variation "
                              f"between resamples, so more (but noisier) disagreement flags (default: {DEFAULT_CHECK_PASS_TEMPERATURE}). "
                              "Has no effect if --verification-passes is 1.")
    parser.add_argument("--log-file", default=None)
    args = parser.parse_args()

    run(
        cms1500_in=args.cms1500_in, ub04_in=args.ub04_in, out_dir=args.out,
        model=args.model, host=args.host, poll_interval=args.poll_interval,
        keep_alive=args.keep_alive, max_dim=args.max_dim, log_file=args.log_file,
        verification_passes=args.verification_passes, check_pass_temperature=args.check_pass_temperature,
    )


if __name__ == "__main__":
    main()
