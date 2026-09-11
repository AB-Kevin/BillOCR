"""
Shared helpers used by ocr_watcher.py, extract_claim_fields.py, and
build_837.py: folder-watching primitives, image handling, and logging.
Kept in one place so the three scripts behave consistently.
"""

import io
import logging
import re
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}
PDF_EXTENSIONS = {".pdf"}

_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_NO_SEPARATOR_DATE_RE = re.compile(r"^\d{6}(\d{2})?$")  # MMDDYY or MMDDYYYY


def _try_strptime(text: str, fmt: str) -> Optional[str]:
    try:
        return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
    except ValueError:
        return None  # e.g. "13/40/2024" -- not a real date; leave it for is_sane_date to flag


def normalize_date(value: Any) -> Any:
    """
    Convert a date the model transcribed "exactly as printed" (see
    claim_schemas.py) into ISO YYYY-MM-DD, deterministically -- no model
    involved, so there's nothing left to swap month and day.

    CMS-1500/UB-04 print a date as three separate boxes (month, day, year);
    what, if anything, visually divides them on a given form or scan varies
    -- "/", "-", ".", one or more spaces, or nothing at all -- and the model
    was told to transcribe exactly what's printed rather than normalize it
    itself, so this has to tolerate whatever that turns out to be rather
    than a fixed list of separators. Digits-only (no separator at all) is
    handled as its own fixed-width case since there's no separator to split
    on; anything else is split on whatever run of non-digit characters
    actually separates the three parts.

    Returns the value unchanged if it's not a string, already looks like
    ISO (a hand-edited Review field, or a model that ignored the "exactly
    as printed" instruction anyway), empty, or doesn't resolve to a real
    date -- in every one of those "leave it alone" cases, whatever comes
    out still gets a fair shot at field_validation.is_sane_date(), so a
    genuinely garbled date is still flagged rather than silently guessed at.
    """
    if not isinstance(value, str):
        return value
    text = value.strip()
    if not text or _ISO_DATE_RE.match(text):
        return value

    if _NO_SEPARATOR_DATE_RE.match(text):
        fmt = "%m%d%Y" if len(text) == 8 else "%m%d%y"
        return _try_strptime(text, fmt) or value

    parts = [p for p in re.split(r"\D+", text) if p]
    if len(parts) == 3:
        month, day, year = parts
        if len(month) <= 2 and len(day) <= 2 and len(year) in (2, 4):
            fmt = "%m %d %Y" if len(year) == 4 else "%m %d %y"
            result = _try_strptime(f"{month} {day} {year}", fmt)
            if result:
                return result
    return value


def normalize_claim_dates(fields: dict, date_fields: list, line_date_fields: dict) -> dict:
    """
    Apply normalize_date() to every known date field on an extracted claim,
    in place -- both top-level fields (date_fields, a list of keys) and
    fields nested one per line item (line_date_fields, {list_field_key:
    [date_key, ...]}, e.g. {"service_lines": ["date_from", "date_to"]}).
    Returns fields for convenience. See claim_schemas.py's *_DATE_FIELDS/
    *_LINE_DATE_FIELDS for the CMS-1500/UB-04 field lists.
    """
    for key in date_fields:
        if key in fields:
            fields[key] = normalize_date(fields[key])
    for lines_key, sub_keys in (line_date_fields or {}).items():
        lines = fields.get(lines_key)
        if isinstance(lines, list):
            for line in lines:
                if isinstance(line, dict):
                    for sub_key in sub_keys:
                        if sub_key in line:
                            line[sub_key] = normalize_date(line[sub_key])
    return fields


_NON_DIGIT_RE = re.compile(r"[^0-9]")


def _digits_only(raw: Any) -> str:
    return "" if raw is None else _NON_DIGIT_RE.sub("", str(raw))


def normalize_phone(value: Any) -> Any:
    """
    Strip a phone number the model transcribed "exactly as printed" (see
    claim_schemas.py) down to plain digits, deterministically.

    CMS-1500/UB-04 print each phone box as "( ___ ) ___-____", with the
    parentheses drawn as part of the box's own artwork right where the area
    code goes -- not something the biller wrote. A model told to transcribe
    exactly what it sees in that box can end up copying those printed
    parens (and whatever stray spacing happens to fall inside/around them)
    as if they were part of the number, the same way normalize_date() exists
    because "transcribe and reformat" is where dates go wrong. Stripping to
    digits-only here — rather than leaving formatting to a downstream
    consumer that has to first guess whether a "(" is data or form artwork —
    also means two verification passes that only differ in that kind of
    cosmetic punctuation/spacing compare equal instead of registering as a
    disagreement (see collect_disagreement_flags).

    A leading "1" is dropped when the result is 11 digits (a fully-dialed
    US number with the country code), leaving a plain 10-digit number.
    Anything else (too short, too long, empty) is returned as whatever
    digits were found, unmodified further -- display formatting happens at
    render time (Review, the 837 viewer), same as normalize_date leaves
    presentation to its own callers.

    Returns the value unchanged if it's not a string.
    """
    if not isinstance(value, str):
        return value
    if value.strip() == "":
        return value
    digits = _digits_only(value)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits


