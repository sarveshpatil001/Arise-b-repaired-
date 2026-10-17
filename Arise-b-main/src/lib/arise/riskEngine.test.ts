// ARISE V1 — DETERMINISTIC RISK ENGINE boundary matrix (PRD Step 6).
// One rule is flipped at a time against an otherwise-approvable input, so a
// regression in any single guard shows up as an APPROVED decision that should
// have been VETOED. The engine is the only authority that can block a trade, so
// "fail closed" here is a safety property, not a preference.
//
// Note on fixtures: QuantFeatures is a wide analytics struct; each fixture only
// fills the fields the risk engine reads (volatility.atr14, interval).

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type AriseConfig } from "./config";
import {
  buildTradePlan,
  dailyLossPct,
  drawdownPct,
  evaluateRisk,
  validateExecution,
  type RiskEngineInput,
} from "./risk";
import type { MindDecision, QuantFeatures } from "./types";

const NOW = Date.parse("2026-10-16T12:00:00Z");

function makeFeatures(overrides: { atr14?: number; interval?: string } = {}): QuantFeatures {
  return {
    symbol: "BTCUSDT",
    interval: overrides.interval ?? "1h",
    dataQuality: "valid",
    barCount: 300,
    volatility: { atr14: overrides.atr14 ?? 50 },
  } as unknown as QuantFeatures;
}

function makeMind(overrides: Partial<MindDecision> = {}): MindDecision {
  return {
    direction: "LONG",
    confidence: 70,
    thesis: "fixture",
    recommendedAction: "TRADE",
    positionSizeRecommendation: 1,
    ...overrides,
  } as unknown as MindDecision;
}

function makeInput(overrides: Partial<RiskEngineInput> = {}): RiskEngineInput {
  return {
    mind: makeMind(),
    features: makeFeatures(),
    config: DEFAULT_CONFIG,
    equity: 10_000,
    balance: 10_000,
    dayStartEquity: 10_000,
    highWaterMark: 10_000,
    openPositions: 0,
    openPositionNotional: 0,
    openPositionExposurePct: 0,
    symbol: "BTCUSDT",
    assetClass: "crypto",
    entryPrice: 100,
    spreadPct: 0.05,
    notionalPerBar: 1_000_000,
    dataQuality: "valid",
    quoteAgeSec: 10,
    manipulationLevel: "NORMAL",
    emergencyStop: false,
    now: NOW,
    ...overrides,
  };
}

const vetoedBy = (inp: RiskEngineInput) => evaluateRisk(inp).reasonCode;

describe("baseline", () => {
  it("approves a clean, fully-specified input with a positive size", () => {
    const result = evaluateRisk(makeInput());
    expect(["APPROVED", "REDUCED"]).toContain(result.decision);
    expect(result.approvedPositionSize).toBeGreaterThan(0);
    expect(Number.isFinite(result.approvedPositionSize)).toBe(true);
    expect(result.checks.every((c) => c.pass)).toBe(true);
  });
});

describe("fail-closed guards", () => {
  it("vetoes on emergency stop", () => {
    expect(vetoedBy(makeInput({ emergencyStop: true }))).toBe("EMERGENCY_STOP");
    expect(evaluateRisk(makeInput({ emergencyStop: true })).approvedPositionSize).toBe(0);
  });

  it("vetoes invalid or stale data quality, but allows degraded", () => {
    expect(vetoedBy(makeInput({ dataQuality: "invalid" }))).toBe("DATA_VALID");
    expect(vetoedBy(makeInput({ dataQuality: "stale" }))).toBe("DATA_VALID");
    expect(evaluateRisk(makeInput({ dataQuality: "degraded" })).decision).not.toBe("VETOED");
  });

  it("vetoes a stale quote and a future-dated quote", () => {
    expect(vetoedBy(makeInput({ quoteAgeSec: 4 * 3600 }))).toBe("DATA_FRESH");
    expect(vetoedBy(makeInput({ quoteAgeSec: -60 }))).toBe("DATA_FRESH");
  });

  it("vetoes NaN / Infinity entry prices instead of sizing on them", () => {
    for (const entryPrice of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = evaluateRisk(makeInput({ entryPrice }));
      expect(result.decision).toBe("VETOED");
      expect(result.approvedPositionSize).toBe(0);
    }
  });

  it("vetoes a non-finite ATR (regression: NaN size used to be approved)", () => {
    const result = evaluateRisk(makeInput({ features: makeFeatures({ atr14: Number.NaN }) }));
    expect(result.decision).toBe("VETOED");
    expect(result.reasonCode).toBe("INPUT_VALID");
    expect(result.approvedPositionSize).toBe(0);
  });

  it("vetoes a non-finite equity", () => {
    const result = evaluateRisk(makeInput({ equity: Number.NaN }));
    expect(result.decision).toBe("VETOED");
    expect(result.approvedPositionSize).toBe(0);
  });

  it("vetoes an exhausted balance", () => {
    expect(vetoedBy(makeInput({ balance: 0 }))).toBe("BALANCE");
  });

  it("vetoes an MIND that does not want a trade", () => {
    expect(vetoedBy(makeInput({ mind: makeMind({ recommendedAction: "WAIT", direction: "FLAT" }) }))).toBe(
      "MIND_ACTIONABLE",
    );
  });

  it("vetoes a size that rounds to zero", () => {
    expect(vetoedBy(makeInput({ mind: makeMind({ positionSizeRecommendation: 0 }) }))).toBe("SIZE_TOO_SMALL");
  });
});

