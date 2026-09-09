"""
Shared helpers used by ocr_watcher.py, extract_claim_fields.py, and
build_837.py: folder-watching primitives, image handling, and logging.
Kept in one place so the three scripts behave consistently.
"""

import io
import logging
import sys
import time
from pathlib import Path
from typing import Optional

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}


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
