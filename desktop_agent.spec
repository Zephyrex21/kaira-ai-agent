# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the KAIRA Desktop Control Agent.

Produces a self-contained onedir bundle (myraa-agent/myraa-agent.exe) with an
embedded Python runtime — the target machine needs no Python installed.

Notes:
- registry.load_all() imports the tool modules dynamically (importlib), so each
  must be listed as a hiddenimport or PyInstaller will not bundle it.
- pywin32 / pycaw / comtypes have runtime-only submodules that also need to be
  declared explicitly.
- Trimmed 2026-08-19: tools_clipboard, tools_browser (Playwright), tools_coding,
  and tools_system were deleted outright (unused-by-voice bulk), so their
  hiddenimports and packages (pyperclip, psutil, playwright, pytesseract,
  nvidia-ml-py3) are gone too. tools_startup is still bundled — it's no longer
  offered to Gemini as a voice tool, but the Settings-panel auto-start toggle
  still calls it directly.
- console=False → the agent runs with no console window (silent background).
"""

from PyInstaller.utils.hooks import collect_submodules

hiddenimports = []

# Dynamically-imported agent tool modules (importlib in registry.load_all).
hiddenimports += [
    "desktop_agent",
    "desktop_agent.main",
    "desktop_agent.registry",
    "desktop_agent.tools_confirmation",
    "desktop_agent.tools_applications",
    "desktop_agent.tools_websites",
    "desktop_agent.tools_search",
    "desktop_agent.tools_files",
    "desktop_agent.tools_pc",
    "desktop_agent.tools_windows",
    "desktop_agent.tools_screenshot",
    "desktop_agent.tools_startup",
]

# Web stack — uvicorn pulls its loop/protocol/lifespan submodules dynamically.
hiddenimports += collect_submodules("uvicorn")
hiddenimports += ["anyio", "click", "h11", "fastapi", "starlette", "pydantic"]

# Windows automation / audio / screen libraries with dynamic submodules.
hiddenimports += collect_submodules("pycaw")
hiddenimports += [
    "comtypes",
    "comtypes.stream",
    "win32api",
    "win32con",
    "win32gui",
    "win32process",
    "win32timezone",
    "pythoncom",
    "pywintypes",
    "pyautogui",
    "pygetwindow",
    "PIL",
    "PIL.Image",
]

# Optional (graceful if unavailable at runtime).
for opt in ("send2trash",):
    try:
        hiddenimports.append(opt)
    except Exception:
        pass

a = Analysis(
    ["run_agent.py"],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter",
        # Headless server — no GUI toolkits. pyautogui's helper libs (mouseinfo,
        # pymsgbox) can pull in Qt bindings, and mixing PyQt5+PyQt6 aborts the
        # build. None are needed at runtime.
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        "matplotlib",
        "IPython",
        "notebook",
        # Heavy scientific / ML stack present in the global env but never used by
        # the agent (confirmed: no desktop_agent module imports these). Excluding
        # them cuts the bundle from ~846MB to well under 100MB. pyscreeze uses
        # cv2/numpy only optionally and falls back cleanly without them.
        "torch",
        "torchvision",
        "torchaudio",
        "cv2",
        "numpy",
        "scipy",
        "pandas",
        "onnxruntime",
        "llvmlite",
        "numba",
        "sympy",
        "sklearn",
        "scikit-learn",
        "tensorflow",
        "transformers",
        "lxml",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="myraa-agent",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="myraa-agent",
)
