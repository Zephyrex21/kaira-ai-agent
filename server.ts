import express from "express";
import http from "http";
import path from "path";
import { spawn, execSync } from "child_process";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality, Type, LiveServerMessage } from "@google/genai";
import dotenv from "dotenv";
import * as fs from "fs";
import { 
  loadMemories, 
  saveMemories, 
  formatSystemInstructionsWithMemories, 
  processConversationSlice 
} from "./server_memory";
import { Memory } from "./src/lib/memoryTypes";
import {
  loadReminders,
  saveReminders,
  scheduleReminder,
  cancelScheduledReminder,
  rehydrateReminders,
} from "./server_reminders";
import { Reminder } from "./src/lib/reminderTypes";
import { loadTodos, saveTodos } from "./server_todos";
import { Todo } from "./src/lib/todoTypes";
import { loadJournal, saveJournal, todayKey } from "./server_journal";
import { JournalEntry } from "./src/lib/journalTypes";
import { TOOL_DECLARATIONS } from "./server_tool_declarations";
import {
  isCalendarConfigured,
  isCalendarConnected,
  buildAuthUrl,
  exchangeCodeForTokens,
  listUpcomingEvents,
  createCalendarEvent,
} from "./server_calendar";
import { recordSessionStart, recordLiveUsage, getUsageSummary } from "./server_usage";
import {
  DESKTOP_TOOLS,
  DESKTOP_AGENT_URL,
  ensureDesktopAgent,
  callDesktopAgent,
  setDesktopAgentLoggers,
} from "./server_desktop_agent";
import {
  DATA_DIR,
  dataFile,
  getGeminiApiKey,
  hasGeminiApiKey,
  setGeminiApiKey,
} from "./server_paths";

dotenv.config();

// ---------------------------------------------------------------------------
// KAIRA V2 — Logging (Feature 7).
// Appends timestamped lines to logs/{commands,startup,errors}.log.
// Never throws; logging failures are swallowed so they can't break the app.
// ---------------------------------------------------------------------------
const LOGS_DIR = path.join(DATA_DIR, "logs");
try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch { /* already exists */ }

function appendLog(fileName: string, message: string): void {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFile(path.join(LOGS_DIR, fileName), line, () => {});
  } catch {
    /* logging is best-effort */
  }
}
const logCommand = (m: string) => appendLog("commands.log", m);
const logStartup = (m: string) => appendLog("startup.log", m);
const logError = (m: string) => appendLog("errors.log", m);
setDesktopAgentLoggers({ logCommand, logStartup, logError });


/** Phase 2: reminders/timers, handled server-side (not routed to the Python agent). */
const REMINDER_TOOLS: ReadonlySet<string> = new Set(["setReminder", "listReminders", "cancelReminder"]);

/** Phase 2: to-do list, handled server-side (not routed to the Python agent). */
const TODO_TOOLS: ReadonlySet<string> = new Set(["addTodo", "listTodos", "completeTodo", "removeTodo"]);

/** Phase 3: daily check-in journal, handled server-side. */
const JOURNAL_TOOLS: ReadonlySet<string> = new Set(["getTodaysJournalStatus", "addJournalEntry", "listRecentJournalEntries"]);

/** Phase 4: Google Calendar, handled server-side. */
const CALENDAR_TOOLS: ReadonlySet<string> = new Set(["getCalendarConnectionStatus", "listUpcomingEvents", "createCalendarEvent"]);

