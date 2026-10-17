// Market-data validation: gaps, closures, structural validity and provenance.
// These pin the audited defect: a detected gap used to be a diagnostic note only,
// so downstream risk/evidence could still authorise a trade on incomplete data.

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config";
import { isExpectedForexClosure, isForexMarketClosedAt, validateBars } from "./validate";
import type { RawBar } from "./validate";

const STEP = 15 * 60_000;
const T0 = Date.parse("2024-06-05T12:00:00Z"); // Wednesday, 12:00 UTC

function bar(time: number, close = 100, overrides: Partial<RawBar> = {}): RawBar {
  return {
    time,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
    ...overrides,
  };
}

function run(bars: RawBar[], opts: { assetClass?: "crypto" | "forex"; source?: string } = {}) {
  return validateBars(bars, {
    symbol: "BTCUSDT",
    assetClass: opts.assetClass ?? "crypto",
    interval: "15m",
    now: T0 + bars.length * STEP + STEP,
    config: DEFAULT_CONFIG,
    source: opts.source,
  });
}

describe("validateBars — quality and gaps", () => {
  it("marks a complete, well-formed series valid", () => {
    const bars = Array.from({ length: 40 }, (_, i) => bar(T0 + i * STEP, 100 + i * 0.1));
    const result = run(bars);
    expect(result.quality).toBe("valid");
    expect(result.unexplainedGapCount).toBe(0);
    expect(result.gapCount).toBe(0);
  });

  it("degrades quality when a candle is missing during an open session", () => {
    const bars = Array.from({ length: 40 }, (_, i) => bar(T0 + i * STEP, 100));
    const withGap = [...bars.slice(0, 20), ...bars.slice(22)]; // drop two 15m bars
    const result = run(withGap);
    expect(result.gapCount).toBeGreaterThan(0);
    expect(result.unexplainedGapCount).toBeGreaterThan(0);
    expect(result.quality).toBe("degraded");
    expect(result.notes.join(" ")).toMatch(/data gap/);
  });

  it("does not treat a documented FX weekend closure as a data defect", () => {
    const friday = Date.parse("2024-06-07T20:45:00Z"); // Friday, before 21:00 UTC
    const sunday = Date.parse("2024-06-09T21:00:00Z"); // Sunday reopen
    expect(isExpectedForexClosure(friday, sunday, STEP)).toBe(true);

    const result = run([bar(friday, 100), bar(sunday, 101)], { assetClass: "forex" });
    expect(result.gapCount).toBe(1);
    expect(result.unexplainedGapCount).toBe(0);
    expect(result.quality).toBe("valid");
  });

  it("follows daylight-saving changes at the New York close/reopen", () => {
    // Winter (EST, UTC-5): Friday closes 22:00 UTC, Sunday reopens 22:00 UTC.
    expect(isForexMarketClosedAt(Date.parse("2026-01-09T21:30:00Z"))).toBe(false); // Fri 16:30
    expect(isForexMarketClosedAt(Date.parse("2026-01-09T22:30:00Z"))).toBe(true); // Fri 17:30
    expect(isForexMarketClosedAt(Date.parse("2026-01-11T21:30:00Z"))).toBe(true); // Sun 16:30
    expect(isForexMarketClosedAt(Date.parse("2026-01-11T22:30:00Z"))).toBe(false); // Sun 17:30

    // Summer (EDT, UTC-4): Friday closes 21:00 UTC, Sunday reopens 21:00 UTC.
    expect(isForexMarketClosedAt(Date.parse("2026-07-10T20:30:00Z"))).toBe(false); // Fri 16:30
    expect(isForexMarketClosedAt(Date.parse("2026-07-10T21:30:00Z"))).toBe(true); // Fri 17:30
    expect(isForexMarketClosedAt(Date.parse("2026-07-12T20:30:00Z"))).toBe(true); // Sun 16:30
    expect(isForexMarketClosedAt(Date.parse("2026-07-12T21:30:00Z"))).toBe(false); // Sun 17:30
  });

  it("recognises the whole winter weekend closure and rejects a holiday-style gap", () => {
    const winterFriday = Date.parse("2026-01-09T21:45:00Z"); // last open 15m candle (EST)
    const winterSunday = Date.parse("2026-01-11T22:00:00Z"); // reopen (EST)
    expect(isExpectedForexClosure(winterFriday, winterSunday, STEP)).toBe(true);

    // A Thursday holiday in an otherwise open week is NOT recognised: no calendar.
    const wed = Date.parse("2026-01-07T15:00:00Z");
    expect(isExpectedForexClosure(wed, wed + 4 * STEP, STEP)).toBe(false);
  });

  it("recognises a weekend on a 1m series (2,880 missing candles), but not invalid input", () => {
    const MIN1 = 60_000;
    const lastOpen = Date.parse("2026-01-09T21:59:00Z"); // last 1m candle before the EST close
    const reopen = Date.parse("2026-01-11T22:00:00Z");
    expect(isExpectedForexClosure(lastOpen, reopen, MIN1)).toBe(true);

    // Unknown clocks must never excuse a gap (the gap stays unexplained).
    expect(isForexMarketClosedAt(Number.NaN)).toBe(false);
    expect(isExpectedForexClosure(Number.NaN, reopen, MIN1)).toBe(false);
    expect(isExpectedForexClosure(reopen, lastOpen, MIN1)).toBe(false);
    expect(isExpectedForexClosure(lastOpen, reopen, 0)).toBe(false);
  });

  it("still degrades an unexplained gap inside a forex session", () => {
    const midweek = Date.parse("2024-06-05T09:00:00Z");
    const result = run([bar(midweek, 100), bar(midweek + 6 * STEP, 101)], { assetClass: "forex" });
    expect(result.unexplainedGapCount).toBe(1);
    expect(result.quality).toBe("degraded");
  });

  it("deduplicates and sorts out-of-order candles", () => {
    const bars = [bar(T0 + 2 * STEP, 102), bar(T0, 100), bar(T0 + STEP, 101), bar(T0 + STEP, 999)];
    const result = run(bars);
    expect(result.duplicateCount).toBe(1);
    expect(result.bars.map((b) => b.time)).toEqual([T0, T0 + STEP, T0 + 2 * STEP]);
    expect(result.bars[1].close).toBe(101);
  });

  it("removes structurally invalid candles and degrades quality", () => {
    const bad = bar(T0 + STEP, 100, { high: 90, low: 110 }); // high < low
    const result = run([bar(T0, 100), bad, bar(T0 + 2 * STEP, 102)]);
    expect(result.removedCount).toBe(1);
    expect(result.quality).toBe("degraded");
    expect(result.bars).toHaveLength(2);
  });

  it("records a >8σ move as a note without calling the market data corrupt", () => {
    const bars = Array.from({ length: 100 }, (_, i) => bar(T0 + i * STEP, 100));
    bars.push(bar(T0 + 100 * STEP, 140));
    const result = run(bars);
    expect(result.removedCount).toBe(0);
    expect(result.quality).toBe("valid");
    expect(result.notes.join(" ")).toMatch(/outlier/);
  });
});

describe("validateBars — provenance", () => {
  it("uses the provider that actually answered (never the symbol pattern)", () => {
    const result = run([bar(T0), bar(T0 + STEP)], { source: "delta" });
    expect(result.bars.every((b) => b.source === "delta")).toBe(true);
  });

  it("does not invent a provider when none is supplied", () => {
    const result = run([bar(T0), bar(T0 + STEP)]);
    expect(result.bars.every((b) => b.source === "unknown")).toBe(true);
  });
});