def normalize_claim_phones(fields: dict, phone_fields: list) -> dict:
    """
    Apply normalize_phone() to every known phone field on an extracted
    claim, in place -- mirrors normalize_claim_dates() above. See
    claim_schemas.py's *_PHONE_FIELDS for the CMS-1500/UB-04 field lists.
    """
    for key in phone_fields:
        if key in fields:
            fields[key] = normalize_phone(fields[key])
    return fields


def combine_money(dollars_raw: Any, cents_raw: Any) -> Optional[float]:
    """
    Combine a charge amount that was extracted as two separate raw reads --
    one per box on the form (see claim_schemas.py's *_MONEY_FIELDS/
    *_LINE_MONEY_FIELDS) -- into a single decimal amount, deterministically.

    CMS-1500/UB-04 print every charge as dollars and cents in two boxes
    divided by a line, a wider box for whole dollars and a narrower box for
    cents. Asking the model to combine those into one decimal itself (as
    the extraction prompt used to) reliably fails in two directions: it
    sometimes drops the cents box entirely, and it sometimes concatenates
    both boxes' digits into one whole number (a $150.00 charge -- "150" and
    "00" -- coming back as 15000 instead of 150.00). Same root cause as the
    date-swapping bug normalize_date() exists for: asking a vision model to
    both transcribe *and* reformat/combine what it sees is where it goes
    wrong, not the transcription itself. So the model is now asked to
    transcribe each box's digits on their own (no arithmetic, no decimal
    point to place), and the combination happens here instead, where it
    can't go wrong.

    Tolerates stray non-digit characters in either box's raw read (a "$",
    a comma, whitespace) and a cents box read as fewer than 2 digits
    (assumed to be missing a leading zero, e.g. "5" meaning "05"). Also
    tolerant of a model that ignored the split and put a complete decimal
    amount straight into the dollars slot anyway (honored as-is rather
    than mangled further by appending a cents part on top of it).

    Returns None if both boxes came back empty/missing -- the field simply
    wasn't present/legible on the form, same as any other null field.
    """
    if (dollars_raw in (None, "")) and (cents_raw in (None, "")):
        return None
    if isinstance(dollars_raw, (int, float)) and not isinstance(dollars_raw, bool):
        return round(float(dollars_raw), 2)
    dollars_text = "" if dollars_raw is None else str(dollars_raw).strip()
    if re.match(r"^-?\d+\.\d{1,2}$", dollars_text):
        try:
            return round(float(dollars_text), 2)
        except ValueError:
            pass  # fall through to the digit-combining path below

    dollars_digits = _digits_only(dollars_raw) or "0"
    cents_digits = _digits_only(cents_raw)[:2].zfill(2) if _digits_only(cents_raw) else "00"
    try:
        return round(float(f"{dollars_digits}.{cents_digits}"), 2)
    except ValueError:
        return None


def combine_claim_money(fields: dict, money_fields: list, line_money_fields: dict) -> dict:
    """
    Apply combine_money() to every known split money field on an extracted
    claim, in place -- mirrors normalize_claim_dates() above. For each base
    name in money_fields (top-level, e.g. "total_charge") or
    line_money_fields ({list_field_key: [base_name, ...]}, e.g.
    {"service_lines": ["charge_amount"]}), reads "<base>_dollars"/
    "<base>_cents" out of the raw model output and replaces them with a
    single "<base>" key holding the combined decimal -- both raw keys are
    removed once combined, so the rest of the pipeline (field_validation.py,
    x12_837.py, Review's edit form) only ever sees the one field name it
    already expects. See claim_schemas.py's *_MONEY_FIELDS/
    *_LINE_MONEY_FIELDS for the CMS-1500/UB-04 field lists.
    """
    for base in money_fields:
        dollars_key, cents_key = f"{base}_dollars", f"{base}_cents"
        if dollars_key in fields or cents_key in fields:
            fields[base] = combine_money(fields.pop(dollars_key, None), fields.pop(cents_key, None))
    for lines_key, bases in (line_money_fields or {}).items():
        lines = fields.get(lines_key)
        if isinstance(lines, list):
            for line in lines:
                if not isinstance(line, dict):
                    continue
                for base in bases:
                    dollars_key, cents_key = f"{base}_dollars", f"{base}_cents"
                    if dollars_key in line or cents_key in line:
                        line[base] = combine_money(line.pop(dollars_key, None), line.pop(cents_key, None))
    return fields


