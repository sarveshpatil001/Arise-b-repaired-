// ARISE V1 — DETERMINISTIC RISK ENGINE. Not AI. Veto authority. Cannot be overridden.
// Rules per PRD §28: daily loss, drawdown, position sizing, exposure, spread, liquidity,
// stale data, anomaly high-risk, emergency stop. Fail-closed on any unknown state.

import type { AriseConfig } from "./config";
import { clamp } from "./math";
import type {
  MindDecision,
  QuantFeatures,
  RiskCheck,
  RiskDecision,
  TradePlan,
} from "./types";
import { DECISION_DATA_POLICY, isFresh } from "./freshness";

/** Anomaly vocabulary, weakest → strongest. quant.ts emits NORMAL, WATCH and HIGH, and
 *  the config type can only permit NORMAL or WATCH. A level that is not in this table is
 *  NOT ranked zero — it is rejected outright by the gate below, so an unexpected or
 *  newly-introduced provider vocabulary fails closed instead of passing as "normal". */
export const ANOMALY_LEVEL_RANK: Record<string, number> = { NORMAL: 0, WATCH: 1, HIGH: 2 };

export interface RiskEngineInput {
  mind: MindDecision;
  features: QuantFeatures;
  config: AriseConfig;
  equity: number;
  balance: number;
  dayStartEquity: number;
  highWaterMark: number;
  openPositions: number;
  openPositionNotional: number; // quote currency across open positions
  openPositionExposurePct: number;
  symbol: string;
  entryPrice: number; // candidate entry (mid or last close)
  spreadPct: number | null;
  /** Determines whether a missing quote book can be estimated (forex) or must veto. */
  assetClass?: "crypto" | "forex";
  notionalPerBar: number;
  dataQuality: string;
  quoteAgeSec: number;
  manipulationLevel: string;
  emergencyStop: boolean;
  now: number;
}

export function dailyLossPct(inp: { dayStartEquity: number; equity: number }): number {
  if (inp.dayStartEquity <= 0) return 0;
  return Math.max(0, ((inp.dayStartEquity - inp.equity) / inp.dayStartEquity) * 100);
}

export function drawdownPct(inp: { highWaterMark: number; equity: number }): number {
  if (inp.highWaterMark <= 0) return 0;
  return Math.max(0, ((inp.highWaterMark - inp.equity) / inp.highWaterMark) * 100);
}

/** Builds ATR-based stop/target plan. Deterministic. */
export function buildTradePlan(
  mind: MindDecision,
  features: QuantFeatures,
  config: AriseConfig,
  equity: number,
  entry: number,
): TradePlan | null {
  if (mind.direction === "FLAT" || !Number.isFinite(entry) || entry <= 0) return null;
  // A non-finite ATR has no safe fallback: Math.max(NaN, x) is NaN, which would
  // propagate into the position size and pass every `<= 0` comparison downstream.
  if (!Number.isFinite(features.volatility.atr14)) return null;
  const side = mind.direction;
  const atr = Math.max(features.volatility.atr14, entry * 0.002);
  const stopDist = clamp(atr * 1.5, entry * 0.004, entry * 0.06);
  const riskPerUnit = stopDist;
  const maxLossQuote = (config.riskPerTradePct / 100) * equity;
  const rawQty = maxLossQuote / riskPerUnit;
  const maxNotional = (config.maxPositionPct / 100) * equity;
  let qty = rawQty;
  const capByNotional = maxNotional / entry;
  if (qty > capByNotional) qty = capByNotional;
  const dir = side === "LONG" ? 1 : -1;
  return {
    side,
    entry,
    stopLoss: entry - dir * stopDist,
    takeProfit: entry + dir * stopDist * 2, // 2R target
    positionSize: qty,
    positionSizeQuote: qty * entry,
    riskPerUnit,
    maxLossQuote: qty * riskPerUnit,
    maxLossPct: (qty * riskPerUnit / equity) * 100,
  };
}