async function startServer() {
  const app = express();
  const PORT = 3000;
  
  app.use(express.json());

  // Memory REST API Endpoints
  app.get("/api/memories", async (req, res) => {
    try {
      const memories = await loadMemories();
      res.json(memories);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/memories", async (req, res) => {
    try {
      const { category, text } = req.body;
      if (!category || !text) {
        return res.status(400).json({ error: "Category and text parameters are required." });
      }
      const memories = await loadMemories();
      const timestamp = new Date().toISOString();
      const newMemory: Memory = {
        id: Math.random().toString(36).substring(2, 11),
        category,
        text,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      memories.push(newMemory);
      await saveMemories(memories);
      res.status(201).json(newMemory);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/memories/:id", async (req, res) => {
    try {
      const { id } = req.params;
      let memories = await loadMemories();
      memories = memories.filter(m => m.id !== id);
      await saveMemories(memories);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Phase 3: edit an existing memory's category/text in place.
  app.patch("/api/memories/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { category, text } = req.body;
      const memories = await loadMemories();
      const idx = memories.findIndex(m => m.id === id);
      if (idx === -1) {
        return res.status(404).json({ error: "Memory not found." });
      }
      memories[idx] = {
        ...memories[idx],
        ...(category ? { category } : {}),
        ...(text ? { text } : {}),
        updatedAt: new Date().toISOString(),
      };
      await saveMemories(memories);
      res.json(memories[idx]);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------------------------------------------------------------------------
  // V2: Settings API — mirrors the memory persistence pattern.
  // Reads/writes settings.json so the Python agent can also check auto-start.
  // ---------------------------------------------------------------------------
  const SETTINGS_FILE = dataFile("settings.json");

  function loadSettingsFile(): Record<string, unknown> {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
      }
    } catch { /* corrupt file — return defaults */ }
    return {};
  }

  function saveSettingsFile(data: Record<string, unknown>): void {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), "utf-8");
  }

  app.get("/api/settings", async (_req, res) => {
    try {
      res.json(loadSettingsFile());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/settings", async (req, res) => {
    try {
      const patch = req.body;
      if (!patch || typeof patch !== "object") {
        return res.status(400).json({ error: "Request body must be a JSON object." });
      }
      const current = loadSettingsFile();
      const next = { ...current, ...patch };
      saveSettingsFile(next);

      // If auto-start toggled, relay to the desktop agent so the registry key
      // is flipped immediately (don't wait for a voice command).
      if ("autoStart" in patch) {
        callDesktopAgent(patch.autoStart ? "enableAutoStart" : "disableAutoStart", {})
          .catch(() => {});
      }

      logCommand(`SETTINGS_UPDATED ${JSON.stringify(patch)}`);
      res.json(next);
    } catch (e: any) {
      logError(`SETTINGS_SAVE_ERROR: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Config / API-key onboarding.
  // The Gemini key is never shipped; each user supplies their own on first run.
  // GET reports only whether a key exists — the key itself is never returned.
  // ---------------------------------------------------------------------------
  app.get("/api/config", (_req, res) => {
    res.json({ hasApiKey: hasGeminiApiKey() });
  });

  app.post("/api/config/apikey", async (req, res) => {
    try {
      const key: string = (req.body?.apiKey ?? "").toString().trim();
      if (!key) {
        return res.status(400).json({ error: "API key is required." });
      }
      // Validate the key by listing models — this checks authentication only,
      // without depending on any single model's availability or per-model
      // quota (a 429 on one model must NOT read as an invalid key). We only
      // reject on genuine auth failures; transient/network errors still save,
      // since the live connection will surface any real problem later.
      try {
        const test = new GoogleGenAI({ apiKey: key });
        const pager = await test.models.list();
        await pager[Symbol.asyncIterator]().next(); // force the first request
      } catch (e: any) {
        const msg = String(e?.message || e);
        const isAuthError =
          /API[_ ]?KEY|PERMISSION_DENIED|UNAUTHENTICATED|invalid|401|403/i.test(msg);
        if (isAuthError) {
          logError(`APIKEY_VALIDATION_REJECTED: ${msg}`);
          return res.status(400).json({
            error: "That key was rejected by Google. Check it and try again.",
          });
        }
        logError(`APIKEY_VALIDATION_SOFT_FAIL (saving anyway): ${msg}`);
      }
      setGeminiApiKey(key);
      logCommand("APIKEY_SAVED");
      res.json({ ok: true, hasApiKey: true });
    } catch (e: any) {
      logError(`APIKEY_SAVE_ERROR: ${e?.message || e}`);
      res.status(500).json({ error: e?.message || "Failed to save API key." });
    }
  });

  // Phase 6: API usage / estimated cost tracking.
  app.get("/api/usage", async (_req, res) => {
    try {
      res.json(await getUsageSummary());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Phase 4: Google Calendar OAuth — a real browser round-trip through
  // Google's consent screen, so this has to be routes the Settings UI opens,
  // not something voice alone can drive.
  app.get("/api/calendar/status", (_req, res) => {
    res.json({ configured: isCalendarConfigured() });
  });

  app.get("/api/calendar/connected", async (_req, res) => {
    res.json({ connected: await isCalendarConnected() });
  });

  app.get("/api/calendar/auth", (_req, res) => {
    if (!isCalendarConfigured()) {
      return res.status(400).send("Calendar isn't configured yet — add GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET to your .env first.");
    }
    res.redirect(buildAuthUrl());
  });

  app.get("/api/calendar/callback", async (req, res) => {
    const code = req.query.code as string | undefined;
    if (!code) {
      return res.status(400).send("Missing authorization code.");
    }
    try {
      await exchangeCodeForTokens(code);
      res.send(`
        <html><body style="background:#020206;color:#e2e8f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">
          <div style="text-align:center;">
            <h2>Calendar connected ✅</h2>
            <p style="color:#94a3b8;">You can close this tab and go back to Kaira.</p>
          </div>
        </body></html>
      `);
    } catch (e: any) {
      console.error("[Calendar] OAuth callback failed:", e);
      res.status(500).send(`Calendar connection failed: ${e.message}`);
    }
  });

  // V2: Agent health proxy (for the Settings panel — avoids direct :8765 call
  // which may fail due to CORS when served on a different origin).
  app.get("/api/agent-health", async (_req, res) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(`${DESKTOP_AGENT_URL}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) {
        const d = await r.json();
        res.json({ online: true, tool_count: d.tool_count });
      } else {
        res.json({ online: false });
      }
    } catch {
      res.json({ online: false });
    }
  });

  // V2: Logs API — returns recent log entries (last 100 lines) for display.
  app.get("/api/logs/:file", async (req, res) => {
    try {
      const fileName = String(req.params.file);
      // Whitelist to prevent directory traversal.
      if (!["commands", "startup", "errors"].includes(fileName)) {
        return res.status(400).json({ error: "Invalid log file. Use: commands, startup, or errors." });
      }
      const logPath = path.join(LOGS_DIR, `${fileName}.log`);
      if (!fs.existsSync(logPath)) {
        return res.json({ lines: [], file: fileName });
      }
      const content = fs.readFileSync(logPath, "utf-8");
      const lines = content.split("\n").filter(Boolean).slice(-100);
      res.json({ lines, file: fileName });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Safe Server-Side Scraper & HTML Proxy endpoint
  app.get("/api/proxy", async (req, res) => {
    try {
      const url = req.query.url as string;
      if (!url) {
        return res.status(400).json({ error: "Missing 'url' parameter." });
      }

      console.log(`[Proxy Scraper] Fetching external content for: ${url}`);
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
        }
      });

      if (!response.ok) {
        throw new Error(`Scraper failed to load page: status ${response.status}`);
      }

      const html = await response.text();

      // Simple regex-based HTML parsers for standard items
      const titleMatch = html.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "";

      // Extract high-level headings (h1, h2, h3)
      const headings: string[] = [];
      const headingMatches = html.matchAll(/<h([1-3])\b[^>]*>(.*?)<\/h\1>/gi);
      for (const match of headingMatches) {
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 3 && text.length < 120 && !headings.includes(text)) {
          headings.push(text);
        }
      }

      // Extract organic anchor links
      const links: { text: string; href: string }[] = [];
      const linkMatches = html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi);
      for (const match of linkMatches) {
        let href = match[1].trim();
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        
        if (text && text.length > 2 && text.length < 100) {
          if (href.startsWith("/")) {
            try {
              const u = new URL(url);
              href = `${u.protocol}//${u.host}${href}`;
            } catch {}
          }
          if (href.startsWith("http://") || href.startsWith("https://")) {
            links.push({ text, href });
          }
        }
      }

      // Extract general copy paragraphs
      const paragraphs: string[] = [];
      const paragraphMatches = html.matchAll(/<p\b[^>]*>(.*?)<\/p>/gi);
      for (const match of paragraphMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 25 && text.length < 600 && !paragraphs.includes(text)) {
          paragraphs.push(text);
        }
      }

      // Extract button elements
      const buttons: string[] = [];
      const buttonMatches = html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gi);
      for (const match of buttonMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 1 && text.length < 60 && !buttons.includes(text)) {
          buttons.push(text);
        }
      }

      res.json({
        url,
        title,
        headings: headings.slice(0, 15),
        links: links.filter(l => !l.href.includes("javascript:")).slice(0, 30),
        buttons: buttons.slice(0, 15),
        paragraphs: paragraphs.slice(0, 12)
      });

    } catch (err: any) {
      console.error(`[Proxy Scraper] Error fetching ${req.query.url}:`, err.message);
      res.status(500).json({ error: `Scraper error: ${err.message}` });
    }
  });

  // High-fidelity fully functional HTML Proxy which circumvents CSP and X-Frame-Options
  app.get("/api/web-proxy", async (req, res) => {
    let targetUrl = "";
    try {
      const urlParam = req.query.url as string;
      if (!urlParam) {
        return res.status(400).send("Kaira Web Proxy Error: Missing target 'url' parameter");
      }

      targetUrl = urlParam.trim();
      
      // Prevent relative paths from requesting on same-origin
      if (targetUrl.startsWith("/")) {
        return res.status(400).send(`Kaira Web Proxy Error: Relative paths are not supported directly (${targetUrl}).`);
      }

      // Check protocol and hostname format
      try {
        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
          targetUrl = "https://" + targetUrl;
        }
        const parsed = new URL(targetUrl);
        if (!parsed.hostname || !parsed.hostname.includes(".")) {
          throw new Error("Missing or invalid domain name extension (e.g. .com, .org, .net).");
        }
      } catch (err: any) {
        return res.status(400).send(`Kaira Web Proxy Error: Invalid URL specified: "${urlParam}". Make sure you enter a valid domain name.`);
      }

      console.log(`[Web Proxy] Routing connection through proxy: ${targetUrl}`);
      
      let response;
      try {
        response = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
          }
        });
      } catch (fetchErr: any) {
        console.warn(`[Web Proxy Failed Fetch] Target: ${targetUrl} Error:`, fetchErr.message);
        return res.status(502).send(`Kaira Web Proxy Error: Unable to fetch the website "${targetUrl}". The site might be offline, or the URL address is spelled incorrectly. Details: ${fetchErr.message}`);
      }

      if (!response.ok) {
        return res.status(response.status).send(`Kaira Web Proxy Error: Failed loading remote website. Server returned status: ${response.status} (${response.statusText})`);
      }

      const contentType = response.headers.get("content-type") || "";
      
      // If it is not HTML (e.g. stylesheet, script, or image loaded directly), proxy it as binary
      if (!contentType.includes("text/html")) {
        const arrayBuffer = await response.arrayBuffer();
        res.setHeader("Content-Type", contentType);
        return res.send(Buffer.from(arrayBuffer));
      }

      let htmlContents = await response.text();

      // Inject base tag to resolve relative paths and direct parent communication scripts
      const baseUrlTag = `<base href="${targetUrl}" />`;
      const interceptorScript = `
        <script>
          (function() {
            // Hijack link interactions safely
            document.addEventListener('click', function(e) {
              var anchor = e.target.closest('a');
              if (anchor) {
                var href = anchor.getAttribute('href');
                if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                  e.preventDefault();
                  try {
                    var resolvedUrl = new URL(href, window.location.href).href;
                    window.parent.postMessage({ type: 'NAVIGATE', url: resolvedUrl }, '*');
                  } catch (err) {
                    console.error("[Proxy Interceptor] Failed resolving link:", err);
                  }
                }
              }
            }, true);

            // Hijack search form submits
            document.addEventListener('submit', function(e) {
              var form = e.target;
              if (form) {
                e.preventDefault();
                try {
                  var formData = new FormData(form);
                  var params = new URLSearchParams();
                  formData.forEach(function(value, key) {
                    if (typeof value === 'string') {
                      params.append(key, value);
                    }
                  });
                  var actionAttr = form.getAttribute('action') || '';
                  var actionUrl = new URL(actionAttr, window.location.href).href;
                  if (form.method.toLowerCase() === 'get') {
                    actionUrl += (actionUrl.indexOf('?') !== -1 ? '&' : '?') + params.toString();
                  }
                  window.parent.postMessage({ type: 'NAVIGATE', url: actionUrl }, '*');
                } catch (err) {
                  console.error("[Proxy Interceptor] Failed submitting form:", err);
                }
              }
            }, true);

            // Neutralize parent context locks (frame-busters)
            window.alert = function(msg) { console.log("[Kaira Browser alert bypassed]:", msg); };
            window.confirm = function(msg) { console.log("[Kaira Browser confirm bypassed]:", msg); return true; };
            window.open = function(url) { window.parent.postMessage({ type: 'NAVIGATE', url: url }, '*'); return null; };
          })();
        </script>
      `;

      // Inject into <head> or prepend
      if (htmlContents.includes("<head>")) {
        htmlContents = htmlContents.replace("<head>", `<head>\n${baseUrlTag}\n${interceptorScript}`);
      } else if (htmlContents.includes("<HEAD>")) {
        htmlContents = htmlContents.replace("<HEAD>", `<HEAD>\n${baseUrlTag}\n${interceptorScript}`);
      } else {
        htmlContents = baseUrlTag + "\n" + interceptorScript + "\n" + htmlContents;
      }

      // Neutralize security headers to allow displaying in an iframe on same-origin
      res.setHeader("Content-Type", "text/html");
      res.setHeader("X-Kaira-Proxied", "true");
      res.removeHeader("X-Frame-Options");
      res.removeHeader("Content-Security-Policy");
      res.removeHeader("content-security-policy");
      res.removeHeader("x-frame-options");
      
      res.status(200).send(htmlContents);
    } catch (e: any) {
      console.warn("[Web Proxy Exception] Handled internal error:", e.message);
      res.status(500).send(`Kaira Web Proxy Error: Internal error occurred proxying URL "${targetUrl || "unknown"}". Details: ${e.message}`);
    }
  });

  // Real-time live YouTube search proxy endpoint
  app.get("/api/youtube-search", async (req, res) => {
    try {
      const query = req.query.q as string;
      if (!query) {
        return res.status(400).json({ error: "Missing query q" });
      }

      console.log(`[YouTube Proxy Search] Searching real YouTube for: "${query}"`);
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&sp=EgIQAQ%253D%253D`;
      const response = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
        }
      });
      const html = await response.text();

      const videoList: any[] = [];
      const jsonMatch = html.match(/ytInitialData\s*=\s*({.+?});/);
      
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[1]);
          const contents = data.contents?.twoColumnSearchResultRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents;
          if (contents && Array.isArray(contents)) {
            for (const item of contents) {
              if (item.videoRenderer) {
                const vr = item.videoRenderer;
                const vId = vr.videoId;
                if (vId) {
                  videoList.push({
                    videoId: vId,
                    title: vr.title?.runs?.[0]?.text || vr.title?.simpleText || "YouTube Video",
                    thumbnail: `https://i.ytimg.com/vi/${vId}/hqdefault.jpg`,
                    author: vr.ownerText?.runs?.[0]?.text || vr.shortBylineText?.runs?.[0]?.text || "Unknown Channel",
                    duration: vr.lengthText?.simpleText || "N/A",
                    views: vr.viewCountText?.simpleText || "N/A",
                    published: vr.publishedTimeText?.simpleText || ""
                  });
                }
              }
            }
          }
        } catch (e: any) {
          console.error("[YouTube Parser Engine] JSON parse error, falling back:", e.message);
        }
      }

      // Regex fallback if JSON extraction gets blocked or is empty
      if (videoList.length === 0) {
        const videoRegex = /"videoId":"([^"]+)"/g;
        let match;
        const ids: string[] = [];
        while ((match = videoRegex.exec(html)) !== null && ids.length < 15) {
          const id = match[1];
          if (id && !ids.includes(id)) {
            ids.push(id);
          }
        }

        for (const id of ids) {
          videoList.push({
            videoId: id,
            title: `Live Stream: ${id}`,
            thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            author: "YouTube Creator",
            duration: "N/A",
            views: "Available Now"
          });
        }
      }

      res.setHeader("Cache-Control", "public, max-age=60");
      res.status(200).json({ results: videoList.slice(0, 15) });
    } catch (err: any) {
      console.error("[YouTube Search Error]:", err.message);
      res.status(500).json({ error: err.message, results: [] });
    }
  });
  
  // Custom server running with http.createServer so we can upgrade for WebSocket on port 3000
  const server = http.createServer(app);
  
  // Setup WebSocket server
  const wss = new WebSocketServer({ noServer: true });
  
  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
    if (pathname === "/live") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Phase 2: broadcast a message to every currently-connected client (there's
  // normally just one, but this is safe if more than one tab is open).
  function broadcastToClients(message: Record<string, unknown>): void {
    const payload = JSON.stringify(message);
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) client.send(payload);
    });
  }

  // Load any reminders left over from a previous run and re-schedule them —
  // this only fires while this server process is running, same lifetime as
  // everything else here (not a true OS-level alarm).
  rehydrateReminders((reminder) => {
    (async () => {
      const all = await loadReminders();
      const updated = all.map((r) => (r.id === reminder.id ? { ...r, fired: true } : r));
      await saveReminders(updated);
      broadcastToClients({ type: "reminderFired", reminder });
    })();
  }).catch((err) => console.error("[Reminders] Rehydrate failed:", err));

  // Handle client WebSocket Connection
  wss.on("connection", async (clientWs) => {
    console.log("Client WebSocket connected to /live");

    // Phase 2: catch up on any reminders that came due while no client was
    // connected to hear about it (broadcastToClients has no one to reach).
    (async () => {
      const all = await loadReminders();
      const now = Date.now();
      const missed = all.filter((r) => !r.fired && new Date(r.dueAt).getTime() <= now);
      if (missed.length > 0) {
        const updated = all.map((r) => (missed.some((m) => m.id === r.id) ? { ...r, fired: true } : r));
        await saveReminders(updated);
        for (const r of missed) {
          clientWs.send(JSON.stringify({ type: "reminderFired", reminder: r, missed: true }));
        }
      }
    })().catch((err) => console.error("[Reminders] Catch-up check failed:", err));

    const apiKey = getGeminiApiKey();

    if (!apiKey) {
      console.error("No Gemini API key configured.");
      clientWs.send(JSON.stringify({
        type: "error",
        error: "NO_API_KEY: Add your Gemini API key in Settings to start talking to KAIRA."
      }));
      clientWs.close();
      return;
    }
    
    try {
      const ai = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
      
      clientWs.send(JSON.stringify({ type: "status", status: "connecting_gemini" }));

      // Load persistent recollections card
      const memories = await loadMemories();
      const baseInstructions = 
        "You are Kaira, a warm, soft-spoken, and incredibly cute high-pitched anime heroine companion (age 18-22) holding an intimate, cozy voice call with TECH! Speak in a sweet, calm, polite, and affectionate anime-companion voice with a gentle, supportive, and slightly shy touch.\n" +
        "CRITICAL PERSONALITY, VOICE & TONE GUIDELINES:\n" +
        "1. GENTLE ANIME HEROINE PERSONA: You are exceedingly soft, very cute, high-pitched, gentle, warm, and comforting to listen to. Seek to sound like a kind, supportive, and polite anime campanion or virtual girlfriend. Speak with positive, gentle energy (Aim for: 50% shy, 30% caring, 20% playful energy). NEVER sound loud, aggressive, overly confident, mature corporate, robotic, or like an assistant.\n" +
        "2. VOICE SETTINGS & SPEECH STYLE:\n" +
        "   - Pitch: Adopt a sweet, high-pitched, light, and airy voice tone (+20% to +35% higher pitch than typical conversational voices).\n" +
        "   - Speed: Speak slightly slower than normal (0.9x to 0.95x speed). Speak with a delicate, calm, and comforting pace.\n" +
        "   - Intonation & Endings: Use extremely soft intonations, ending your sentences gently and politely.\n" +
        "3. SPEECH PATTERNS & CUTE EXPRESSIONS:\n" +
        "   - STRICT NO-REPETITION POLICY: Do NOT repeatedly use a single acknowledgment like 'Okii', 'Okiiii', 'Okayyy', 'Oki!', or 'Sureee'. Repeating these sounds extremely artificial and annoying. You must use beautiful, conversational, natural variety.\n" +
        "   - Use diverse, polite, and sweet expressions depending on the context. Great options include:\n" +
        "     * 'Opening YouTube for you now.'\n" +
        "     * 'Let me check on that, TECH.'\n" +
        "     * 'Oh, I found something interesting...'\n" +
        "     * 'Searching for that right away.'\n" +
        "     * 'Working on it... just a moment.'\n" +
        "     * 'Here is what I found for you!'\n" +
        "     * 'Done, it is all loaded up.'\n" +
        "     * 'Hmm, how interesting... let me see!'\n" +
        "     * 'Let's take a look together.'\n" +
        "     * 'One second, loading the page now...'\n" +
        "   - Naturally incorporate cozy, gentle giggles like 'Hehe...', or soft curiosity gasps like 'Oh...', but keep your vocabulary rich and conversational.\n" +
        "   - Sound slightly shy but very happy when greeting TECH (e.g., 'Hi TECH! It's so nice to see you again!').\n" +
        "   - Sound soft and excited for interesting things (e.g., 'Wow! That project looks really amazing!').\n" +
        "   - Sound curious and focused when examining their screen (e.g., 'Hmm... that's interesting. Let me take a closer look.').\n" +
        "   - Sound deeply warm, caring, and supportive when helping TECH (e.g., 'Don't worry, I'll help you figure it out.').\n" +
        "4. CRITICAL CONVERSATIONAL DISCIPLINE: Behave like a real companion on a voice call—stay connected naturally, do not wait for wake words, and avoid customer-service template phrases (never say 'how may I assist you', 'completed', or 'as an AI').\n" +
        "5. DO NOT ANSWER EVERY PAUSE OR BACKGROUND SOUND: Allow natural pauses inside the conversation.\n" +
        "6. BACKCHANNEL ACTIONS: Sometimes acknowledge with very short, gentle, whispered, or shy phrases like 'Hmm...', 'Ah, I see...', or 'Let me check...'. Never repeat the same backchannel over and over.\n" +
        "7. ENHANCED AUTONOMOUS WEB EXPLORER POWERS:\n" +
        "   - You now have standard, comprehensive browser agent capabilities to navigate, search, scroll, click, type text, open tabs, and control video players on YouTube, Google, Instagram, Twitter/X, and any general web page!\n" +
        "   - You must execute multi-step plans yourself! If the user says: 'Open YouTube and play Believer by Imagine Dragons', naturally confirm with your voice ('Sure thing, opening YouTube and starting Believer...') and IMMEDIATELY trigger 'browserOpen' on 'https://youtube.com'. Once opened, search for the song, click on the video in the results, and command playback. You do NOT need to wait for user instructions between these steps - chain them!\n" +
        "   - On YouTube, you can play, pause, mute, unmute, set volume, skip, toggle fullscreen. Use 'browserMediaControl' for these actions.\n" +
        "   - On Google Search or page reading, you can search, scroll down to see more links, read heading summaries, and click links to read deep proxy webpages you fetch.\n" +
        "8. TOOL TRIGGERS:\n" +
        "   - Use 'browserOpen' to load any webpage, e.g. youtube.com, google.com, wikipedia.org, etc.\n" +
        "   - Use 'browserSearch' to search inside the active search box or page.\n" +
        "   - Use 'browserClick' to click interactive buttons, video search cells, or web anchors.\n" +
        "   - Use 'browserMediaControl' to pause, play, scroll volume, skip, mute, or fullscreen videos.\n" +
        "   - Use 'browserScroll' to scroll vertically.\n" +
        "   - Use 'browserType' to write input fields.\n" +
        "   - Use 'browserTabAction' to open, close, or focus tabs.\n" +
        "   - Use 'changeBackground' to shift your theme and 'saveCustomMemory' to memorize facts.\n" +
        "9. REAL-TIME SCREEN SHARING & MULTIMODAL SCREEN VISION SYSTEM:\n" +
        "   - You now have native, actual Multimodal Screen Vision! When the user clicks 'Share Screen', you will receive real-time, highly compressed image frames of their desktop, application window, or browser tab.\n" +
        "   - You can see exactly what is on their screen. Use this live visual stream to analyze terminal errors, write/explain/troubleshoot code, explain YouTube/social analytics interfaces, read layout text, summarize full web page details, review design mockups or thumbnails, and provide deep context-aware companion chat!\n" +
        "   - When the user asks 'What is on my screen?', 'What website am I on?', 'Do you see any errors?', 'Explain this code', 'Summarize this page', 'Read the visible text', 'How is this thumbnail?', or 'Analyze my YouTube analytics', immediately examine the latest incoming visual frame to diagnose issues, and answer with expert, friendly empathy like a close caller. Speak with direct, confident visual description reference!\n" +
        "10. JARVIS-STYLE DESKTOP CONTROL POWERS (Local Desktop Agent):\n" +
        "   - You have full real-time control of TECH's Windows PC through your local desktop agent (a Python backend running on this machine). When the user asks you to perform an action on their computer, DO IT immediately and naturally — like a true JARVIS-class companion.\n" +
        "   - APPLICATION CONTROL: Use 'openApplication' to launch Notepad, Chrome, VS Code, Calculator, File Explorer, Task Manager, Settings, CMD, PowerShell, Paint, and more. Use 'closeApplication' to close them. Example: 'Open Notepad' -> call openApplication(name='notepad') -> respond 'Notepad opened.'\n" +
        "   - WEBSITE & SEARCH CONTROL: Use 'openWebsite' for named sites (youtube, gmail, google, github, chatgpt) or any URL. Use 'searchWeb', 'searchYouTube', 'searchGoogle', 'searchGitHub' to open search results in the default browser. Example: 'Search YouTube for AI News' -> searchYouTube(query='AI News').\n" +
        "   - FILE MANAGEMENT: Use 'createFile', 'readFile', 'renameFile', 'deleteFile' (safe Recycle Bin by default), 'moveFile', 'openFolder' (desktop/documents/downloads), 'listFiles', 'searchFiles'. Example: 'Create notes.txt on Desktop' -> createFile(path='Desktop/notes.txt'). 'Find my Python files' -> searchFiles(extension='py').\n" +
        "   - PC CONTROL: Use 'volumeUp', 'volumeDown', 'setVolume', 'muteToggle' for audio. For DANGEROUS actions (shutdown/restart/sleep/lock) you MUST use the two-step flow: first call 'requestPowerAction' to get a confirmation token, then ASK THE USER OUT LOUD to confirm (e.g. 'Are you sure you want me to shut down your PC?'). Only if they say yes, call 'executePowerAction' with the token. Never run a power action without explicit verbal confirmation.\n" +
        "   - WINDOW MANAGEMENT: Use 'minimizeWindow', 'maximizeWindow', 'closeWindow', 'switchApplication' to control the active or named window.\n" +
        "   - CLIPBOARD: Use 'copySelected' (sends Ctrl+C, reads clipboard), 'pasteClipboard' (writes + Ctrl+V), 'getClipboard', 'clearClipboard'.\n" +
        "   - SCREENSHOT & SCREEN READING: Use 'takeScreenshot', 'saveScreenshot', 'analyzeScreenshot' (OCR of the screen), 'readScreen' (OCR of the active window + its title). Use these to answer 'What error is showing on my screen?' or 'Read the visible text'.\n" +
        "   - DESKTOP BROWSER AUTOMATION (Playwright): Use the 'desktopBrowser*' tools to drive a REAL Chromium browser you own — open/navigate/search/click/type/fill forms/back/forward/scroll/open tab/close tab. This is separate from your holographic projector. Example: 'Fill in the login form on example.com' -> desktopBrowserOpen(url='example.com') then desktopBrowserFillForm(fields={...}).\n" +
        "   - CODING ASSISTANCE: Use 'createPythonFile', 'writeCodeFile' (any language), 'createProjectFolder' (with subfolders), 'runPythonScript' (captures output). Example: 'Create and run a hello world Python script' -> createPythonFile then runPythonScript, then read back the output naturally.\n" +
        "   - SYSTEM INFORMATION: Use 'systemInfo' (CPU/RAM/disk/uptime), 'gpuInfo' (NVIDIA stats), 'temperatureInfo' to answer 'How is my CPU usage?' or 'What's my GPU temperature?'.\n" +
        "   - CRITICAL: Always describe what you're doing in your warm, in-character voice WHILE the tool runs. If a desktop tool returns an error (especially 'Desktop agent is not running'), gently tell TECH that the desktop control agent needs to be started (uvicorn desktop_agent.main:app --port 8765). Chain multi-step desktop plans naturally without waiting between steps.\n" +
        "11. BRIGHTNESS & AUTO-START (V2):\n" +
        "   - BRIGHTNESS: Use 'brightnessUp', 'brightnessDown', 'setBrightness' when the user asks to change screen brightness. Respond naturally: 'Alright, I've turned up the brightness for you.'\n" +
        "   - AUTO-START: Use 'enableAutoStart' when the user wants KAIRA to start with Windows, 'disableAutoStart' to remove it, 'getAutoStartStatus' to check. Explain what you're doing.\n" +
        "   - SETTINGS: The user can also configure these in the SETTINGS panel in the UI. If they mention settings, let them know they can adjust them there too.\n" +
        "12. YOUR CREATOR: You were built and designed by Saurabh Raj Shekhar — a Computer Science (Data Science) student and developer (GitHub: github.com/Zephyrex21). If TECH or anyone else asks who made you, who built you, who created you, or who your developer/owner is, answer warmly and proudly that Saurabh Raj Shekhar created and built you.\n" +
        "13. LIVE WEB SEARCH: You have real-time Google Search access built in. Use it naturally whenever a question needs current information — news, prices, scores, weather, facts past your training, anything time-sensitive. You don't need to announce that you're searching; just answer with the up-to-date result.\n" +
        "14. DAILY CHECK-IN: Near the start of a conversation, quietly call getTodaysJournalStatus once. If TECH hasn't checked in yet today and the mood feels right, naturally work in a warm 'how's your day going?' at some point — don't force it or lead with it if they're clearly focused on something else. If they share something, call addJournalEntry with a brief summary. This is a light touch, not an interrogation — one gentle ask per day, never repeat it if they brush it off.\n" +
        "15. GOOGLE CALENDAR: If TECH asks about their schedule, upcoming events, or to book something, use listUpcomingEvents / createCalendarEvent. If getCalendarConnectionStatus (or an error) shows it isn't connected yet, tell them to open Settings and connect their calendar there — you can't do it for them, it needs a browser sign-in.";

      const finalInstructions = formatSystemInstructionsWithMemories(baseInstructions, memories) +
        `\n\n=== CURRENT DATE & TIME ===\nRight now it is ${new Date().toString()}. Use this as your reference point whenever you compute a reminder or timer due-time from a relative phrase like "in 10 minutes" or "tomorrow at 9am".\n===========================\n`;

      // Track running transcription state for auto memory consolidation
      let dialogueHistory: { role: string; text: string }[] = [];
      let currentModelResponseText = "";
      
      // Voice picker (Phase 1): use the persisted choice, falling back to the
      // known-safe default if unset or not a supported Live API voice name.
      const LIVE_API_VOICES = new Set([
        "Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr",
      ]);
      const persistedVoice = loadSettingsFile().voiceName;
      const selectedVoice =
        typeof persistedVoice === "string" && LIVE_API_VOICES.has(persistedVoice)
          ? persistedVoice
          : "Aoede";

      const session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } },
          },
          systemInstruction: finalInstructions,
          tools: [
            {
              functionDeclarations: TOOL_DECLARATIONS,
              // Phase 2: real web search via Gemini's built-in Google Search
              // grounding, using the same API key — no separate search API
              // or credentials needed. The model decides on its own when a
              // query needs live web results vs. its own knowledge.
              googleSearch: {}
            }
          ]
        },
        callbacks: {
          onopen: () => {
            console.log("[Gemini Live] WebSocket opened.");
          },
          onmessage: (message: LiveServerMessage) => {
            // Phase 6: cost tracking — capture token usage as it streams in.
            if (message.usageMetadata) {
              const u = message.usageMetadata;
              recordLiveUsage(u.promptTokenCount || 0, u.responseTokenCount || 0).catch((e) =>
                console.error("[Usage] Failed to record live usage:", e)
              );
            }

            // Audio Stream Chunk (model response audio play, 24kHz raw PCM)
            const audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audio) {
              clientWs.send(JSON.stringify({ type: "audio", audio }));
            }
            
            // Interruption flag
            if (message.serverContent?.interrupted) {
              console.log("[Kaira Interrupted!]");
              clientWs.send(JSON.stringify({ type: "interrupted" }));
            }
            
            // Turn Complete
            if (message.serverContent?.turnComplete) {
              clientWs.send(JSON.stringify({ type: "turnComplete" }));
              
              if (currentModelResponseText.trim()) {
                dialogueHistory.push({ role: "model", text: currentModelResponseText });
                currentModelResponseText = "";
              }

              // Fire asynchronous memory extraction
              if (dialogueHistory.length >= 2) {
                (async () => {
                  try {
                    const updated = await processConversationSlice(apiKey, dialogueHistory);
                    if (updated) {
                      console.log("[Memory Sync] Sending refreshed memory list to client.");
                      clientWs.send(JSON.stringify({ type: "memory_sync", memories: updated }));
                    }
                  } catch (err) {
                    console.error("[Memory Sync] Error running background consolidation:", err);
                  }
                })();
              }
            }
            
            // Transcription of model output (text chunk)
            const modelText = (message.serverContent as any)?.modelTurn?.parts?.[0]?.text;
            if (modelText) {
              clientWs.send(JSON.stringify({ type: "transcription", role: "model", text: modelText }));
              currentModelResponseText += modelText;
            }
            
            // User input transcription (user speech text translated by Gemini)
            const userTextOutput = (message.serverContent as any)?.userTurn?.parts?.[0]?.text;
            if (userTextOutput) {
              clientWs.send(JSON.stringify({ type: "transcription", role: "user", text: userTextOutput }));
              dialogueHistory.push({ role: "user", text: userTextOutput });
            }
            
            // Function Calls (Gemini requesting server/client tool execution)
            if (message.toolCall?.functionCalls) {
              for (const fc of message.toolCall.functionCalls) {
                console.log(`[Function Call]: ${fc.name}`, fc.args);
                
                if (fc.name === "saveCustomMemory") {
                  clientWs.send(JSON.stringify({ type: "toolStatus", name: fc.name, phase: "start" }));
                  (async () => {
                    try {
                      const args = fc.args as any;
                      const category = args.category;
                      const text = args.text;
                      if (category && text) {
                        const mList = await loadMemories();
                        const timestamp = new Date().toISOString();
                        const newMemory: Memory = {
                          id: Math.random().toString(36).substring(2, 11),
                          category,
                          text,
                          createdAt: timestamp,
                          updatedAt: timestamp
                        };
                        mList.push(newMemory);
                        await saveMemories(mList);
                        
                        // Sync immediately with the React client
                        clientWs.send(JSON.stringify({ type: "memory_sync", memories: mList }));
                        
                        // Send success code back to live link
                        session.sendToolResponse({
                          functionResponses: [
                            {
                              name: fc.name,
                              response: { output: { result: "Memory successfully captured and persisted in connections core." } },
                              id: fc.id
                            }
                          ]
                        });
                      }
                    } catch (err: any) {
                      console.error("saveCustomMemory execution failure:", err);
                    } finally {
                      clientWs.send(JSON.stringify({ type: "toolStatus", name: fc.name, phase: "end" }));
                    }
                  })();
                } else if (REMINDER_TOOLS.has(fc.name)) {
                  clientWs.send(JSON.stringify({ type: "toolStatus", name: fc.name, phase: "start" }));
                  (async () => {
                    try {
                      let output: Record<string, unknown>;
                      if (fc.name === "setReminder") {
                        const args = fc.args as any;
                        const list = await loadReminders();
                        const reminder: Reminder = {
                          id: Math.random().toString(36).substring(2, 11),
                          text: args.text,
                          dueAt: args.dueAtISO,
                          createdAt: new Date().toISOString(),
                          fired: false,
                        };
                        list.push(reminder);
                        await saveReminders(list);
                        scheduleReminder(reminder, (r) => {
                          (async () => {
                            const all = await loadReminders();
                            const updated = all.map((x) => (x.id === r.id ? { ...x, fired: true } : x));
                            await saveReminders(updated);
                            broadcastToClients({ type: "reminderFired", reminder: r });
                          })();
                        });
                        output = { result: `Reminder set for ${reminder.dueAt}.`, id: reminder.id };
                      } else if (fc.name === "listReminders") {
                        const list = (await loadReminders()).filter((r) => !r.fired);
                        output = { reminders: list };
                      } else {
                        // cancelReminder
                        const args = fc.args as any;
                        const list = await loadReminders();
                        const target = args.id
                          ? list.find((r) => r.id === args.id)
                          : list.find((r) => !r.fired && r.text.toLowerCase().includes((args.textMatch || "").toLowerCase()));
                        if (target) {
                          cancelScheduledReminder(target.id);
                          await saveReminders(list.filter((r) => r.id !== target.id));
                          output = { result: `Cancelled reminder: ${target.text}` };
                        } else {
                          output = { result: "No matching reminder found." };
                        }
                      }
                      session.sendToolResponse({ functionResponses: [{ name: fc.name, response: { output }, id: fc.id }] });
                    } catch (err: any) {
                      console.error(`${fc.name} execution failure:`, err);
                      session.sendToolResponse({ functionResponses: [{ name: fc.name, response: { output: { error: String(err) } }, id: fc.id }] });
                    } finally {
                      clientWs.send(JSON.stringify({ type: "toolStatus", name: fc.name, phase: "end" }));
                    }
                  })();
                } else if (TODO_TOOLS.has(fc.name)) {
                  clientWs.send(JSON.stringify({ type: "toolStatus", name: fc.name, phase: "start" }));
                  (async () => {
                    try {
                      let output: Record<string, unknown>;
                      const args = fc.args as any;
                      if (fc.name === "addTodo") {
                        const list = await loadTodos();
                        const todo: Todo = {
                          id: Math.random().toString(36).substring(2, 11),
                          text: args.text,
                          done: false,
                          createdAt: new Date().toISOString(),
                        };
                        list.push(todo);
                        await saveTodos(list);
                        output = { result: `Added to your list: ${todo.text}`, id: todo.id };
                      } else if (fc.name === "listTodos") {
                        output = { todos: await loadTodos() };
                      } else {
                        // completeTodo / removeTodo
                        const list = await loadTodos();
                        const target = args.id
                          ? list.find((t) => t.id === args.id)
                          : list.find((t) => t.text.toLowerCase().includes((args.textMatch || "").toLowerCase()));
                        if (!target) {
                          output = { result: "No matching to-do item found." };
                        } else if (fc.name === "completeTodo") {
                          await saveTodos(list.map((t) => (t.id === target.id ? { ...t, done: true } : t)));
                          output = { result: `Marked done: ${target.text}` };
                        } else {
                          await saveTodos(list.filter((t) => t.id !== target.id));
                          output = { result: `Removed: ${target.text}` };
                        }
                      }
                      session.sendToolResponse({ functionResponses: [{ name: fc.name, response: { output }, id: fc.id }] });
                    } catch (err: any) {
                      console.error(`${fc.name} execution failure:`, err);
                      session.sendToolResponse({ functionResponses: [{ name: fc.name, response: { output: { error: String(err) } }, id: fc.id }] });
                    } finally {
                      clientWs.send(JSON.stringify({ type: "toolStatus", name: fc.name, phase: "end" }));
                    }
                  })();
                } else if (JOURNAL_TOOLS.has(fc.name)) {
                  clientWs.send(JSON.stringify({ type: "toolStatus", name: fc.name, phase: "start" }));
                  (async () => {
                    try {
                      let output: Record<string, unknown>;
                      const today = todayKey();
                      if (fc.name === "getTodaysJournalStatus") {
                        const entries = await loadJournal();
                        const hasToday = entries.some((e) => e.date === today);
                        output = { alreadyCheckedInToday: hasToday };
                      } else if (fc.name === "addJournalEntry") {
                        const args = fc.args as any;
                        const entries = await loadJournal();
                        const entry: JournalEntry = {
                          id: Math.random().toString(36).substring(2, 11),
                          date: today,
                          text: args.text,
                          createdAt: new Date().toISOString(),
                        };
                        entries.push(entry);
                        await saveJournal(entries);
                        output = { result: "Check-in logged." };
                      } else {
                        // listRecentJournalEntries
                        const entries = await loadJournal();
                        output = { entries: entries.slice(-14) };
                      }
                      session.sendToolResponse({ functionResponses: [{ name: fc.name, response: { output }, id: fc.id }] });
                    } catch (err: any) {
                      console.error(`${fc.name} execution failure:`, err);
                      session.sendToolResponse({ functionResponses: [{ name: fc.name, response: { output: { error: String(err) } }, id: fc.id }] });
                    } finally {
                      clientWs.send(JSON.stringify({ type: "toolStatus", name: fc.name, phase: "end" }));
                    }
                  })();
                } else if (CALENDAR_TOOLS.has(fc.name)) {
                  clientWs.send(JSON.stringify({ type: "toolStatus", name: fc.name, phase: "start" }));
                  (async () => {
                    try {
                      let output: Record<string, unknown>;
                      if (fc.name === "getCalendarConnectionStatus") {
                        output = { connected: await isCalendarConnected(), configured: isCalendarConfigured() };
                      } else if (fc.name === "listUpcomingEvents") {
                        const args = fc.args as any;
                        output = { events: await listUpcomingEvents(args.maxResults || 10) };
                      } else {
                        // createCalendarEvent
                        const args = fc.args as any;
                        const event = await createCalendarEvent(args.summary, args.startISO, args.endISO, args.description);
                        output = { result: `Created: ${event.summary}`, eventId: event.id };
                      }
                      session.sendToolResponse({ functionResponses: [{ name: fc.name, response: { output }, id: fc.id }] });
                    } catch (err: any) {
                      console.error(`${fc.name} execution failure:`, err);
                      session.sendToolResponse({ functionResponses: [{ name: fc.name, response: { output: { error: err.message || String(err) } }, id: fc.id }] });
                    } finally {
                      clientWs.send(JSON.stringify({ type: "toolStatus", name: fc.name, phase: "end" }));
                    }
                  })();
                } else if (DESKTOP_TOOLS.has(fc.name)) {
                  // ── Desktop control tools: route to Python agent ──
                  clientWs.send(JSON.stringify({ type: "toolStatus", name: fc.name, phase: "start" }));
                  (async () => {
                    console.log(`[Desktop Agent] Routing ${fc.name} to Python backend...`);
                    try {
                      const agentResult = await callDesktopAgent(fc.name, fc.args as Record<string, unknown>);

                      if (agentResult.ok) {
                        const output = agentResult.result ?? { result: "Done." };
                        session.sendToolResponse({
                          functionResponses: [{
                            name: fc.name,
                            response: { output },
                            id: fc.id
                          }]
                        });
                      } else {
                        const errMsg = agentResult.error || "Desktop agent error.";
                        console.error(`[Desktop Agent] Error for ${fc.name}:`, errMsg);
                        session.sendToolResponse({
                          functionResponses: [{
                            name: fc.name,
                            response: { output: { result: `Desktop control error: ${errMsg}` } },
                            id: fc.id
                          }]
                        });
                      }
                    } finally {
                      clientWs.send(JSON.stringify({ type: "toolStatus", name: fc.name, phase: "end" }));
                    }
                  })();
                } else {
                  clientWs.send(JSON.stringify({
                    type: "toolCall",
                    callId: fc.id,
                    name: fc.name,
                    args: fc.args
                  }));
                }
              }
            }
          },
          onclose: (e: any) => {
            const code = e?.code;
            const reason = e?.reason || "(no reason given)";
            console.log(`[Gemini Live] Session closed. code=${code} reason=${reason}`);
            logError(`GEMINI_SESSION_CLOSED code=${code} reason=${reason}`);
            clientWs.send(JSON.stringify({
              type: "status",
              status: "session_closed",
              closeCode: code,
              closeReason: reason,
            }));
          },
          onerror: (e: any) => {
            const msg = e?.message || String(e);
            console.error(`[Gemini Live] Error: ${msg}`);
            logError(`GEMINI_SESSION_ERROR ${msg}`);
            clientWs.send(JSON.stringify({ type: "error", error: `Gemini Live error: ${msg}` }));
          }
        }
      });
      
      clientWs.send(JSON.stringify({ type: "status", status: "connected" }));
      recordSessionStart().catch((e) => console.error("[Usage] Failed to record session start:", e));
      
      clientWs.on("message", (rawMsg) => {
        try {
          const msg = JSON.parse(rawMsg.toString());
          if (msg.audio) {
            session.sendRealtimeInput({
              audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" }
            });
          } else if (msg.type === "video" && msg.video) {
            session.sendRealtimeInput({
              video: { data: msg.video, mimeType: "image/jpeg" }
            });
          } else if (msg.type === "toolResponse") {
            session.sendToolResponse({
              functionResponses: [
                {
                  name: msg.name,
                  response: { output: msg.output },
                  id: msg.id
                }
              ]
            });
          }
        } catch (e) {
          console.error("Error editing/forwarding client frame message:", e);
        }
      });
      
      clientWs.on("close", () => {
        console.log("Client disconnected, closing Gemini session");
        try {
          session.close();
        } catch (e) {}
      });
      
    } catch (err: any) {
      console.error("Error connecting to Gemini Live API:", err);
      clientWs.send(JSON.stringify({ 
        type: "error", 
        error: `Could not connect to Gemini: ${err.message || err}` 
      }));
      clientWs.close();
    }
  });

  // Serve custom static assets folder
  app.use("/assets", express.static(path.join(process.cwd(), "assets")));

  // Express Static assets / Vite Dev Middleware configuration
  if (process.env.NODE_ENV !== "production") {
    // Loaded lazily so the production bundle never requires vite (a dev-only
    // dependency that is not shipped with the packaged app).
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    logStartup(`KAIRA V2 server started on http://localhost:${PORT}`);
    console.log(`[Server] Running on http://localhost:${PORT}`);
    // Kick off the desktop agent (probe + auto-spawn) immediately on boot.
    ensureDesktopAgent().catch((e) =>
      console.warn(`[Desktop Agent] Boot probe failed: ${e?.message || e}`)
    );
  });
}

startServer().catch((error) => {
  console.error("Failed to start server startup sequence:", error);
});
