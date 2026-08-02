export interface Reminder {
  id: string;
  text: string;
  /** ISO 8601 timestamp for when this reminder should fire. */
  dueAt: string;
  createdAt: string;
  fired: boolean;
}
