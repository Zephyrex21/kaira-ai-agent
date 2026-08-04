import fs from "fs/promises";
import { dataFile } from "./server_paths";

const TOKENS_FILE = dataFile("calendar_tokens.json");
const REDIRECT_URI = "http://localhost:3000/api/calendar/callback";
const SCOPE = "https://www.googleapis.com/auth/calendar.events";

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number; // ms epoch
}

function getClientId(): string | undefined {
  return process.env.GOOGLE_CALENDAR_CLIENT_ID;
}
function getClientSecret(): string | undefined {
  return process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
}

export function isCalendarConfigured(): boolean {
  return Boolean(getClientId() && getClientSecret());
}

async function loadTokens(): Promise<StoredTokens | null> {
  try {
    const data = await fs.readFile(TOKENS_FILE, "utf-8");
    return JSON.parse(data) as StoredTokens;
  } catch {
    return null;
  }
}

async function saveTokens(tokens: StoredTokens): Promise<void> {
  await fs.writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2), "utf-8");
}

export async function isCalendarConnected(): Promise<boolean> {
  return (await loadTokens()) !== null;
}

export function buildAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: getClientId()!,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // ensures a refresh_token is issued even on repeat auth
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<void> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: getClientId()!,
      client_secret: getClientSecret()!,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  await saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_date: Date.now() + data.expires_in * 1000,
  });
}

async function refreshAccessToken(tokens: StoredTokens): Promise<StoredTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokens.refresh_token,
      client_id: getClientId()!,
      client_secret: getClientSecret()!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const updated: StoredTokens = {
    access_token: data.access_token,
    refresh_token: tokens.refresh_token, // refresh tokens don't rotate by default
    expiry_date: Date.now() + data.expires_in * 1000,
  };
  await saveTokens(updated);
  return updated;
}

/** Returns a currently-valid access token, refreshing it first if it's expired (or about to). */
async function getValidAccessToken(): Promise<string> {
  let tokens = await loadTokens();
  if (!tokens) throw new Error("Calendar is not connected yet. Ask TECH to connect it in Settings first.");
  if (Date.now() > tokens.expiry_date - 60_000) {
    tokens = await refreshAccessToken(tokens);
  }
  return tokens.access_token;
}

export async function listUpcomingEvents(maxResults: number = 10): Promise<any[]> {
  const token = await getValidAccessToken();
  const params = new URLSearchParams({
    maxResults: String(maxResults),
    orderBy: "startTime",
    singleEvents: "true",
    timeMin: new Date().toISOString(),
  });
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Calendar list failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.items || []).map((e: any) => ({
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    description: e.description,
  }));
}

export async function createCalendarEvent(
  summary: string,
  startISO: string,
  endISO: string,
  description?: string
): Promise<any> {
  const token = await getValidAccessToken();
  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary,
      description,
      start: { dateTime: startISO },
      end: { dateTime: endISO },
    }),
  });
  if (!res.ok) throw new Error(`Calendar create failed: ${res.status} ${await res.text()}`);
  return res.json();
}
