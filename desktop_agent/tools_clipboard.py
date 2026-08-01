"""
Clipboard control: copy / paste / read / clear.

copy_selected  -> sends Ctrl+C to whatever has focus, then reads the clipboard.
paste_clipboard-> writes `text` to the clipboard, then sends Ctrl+V.
get_clipboard  -> returns the current clipboard text.
clear_clipboard-> empties the clipboard.

pyperclip is the backend; copy/paste keystrokes use pyautogui when available.
"""

from __future__ import annotations

import time
from typing import Any, Dict

from .registry import ToolError, register


def _press_copy() -> None:
    try:
        import pyautogui

        pyautogui.hotkey("ctrl", "c")
        return
    except Exception:
        pass
    # Fallback to Windows keybd_event
    try:
        import ctypes

        VK_CONTROL = 0x11
        VK_C = 0x43
        KEYEVENTF_KEYUP = 0x0002
        u32 = ctypes.windll.user32
        u32.keybd_event(VK_CONTROL, 0, 0, 0)
        u32.keybd_event(VK_C, 0, 0, 0)
        time.sleep(0.03)
        u32.keybd_event(VK_C, 0, KEYEVENTF_KEYUP, 0)
        u32.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)
    except Exception:
        raise ToolError("Could not send copy keystroke.")


def _press_paste() -> None:
    try:
        import pyautogui

        pyautogui.hotkey("ctrl", "v")
        return
    except Exception:
        pass
    try:
        import ctypes

        VK_CONTROL = 0x11
        VK_V = 0x56
        KEYEVENTF_KEYUP = 0x0002
        u32 = ctypes.windll.user32
        u32.keybd_event(VK_CONTROL, 0, 0, 0)
        u32.keybd_event(VK_V, 0, 0, 0)
        time.sleep(0.03)
        u32.keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0)
        u32.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)
    except Exception:
        raise ToolError("Could not send paste keystroke.")


def _read_clipboard() -> str:
    try:
        import pyperclip

        return pyperclip.paste() or ""
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not read clipboard: {e}")


def _write_clipboard(text: str) -> None:
    try:
        import pyperclip

        pyperclip.copy(text)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not write clipboard: {e}")


@register("copySelected")
def copy_selected(args: Dict[str, Any]) -> Dict[str, Any]:
    _press_copy()
    # Clipboard is asynchronous; give it a beat.
    time.sleep(float(args.get("wait", 0.35)))
    text = _read_clipboard()
    if not text:
        return {"result": "Sent copy, but the clipboard is empty."}
    preview = text if len(text) <= 200 else text[:200] + "…"
    return {"result": f"Copied {len(text)} characters.", "text": preview, "full_length": len(text)}


@register("pasteClipboard")
def paste_clipboard(args: Dict[str, Any]) -> Dict[str, Any]:
    text = args.get("text")
    if text is None:
        # Paste whatever is already on the clipboard.
        _press_paste()
        return {"result": "Pasted the current clipboard contents."}
    _write_clipboard(str(text))
    time.sleep(0.1)
    _press_paste()
    preview = str(text) if len(str(text)) <= 200 else str(text)[:200] + "…"
    return {"result": f"Pasted text ({len(str(text))} chars).", "text": preview}


@register("getClipboard")
def get_clipboard(args: Dict[str, Any]) -> Dict[str, Any]:
    text = _read_clipboard()
    max_chars = int(args.get("max_chars", 1000))
    if len(text) > max_chars:
        text = text[:max_chars] + "…"
    return {"result": "Clipboard read.", "text": text, "length": len(text)}


@register("clearClipboard")
def clear_clipboard(args: Dict[str, Any]) -> Dict[str, Any]:
    _write_clipboard("")
    return {"result": "Clipboard cleared."}


__all__ = ["copy_selected", "paste_clipboard", "get_clipboard", "clear_clipboard"]
