import path from "path";
import * as fs from "fs";
import { spawn, execSync } from "child_process";

/**
 * KAIRA Desktop Control Agent — HTTP bridge to the Python FastAPI backend.
 * Extracted from server.ts so the spawn/health/execute logic can be read and
 * tested on its own, separate from the WS session and tool-dispatch code.
 */

export const DESKTOP_AGENT_URL = process.env.DESKTOP_AGENT_URL || "http://127.0.0.1:8765";
const DESKTOP_AGENT_TIMEOUT = 25_000; // ms

/**
 * The complete set of tool names routed to the Python desktop agent.
 * Kept in sync with desktop_agent/registry.py DESKTOP_TOOL_NAMES.
 */
export const DESKTOP_TOOLS: ReadonlySet<string> = new Set([
  // applications / websites / search
  "openApplication", "closeApplication", "openWebsite",
  "searchWeb", "searchYouTube", "searchGoogle", "searchGitHub",
  // files
  "createFile", "readFile", "renameFile", "deleteFile", "moveFile",
  "openFolder", "listFiles", "searchFiles",
  // pc control (volume + gated power)
  "volumeUp", "volumeDown", "muteToggle", "setVolume",
  "requestPowerAction", "executePowerAction",
  // windows
  "minimizeWindow", "maximizeWindow", "closeWindow", "switchApplication",
  // clipboard
  "copySelected", "pasteClipboard", "getClipboard", "clearClipboard",
  // screenshot / screen reading
  "takeScreenshot", "saveScreenshot", "analyzeScreenshot", "readScreen",
  // browser automation (Playwright — desktop-owned, separate from holographic UI)
  "desktopBrowserOpen", "desktopBrowserNavigate", "desktopBrowserOpenTab",
  "desktopBrowserCloseTab", "desktopBrowserSearch", "desktopBrowserClick",
  "desktopBrowserType", "desktopBrowserFillForm", "desktopBrowserGoBack",
  "desktopBrowserGoForward", "desktopBrowserScroll",
  // coding assistance
  "createPythonFile", "runPythonScript", "createProjectFolder", "writeCodeFile",
  // system information
  "systemInfo", "gpuInfo", "temperatureInfo",
  // brightness control (V2)
  "brightnessUp", "brightnessDown", "setBrightness",
  // Windows auto-start management (V2)
  "enableAutoStart", "disableAutoStart", "getAutoStartStatus",
]);

/**
 * Whether the desktop agent has been confirmed alive in this process lifetime.
 * If false, callDesktopAgent will probe /health and attempt an auto-spawn.
 */
let desktopAgentVerified = false;

/**
 * An in-flight ensureDesktopAgent() attempt, if one is running. Concurrent
 * callers (e.g. the boot-time check and a tool call arriving moments later)
 * await this same attempt instead of each spawning their own competing
 * process on the same port — which is what was causing the agent to never
 * come online: multiple uvicorn instances fighting over :8765, none of them
 * starting cleanly.
 */
let inFlightEnsure: Promise<void> | null = null;

// Injected logging hooks so this module doesn't need to know about the log
// file layout — server.ts wires its appendLog-based loggers in via this.
type Logger = (message: string) => void;
let logStartup: Logger = () => {};
let logError: Logger = () => {};
let logCommand: Logger = () => {};
export function setDesktopAgentLoggers(hooks: { logStartup?: Logger; logError?: Logger; logCommand?: Logger }): void {
  if (hooks.logStartup) logStartup = hooks.logStartup;
  if (hooks.logError) logError = hooks.logError;
  if (hooks.logCommand) logCommand = hooks.logCommand;
}

/**
 * Auto-spawn the Python desktop agent as a detached child process if it is not
 * already listening. Looks for the project's bundled Python interpreter first,
 * falling back to `python` / `python3` on PATH. Runs detached so it survives
 * even if KAIRA's node process is killed.
 */
