import fs from "fs/promises";
import { dataFile } from "./server_paths";

const USAGE_FILE = dataFile("usage.json");

// Pricing as of Aug 2026 (USD per 1M tokens). Voice sessions are audio-input
// dominant, so the Live model's audio-input rate is used as the input price —
// this is a reasonable estimate, not an exact replica of Google's billing
// (which also breaks down cached/tool-use tokens separately).
const PRICING = {
  live: { input: 3.00, output: 4.50 }, // gemini-3.1-flash-live-preview, audio in/out
  memory: { input: 1.50, output: 9.00 }, // gemini-3.5-flash, text-only (memory consolidation)
};

interface UsageTotals {
  liveInputTokens: number;
  liveOutputTokens: number;
  memoryInputTokens: number;
  memoryOutputTokens: number;
  sessionCount: number;
  lastUpdated: string;
}

const EMPTY_TOTALS: UsageTotals = {
  liveInputTokens: 0,
  liveOutputTokens: 0,
  memoryInputTokens: 0,
  memoryOutputTokens: 0,
  sessionCount: 0,
  lastUpdated: new Date().toISOString(),
};

async function loadTotals(): Promise<UsageTotals> {
  try {
    const data = await fs.readFile(USAGE_FILE, "utf-8");
    return { ...EMPTY_TOTALS, ...JSON.parse(data) };
  } catch {
    return { ...EMPTY_TOTALS };
  }
}

async function saveTotals(totals: UsageTotals): Promise<void> {
  await fs.writeFile(USAGE_FILE, JSON.stringify(totals, null, 2), "utf-8");
}

/** Call once per live session start, so sessionCount reflects actual usage sessions. */
export async function recordSessionStart(): Promise<void> {
  const totals = await loadTotals();
  totals.sessionCount += 1;
  totals.lastUpdated = new Date().toISOString();
  await saveTotals(totals);
}

export async function recordLiveUsage(promptTokens: number, responseTokens: number): Promise<void> {
  const totals = await loadTotals();
  totals.liveInputTokens += promptTokens || 0;
  totals.liveOutputTokens += responseTokens || 0;
  totals.lastUpdated = new Date().toISOString();
  await saveTotals(totals);
}

export async function recordMemoryUsage(promptTokens: number, responseTokens: number): Promise<void> {
  const totals = await loadTotals();
  totals.memoryInputTokens += promptTokens || 0;
  totals.memoryOutputTokens += responseTokens || 0;
  totals.lastUpdated = new Date().toISOString();
  await saveTotals(totals);
}

export async function getUsageSummary() {
  const t = await loadTotals();
  const liveCost = (t.liveInputTokens / 1_000_000) * PRICING.live.input + (t.liveOutputTokens / 1_000_000) * PRICING.live.output;
  const memoryCost = (t.memoryInputTokens / 1_000_000) * PRICING.memory.input + (t.memoryOutputTokens / 1_000_000) * PRICING.memory.output;
  return {
    ...t,
    estimatedCostUSD: Math.round((liveCost + memoryCost) * 10000) / 10000,
    isEstimate: true,
  };
}
