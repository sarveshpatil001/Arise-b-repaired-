// Regression for the decision-data integrity defect: providers return the currently
// forming candle as their last bar. A decision snapshot must contain completed candles
// only — a forming close moves until the bar closes and is not an executable price.
import { describe, expect, it } from "vitest";
import { buildSnapshot } from "./pipeline";
import { DEFAULT_CONFIG } from "./config";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");

function bars(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    time: T0 + i * HOUR,
    open: 100 + i * 0.1,
    high: 101 + i * 0.1,
    low: 99 + i * 0.1,
    close: 100.5 + i * 0.1,
    volume: 10,
  }));
}

function snapshotAt(now: number, series = bars(130)) {
  return buildSnapshot(series, {
    symbol: "BTCUSDT",
    assetClass: "crypto",
    interval: "1h",
    now,
    config: DEFAULT_CONFIG,
    bestBid: 100,
    bestAsk: 100.1,
    source: "binance",
  });
}

describe("buildSnapshot — completed candles only", () => {
  it("excludes the provider's forming candle from decisions and marks", () => {
    const series = bars(130);
    const forming = series[series.length - 1];
    const result = snapshotAt(forming.time + 10 * 60_000, series);

    expect(result.errorCode).toBeNull();
    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot!.bars).toHaveLength(129);
    expect(result.snapshot!.latest.time).toBe(forming.time - HOUR);
    expect(result.snapshot!.bars.some((b) => b.time === forming.time)).toBe(false);
    expect(result.notes.join(" ")).toMatch(/forming bar/);
  });

  it("fails closed when the series contains no completed candle", () => {
    const result = snapshotAt(T0 + 10 * 60_000, bars(1));
    expect(result.snapshot).toBeNull();
    expect(result.errorCode).toBe("NO_COMPLETED_DATA");
  });
});
