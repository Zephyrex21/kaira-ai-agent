"""
KAIRA Desktop Control Agent — Central tool registry.

Each tool module registers handlers into a flat dict `TOOLS` mapping
tool_name -> callable(args: dict) -> dict.

Handlers return a plain dict, typically {"result": "<status string>"}.
Errors should raise ToolError(message) so main.py can map them to {error}.
Shared singletons (Playwright browser/page, confirmation store, etc.) live
on the `State` object so handlers stay stateless and easy to test.
"""

from __future__ import annotations

import importlib
import threading
from typing import Any, Callable, Dict


class ToolError(Exception):
    """Raised by a tool handler to signal a clean, user-facing failure."""

    def __init__(self, message: str, *, fatal: bool = False):
        super().__init__(message)
        self.message = message
        self.fatal = fatal


class State:
    """Process-wide shared state for tool handlers."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        # Confirmation tokens for dangerous (power) actions.
        # token -> {"action": <tool_name>, "expires": <epoch>}
        self.confirmations: Dict[str, Dict[str, Any]] = {}
        # Playwright singletons — lazily initialized on first browser tool use.
        self.playwright = None
        self.browser = None
        self.context = None
        self.page = None

    def reset_playwright(self) -> None:
        """Tear down any cached Playwright resources (used on errors)."""
        try:
            if self.page is not None:
                self.page = None
            if self.context is not None:
                self.context = None
            if self.browser is not None:
                self.browser = None
            if self.playwright is not None:
                self.playwright = None
        except Exception:
            pass


STATE = State()

# tool_name -> handler(args: dict) -> dict
TOOLS: Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]] = {}


def register(name: str):
    """Decorator to register a handler under a tool name."""

    def deco(fn: Callable[[Dict[str, Any]], Dict[str, Any]]):
        TOOLS[name] = fn
        return fn

    return deco


# The set of all tool names KAIRA may route to this agent.
# Kept in sync with the functionDeclarations added in server.ts.
#
# Trimmed (2026-08-19) to cut response latency: removed the Playwright
# desktop-browser suite, coding assistance, system/GPU/temperature info,
# clipboard control, Windows auto-start, and the OCR screenshot tools
# (analyzeScreenshot/readScreen) as unused-by-voice bulk. Their handler
# modules were deleted outright rather than left dead. searchYouTube/
# searchGoogle/searchGitHub were also dropped since searchWeb(engine=...)
# already covers them.
DESKTOP_TOOL_NAMES = [
    # applications / websites / search
    "openApplication",
    "closeApplication",
    "openWebsite",
    "searchWeb",
    # files
    "createFile",
    "readFile",
    "renameFile",
    "deleteFile",
    "moveFile",
    "openFolder",
    "listFiles",
    "searchFiles",
    # pc control (volume + gated power)
    "volumeUp",
    "volumeDown",
    "muteToggle",
    "setVolume",
    "requestPowerAction",  # first step: issues a confirmation token
    "executePowerAction",  # second step: runs the gated action
    # windows
    "minimizeWindow",
    "maximizeWindow",
    "closeWindow",
    "switchApplication",
    # screenshot (basic capture only — OCR tools removed)
    "takeScreenshot",
    "saveScreenshot",
    # brightness control (V2)
    "brightnessUp",
    "brightnessDown",
    "setBrightness",
]


# --- Eagerly import all tool modules so their @register decorators run. ---
# Each module is imported defensively: a hard import failure here would make
# the whole agent unstartable, which we want to avoid. The modules themselves
# keep optional-dependency imports lazy/try-except.
_MODULE_NAMES = [
    "tools_confirmation",
    "tools_applications",
    "tools_websites",
    "tools_search",
    "tools_files",
    "tools_pc",
    "tools_windows",
    "tools_screenshot",
    # tools_startup is kept registered (not deleted) even though its tools
    # are no longer in DESKTOP_TOOL_NAMES / offered to Gemini — the Settings
    # panel's "Start with Windows" toggle calls enableAutoStart/
    # disableAutoStart directly via callDesktopAgent(), bypassing the model
    # entirely, so the handler still needs to exist and be registered.
    "tools_startup",
]


def load_all() -> None:
    for mod_name in _MODULE_NAMES:
        importlib.import_module(f".{mod_name}", package="desktop_agent")


__all__ = ["TOOLS", "STATE", "DESKTOP_TOOL_NAMES", "ToolError", "register", "load_all"]
