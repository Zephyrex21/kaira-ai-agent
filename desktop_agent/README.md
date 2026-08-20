# KAIRA Desktop Control Agent

A local Python FastAPI service that gives KAIRA **JARVIS-style desktop control** —
open apps, manage files, control volume, take screenshots, adjust brightness, and more.

> **This agent does NOT modify KAIRA's UI, personality, or chat system.** It is a pure
> backend tool layer that KAIRA's existing Node bridge (`server.ts`) calls over HTTP.
>
> **Trimmed 2026-08-19** to cut voice-response latency: the Playwright desktop-browser
> suite, coding assistance, system/GPU/temperature info, clipboard control, and
> screenshot OCR were removed as unused-by-voice bulk (79 → 50 tools declared to
> Gemini overall). Auto-start is still here as a backend-only handler — it's no
> longer offered to Gemini, but the Settings panel's "Start with Windows" toggle
> still calls it directly over HTTP.

---

## Prerequisites

| Dependency | Why | Notes |
|---|---|---|
| **Python 3.11+** | Runtime | Use the full interpreter path, e.g. `C:\Users\MSI\AppData\Local\Programs\Python\Python311\python.exe` |
| **pip** | Install Python packages | Ships with Python |

---

## Setup (one-time)

```bash
# 1. Navigate to the project root
cd C:\Users\MSI\Desktop\kaira-ai-assistant

# 2. Install Python dependencies (use the full interpreter path if `python` shim is broken)
"C:\Users\MSI\AppData\Local\Programs\Python\Python311\python.exe" -m pip install -r desktop_agent/requirements.txt
```

---

## Run

```bash
# Start the desktop agent on port 8765
"C:\Users\MSI\AppData\Local\Programs\Python\Python311\python.exe" -m desktop_agent.main

# Or with uvicorn directly:
"C:\Users\MSI\AppData\Local\Programs\Python\Python311\python.exe" -m uvicorn desktop_agent.main:app --host 127.0.0.1 --port 8765
```

The agent binds to `127.0.0.1:8765`. Then start KAIRA normally with `npm run dev`.

---

## API

### `GET /health`
Returns `{ status: "ok", tools: [...], tool_count: N }`.

### `GET /tools`
Returns the list of registered tool names.

### `POST /execute`
```json
{ "tool": "openApplication", "args": { "name": "notepad" } }
```
Returns:
```json
{ "ok": true, "result": { "result": "Notepad opened." }, "tool": "openApplication" }
```
On error:
```json
{ "ok": false, "error": "File does not exist: ...", "tool": "readFile" }
```

---

## Available Tools

### 🖥️ Applications
| Tool | Description |
|---|---|
| `openApplication` | Open Notepad, Chrome, VS Code, Calculator, Explorer, Task Manager, Settings, etc. |
| `closeApplication` | Close a running application by name |

### 🌐 Websites & Search
| Tool | Description |
|---|---|
| `openWebsite` | Open a named site (YouTube, Gmail, GitHub…) or arbitrary URL in the default browser |
| `searchWeb` | Search any engine via `engine` param (Google, YouTube, GitHub, DuckDuckGo, Bing) |

### 📁 Files
| Tool | Description |
|---|---|
| `createFile` | Create a text file with content |
| `readFile` | Read a file's contents |
| `renameFile` | Rename a file |
| `deleteFile` | Delete a file (sends to Recycle Bin by default) |
| `moveFile` | Move a file to a new location |
| `openFolder` | Open Desktop, Documents, Downloads, etc. in Explorer |
| `listFiles` | List files in a folder |
| `searchFiles` | Find files by name/extension (e.g. "find my Python files") |

### 🎛️ PC Control
| Tool | Description |
|---|---|
| `volumeUp` | Increase volume |
| `volumeDown` | Decrease volume |
| `setVolume` | Set volume to a specific percentage |
| `muteToggle` | Toggle mute/unmute |
| `requestPowerAction` | **Step 1**: Request confirmation token for shutdown/restart/sleep/lock |
| `executePowerAction` | **Step 2**: Execute the power action with a valid token |

### 🪟 Window Management
| Tool | Description |
|---|---|
| `minimizeWindow` | Minimize active or named window |
| `maximizeWindow` | Maximize active or named window |
| `closeWindow` | Close active or named window |
| `switchApplication` | Switch to a named window, or Alt+Tab cycle |

### 📸 Screenshot
| Tool | Description |
|---|---|
| `takeScreenshot` | Capture the full screen |
| `saveScreenshot` | Save screenshot to Pictures/KairaScreenshots |

OCR (`analyzeScreenshot` / `readScreen`) was removed — it overlapped with
Kaira's live multimodal screen vision (real-time frames while screen-share is
on), which covers the same "what's on my screen" use case without a separate
capture-then-OCR round trip.

### 🔆 Brightness
| Tool | Description |
|---|---|
| `brightnessUp` | Increase screen brightness by a step |
| `brightnessDown` | Decrease screen brightness by a step |
| `setBrightness` | Set brightness to an exact percentage |

### 🚀 Auto-start (backend-only, not a voice tool)
| Tool | Description |
|---|---|
| `enableAutoStart` | Add a Windows Run-key entry so KAIRA launches at login |
| `disableAutoStart` | Remove that Run-key entry |
| `getAutoStartStatus` | Check whether the entry currently exists |

Not declared to Gemini (removed 2026-08-19 to cut prompt bulk — Kaira never
needed it via voice). Still registered and callable: the Settings panel's
"Start with Windows" toggle calls it directly over HTTP.

---

## Removed (2026-08-19)

To cut response latency, these tool families were removed outright along
with their handler modules and dependencies:

- **Playwright desktop-browser automation** (`desktopBrowser*`) — real
  Chromium control (click/type/fill forms/tabs). Distinct from the in-app
  holographic browser console (`browser*`), which is untouched.
- **Coding assistance** (`createPythonFile`, `writeCodeFile`,
  `createProjectFolder`, `runPythonScript`)
- **System/GPU/temperature info** (`systemInfo`, `gpuInfo`,
  `temperatureInfo`)
- **Clipboard control** (`copySelected`, `pasteClipboard`, `getClipboard`,
  `clearClipboard`)
- **Screenshot OCR** (`analyzeScreenshot`, `readScreen`) — plain
  `takeScreenshot` / `saveScreenshot` remain
- **`searchYouTube` / `searchGoogle` / `searchGitHub`** — redundant with
  `searchWeb(engine=...)`, which already covers all four engines

---

## Safety

- **Power actions** (shutdown, restart, sleep, lock) require a **two-step confirmation token**: KAIRA must first call `requestPowerAction` (which issues a single-use, 60-second token), ask the user out loud to confirm, then call `executePowerAction` with the token. Without a valid token, the action is refused.
- **File deletions** go to the Recycle Bin by default (`send2trash`).
- **File operations** are scoped to safe folders (Desktop, Documents, Downloads, Pictures, Music, Videos, home, project root). Paths outside these roots are rejected.

---

## Architecture

```
KAIRA voice chat (existing, untouched)
        ↓
Gemini Live API (existing)
        ↓
server.ts — functionCall routing
        ↓
HTTP POST → localhost:8765/execute
        ↓
Python FastAPI desktop_agent
        ↓
pyautogui / pywin32 / pycaw / etc.
        ↓
Windows Desktop
```