/** Deterministic risk decision for a proposed trade. */
export function evaluateRisk(inp: RiskEngineInput): RiskDecision {
  const checks: RiskCheck[] = [];
  const cfg = inp.config;
  const add = (rule: string, pass: boolean, detail: string) =>
    checks.push({ rule, pass, detail });

  // 1. Emergency stop — absolute veto
  add("EMERGENCY_STOP", !inp.emergencyStop, inp.emergencyStop ? "Emergency stop active — all new trades blocked" : "No emergency stop");

  // 1b. Input sanity — fail closed on non-finite / impossible risk inputs.
  // Without this, a NaN entry price, equity or ATR could reach the sizing math,
  // yield a NaN size that passes every `<= 0` guard, and be "approved".
  const inputOk =
    Number.isFinite(inp.entryPrice) && inp.entryPrice > 0 &&
    Number.isFinite(inp.equity) && inp.equity > 0 &&
    Number.isFinite(inp.features.volatility.atr14) && inp.features.volatility.atr14 > 0 &&
    Number.isFinite(inp.notionalPerBar) && inp.notionalPerBar >= 0;
  add(
    "INPUT_VALID",
    inputOk,
    inputOk
      ? "risk inputs are finite and positive"
      : "non-finite or non-positive risk input (entry price / equity / ATR / notional per bar)",
  );

  // 2. Data validity — fail closed
  const dataOk = inp.dataQuality === "valid" || inp.dataQuality === "degraded";
  add("DATA_VALID", dataOk, `data quality: ${inp.dataQuality}`);

  // 3. Data staleness — DECISION_DATA_POLICY: 3× the decision's own candle interval.
  // A negative quote age means a future-dated quote and is rejected as INVALID
  // (documented behavior change vs the legacy age-only comparison).
  const freshness = isFresh(
    { time: inp.now - inp.quoteAgeSec * 1000, price: inp.entryPrice, interval: inp.features.interval, completed: true },
    inp.now,
    DECISION_DATA_POLICY(cfg.barStaleMultiplier, inp.features.interval),
  );
  const freshnessDetail =
    freshness.status === "INVALID"
      ? `invalid quote data — ${freshness.reason ?? "unknown reason"} (quote age ${Math.round(inp.quoteAgeSec)}s)`
      : `quote age ${Math.round(inp.quoteAgeSec)}s vs limit ${Math.round((freshness.maxAgeMs ?? 0) / 1000)}s`;
  add("DATA_FRESH", freshness.fresh, freshnessDetail);

  // 4. Daily loss limit
  const dl = dailyLossPct({ dayStartEquity: inp.dayStartEquity, equity: inp.equity });
  add("MAX_DAILY_LOSS", dl < cfg.maxDailyLossPct, `daily loss ${dl.toFixed(2)}% vs limit ${cfg.maxDailyLossPct}%`);

  // 5. Drawdown limit
  const dd = drawdownPct({ highWaterMark: inp.highWaterMark, equity: inp.equity });
  add("MAX_DRAWDOWN", dd < cfg.maxDrawdownPct, `drawdown ${dd.toFixed(2)}% vs limit ${cfg.maxDrawdownPct}%`);

  // 6. Anomaly gate — the ceiling comes from the validated config, so an operator who
  // tightens `maxAnomalyLevelForTrade` to NORMAL actually gets WATCH vetoed. The gate
  // used to hardcode NORMAL|WATCH, which silently ignored that setting (fail-open
  // against a stricter configuration). An unknown level is never treated as safe.
  const levelRank = ANOMALY_LEVEL_RANK[String(inp.manipulationLevel).toUpperCase()];
  const maxAnomalyRank = ANOMALY_LEVEL_RANK[String(cfg.maxAnomalyLevelForTrade).toUpperCase()] ?? 0;
  const anomalyOk = levelRank !== undefined && levelRank <= maxAnomalyRank;
  add(
    "ANOMALY_GATE",
    anomalyOk,
    anomalyOk
      ? `anomaly level: ${inp.manipulationLevel} (ceiling ${cfg.maxAnomalyLevelForTrade})`
      : `anomaly level: ${inp.manipulationLevel} exceeds the configured ceiling ${cfg.maxAnomalyLevelForTrade}`,
  );

  // 7. Spread gate — an absent quote book is NOT a passed check.
  //    Crypto feeds carry top-of-book; if it is missing the execution cost is
  //    unknown, so the check fails closed. Forex has no provider book, so a
  //    documented conservative estimate is applied and labelled ESTIMATED —
  //    never presented as an observed spread.
  const observedSpread = inp.spreadPct;
  const estimatedSpread =
    observedSpread === null && inp.assetClass === "forex" ? cfg.estimatedForexSpreadPct : null;
  const effectiveSpread = observedSpread ?? estimatedSpread;
  const spreadOk = effectiveSpread !== null && effectiveSpread <= cfg.maxSpreadPct;
  const spreadDetail =
    observedSpread !== null
      ? `spread ${observedSpread.toFixed(3)}% (observed) vs limit ${cfg.maxSpreadPct}%`
      : estimatedSpread !== null
        ? `spread unavailable — estimated ${estimatedSpread.toFixed(3)}% (forex, not observed) vs limit ${cfg.maxSpreadPct}%`
        : "spread unavailable — no quote book, execution cost unknown";
  add("MAX_SPREAD", spreadOk, spreadDetail);

  // 8. Liquidity gate
  const liqOk = inp.notionalPerBar >= cfg.minLiquidityNotional;
  add("MIN_LIQUIDITY", liqOk, `notional/bar ${Math.round(inp.notionalPerBar)} vs min ${cfg.minLiquidityNotional}`);

  // 9. Position count sanity
  add("POSITION_COUNT", inp.openPositions < 5, `${inp.openPositions} open position(s) vs max 5`);

  // 10. Gross exposure headroom
  const headroom = cfg.maxGrossExposurePct - inp.openPositionExposurePct;
  add("GROSS_EXPOSURE", headroom >= cfg.maxPositionPct * 0.25, `headroom ${headroom.toFixed(1)}% vs needed ${cfg.maxPositionPct * 0.25}%`);

  // 11. Balance available
  add("BALANCE", inp.balance > 0, `available balance $${inp.balance.toFixed(2)}`);

  // 12. MIND must actually want a trade
  const mindTradeable = inp.mind.recommendedAction !== "WAIT" && inp.mind.direction !== "FLAT";
  add("MIND_ACTIONABLE", mindTradeable, `MIND recommends ${inp.mind.recommendedAction} (${inp.mind.direction})`);

  const failed = checks.filter((c) => !c.pass);
  const vetoed = failed.length > 0;
  const firstFail = failed[0];

  if (vetoed) {
    return {
      decision: "VETOED",
      reasonCode: firstFail?.rule ?? "UNKNOWN",
      message: firstFail?.detail ?? "risk rule failed",
      checks,
      approvedPositionSize: 0,
      timestamp: inp.now,
      engineVersion: "risk-v1",
    };
  }

  // Position sizing under risk controls
  const plan = buildTradePlan(inp.mind, inp.features, cfg, inp.equity, inp.entryPrice);
  if (!plan) {
    return {
      decision: "NO_TRADE",
      reasonCode: "NO_DIRECTION",
      message: "MIND direction is FLAT",
      checks,
      approvedPositionSize: 0,
      timestamp: inp.now,
      engineVersion: "risk-v1",
    };
  }

  let approvedSize = plan.positionSize;
  let reduced = false;

  // Apply MIND size recommendation
  approvedSize *= inp.mind.positionSizeRecommendation;

  // Cap by remaining gross-exposure headroom
  const headroomNotional = ((cfg.maxGrossExposurePct - inp.openPositionExposurePct) / 100) * inp.equity;
  const capByHeadroom = headroomNotional / inp.entryPrice;
  if (approvedSize > capByHeadroom) {
    approvedSize = capByHeadroom;
    reduced = true;
  }

  // Round down to 6 decimals
  approvedSize = Math.floor(approvedSize * 1e6) / 1e6;

  if (!Number.isFinite(approvedSize) || approvedSize <= 0) {
    return {
      decision: "VETOED",
      reasonCode: Number.isFinite(approvedSize) ? "SIZE_TOO_SMALL" : "SIZE_INVALID",
      message: "position size rounds to zero under current risk limits",
      checks,
      approvedPositionSize: 0,
      timestamp: inp.now,
      engineVersion: "risk-v1",
    };
  }

  return {
    decision: reduced ? "REDUCED" : "APPROVED",
    reasonCode: reduced ? "SIZE_REDUCED" : "ALL_CHECKS_PASS",
    message: reduced
      ? "approved with reduced size (exposure headroom)"
      : "all deterministic risk checks passed",
    checks,
    approvedPositionSize: approvedSize,
    timestamp: inp.now,
    engineVersion: "risk-v1",
  };
}

