import fs from "fs/promises";
import { JournalEntry } from "./src/lib/journalTypes";
import { dataFile } from "./server_paths";

const JOURNAL_FILE = dataFile("journal.json");

export async function loadJournal(): Promise<JournalEntry[]> {
  try {
    const data = await fs.readFile(JOURNAL_FILE, "utf-8");
    return JSON.parse(data) as JournalEntry[];
  } catch (error: any) {
    if (error.code === "ENOENT") return [];
    console.error("[Journal] Error loading journal, returning fallback:", error);
    return [];
  }
}

export async function saveJournal(entries: JournalEntry[]): Promise<void> {
  try {
    await fs.writeFile(JOURNAL_FILE, JSON.stringify(entries, null, 2), "utf-8");
  } catch (error) {
    console.error("[Journal] Error writing journal file:", error);
  }
}

/** Today's date as YYYY-MM-DD, matching how entries are keyed. */
export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}