describe("limits and boundaries", () => {
  it("vetoes exactly at the daily-loss limit and passes just inside it", () => {
    // limit is 3% of day-start equity
    expect(vetoedBy(makeInput({ equity: 9_700, dayStartEquity: 10_000 }))).toBe("MAX_DAILY_LOSS");
    expect(evaluateRisk(makeInput({ equity: 9_701, dayStartEquity: 10_000 })).decision).not.toBe("VETOED");
    expect(dailyLossPct({ dayStartEquity: 10_000, equity: 9_700 })).toBeCloseTo(3, 6);
  });

  it("vetoes exactly at the drawdown limit and passes just inside it", () => {
    // day-start equity is held equal to equity so the daily-loss rule cannot fire
    // first — this isolates the drawdown boundary.
    expect(vetoedBy(makeInput({ equity: 9_000, dayStartEquity: 9_000, highWaterMark: 10_000 }))).toBe(
      "MAX_DRAWDOWN",
    );
    expect(
      evaluateRisk(makeInput({ equity: 9_001, dayStartEquity: 9_001, highWaterMark: 10_000 })).decision,
    ).not.toBe("VETOED");
    expect(drawdownPct({ highWaterMark: 10_000, equity: 9_000 })).toBeCloseTo(10, 6);
  });

  it("vetoes the 5th open position", () => {
    expect(evaluateRisk(makeInput({ openPositions: 4 })).decision).not.toBe("VETOED");
    expect(vetoedBy(makeInput({ openPositions: 5 }))).toBe("POSITION_COUNT");
  });

  it("vetoes when gross exposure has no headroom left", () => {
    expect(vetoedBy(makeInput({ openPositionExposurePct: DEFAULT_CONFIG.maxGrossExposurePct }))).toBe(
      "GROSS_EXPOSURE",
    );
  });

  it("vetoes a spread wider than the configured maximum", () => {
    expect(vetoedBy(makeInput({ spreadPct: DEFAULT_CONFIG.maxSpreadPct * 2 }))).toBe("MAX_SPREAD");
  });

  // Regression: a missing spread used to pass as "not vetoed", so an unknown
  // execution cost could never block a trade. Crypto must now fail closed.
  it("vetoes a crypto trade when the quote book is missing", () => {
    const result = evaluateRisk(makeInput({ spreadPct: null }));
    expect(result.decision).toBe("VETOED");
    expect(result.reasonCode).toBe("MAX_SPREAD");
    expect(result.checks.find((c) => c.rule === "MAX_SPREAD")?.detail).toMatch(
      /spread unavailable/,
    );
  });

  it("applies a documented ESTIMATED spread for forex (never as observed)", () => {
    const result = evaluateRisk(makeInput({ spreadPct: null, assetClass: "forex" }));
    expect(result.decision).not.toBe("VETOED");
    const detail = result.checks.find((c) => c.rule === "MAX_SPREAD")?.detail ?? "";
    expect(detail).toMatch(/estimated/);
    expect(detail).toMatch(/not observed/);
  });

  it("still vetoes forex when the documented estimate exceeds the limit", () => {
    const result = evaluateRisk(
      makeInput({
        spreadPct: null,
        assetClass: "forex",
        config: { ...DEFAULT_CONFIG, estimatedForexSpreadPct: DEFAULT_CONFIG.maxSpreadPct * 2 },
      }),
    );
    expect(result.reasonCode).toBe("MAX_SPREAD");
  });

  it("vetoes thin liquidity when a floor is configured", () => {
    const config: AriseConfig = { ...DEFAULT_CONFIG, minLiquidityNotional: 50_000 };
    expect(vetoedBy(makeInput({ config, notionalPerBar: 10_000 }))).toBe("MIN_LIQUIDITY");
  });

  it("vetoes a high manipulation level", () => {
    expect(vetoedBy(makeInput({ manipulationLevel: "HIGH" }))).toBe("ANOMALY_GATE");
  });

  it("enforces the configured anomaly ceiling instead of a hardcoded pair", () => {
    // Shipped default ceiling is WATCH.
    expect(evaluateRisk(makeInput({ manipulationLevel: "NORMAL" })).decision).not.toBe("VETOED");
    expect(evaluateRisk(makeInput({ manipulationLevel: "WATCH" })).decision).not.toBe("VETOED");

    // A stricter configured ceiling must actually veto the level it excludes.
    const strict: AriseConfig = { ...DEFAULT_CONFIG, maxAnomalyLevelForTrade: "NORMAL" };
    expect(vetoedBy(makeInput({ config: strict, manipulationLevel: "WATCH" }))).toBe("ANOMALY_GATE");
    expect(vetoedBy(makeInput({ config: strict, manipulationLevel: "HIGH" }))).toBe("ANOMALY_GATE");
    expect(evaluateRisk(makeInput({ config: strict, manipulationLevel: "NORMAL" })).decision).not.toBe(
      "VETOED",
    );
  });

  it("never treats an unknown anomaly vocabulary as safe", () => {
    for (const level of ["EXTREME", "unknown", "", "normal "]) {
      const result = evaluateRisk(makeInput({ manipulationLevel: level }));
      expect(result.decision).toBe("VETOED");
      expect(result.reasonCode).toBe("ANOMALY_GATE");
      expect(result.approvedPositionSize).toBe(0);
    }
  });
});