/** Execution validator: order-level checks AFTER risk approval (PRD §32). */
export function validateExecution(
  order: { symbol: string; side: "LONG" | "SHORT"; qty: number; type: "MARKET" },
  market: { bestBid: number | null; bestAsk: number | null; lastClose: number; spreadPct: number | null },
  config: AriseConfig,
): { ok: boolean; reasonCode: string; fillPrice: number } {
  const useBid = order.side === "LONG" ? market.bestBid : null;
  const useAsk = order.side === "LONG" ? null : market.bestAsk;
  const ref = useBid ?? useAsk ?? market.lastClose;
  // Finiteness is checked explicitly: `NaN <= 0` and `NaN > 0` are both false, so
  // an ordering-style guard alone would let NaN through.
  if (!Number.isFinite(ref) || !(ref > 0)) {
    return { ok: false, reasonCode: "NO_VALID_PRICE", fillPrice: 0 };
  }
  if (!Number.isFinite(order.qty) || !(order.qty > 0)) {
    return { ok: false, reasonCode: "INVALID_QTY", fillPrice: 0 };
  }
  if (market.spreadPct !== null && market.spreadPct > config.maxSpreadPct) {
    return { ok: false, reasonCode: "SPREAD_WIDE", fillPrice: 0 };
  }
  return { ok: true, reasonCode: "OK", fillPrice: ref };
}
