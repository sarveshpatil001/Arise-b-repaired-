// ARISE V1 — pure mark-selection layer (one mark service, no Convex, no network).
//
// Invariant: an equity mark is the close of the last COMPLETED bar of the policy's
// own interval, fresh under that policy (MARK_POLICY: completed 15m bars, ≤45m old).
// Anything else — forming bars, mismatched intervals, missing, stale, or invalid
// rows — produces NO mark, and callers fail closed (entry-price fallback /
// MARKS_UNAVAILABLE). Rows advance monotonically: only a strictly newer bar time
// may replace a stored row.

import { isFresh, type FreshnessPolicy } from "./freshness";
import { intervalMs } from "./quant";
import type { Mark } from "./ledger";

/** Minimum shape of a validated bar needed to produce a mark. */
export interface MarkBar {
  time: number;
  close: number;
}

/** Minimum shape of a persisted marks-table row needed to load a mark. */
export interface MarkRow {
  symbol: string;
  price: number;
  time: number;
  interval: string;
  source?: string;
  updatedAt?: number;
}

/** A mark candidate before the symbol is attached. */
export type CompletedMark = Omit<Mark, "symbol">;

/**
 * Last COMPLETED bar's close as a mark candidate. `interval` is the interval the
 * provider actually resolved; when `requestedInterval` is given and differs
 * (fallback/resampling relabeled the series), no mark is produced.
 */
export function selectCompletedMark(
  bars: MarkBar[],
  opts: { interval: string; now: number; requestedInterval?: string },
): CompletedMark | null {
  const { interval, now, requestedInterval } = opts;
  if (requestedInterval !== undefined && requestedInterval !== interval) return null;
  if (!Number.isFinite(now) || now <= 0) return null;
  const step = intervalMs(interval);
  const completedBars = bars.filter(
    (bar) =>
      Number.isFinite(bar.time) &&
      bar.time > 0 &&
      Number.isFinite(bar.close) &&
      bar.close > 0 &&
      bar.time + step <= now,
  );
  const last = completedBars[completedBars.length - 1];
  if (!last) return null;
  return { price: last.close, time: last.time, interval, completed: true };
}

/**
 * Newest usable mark per requested symbol. A missing, stale, invalid, or
 * wrong-interval row yields no entry for that symbol (fail closed) — callers
 * treat absence as "no fresh completed mark".
 */
export function loadMarks(
  rows: MarkRow[],
  symbols: string[],
  now: number,
  policy: FreshnessPolicy,
): Record<string, Mark> {
  const marks: Record<string, Mark> = {};
  for (const symbol of symbols) {
    let newest: MarkRow | undefined;
    for (const row of rows) {
      if (row.symbol !== symbol) continue;
      if (!newest || row.time > newest.time) newest = row;
    }
    if (!newest) continue;
    // The row must be a completed bar of the policy's own interval.
    if (newest.interval !== policy.interval) continue;
    const mark: Mark = {
      symbol,
      price: newest.price,
      time: newest.time,
      interval: newest.interval,
      completed: true,
    };
    if (isFresh(mark, now, policy).fresh) marks[symbol] = mark;
  }
  return marks;
}

/** Monotonic write rule: only a strictly newer bar time may replace the stored row. */
export function shouldUpsert(
  existing: { time: number } | null | undefined,
  incoming: { time: number },
): boolean {
  if (!existing) return true;
  return incoming.time > existing.time;
}
