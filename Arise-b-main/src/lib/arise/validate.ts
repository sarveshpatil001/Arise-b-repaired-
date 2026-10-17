// ARISE V1 — market data validation. Fail-closed: bad data ⇒ invalid ⇒ NO TRADE.
// Checks per PRD §10: missing/duplicate/invalid prices, impossible OHLC, staleness,
// gaps, monotonic time ordering.

import type { AriseConfig } from "./config";
import type { Bar, DataQuality } from "./types";
import { stdev } from "./math";
import { intervalMs } from "./quant";

export interface RawBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ValidationResult {
  bars: Bar[];
  quality: DataQuality;
  notes: string[];
  duplicateCount: number;
  gapCount: number;
  /** Gaps that are NOT explained by a documented market closure. These degrade quality. */
  unexplainedGapCount: number;
  removedCount: number;
}

/**
 * FX weekly session clock: the interbank week runs Sunday 17:00 → Friday 17:00
 * **America/New_York**, which is what the FX feed's session follows.
 *
 * The previous rule hardcoded 21:00 UTC. That is only correct during EDT (UTC-4):
 * during EST (UTC-5) the market actually closes at 22:00 UTC and reopens at
 * 22:00 UTC, so the old rule called one open hour "closed" (hiding a real gap)
 * and one closed hour "open" (flagging a fake gap every Sunday). Reading the
 * wall clock in New York makes the UTC boundary follow daylight-saving changes
 * from the platform timezone database instead of a hand-maintained offset.
 *
 * NOT a market calendar: exchange holidays and provider-specific maintenance
 * windows are unknown here, so their gaps still count as unexplained and degrade
 * the snapshot (the conservative direction). A gap while the session is open is
 * ALWAYS unexplained.
 */
const NEW_YORK_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function isForexMarketClosedAt(now: number): boolean {
  // If the session clock cannot be read, do NOT claim the market was closed:
  // returning true here would excuse a real gap and mark corrupted data as valid
  // (fail-open). Unknown means "not provably closed", so the gap stays unexplained.
  if (!Number.isFinite(now)) return false;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = NEW_YORK_CLOCK.formatToParts(new Date(now));
  } catch {
    return false;
  }
  const value = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = value("weekday");
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  const minutes = hour * 60 + minute;
  if (day === "Sat") return true;
  if (day === "Fri" && minutes >= 17 * 60) return true;
  if (day === "Sun" && minutes < 17 * 60) return true;
  return false;
}

/** True when every candle START time between the two bars falls in a closed session. */
export function isExpectedForexClosure(prevTime: number, nextTime: number, step: number): boolean {
  // A 1m series over a 48h weekend is 2,880 steps; the cap must cover the longest
  // legitimate closure this rule can explain, or a real weekend on 1m data would be
  // reported as corrupt. Anything longer is not provably a weekend.
  const MAX_STEPS = 5_000;
  if (!Number.isFinite(prevTime) || !Number.isFinite(nextTime) || !Number.isFinite(step)) return false;
  if (!(step > 0) || !(nextTime > prevTime)) return false;
  if ((nextTime - prevTime) / step > MAX_STEPS) return false;
  for (let t = prevTime + step; t < nextTime; t += step) {
    if (!isForexMarketClosedAt(t)) return false;
  }
  return true;
}

const isPosNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

