/**
 * KAIRA — path & secret resolution.
 *
 * Separates read-only *code/asset* locations (shipped with the app) from the
 * writable *data* location (per-user, survives reinstalls). When the packaged
 * Electron app launches the backend it sets KAIRA_DATA_DIR to a writable
 * folder under %APPDATA%\KAIRA, because the install directory (Program
 * Files) is read-only.
 *
 * In development, KAIRA_DATA_DIR is unset, so this falls back to a
 * `.kaira-data` subfolder of the project root — deliberately NOT the
 * project root itself (fixed 2026-08-20). Vite's dev server watches the
 * whole project root for source changes; every write to a data file
 * (secrets.json, settings.json, usage.json, etc.) used to land there too,
 * which triggered a full page reload on every write — killing the
 * WebSocket to /live and closing the Gemini Live session mid-conversation.
 * `.kaira-data/` is excluded from Vite's watcher in vite.config.ts.
 *
 * The Gemini API key is NOT shipped with the app. Each user supplies their own
 * on first run; it is stored here in the per-user data dir (never returned to
 * the frontend).
 */

import fs from "fs";
import path from "path";

/** Writable per-user data directory. Falls back to ./.kaira-data in development. */
export const DATA_DIR: string =
  process.env.KAIRA_DATA_DIR || path.join(process.cwd(), ".kaira-data");

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {
  /* already exists / best-effort */
}

// ---------------------------------------------------------------------------
// One-time migration (2026-08-20): existing dev installs have secrets.json,
// settings.json, usage.json, memories.json, reminders.json, todos.json,
// journal.json, and calendar_tokens.json sitting directly in the project
// root from before DATA_DIR moved to .kaira-data/. Move them in on first
// run under the new layout so nobody's memories/settings/usage history
// appear to vanish. No-op once migrated (skips any file already present at
// the new location, and no-ops entirely in production, where
// KAIRA_DATA_DIR is always explicitly set to somewhere outside the project).
// ---------------------------------------------------------------------------
if (!process.env.KAIRA_DATA_DIR) {
  const LEGACY_FILES = [
    "secrets.json",
    "settings.json",
    "usage.json",
    "memories.json",
    "reminders.json",
    "todos.json",
    "journal.json",
    "calendar_tokens.json",
  ];
  for (const name of LEGACY_FILES) {
    const oldPath = path.join(process.cwd(), name);
    const newPath = path.join(DATA_DIR, name);
    try {
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
        fs.renameSync(oldPath, newPath);
        console.log(`[Data Migration] Moved ${name} -> .kaira-data/${name}`);
      }
    } catch (err) {
      console.warn(`[Data Migration] Could not move ${name}:`, err);
    }
  }
}

/** Absolute path to a file inside the writable data directory. */
export function dataFile(name: string): string {
  return path.join(DATA_DIR, name);
}

// ---------------------------------------------------------------------------
// Gemini API key store (secrets.json in the data dir).
// ---------------------------------------------------------------------------
const SECRETS_FILE = dataFile("secrets.json");

interface Secrets {
  geminiApiKey?: string;
}

function readSecrets(): Secrets {
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf-8")) as Secrets;
    }
  } catch {
    /* corrupt — treat as empty */
  }
  return {};
}

/**
 * Resolve the active Gemini API key.
 * Priority: user-entered key (secrets.json) → environment (.env, dev only).
 */
export function getGeminiApiKey(): string | undefined {
  const stored = readSecrets().geminiApiKey?.trim();
  if (stored) return stored;
  const env = process.env.GEMINI_API_KEY?.trim();
  return env || undefined;
}

/**
 * Which source is actually providing the active key — a stored key in
 * secrets.json always wins over .env, which is easy to forget mid-debugging
 * (editing .env repeatedly has no effect while an old stored key remains).
 */
export function getGeminiApiKeySource(): "stored" | "env" | "none" {
  if (readSecrets().geminiApiKey?.trim()) return "stored";
  if (process.env.GEMINI_API_KEY?.trim()) return "env";
  return "none";
}

/** Whether any usable key is configured (without revealing it). */
export function hasGeminiApiKey(): boolean {
  return Boolean(getGeminiApiKey());
}

/** Persist a user-supplied key to the per-user secrets file. */
export function setGeminiApiKey(key: string): void {
  const trimmed = (key || "").trim();
  if (!trimmed) throw new Error("API key must not be empty.");
  const current = readSecrets();
  current.geminiApiKey = trimmed;
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(current, null, 2), "utf-8");
  try {
    fs.chmodSync(SECRETS_FILE, 0o600); // owner-only where supported
  } catch {
    /* Windows ACLs differ; best-effort */
  }
}

/** Remove the stored key (used by "reset"/sign-out flows). */
export function clearGeminiApiKey(): void {
  const current = readSecrets();
  delete current.geminiApiKey;
  try {
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(current, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
}
