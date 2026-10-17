import { describe, expect, it } from "vitest";
import {
  arenaRiskVeto,
  assessMonitoring,
  buildCatalystView,
  buildModuleHealth,
  buildTradePlanCard,
  computePerformance,
  computeRiskPreview,
  type DecisionLike,
  type RawCatalyst,
} from "./analysis";

const HOUR = 3_600_000;

function decision(overrides: Partial<DecisionLike> = {}): DecisionLike {
  return {
    _id: "d1",
    symbol: "BTCUSDT",
    interval: "1h",
    status: "TRADE",
    direction: "LONG",
    confidence: 0.72,
    thesis: "Trend continuation with aligned momentum.",
    recommendedAction: "TRADE",
    dataQuality: "valid",
    dataSource: "binance",
    dataTimestamp: 1_000_000,
    plan: {
      side: "LONG",
      entry: 100,
      stopLoss: 98,
      takeProfit: 104,
      positionSize: 10,
      positionSizeQuote: 1000,
      riskPerUnit: 2,
      maxLossQuote: 20,
    },
    risk: { decision: "APPROVED", reasonCode: "ALL_CHECKS_PASS", checks: [{ rule: "x", pass: true, detail: "" }] },
    evidence: { outcome: "TRADE", reasonCodes: [] },
    features: { volatility: { atr14: 1.2, atrPct: 1.2 } },
    snapshotMeta: { lastClose: 100, lastBarTime: 1_000_000 },
    agents: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`a${i}`, { confidence: 0.6 }])),
    ...overrides,
  };
}

describe("trade plan card", () => {
  it("builds a labelled R-multiple ladder and an entry window", () => {
    const card = buildTradePlanCard(decision(), 1_000_000 + HOUR);
    expect(card.available).toBe(true);
    expect(card.side).toBe("LONG");
    expect(card.riskReward).toBe(2);
    expect(card.targets.map((t) => t.label)).toEqual(["TP1", "TP2", "TP3"]);
    expect(card.targets.find((t) => t.label === "TP1")?.price).toBe(102);
    expect(card.targets.find((t) => t.label === "TP1")?.derived).toBe(true);
    expect(card.targets.find((t) => t.label === "TP2")?.derived).toBe(false);
    expect(card.entryWindowExpiresAt).toBe(1_000_000 + 2 * HOUR);
    expect(card.entryWindowExpired).toBe(false);
    expect(card.execution).toBe("SIGNAL_ONLY");
    expect(card.confidence).toBeCloseTo(0.72);
  });

  it("expires the entry window without changing the original plan", () => {
    const card = buildTradePlanCard(decision(), 1_000_000 + 3 * HOUR);
    expect(card.available).toBe(false);
    expect(card.noTradeReason).toBe("ENTRY_WINDOW_EXPIRED");
    expect(card.entry).toBeNull();
    expect(card.targets).toEqual([]);
  });

  it("returns NO TRADE for a risk veto", () => {
    const card = buildTradePlanCard(
      decision({ status: "VETOED", risk: { decision: "VETOED", reasonCode: "MAX_SPREAD", message: "spread too wide" } }),
      1_000_001,
    );
    expect(card.available).toBe(false);
    expect(card.noTradeReason).toBe("VETOED");
    expect(card.noTradeDetail).toContain("spread too wide");
  });

  it("returns NO TRADE when data quality is invalid", () => {
    const card = buildTradePlanCard(decision({ dataQuality: "invalid" }), 1_000_001);
    expect(card.noTradeReason).toBe("DATA_NOT_VALID");
    expect(card.side).toBeNull();
  });

  it("withholds confidence when there is no defensible ensemble basis", () => {
    const card = buildTradePlanCard(decision({ agents: {} }), 1_000_001);
    expect(card.confidence).toBeNull();
    expect(card.confidenceBasis).toBeNull();
  });
});

