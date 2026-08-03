export interface JournalEntry {
  id: string;
  /** YYYY-MM-DD, local-ish date this entry belongs to. */
  date: string;
  text: string;
  createdAt: string;
}