function spawnDesktopAgent(): void {
  const agentEnv = {
    ...process.env,
    KAIRA_AGENT_HOST: "127.0.0.1",
    KAIRA_AGENT_PORT: "8765",
  };

  // Capture the agent's stdout/stderr to a log file instead of discarding it
  // (stdio: "ignore" previously meant a crash on the Python side — import
  // error, port already in use, any startup exception — was completely
  // invisible; we'd only ever see "did not come online", never why).
  const agentLogPath = path.join(process.cwd(), "logs", "desktop_agent.log");
  let agentLogFd: number | "ignore" = "ignore";
  try {
    fs.mkdirSync(path.dirname(agentLogPath), { recursive: true });
    agentLogFd = fs.openSync(agentLogPath, "a");
    fs.appendFileSync(agentLogPath, `\n--- spawn attempt ${new Date().toISOString()} ---\n`);
  } catch {
    // Fall back to "ignore" below if the log file can't be opened — this is
    // best-effort diagnostics, not something that should block a spawn.
  }

  // Preferred path (packaged app): a PyInstaller-frozen agent exe that embeds
  // its own Python runtime. Set by the Electron main process via KAIRA_AGENT_EXE.
  const frozenExe = process.env.KAIRA_AGENT_EXE;
  if (frozenExe && fs.existsSync(frozenExe)) {
    try {
      const child = spawn(frozenExe, [], {
        cwd: path.dirname(frozenExe),
        detached: true,
        stdio: ["ignore", agentLogFd, agentLogFd],
        windowsHide: true, // never flash a console window
        env: agentEnv,
      });
      child.unref();
      logStartup(`AGENT_SPAWN frozen exe pid=${child.pid} path=${frozenExe}`);
      console.log(`[Desktop Agent] Launched frozen agent (PID ${child.pid}). Output logged to logs/desktop_agent.log`);
      return;
    } catch (e: any) {
      logError(`AGENT_SPAWN_FROZEN_FAILED: ${e?.message || e}`);
      // fall through to the Python path below
    }
  }

  // Development fallback: run the agent from source using a local Python.
  const candidates = [
    process.env.KAIRA_PYTHON,
    "C:\\Users\\MSI\\AppData\\Local\\Programs\\Python\\Python311\\python.exe",
    "python",
    "python3",
  ].filter(Boolean) as string[];
  const py = candidates.find((p) => {
    try {
      execSync(`"${p}" --version`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!py) {
    console.warn("[Desktop Agent] No frozen agent and no Python interpreter found; desktop control unavailable.");
    logError("AGENT_SPAWN_NO_RUNTIME: neither KAIRA_AGENT_EXE nor Python available");
    return;
  }
  try {
    const child = spawn(
      py,
      ["-m", "uvicorn", "desktop_agent.main:app", "--host", "127.0.0.1", "--port", "8765"],
      { cwd: process.cwd(), detached: true, stdio: ["ignore", agentLogFd, agentLogFd], windowsHide: true, env: agentEnv }
    );
    child.unref();
    logStartup(`AGENT_SPAWN python pid=${child.pid}`);
    console.log(`[Desktop Agent] Auto-spawned via Python (PID ${child.pid}). Output logged to logs/desktop_agent.log`);
  } catch (e: any) {
    console.warn(`[Desktop Agent] Auto-spawn failed: ${e?.message || e}`);
    logError(`AGENT_SPAWN_PYTHON_FAILED: ${e?.message || e}`);
  }
}

/**
 * Probe the desktop agent /health endpoint. Returns true if it responds 200.
 */
async function isDesktopAgentAlive(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${DESKTOP_AGENT_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure the desktop agent is running. If not verified yet, probe health; if
 * down, auto-spawn and poll until it is ready (or timeout). Concurrent calls
 * share a single in-flight attempt rather than each spawning their own
 * process on the same port.
 */
export async function ensureDesktopAgent(): Promise<void> {
  if (desktopAgentVerified) return;
  if (inFlightEnsure) return inFlightEnsure;

  inFlightEnsure = (async () => {
    try {
      if (await isDesktopAgentAlive()) {
        desktopAgentVerified = true;
        console.log("[Desktop Agent] Already running — 52 tools available.");
        return;
      }
      console.log("[Desktop Agent] Not detected. Auto-starting...");
      spawnDesktopAgent();
      // A fresh process (imports pywin32/pycaw/playwright/etc.) can
      // genuinely take longer than 20s on a slower machine or a cold
      // filesystem cache — 45s gives it real room without the caller
      // waiting indefinitely, and since this attempt is now shared, later
      // callers no longer restart the clock by spawning a duplicate.
      for (let i = 1; i <= 45; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await isDesktopAgentAlive()) {
          desktopAgentVerified = true;
          console.log(`[Desktop Agent] Online after ${i}s — 52 tools available.`);
          return;
        }
      }
      console.warn("[Desktop Agent] Did not come online within 45s. Desktop control will be unavailable.");
      try {
        const logPath = path.join(process.cwd(), "logs", "desktop_agent.log");
        const tail = fs.readFileSync(logPath, "utf-8").split("\n").slice(-25).join("\n");
        console.warn(`[Desktop Agent] Last output from the agent process (logs/desktop_agent.log):\n${tail}`);
      } catch {
        console.warn("[Desktop Agent] No log output was captured either — the process may have failed to start at all (check the Python interpreter path).");
      }
    } finally {
      inFlightEnsure = null;
    }
  })();

  return inFlightEnsure;
}

/**
 * Call the Python desktop agent. Returns the parsed JSON response.
 * If the agent is unreachable, returns a user-friendly error payload.
 */
export async function callDesktopAgent(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  // Lazy ensure: if we haven't verified the agent, try (re)starting it once.
  if (!desktopAgentVerified) {
    await ensureDesktopAgent();
  }
  try {
    logCommand(`EXECUTE ${tool} ${JSON.stringify(args)}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DESKTOP_AGENT_TIMEOUT);

    const res = await fetch(`${DESKTOP_AGENT_URL}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logError(`AGENT_HTTP_${res.status} ${tool}: ${text.substring(0, 200)}`);
      return { ok: false, error: `Desktop agent HTTP ${res.status}: ${text}` };
    }
    return await res.json();
  } catch (err: any) {
    desktopAgentVerified = false; // mark stale so next call retries the spawn
    const msg = err?.name === "AbortError"
      ? "Desktop agent timed out."
      : "Desktop agent is not running. Start it with: uvicorn desktop_agent.main:app --port 8765";
    logError(`AGENT_UNREACHABLE ${tool}: ${msg}`);
    return { ok: false, error: msg };
  }
}