describe("monitoring", () => {
  const position = {
    symbol: "BTCUSDT",
    side: "LONG",
    qty: 1,
    entryPrice: 100,
    stopLoss: 95,
    takeProfit: 110,
    entryFee: 0.04,
    status: "OPEN",
    openedAt: 1_000_000,
  };

  it("refuses to evaluate a candle older than the entry", () => {
    const result = assessMonitoring({
      decision: decision(),
      position,
      mark: { symbol: "BTCUSDT", price: 101, time: 900_000, interval: "1h", completed: true },
      now: 1_100_000,
    });
    expect(result.status).toBe("PRE_ENTRY");
    expect(result.unrealizedPnl).toBeNull();
  });

  it("marks stale completed data as unavailable instead of guessing", () => {
    const result = assessMonitoring({
      decision: decision(),
      position,
      mark: { symbol: "BTCUSDT", price: 101, time: 1_050_000, interval: "1h", completed: true },
      now: 1_050_000 + 4 * HOUR,
    });
    expect(result.status).toBe("STALE");
    expect(result.thesisStatus).toBe("UNKNOWN");
  });

  it("evaluates a post-entry completed observation and estimates net P&L", () => {
    const result = assessMonitoring({
      decision: decision(),
      position,
      mark: { symbol: "BTCUSDT", price: 96, time: 1_050_000, interval: "1h", completed: true },
      now: 1_060_000,
    });
    expect(result.status).toBe("OK");
    expect(result.currentDirection).toBe("DOWN");
    expect(result.followingPrediction).toBe(false);
    expect(result.thesisStatus).toBe("WEAKENED");
    expect(result.unrealizedPnl).toBeLessThan(0);
    // Entry fee + an estimated exit fee are charged; no fabricated gross-only number.
    expect(result.unrealizedPnl).toBeCloseTo(96 - 100 - 0.04 - (96 * 0.0004));
  });

  it("invalidates the thesis at the predefined stop", () => {
    const result = assessMonitoring({
      decision: decision(),
      position,
      mark: { symbol: "BTCUSDT", price: 95, time: 1_050_000, interval: "1h", completed: true },
      now: 1_060_000,
    });
    expect(result.thesisStatus).toBe("INVALIDATED");
    expect(result.stopStatus).toBe("HIT");
  });

  it("reports unavailable when no observation exists", () => {
    const result = assessMonitoring({ decision: decision(), position, mark: null, now: 1_000_001 });
    expect(result.status).toBe("UNAVAILABLE");
  });
});

describe("risk preview", () => {
  const base = {
    side: "LONG" as const,
    entry: 100,
    atr: 1,
    equity: 10_000,
    balance: 10_000,
    dayStartEquity: 10_000,
    highWaterMark: 10_000,
    openNotional: 0,
    openPositions: 0,
    emergencyStop: false,
    config: {
      riskPerTradePct: 0.5,
      maxPositionPct: 15,
      maxGrossExposurePct: 60,
      maxDailyLossPct: 3,
      maxDrawdownPct: 10,
    },
  };

  it("sizes from monetary risk and respects the position cap", () => {
    const preview = computeRiskPreview(base);
    expect(preview.decision).toBe("REDUCED");
    expect(preview.stopLoss).toBeCloseTo(98.5);
    expect(preview.qty).toBeCloseTo(15);
    expect(preview.notional).toBeCloseTo(1500);
    expect(preview.estimatedCosts).toBeGreaterThan(0);
    expect(preview.riskAmount).toBeLessThanOrEqual((0.5 / 100) * 10_000);
    expect(preview.execution).toBe("SIGNAL_ONLY");
  });

  it("returns NO TRADE when the daily loss limit is already breached", () => {
    const preview = computeRiskPreview({ ...base, equity: 9_000 });
    expect(preview.decision).toBe("NO_TRADE");
    expect(preview.reasonCode).toBe("MAX_DAILY_LOSS");
    expect(preview.qty).toBe(0);
  });

  it("returns NO TRADE while the paper pause is active", () => {
    const preview = computeRiskPreview({ ...base, emergencyStop: true });
    expect(preview.decision).toBe("NO_TRADE");
    expect(preview.reasonCode).toBe("EMERGENCY_STOP");
  });

  it("rejects impossible inputs instead of producing a size", () => {
    const preview = computeRiskPreview({ ...base, entry: Number.NaN });
    expect(preview.decision).toBe("NO_TRADE");
    expect(preview.qty).toBe(0);
    expect(preview.stopLoss).toBeNull();
  });

  it("never widens the stop to make a trade fit", () => {
    const preview = computeRiskPreview(base);
    const stopDistance = Math.abs(100 - (preview.stopLoss as number));
    expect(stopDistance).toBeCloseTo(1.5);
    expect(preview.stopLoss).toBeLessThan(100);
  });
});

