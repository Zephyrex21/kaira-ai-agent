"""
Screenshot capture: take and save screenshots.

  takeScreenshot -> capture full screen, return metadata (+ small base64)
  saveScreenshot -> capture & write to a file under the Screenshots folder

OCR (analyzeScreenshot / readScreen) was removed (2026-08-19) — it
overlapped with the live multimodal screen-vision stream (real-time frames
while screen-share is on) and pulled in the pytesseract + Tesseract-engine
dependency for a rarely-used path. Plain capture stays since it's cheap and
still useful on its own.
"""

from __future__ import annotations

import base64
import io
import os
import time
from pathlib import Path
from typing import Any, Dict

from .registry import ToolError, register

SCREENSHOTS_DIR = Path(os.path.expanduser("~")) / "Pictures" / "KairaScreenshots"


def _capture() -> "Any":
    """Capture the full virtual screen as a PIL Image."""
    try:
        from PIL import ImageGrab

        img = ImageGrab.grab(all_screens=True)
        return img
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Screen capture failed: {e}")


def _image_to_b64(img, fmt="PNG", quality=70) -> str:
    buf = io.BytesIO()
    if fmt.upper() == "JPEG":
        img.convert("RGB").save(buf, format="JPEG", quality=quality)
    else:
        img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode("ascii")


@register("takeScreenshot")
def take_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    img = _capture()
    include_image = bool(args.get("include_image", False))
    result: Dict[str, Any] = {
        "result": f"Captured screen ({img.width}x{img.height}).",
        "width": img.width,
        "height": img.height,
    }
    if include_image:
        # Downscale + JPEG to keep payload small for the WS bridge.
        max_dim = int(args.get("max_dim", 1280))
        if max(img.size) > max_dim:
            ratio = max_dim / max(img.size)
            img_small = img.resize(
                (max(1, int(img.width * ratio)), max(1, int(img.height * ratio)))
            )
        else:
            img_small = img
        result["image_base64"] = _image_to_b64(img_small, fmt="JPEG", quality=60)
        result["image_mime"] = "image/jpeg"
    return result


@register("saveScreenshot")
def save_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    img = _capture()
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = args.get("name")
    fname = f"{name}-{stamp}.png" if name else f"screenshot-{stamp}.png"
    out_path = SCREENSHOTS_DIR / fname
    img.save(out_path, format="PNG")
    return {"result": f"Saved screenshot to {out_path}.", "path": str(out_path)}


__all__ = ["take_screenshot", "save_screenshot"]
