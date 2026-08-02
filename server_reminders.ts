import fs from "fs/promises";
import { Reminder } from "./src/lib/reminderTypes";
import { dataFile } from "./server_paths";

const REMINDERS_FILE = dataFile("reminders.json");

export async function loadReminders(): Promise<Reminder[]> {
  try {
    const data = await fs.readFile(REMINDERS_FILE, "utf-8");
    return JSON.parse(data) as Reminder[];
  } catch (error: any) {
    if (error.code === "ENOENT") return [];
    console.error("[Reminders] Error loading reminders, returning fallback:", error);
    return [];
  }
}

export async function saveReminders(reminders: Reminder[]): Promise<void> {
  try {
    await fs.writeFile(REMINDERS_FILE, JSON.stringify(reminders, null, 2), "utf-8");
  } catch (error) {
    console.error("[Reminders] Error writing reminders file:", error);
  }
}

/**
 * In-process scheduler. Reminders survive server restarts (persisted to
 * disk), but only fire while this process is running — same lifetime as
 * the desktop-agent auto-spawn and everything else here. A restart re-scans
 * and re-schedules anything still pending, including anything that was due
 * while the app was closed (fires immediately, capped at a small backlog so
 * a long-dead process doesn't fire a flood of years-old reminders).
 */
const scheduledTimers = new Map<string, NodeJS.Timeout>();
const MAX_OVERDUE_MS = 1000 * 60 * 60 * 24; // ignore anything more than 24h overdue

export function scheduleReminder(reminder: Reminder, onFire: (r: Reminder) => void): void {
  if (reminder.fired) return;
  const dueMs = new Date(reminder.dueAt).getTime();
  const delay = dueMs - Date.now();

  if (delay < -MAX_OVERDUE_MS) return; // too old, silently skip

  const timer = setTimeout(() => {
    scheduledTimers.delete(reminder.id);
    onFire(reminder);
  }, Math.max(0, delay));
  scheduledTimers.set(reminder.id, timer);
}

export function cancelScheduledReminder(id: string): void {
  const t = scheduledTimers.get(id);
  if (t) {
    clearTimeout(t);
    scheduledTimers.delete(id);
  }
}

/** Load persisted reminders and (re)schedule every pending one. Call once on server boot. */
export async function rehydrateReminders(onFire: (r: Reminder) => void): Promise<void> {
  const reminders = await loadReminders();
  for (const r of reminders) {
    scheduleReminder(r, onFire);
  }
}