describe("performance", () => {
  it("measures directional accuracy only against later observations", () => {
    const records = Array.from({ length: 6 }, (_, i) => ({
      decisionId: `d${i}`,
      symbol: "BTCUSDT",
      interval: "1h",
      direction: "LONG",
      status: "TRADE",
      confidence: 0.6,
      dataTimestamp: 1_000_000 + i * HOUR,
      snapshotMeta: { lastClose: 100 + i },
      strategy: { selectedId: "momentum" },
    }));
    const report = computePerformance(records, []);
    expect(report.overall.evaluatedPredictions).toBe(5);
    expect(report.overall.accuracyPct).toBe(100);
    expect(report.overall.evidenceSufficient).toBe(false);
    expect(report.overall.trades).toBe(0);
    expect(report.overall.winRatePct).toBeNull();
  });

  it("reports null rather than inventing metrics when no observation exists", () => {
    const report = computePerformance(
      [{
        decisionId: "d1",
        symbol: "BTCUSDT",
        interval: "1h",
        direction: "LONG",
        status: "TRADE",
        confidence: 0.6,
        dataTimestamp: 1_000_000,
        snapshotMeta: { lastClose: 100 },
      }],
      [],
    );
    expect(report.overall.accuracyPct).toBeNull();
    expect(report.overall.profitFactor).toBeNull();
    expect(report.overall.expectancy).toBeNull();
    expect(report.notes.join(" ")).toContain("No later observation");
  });

  it("computes trade metrics from closed paper positions", () => {
    const positions = Array.from({ length: 20 }, (_, i) => ({
      _id: `p${i}`,
      decisionId: `d${i}`,
      symbol: i % 2 === 0 ? "BTCUSDT" : "ETHUSDT",
      side: "LONG",
      status: "CLOSED",
      pnl: i < 12 ? 100 : -50,
      entryFee: 1,
      exitFee: 1,
      openedAt: 1_000_000 + i,
      closedAt: 1_000_500 + i,
      exitReason: i < 12 ? "TAKE_PROFIT" : "STOP_LOSS",
    }));
    const report = computePerformance([], positions, [
      { t: 1, equity: 10_000 },
      { t: 2, equity: 11_000 },
      { t: 3, equity: 9_000 },
    ]);
    expect(report.overall.trades).toBe(20);
    expect(report.overall.winRatePct).toBeCloseTo(60);
    expect(report.overall.profitFactor).toBeCloseTo(1200 / 400);
    expect(report.overall.avgWin).toBeCloseTo(100);
    expect(report.overall.avgLoss).toBeCloseTo(50);
    expect(report.overall.maxDrawdownPct).toBeCloseTo((2000 / 11000) * 100);
    expect(report.overall.totalFees).toBe(40);
  });

  it("does not report a profit factor when there are no losing trades", () => {
    const report = computePerformance([], [
      {
        _id: "p1",
        symbol: "BTCUSDT",
        side: "LONG",
        status: "CLOSED",
        pnl: 10,
        openedAt: 1,
        closedAt: 2,
      },
    ]);
    expect(report.overall.profitFactor).toBeNull();
  });
});

