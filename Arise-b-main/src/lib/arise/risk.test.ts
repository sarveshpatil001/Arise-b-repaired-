// Tests for src/lib/arise/risk.ts — DATA_FRESH policy boundaries and messaging.
// Pure functions; no Convex, no network.

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config";
import { evaluateRisk, type RiskEngineInput } from "./risk";
import { intervalMs } from "./quant";
import type { MindDecision, QuantFeatures, RiskCheck } from "./types";

const NOW = 1_800_000_000_000; // fixed "current time"
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const mind: MindDecision = {
  direction: "LONG",
  confidence: 0.7,
  thesis: "test thesis",
  supportingEvidence: [],
  contradictingEvidence: [],
  keyRisks: [],
  invalidationConditions: [],
  recommendedAction: "TRADE",
  positionSizeRecommendation: 1,
  agreementPct: 70,
  debate: [],
  dataTimestamp: NOW,
  mindVersion: "test",
};

const features: QuantFeatures = {
  symbol: "BTCUSDT",
  interval: "15m",
  dataQuality: "valid",
  barCount: 200,
  trend: {
    slopePerBarPct: 0.1,
    ema20: 100,
    ema50: 99,
    emaStructure: "BULLISH",
    sma20: 100,
    distFromSma20Pct: 1,
    distFromSma20Sigma: 0.5,
    adx: 25,
    trendStrength: "MODERATE",
  },
  momentum: {
    roc10Pct: 2,
    roc3Pct: 1,
    rsi14: 55,
    rsiState: "NEUTRAL",
    macd: 1,
    macdSignal: 0.5,
    macdHist: 0.5,
    momentumScore: 0.4,
  },
  volatility: {
    realizedVolPct: 1,
    atr14: 50,
    atrPct: 1,
    volPercentile: 50,
    volRegime: "NORMAL",
  },
  statistics: {
    zScore20: 0.5,
    rollingMean20: 100,
    rollingStd20: 2,
    rangePositionPct: 60,
    autocorr1: 0.1,
    retStd: 1,
  },
  liquidity: {
    volumeZ: 0.5,
    spreadPct: 0.05,
    notionalPerBar: 1_000_000,
    liquidityState: "HIGH",
  },
  confidence: 0.7,
};

function riskInput(overrides: Partial<RiskEngineInput>): RiskEngineInput {
  return {
    mind,
    features,
    config: DEFAULT_CONFIG,
    equity: 10_000,
    balance: 10_000,
    dayStartEquity: 10_000,
    highWaterMark: 10_000,
    openPositions: 0,
    openPositionNotional: 0,
    openPositionExposurePct: 0,
    symbol: "BTCUSDT",
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

function dataFreshCheck(overrides: Partial<RiskEngineInput>): RiskCheck {
  const decision = evaluateRisk(riskInput(overrides));
  const check = decision.checks.find((c) => c.rule === "DATA_FRESH");
  if (!check) throw new Error("DATA_FRESH check missing");
  return check;
}

const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"];

describe("DATA_FRESH boundary equivalence (decision-candle policy)", () => {
  it.each(INTERVALS)(
    "matches the age-only rule at 0 / limit-1ms / limit / limit+1ms for %s",
    (interval) => {
      const limitMs = intervalMs(interval) * DEFAULT_CONFIG.barStaleMultiplier;
      const points: Array<{ label: string; ageMs: number; expected: boolean }> = [
        { label: "age 0", ageMs: 0, expected: true },
        { label: "limit - 1ms", ageMs: limitMs - 1, expected: true },
        { label: "limit exactly", ageMs: limitMs, expected: true }, // age == limit is fresh
        { label: "limit + 1ms", ageMs: limitMs + 1, expected: false },
      ];
      for (const point of points) {
        const quoteAgeSec = point.ageMs / 1000;
        const check = dataFreshCheck({ features: { ...features, interval }, quoteAgeSec });
        // Legacy age-only predicate on valid inputs — must agree everywhere.
        const ageOnly = quoteAgeSec * 1000 <= limitMs;
        expect(ageOnly, `${interval} ${point.label}`).toBe(point.expected);
        expect(check.pass, `${interval} ${point.label}`).toBe(point.expected);
        expect(check.detail, `${interval} ${point.label}`).toContain(`limit ${Math.round(limitMs / 1000)}s`);
      }
    },
  );
});

describe("DATA_FRESH detail for invalid inputs", () => {
  it("shows the invalidation reason instead of 'limit 0s' for a non-positive entry price", () => {
    const check = dataFreshCheck({ entryPrice: 0, quoteAgeSec: 10 });
    expect(check.pass).toBe(false);
    expect(check.detail).not.toContain("limit 0s");
    expect(check.detail).toContain("price");
  });

  it("shows the invalidation reason instead of 'limit 0s' for a non-finite quote age", () => {
    const check = dataFreshCheck({ quoteAgeSec: Number.NaN });
    expect(check.pass).toBe(false);
    expect(check.detail).not.toContain("limit 0s");
    expect(check.detail).toContain("quote age");
  });

  it("rejects a negative quote age (future-dated quote) and says why", () => {
    const check = dataFreshCheck({ quoteAgeSec: -5 });
    expect(check.pass).toBe(false);
    expect(check.detail).not.toContain("limit 0s");
    expect(check.detail.toLowerCase()).toContain("future");
  });

  it("still accepts age exactly at the decision interval limit", () => {
    const limitMs = intervalMs("1d") * DEFAULT_CONFIG.barStaleMultiplier;
    expect(limitMs).toBe(3 * DAY);
    const check = dataFreshCheck({ features: { ...features, interval: "1d" }, quoteAgeSec: limitMs / 1000 });
    expect(check.pass).toBe(true);
  });
});
