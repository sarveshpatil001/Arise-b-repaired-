import { describe, expect, it } from "vitest";
import {
  ARENA_STRATEGIES,
  classifyMarket,
  runArena,
  sanitizeBars,
  scoreOf,
  strategySignal,
  type ArenaBar,
  type ArenaConfig,
} from "./arena";

const HOUR = 3_600_000;

function series(count: number, priceAt: (i: number) => number, volumeAt: (i: number) => number = () => 1_000): ArenaBar[] {
  return Array.from({ length: count }, (_, i) => {
    const close = priceAt(i);
    const open = i === 0 ? close : priceAt(i - 1);
    const high = Math.max(open, close) + 0.4;
    const low = Math.min(open, close) - 0.4;
    return { time: 1_000_000 + i * HOUR, open, high, low, close, volume: volumeAt(i) };
  });
}

const config: Partial<ArenaConfig> = {
  startingEquity: 10_000,
  feeBps: 4,
  slippageBps: 2,
  minBars: 150,
  minOosTrades: 8,
  inSamplePct: 0.7,
  stopAtrMult: 1.5,
  targetAtrMult: 3,
};

describe("arena data hygiene", () => {
  it("drops duplicates, invalid OHLC and out-of-order bars", () => {
    const clean = sanitizeBars([
      { time: 3, open: 10, high: 11, low: 9, close: 10, volume: 100 },
      { time: 3, open: 12, high: 13, low: 11, close: 12, volume: 100 },
      { time: 1, open: 10, high: 9, low: 11, close: 10, volume: 100 }, // high < low
      { time: 2, open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { time: 4, open: 10, high: 11, low: 9, close: 12, volume: 100 }, // close > high
    ]);
    expect(clean.map((b) => b.time)).toEqual([2, 3]);
    expect(clean[1].open).toBe(12);
  });

  it("does not evaluate with insufficient history", () => {
    const result = runArena(series(60, (i) => 100 + i), {
      symbol: "BTCUSDT",
      interval: "1h",
      dataSource: "test",
      now: 9_000_000,
      config,
    });
    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.selected).toBeNull();
    expect(result.strategies).toHaveLength(10);
    expect(result.strategies.every((s) => s.status === "INSUFFICIENT_DATA")).toBe(true);
    expect(result.noTradeReason).toContain("insufficient");
  });
});

describe("no look-ahead", () => {
  it("leaves every strategy signal unchanged when future bars change", () => {
    const bars = series(220, (i) => 100 + i * 0.05 + Math.sin(i / 4) * 0.7);
    const i = 150;
    for (const strategy of ARENA_STRATEGIES) {
      const before = strategySignal(strategy.id, bars, i);
      const mutated = bars.map((bar, index) =>
        index > i
          ? {
              ...bar,
              close: bar.close * 1.25,
              high: bar.high * 1.3,
              low: bar.low * 0.75,
              volume: bar.volume * 9,
            }
          : bar,
      );
      const after = strategySignal(strategy.id, mutated, i);
      expect(after, strategy.id).toEqual(before);
    }
  });
});

describe("market classification", () => {
  it("classifies a sustained rise as trending up", () => {
    const bars = series(200, (i) => 100 + i * 0.15);
    expect(classifyMarket(bars).marketClass).toBe("TRENDING_UP");
  });

  it("classifies a flat series as ranging or unclear, never as a trend", () => {
    const bars = series(200, (i) => 100 + Math.sin(i / 6) * 0.05);
    // A flat, oscillating series must never be called a trend; a fresh EMA cross may
    // legitimately be labelled TRANSITIONING.
    expect(["RANGING", "UNCLEAR", "TRANSITIONING"]).toContain(classifyMarket(bars).marketClass);
  });

  it("reports unclear for too little history", () => {
    expect(classifyMarket(series(10, () => 100)).marketClass).toBe("UNCLEAR");
  });
});

describe("arena evaluation", () => {
  it("runs ten rule-based candidates with cost-aware OOS metrics", () => {
    const result = runArena(series(400, (i) => 100 + i * 0.04 + Math.sin(i / 4) * 0.6), {
      symbol: "BTCUSDT",
      interval: "1h",
      dataSource: "test",
      now: 9_000_000,
      config,
    });
    expect(result.status).toBe("OK");
    expect(result.strategies).toHaveLength(10);
    expect(result.strategies.map((s) => s.label)).toEqual(ARENA_STRATEGIES.map((s) => s.label));
    expect(result.strategies.every((s) => s.kind === "RULE_BASED")).toBe(true);
    expect(result.execution).toBe("SIGNAL_ONLY");
    expect(result.bars).toBe(400);
    expect(result.splitIndex).toBeGreaterThan(60);

    const traded = result.strategies.filter((s) => (s.metrics?.trades ?? 0) > 0);
    expect(traded.length).toBeGreaterThan(0);
    for (const strategy of traded) {
      expect(strategy.metrics?.feesPaid ?? 0).toBeGreaterThan(0);
      expect(strategy.metrics?.expectancy).not.toBeNull();
    }
    for (const strategy of result.strategies) {
      if (strategy.status === "ELIGIBLE") {
        expect(strategy.metrics?.trades ?? 0).toBeGreaterThanOrEqual(config.minOosTrades ?? 8);
        expect(strategy.gates.sampleSize).toBe(true);
        expect(strategy.gates.regimeFit).toBe(true);
        expect(strategy.gates.hasSignal).toBe(true);
      }
    }
  });

  it("returns NO TRADE when no strategy can trade", () => {
    const flat = series(300, () => 100, () => 0);
    const result = runArena(flat, {
      symbol: "BTCUSDT",
      interval: "1h",
      dataSource: "test",
      now: 9_000_000,
      config,
    });
    expect(result.status).toBe("OK");
    expect(result.selected).toBeNull();
    expect(result.noTradeReason).toContain("NO TRADE");
    expect(result.strategies.every((s) => s.status !== "ELIGIBLE")).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const bars = series(320, (i) => 100 + i * 0.03 + Math.cos(i / 7) * 0.9);
    const args = { symbol: "ETHUSDT", interval: "1h", dataSource: "test", now: 9_000_000, config };
    const a = runArena(bars, args);
    const b = runArena(bars, args);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("ranks better evidence above worse evidence", () => {
    const good = scoreOf({
      trades: 30,
      winRatePct: 55,
      profitFactor: 1.8,
      expectancy: 120,
      totalReturnPct: 36,
      maxDrawdownPct: 6,
      avgWin: 200,
      avgLoss: 80,
      feesPaid: 40,
      stability: 0.67,
    });
    const bad = scoreOf({
      trades: 30,
      winRatePct: 45,
      profitFactor: 1.1,
      expectancy: 5,
      totalReturnPct: 1,
      maxDrawdownPct: 22,
      avgWin: 100,
      avgLoss: 90,
      feesPaid: 80,
      stability: 0.33,
    });
    expect(good).toBeGreaterThan(bad);
  });

  it("never selects a strategy with insufficient out-of-sample trades", () => {
    const result = runArena(series(220, (i) => 100 + i * 0.06 + Math.sin(i / 3) * 1.1), {
      symbol: "BTCUSDT",
      interval: "1h",
      dataSource: "test",
      now: 9_000_000,
      config: { ...config, minOosTrades: 50 },
    });
    expect(result.selected).toBeNull();
    expect(result.strategies.every((s) => s.status !== "ELIGIBLE")).toBe(true);
  });
});