describe("catalysts", () => {
  const now = 1_760_000_000_000;
  const base = (overrides: Partial<RawCatalyst> = {}): RawCatalyst => ({
    title: "US CPI release",
    scheduledAt: new Date(now + 24 * HOUR).toISOString(),
    timeZone: "America/New_York",
    source: "Bureau of Labor Statistics",
    sourceUrl: "https://www.bls.gov/schedule/news_release/cpi.htm",
    lastUpdatedAt: now - HOUR,
    affectedAssets: ["EURUSD", "BTCUSDT"],
    importance: "HIGH",
    certainty: "CONFIRMED",
    consensus: "3.1% y/y",
    scenarios: { bullish: "Softer print", bearish: "Hotter print", uncertain: "In line" },
    risks: ["Consensus can be revised"],
    ...overrides,
  });

  it("is honestly unconfigured without a provider", () => {
    const view = buildCatalystView({ configured: false, now });
    expect(view.status).toBe("UNCONFIGURED");
    expect(view.events).toEqual([]);
    expect(view.notes.join(" ")).toContain("No economic-calendar provider");
  });

  it("returns at most three verified upcoming events", () => {
    const view = buildCatalystView({
      configured: true,
      provider: "calendar.example",
      now,
      raw: [base(), base({ title: "FOMC decision" }), base({ title: "NFP" }), base({ title: "GDP" })],
    });
    expect(view.status).toBe("CONFIGURED");
    expect(view.events).toHaveLength(3);
    expect(view.events[0].title).toBe("US CPI release");
    expect(view.events[0].certainty).toBe("CONFIRMED");
  });

  it("rejects events without source, URL, timestamp or timezone", () => {
    const view = buildCatalystView({
      configured: true,
      now,
      raw: [
        base({ sourceUrl: "javascript:alert(1)" }),
        base({ scheduledAt: "not-a-date" }),
        base({ timeZone: "" }),
        base({ title: "Valid event" }),
      ],
    });
    expect(view.status).toBe("CONFIGURED");
    expect(view.events).toHaveLength(1);
    expect(view.notes.join(" ")).toContain("3 event(s) rejected");
  });

  it("excludes past events and marks an all-stale feed STALE", () => {
    const past = buildCatalystView({
      configured: true,
      now,
      raw: [base({ scheduledAt: now - HOUR })],
    });
    expect(past.status).toBe("EMPTY");
    expect(past.notes.join(" ")).toContain("past event");

    const stale = buildCatalystView({
      configured: true,
      now,
      raw: [base({ lastUpdatedAt: now - 8 * 24 * HOUR })],
    });
    expect(stale.status).toBe("STALE");
    expect(stale.events).toEqual([]);
  });

  it("deduplicates the same event syndicated twice", () => {
    const view = buildCatalystView({
      configured: true,
      now,
      raw: [base(), base()],
    });
    expect(view.events).toHaveLength(1);
  });

  it("does not invent an event when the payload is empty", () => {
    const view = buildCatalystView({ configured: true, now, raw: { events: [] } });
    expect(view.status).toBe("EMPTY");
    expect(view.events).toEqual([]);
  });
});

describe("module health", () => {
  it("does not report a module reachable without a recorded run", () => {
    const modules = buildModuleHealth({
      now: 2_000_000,
      latestDecision: null,
      latestRecord: null,
      monitor: null,
      account: null,
      catalysts: buildCatalystView({ configured: false, now: 2_000_000 }),
      arenaRanAt: null,
      providerFailureCount: 0,
      providerEventAt: null,
    });
    const trade = modules.find((m) => m.id === "trade-analysis");
    expect(trade?.reachable).toBe(false);
    expect(trade?.state).toBe("OFFLINE");
    expect(modules.find((m) => m.id === "arena")?.state).toBe("NOT_RUN");
    expect(modules.find((m) => m.id === "news")?.state).toBe("UNCONFIGURED");
  });

  it("marks a provider degraded on recorded failures", () => {
    const modules = buildModuleHealth({
      now: 2_000_000,
      latestDecision: decision({ dataTimestamp: 2_000_000 }),
      latestRecord: null,
      monitor: { state: "HEALTHY", lastTickAt: 1_999_000, detail: "ok" },
      account: null,
      catalysts: null,
      arenaRanAt: null,
      providerFailureCount: 3,
      providerEventAt: 1_999_500,
    });
    expect(modules.find((m) => m.id === "market-data")?.state).toBe("DEGRADED");
    expect(modules.find((m) => m.id === "trade-analysis")?.state).toBe("HEALTHY");
  });
});

describe("arena risk veto", () => {
  const selected = { id: "trend-following", label: "Trend Following" };

  it("clears a selected strategy when the risk review returns NO_TRADE", () => {
    const veto = arenaRiskVeto(selected, {
      decision: "NO_TRADE",
      reasonCode: "MAX_POSITIONS",
      message: "5 open vs max 5",
    });
    expect(veto).toEqual({
      id: "trend-following",
      label: "Trend Following",
      reasonCode: "MAX_POSITIONS",
      message: "5 open vs max 5",
    });
  });

  it("keeps the selection when risk approves or reduces size", () => {
    expect(
      arenaRiskVeto(selected, { decision: "APPROVED", reasonCode: "ALL_CHECKS_PASS", message: "ok" }),
    ).toBeNull();
    expect(
      arenaRiskVeto(selected, { decision: "REDUCED", reasonCode: "SIZE_REDUCED", message: "reduced" }),
    ).toBeNull();
  });

  it("has nothing to veto without a selected strategy or without a review", () => {
    expect(arenaRiskVeto(null, { decision: "NO_TRADE", reasonCode: "X", message: "x" })).toBeNull();
    expect(arenaRiskVeto(selected, null)).toBeNull();
  });
});