export function validateBars(
  raw: RawBar[],
  opts: {
    symbol: string;
    assetClass: Bar["assetClass"];
    interval: string;
    now: number; // ms epoch UTC
    config: AriseConfig;
    /** Provider that actually returned these bars. Never inferred from the symbol. */
    source?: string;
  },
): ValidationResult {
  const { symbol, assetClass, interval } = opts;
  const notes: string[] = [];
  const step = intervalMs(interval);
  const sorted = [...raw].sort((a, b) => a.time - b.time);

  // Deduplicate by timestamp (duplicate event protection)
  const seen = new Set<number>();
  let duplicateCount = 0;
  const unique: RawBar[] = [];
  for (const b of sorted) {
    if (seen.has(b.time)) {
      duplicateCount++;
      continue;
    }
    seen.add(b.time);
    unique.push(b);
  }
  if (duplicateCount > 0) notes.push(`${duplicateCount} duplicate bar(s) removed`);

  // Structural validity
  const valid: RawBar[] = [];
  let removedCount = 0;
  for (const b of unique) {
    const okShape =
      isPosNum(b.time) &&
      isPosNum(b.open) &&
      isPosNum(b.high) &&
      isPosNum(b.low) &&
      isPosNum(b.close) &&
      b.high >= b.low &&
      b.high >= Math.max(b.open, b.close) - 1e-9 &&
      b.low <= Math.min(b.open, b.close) + 1e-9 &&
      b.volume >= 0;
    if (!okShape) {
      removedCount++;
      continue;
    }
    valid.push(b);
  }
  if (removedCount > 0) notes.push(`${removedCount} structurally invalid bar(s) removed`);

  // Detect gaps. A gap that spans a documented market closure is reported but is
  // NOT a data-quality defect; an unexplained gap degrades the whole snapshot so
  // no actionable decision can be derived from missing information.
  let gapCount = 0;
  let unexplainedGapCount = 0;
  for (let i = 1; i < valid.length; i++) {
    if (valid[i].time - valid[i - 1].time > step * 1.5) {
      gapCount++;
      const expected =
        assetClass === "forex" && isExpectedForexClosure(valid[i - 1].time, valid[i].time, step);
      if (!expected) unexplainedGapCount++;
    }
  }
  if (gapCount > 0) {
    notes.push(`${gapCount} data gap(s) detected (${unexplainedGapCount} unexplained)`);
  }

  // Statistical outlier scan (z-score of returns on closes)
  const closes = valid.map((b) => b.close);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const sd = stdev(rets);
  let outliers = 0;
  for (const r of rets) {
    if (sd > 0 && Math.abs(r / sd) > 8) outliers++;
  }
  if (outliers > 0) notes.push(`${outliers} statistical outlier return(s) >8σ`);

  // Structurally invalid bars that had to be removed, or a gap that no documented
  // closure explains, mean the snapshot is incomplete: degraded (never "valid").
  // NOTE: statistical outliers are reported in `notes` but do not degrade quality —
  // an 8σ crypto move can be entirely real, and rejecting it would be a fabricated
  // safety claim rather than a real one.
  const quality: DataQuality = removedCount > 0 || unexplainedGapCount > 0 ? "degraded" : "valid";
  const bars: Bar[] = valid.map((b) => ({
    symbol,
    assetClass,
    interval,
    time: b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    // Truthful provenance: the caller passes the provider that actually answered.
    // If it is unknown, say so — never infer a provider from the symbol.
    source: opts.source ?? "unknown",
    quality,
  }));

  return { bars, quality, notes, duplicateCount, gapCount, unexplainedGapCount, removedCount };
}

/** Assesses freshness of a validated set of bars + optional top-of-book. */
export function assessFreshness(
  bars: Bar[],
  opts: {
    interval: string;
    now: number;
    config: AriseConfig;
    bestBid?: number | null;
    bestAsk?: number | null;
  },
): { quality: DataQuality; quoteAgeSec: number; notes: string[] } {
  const notes: string[] = [];
  const last = bars[bars.length - 1];
  if (!last) return { quality: "invalid", quoteAgeSec: Infinity, notes: ["no bars"] };
  const step = intervalMs(opts.interval) / 1000;
  const barAgeSec = (opts.now - last.time) / 1000;
  const quoteAgeSec = barAgeSec;
  const notes2: string[] = notes;

  if (barAgeSec > step * opts.config.barStaleMultiplier) {
    notes2.push(`latest bar is ${Math.round(barAgeSec / 60)}m old (>${opts.config.barStaleMultiplier}× interval)`);
    return { quality: "stale", quoteAgeSec, notes: notes2 };
  }
  if (bars.length < opts.config.minBars) {
    notes2.push(`only ${bars.length} validated bars (< ${opts.config.minBars})`);
    return { quality: "degraded", quoteAgeSec, notes: notes2 };
  }
  // Bid/ask sanity if present
  if (
    opts.bestBid != null &&
    opts.bestAsk != null &&
    (opts.bestBid <= 0 || opts.bestAsk <= 0 || opts.bestAsk < opts.bestBid)
  ) {
    notes2.push("crossed/invalid top-of-book");
    return { quality: "invalid", quoteAgeSec, notes: notes2 };
  }
  return { quality: "valid", quoteAgeSec, notes: notes2 };
}