def wait_until_stable(path: Path, checks: int = 3, interval: float = 0.5, max_wait: float = 30.0) -> bool:
    """
    Wait until a file's size stops changing between checks, so we don't
    read a file that a scanner or sync tool is still writing to.
    Returns False if the file disappeared or never stabilized in time.
    """
    last_size = -1
    stable_count = 0
    elapsed = 0.0
    while elapsed < max_wait:
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            return False
        if size == last_size and size > 0:
            stable_count += 1
            if stable_count >= checks:
                return True
        else:
            stable_count = 0
            last_size = size
        time.sleep(interval)
        elapsed += interval
    return False


def convert_pdf_to_images(pdf_path: Path, dpi: int = 200) -> list[Path]:
    """
    Render every page of a PDF to its own PNG, written next to the PDF as
    "<stem>_p<N>_<random>.png" (page order preserved; the random suffix just
    avoids colliding with a previous conversion of a same-named file).
    Returns the created paths in page order.

    Used by extract_claim_fields.py so a dropped PDF is expanded into plain
    images *before* anything else sees it -- the rest of the pipeline (one
    image = one claim) is otherwise unchanged. A multi-page PDF therefore
    becomes one claim per page, which is the right behavior for a scanned/
    faxed batch of claim forms saved as a single PDF.

    Uses pypdfium2 (Chromium's PDF renderer) rather than the more common
    pdf2image, because pypdfium2 ships as a self-contained wheel -- no
    Poppler (or any other external binary) needs to be installed on the
    OCR machine.
    """
    try:
        import pypdfium2 as pdfium
    except ImportError:
        sys.exit(
            "The 'pypdfium2' package is required to process PDF files. Install it with:\n"
            "    pip install pypdfium2"
        )

    scale = dpi / 72  # PDF page geometry is in 72-dpi points
    out_paths = []
    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        for i, page in enumerate(pdf):
            bitmap = page.render(scale=scale)
            out_path = pdf_path.with_name(f"{pdf_path.stem}_p{i + 1}_{uuid.uuid4().hex[:6]}.png")
            bitmap.to_pil().save(out_path, format="PNG")
            out_paths.append(out_path)
    finally:
        pdf.close()
    return out_paths


def load_image_payload(image_path: Path, max_dim: Optional[int]):
    """
    Return what to hand Ollama for this image: the original file path if no
    resizing is requested (or the image is already small), otherwise resized
    PNG bytes.
    """
    if not max_dim:
        return str(image_path)
    try:
        from PIL import Image
    except ImportError:
        sys.exit(
            "The 'Pillow' package is required for --max-dim resizing. Install it with:\n"
            "    pip install Pillow"
        )

    with Image.open(image_path) as img:
        img = img.convert("RGB")
        width, height = img.size
        longest_side = max(width, height)
        if longest_side <= max_dim:
            return str(image_path)
        scale = max_dim / longest_side
        resized = img.resize((int(width * scale), int(height * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        resized.save(buf, format="PNG")
        return buf.getvalue()


def build_logger(name: str, log_file: Optional[str]) -> logging.Logger:
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%Y-%m-%d %H:%M:%S")

    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(fmt)
    logger.addHandler(stream)

    if log_file:
        file_handler = logging.FileHandler(log_file, encoding="utf-8")
        file_handler.setFormatter(fmt)
        logger.addHandler(file_handler)

    return logger


def chat_with_thinking_fallback(client, model: str, messages: list, keep_alive, response_format: Optional[str] = None,
                                 options: Optional[dict] = None):
    """
    Call Ollama chat() and return (content, used_thinking_fallback).
    Some Qwen3-VL builds route the answer entirely into `message.thinking`
    instead of `message.content` when an image is attached, even with
    think=False (ollama/ollama#14716). This recovers from that rather than
    silently returning empty text -- see the README for the permanent fix
    (an "-instruct" tagged model).

    Pass format="json" to ask Ollama to constrain output to valid JSON
    syntax (supported by the /api/chat "format" parameter) -- useful for
    the claim field extractor, irrelevant for plain transcription.

    Pass options={"temperature": ...} etc. to override Ollama's default
    sampling for this call -- used by extract_claim_fields.py's
    verification passes, which want higher-temperature resamples of the
    same image to check against the (default-temperature) primary read.
    """
    kwargs = dict(model=model, messages=messages, keep_alive=keep_alive, think=False)
    if response_format:
        kwargs["format"] = response_format
    if options:
        kwargs["options"] = options
    response = client.chat(**kwargs)
    message = response.get("message", {}) or {}
    content = (message.get("content") or "").strip()
    if content:
        return content, False
    thinking = (message.get("thinking") or "").strip()
    return thinking, bool(thinking)