describe("position sizing", () => {
  it("never exceeds the configured per-trade risk", () => {
    const result = evaluateRisk(makeInput());
    const riskQuote = result.approvedPositionSize * (makeInput().entryPrice * 0.06);
    // stop distance is clamped to <= 6% of entry, and risk per trade is 0.5% of equity
    expect(riskQuote).toBeLessThanOrEqual(0.005 * 10_000 + 1e-6);
  });

  it("returns null from buildTradePlan for impossible inputs", () => {
    const config = DEFAULT_CONFIG;
    for (const entry of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      expect(buildTradePlan(makeMind(), makeFeatures(), config, 10_000, entry)).toBeNull();
    }
    expect(buildTradePlan(makeMind(), makeFeatures({ atr14: Number.NaN }), config, 10_000, 100)).toBeNull();
    expect(buildTradePlan(makeMind(), makeFeatures(), config, 10_000, 100)).not.toBeNull();
  });
});

describe("execution validator", () => {
  const market = { bestBid: 99.9, bestAsk: 100.1, lastClose: 100, spreadPct: 0.05 };

  it("accepts a clean order", () => {
    expect(validateExecution({ symbol: "BTCUSDT", side: "LONG", qty: 1, type: "MARKET" }, market, DEFAULT_CONFIG).ok).toBe(true);
  });

  it("rejects invalid and non-finite quantities", () => {
    for (const qty of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        validateExecution({ symbol: "BTCUSDT", side: "LONG", qty, type: "MARKET" }, market, DEFAULT_CONFIG).reasonCode,
      ).toBe("INVALID_QTY");
    }
  });

  it("rejects a missing or non-finite reference price", () => {
    for (const lastClose of [0, Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      expect(
        validateExecution(
          { symbol: "BTCUSDT", side: "LONG", qty: 1, type: "MARKET" },
          { bestBid: null, bestAsk: null, lastClose, spreadPct: null },
          DEFAULT_CONFIG,
        ).reasonCode,
      ).toBe("NO_VALID_PRICE");
    }
  });

  it("rejects a wide spread", () => {
    expect(
      validateExecution({ symbol: "BTCUSDT", side: "LONG", qty: 1, type: "MARKET" }, { ...market, spreadPct: 5 }, DEFAULT_CONFIG)
        .reasonCode,
    ).toBe("SPREAD_WIDE");
  });
});
