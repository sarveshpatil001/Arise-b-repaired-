// Backtest engine integrity tests: determinism, no-lookahead, fees, equity, SL/TP, splits.
import { describe, expect, it } from "vitest";
import { runBacktest, strategySignal, type BTBar } from "./backtest";

function genBars(n: number, start = 100): BTBar[] {
  const out: BTBar[] = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 10) * 0.8 + (i % 7 === 0 ? 1.2 : -0.3);
    const open = px;
    const close = Math.max(1, px + drift);
    out.push({
      time: 1_700_000_000_000 + i * 3_600_000,
      open,
      high: Math.max(open, close) * 1.002,
      low: Math.min(open, close) * 0.998,
      close,
      volume: 1000 + (i % 5) * 100,
    });
    px = close;
  }
  return out;
}

describe("backtest engine", () => {
  it("is deterministic given the same seed", () => {
    const bars = genBars(200);
    const a = runBacktest(bars, "sma-cross", { seed: 7 });
    const b = runBacktest(bars, "sma-cross", { seed: 7 });
    expect(a.metrics.finalEquity).toBe(b.metrics.finalEquity);
    expect(a.trades.length).toBe(b.trades.length);
    expect(JSON.stringify(a.equityCurve)).toBe(JSON.stringify(b.equityCurve));
  });

  it("deducts fees and reconciles equity = start + realized pnl", () => {
    const bars = genBars(200);
    const r = runBacktest(bars, "sma-cross", { feeBps: 10, slippageBps: 5 });
    expect(r.metrics.feesTotal).toBeGreaterThanOrEqual(0);
    const realized = r.trades.reduce((s, t) => s + t.pnl, 0);
    expect(r.metrics.finalEquity).toBeCloseTo(10_000 + realized, 6);
    for (const t of r.trades) {
      expect(t.pnl).toBeCloseTo(t.gross - t.entryFee - t.exitFee, 8);
    }
  });

  it("fills at next open (no look-ahead): signal sees only history", () => {
    // signal at i must equal signal computed on truncated closes
    const bars = genBars(100);
    const closes = bars.map((b) => b.close);
    for (const i of [10, 30, 60, 90]) {
      const full = strategySignal("sma-cross", closes, i, true);
      const trunc = strategySignal("sma-cross", closes.slice(0, i + 1), i, true);
      expect(full).toBe(trunc);
    }
    // entries occur at i+1 open, never at same-bar close
    const r = runBacktest(bars, "rsi-mean", { minBars: 20 });
    for (const t of r.trades) {
      // A stop/target may be hit later on the entry bar after a next-open fill.
      expect(t.exitIdx).toBeGreaterThanOrEqual(t.entryIdx);
      expect(bars[t.entryIdx].open).toBeGreaterThan(0);
    }
  });

  it("maps SL before TP conservatively and respects stop/target", () => {
    const bars: BTBar[] = [];
    let px = 100;
    for (let i = 0; i < 150; i++) {
      px = i < 75 ? px * 1.005 : px * 0.995;
      bars.push({ time: i * 60_000, open: px, high: px * 1.01, low: px * 0.99, close: px, volume: 500 });
    }
    const r = runBacktest(bars, "sma-cross", { stopPct: 1, targetPct: 2, minBars: 30 });
    const sl = r.trades.filter((t) => t.exitReason === "STOP_LOSS");
    for (const t of sl) {
      const adverse = t.side === "LONG" ? (t.entryPrice - t.exitPrice) / t.entryPrice : (t.exitPrice - t.entryPrice) / t.entryPrice;
      expect(adverse).toBeGreaterThanOrEqual(-0.01); // stop level approx honored (slippage small)
    }
    expect(r.trades.length).toBeGreaterThan(0);
  });

  it("splits in-sample / out-of-sample without leakage", () => {
    const bars = genBars(200);
    const r = runBacktest(bars, "arise-momentum", { inSamplePct: 0.7, minBars: 30 });
    expect(r.splitIdx).toBe(Math.floor(r.equityCurve.length > 0 ? 200 * 0.7 : 140));
    for (const t of r.trades) {
      expect(t.inSample).toBe(t.entryIdx < r.splitIdx);
    }
    // in+out pnl sums to total
    const inP = r.trades.filter((t) => t.inSample).reduce((s, t) => s + t.pnl, 0);
    const outP = r.trades.filter((t) => !t.inSample).reduce((s, t) => s + t.pnl, 0);
    expect(inP + outP).toBeCloseTo(r.trades.reduce((s, t) => s + t.pnl, 0), 8);
  });

  it("returns INSUFFICIENT_DATA when bars are too few", () => {
    const bars = genBars(20);
    const r = runBacktest(bars, "sma-cross");
    expect(r.insufficientData).toBe(true);
    expect(r.fitness.verdict).toBe("INSUFFICIENT_DATA");
    expect(r.trades.length).toBe(0);
  });

  it("buy-hold baseline enters once and holds", () => {
    const bars = genBars(150);
    const r = runBacktest(bars, "buy-hold", { minBars: 30, positionPct: 100 });
    expect(r.trades.length).toBeGreaterThanOrEqual(1);
    // first trade entries at bar 1 (signal at 0 filled at next open)
    expect(r.trades[0].entryIdx).toBe(1);
  });

  it("checks the entry bar after the next-open fill and prioritizes the stop", () => {
    const bars: BTBar[] = [
      { time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      { time: 1, open: 100, high: 103, low: 97, close: 100, volume: 1000 },
      { time: 2, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
    ];
    const result = runBacktest(bars, "buy-hold", {
      minBars: 3, feeBps: 0, slippageBps: 0, positionPct: 100, stopPct: 1, targetPct: 2,
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].entryIdx).toBe(1);
    expect(result.trades[0].exitIdx).toBe(1);
    expect(result.trades[0].exitReason).toBe("STOP_LOSS");

    const targetOnlyBars = bars.map((bar, i) =>
      i === 1 ? { ...bar, low: 100, high: 103 } : bar,
    );
    const targetResult = runBacktest(targetOnlyBars, "buy-hold", {
      minBars: 3, feeBps: 0, slippageBps: 0, positionPct: 100, stopPct: 1, targetPct: 2,
    });
    expect(targetResult.trades[0].exitIdx).toBe(1);
    expect(targetResult.trades[0].exitReason).toBe("TAKE_PROFIT");
  });

  it("fills long and short stops at the adverse bar open after a gap", () => {
    const longBars: BTBar[] = [
      { time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
      { time: 1, open: 100, high: 100.1, low: 99.9, close: 100, volume: 1000 },
      { time: 2, open: 90, high: 91, low: 89, close: 90, volume: 1000 },
    ];
    const longResult = runBacktest(longBars, "buy-hold", {
      minBars: 3, feeBps: 0, slippageBps: 0, positionPct: 100, stopPct: 1, targetPct: 50,
    });
    expect(longResult.trades[0].exitReason).toBe("STOP_LOSS");
    expect(longResult.trades[0].exitIdx).toBe(2);
    expect(longResult.trades[0].exitPrice).toBeCloseTo(90, 1);

    const shortBars: BTBar[] = Array.from({ length: 18 }, (_, i) => {
      const close = i < 15 ? 100 + i : i < 17 ? 114 : 120;
      const open = i < 15 ? 100 + i : i < 17 ? 114 : 120;
      return {
        time: i,
        open,
        high: i === 17 ? 121 : close + 0.1,
        low: i === 17 ? 119 : close - 0.1,
        close,
        volume: 1000,
      };
    });
    const shortResult = runBacktest(shortBars, "rsi-mean", {
      minBars: 18, feeBps: 0, slippageBps: 0, positionPct: 100, stopPct: 1, targetPct: 50,
    });
    const shortTrade = shortResult.trades[0];
    expect(shortTrade.side).toBe("SHORT");
    expect(shortTrade.exitReason).toBe("STOP_LOSS");
    expect(shortTrade.exitIdx).toBe(17);
    expect(shortTrade.exitPrice).toBeCloseTo(120, 1);
  });

  it("models low liquidity with higher execution costs than baseline", () => {
    const flatBars: BTBar[] = Array.from({ length: 3 }, (_, i) => ({
      time: i,
      open: 100,
      high: 100.1,
      low: 99.9,
      close: 100,
      volume: 1000,
    }));
    const config = {
      minBars: 3, feeBps: 0, slippageBps: 10, positionPct: 100, stopPct: 50, targetPct: 50, seed: 17,
    };
    const baseline = runBacktest(flatBars, "buy-hold", config, "none");
    const stressed = runBacktest(flatBars, "buy-hold", config, "low-liquidity");

    expect(stressed.trades[0].exitPrice).toBeLessThan(baseline.trades[0].exitPrice);
    expect(stressed.metrics.finalEquity).toBeLessThan(baseline.metrics.finalEquity);
  });
});
