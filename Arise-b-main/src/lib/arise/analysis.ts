// ARISE — Analysis section: pure, deterministic support logic.
//
// This module contains no clock reads, no network and no Convex imports. Every
// function takes an explicit `now` so a rendered analysis can be reproduced and
// tested. Nothing here invents a price, a prediction, a provider status or a
// performance number: when the evidence required for a statement is missing the
// result says so (NO_TRADE / UNAVAILABLE / INSUFFICIENT_DATA).
//
// The hard risk controls remain in `risk.ts`; the AI layers cannot override them.
// The helpers below only DESCRIBE a decision or preview a deterministic sizing
// calculation. They never execute an order.

import { clamp } from "./math";
import { intervalMs } from "./quant";

// ---------------------------------------------------------------- trade plan card

export type AnalysisSide = "LONG" | "SHORT";
export type NoTradeReason =
  | "NO_DIRECTION"
  | "NO_PLAN"
  | "VETOED"
  | "DATA_NOT_VALID"
  | "EVIDENCE_REJECTED"
  | "ENTRY_WINDOW_EXPIRED";

export interface DecisionPlanLike {
  side?: string;
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  positionSize?: number;
  positionSizeQuote?: number;
  riskPerUnit?: number;
  maxLossQuote?: number;
  maxLossPct?: number;
}

export interface DecisionLike {
  _id?: string;
  symbol: string;
  interval: string;
  status: string;
  direction: string;
  confidence: number;
  thesis: string;
  recommendedAction: string;
  dataQuality: string;
  dataSource: string;
  dataTimestamp: number;
  plan?: DecisionPlanLike | null;
  risk?: { decision?: string; reasonCode?: string; message?: string; checks?: unknown[] } | null;
  evidence?: { outcome?: string; reasonCodes?: string[]; ceiling?: number } | null;
  features?: { volatility?: { atr14?: number; atrPct?: number } } | null;
  snapshotMeta?: { lastClose?: number; lastBarTime?: number } | null;
  agents?: Record<string, unknown> | null;
}

export interface PriceTarget {
  label: "TP1" | "TP2" | "TP3";
  price: number;
  rMultiple: number;
  derived: boolean;
}

export interface TradePlanCard {
  available: boolean;
  noTradeReason: NoTradeReason | null;
  noTradeDetail: string;
  side: AnalysisSide | null;
  entry: number | null;
  entryRange: { low: number; high: number } | null;
  stopLoss: number | null;
  targets: PriceTarget[];
  riskReward: number | null;
  entryConditions: string[];
  entryWindowExpiresAt: number | null;
  entryWindowExpired: boolean;
  estimatedHoldingBars: { min: number; max: number } | null;
  estimatedHoldingHours: { min: number; max: number } | null;
  closeConditions: string[];
  strategy: string | null;
  explanation: string;
  evidence: string[];
  dataQuality: string;
  provider: string;
  interval: string;
  createdAt: number;
  /** null unless the confidence has a stated, reproducible basis. */
  confidence: number | null;
  confidenceBasis: string | null;
  /** Clearly distinguishes a generated signal from an executed paper trade. */
  execution: "SIGNAL_ONLY";
}

const MODEL_VERSION = "analysis-v1";

/**
 * Turns a stored decision into a readable, fully-labelled trade card.
 *
 * TP1/TP2/TP3 are deterministic R-multiples of the plan's stop distance. TP2 is the
 * plan's own take-profit; TP1/TP3 are derived and marked `derived: true` so a reader
 * can never mistake them for levels the pipeline itself decided. Entry range is a
 * quoting band around the plan entry, not a promise that any price fills.
 */
export function buildTradePlanCard(decision: DecisionLike, now: number): TradePlanCard {
  const interval = decision.interval;
  const plan = decision.plan ?? null;
  const side = plan?.side === "LONG" || plan?.side === "SHORT"
    ? (plan.side as AnalysisSide)
    : decision.direction === "LONG" || decision.direction === "SHORT"
      ? (decision.direction as AnalysisSide)
      : null;
  const entry = finitePositive(plan?.entry) ? plan!.entry! : null;
  const stop = finitePositive(plan?.stopLoss) ? plan!.stopLoss! : null;
  const target = finitePositive(plan?.takeProfit) ? plan!.takeProfit! : null;
  const riskPerUnit = entry !== null && stop !== null ? Math.abs(entry - stop) : null;
  const qualityOk = decision.dataQuality === "valid" || decision.dataQuality === "degraded";
  const evidenceOutcome = decision.evidence?.outcome?.toUpperCase() ?? null;

  let noTradeReason: NoTradeReason | null = null;
  let noTradeDetail = "";
  if (decision.status === "VETOED") {
    noTradeReason = "VETOED";
    noTradeDetail = decision.risk?.message ?? "Deterministic risk controls vetoed this trade.";
  } else if (evidenceOutcome === "REJECT") {
    noTradeReason = "EVIDENCE_REJECTED";
    noTradeDetail = "The evidence gate rejected the trade; the original analysis is retained unchanged.";
  } else if (!qualityOk) {
    noTradeReason = "DATA_NOT_VALID";
    noTradeDetail = `Market data is ${decision.dataQuality}; no trade plan can be established.`;
  } else if (decision.direction === "FLAT" || !side) {
    noTradeReason = "NO_DIRECTION";
    noTradeDetail = "The analysis returned no directional edge. NO TRADE is a valid result.";
  } else if (entry === null || stop === null || target === null || riskPerUnit === null || riskPerUnit <= 0) {
    noTradeReason = "NO_PLAN";
    noTradeDetail = "No complete entry/stop/target plan was produced for this analysis.";
  }

  const entryWindowExpiresAt = entry !== null ? decision.dataTimestamp + 2 * intervalMs(interval) : null;
  const entryWindowExpired = entryWindowExpiresAt !== null && now > entryWindowExpiresAt;
  if (!noTradeReason && entryWindowExpired) {
    noTradeReason = "ENTRY_WINDOW_EXPIRED";
    noTradeDetail = "The entry window for this analysis has expired; re-run the analysis for a current plan.";
  }

  const available = noTradeReason === null;
  const entryRange = available && entry !== null
    ? {
        low: entry - Math.max(entry * 0.0005, (riskPerUnit ?? 0) * 0.1),
        high: entry + Math.max(entry * 0.0005, (riskPerUnit ?? 0) * 0.1),
      }
    : null;

  const targets: PriceTarget[] = [];
  if (available && entry !== null && side && riskPerUnit && riskPerUnit > 0) {
    const dir = side === "LONG" ? 1 : -1;
    targets.push({ label: "TP1", price: entry + dir * riskPerUnit, rMultiple: 1, derived: true });
    targets.push({
      label: "TP2",
      price: target as number,
      rMultiple: Math.abs((target as number) - entry) / riskPerUnit,
      derived: false,
    });
    targets.push({ label: "TP3", price: entry + dir * riskPerUnit * 3, rMultiple: 3, derived: true });
  }

  const reward = available && entry !== null && target !== null ? Math.abs(target - entry) : null;
  const riskReward = reward !== null && riskPerUnit && riskPerUnit > 0 ? reward / riskPerUnit : null;

  const barsPerHour = 3_600_000 / Math.max(1, intervalMs(interval));
  const estimatedHoldingBars = available ? { min: 2, max: 6 } : null;
  const estimatedHoldingHours = estimatedHoldingBars
    ? {
        min: Math.round((estimatedHoldingBars.min / barsPerHour) * 10) / 10,
        max: Math.round((estimatedHoldingBars.max / barsPerHour) * 10) / 10,
      }
    : null;

  const agents = decision.agents && typeof decision.agents === "object" ? Object.values(decision.agents) : [];
  const agentConfidences = agents
    .map((a) => (a && typeof a === "object" ? (a as { confidence?: unknown }).confidence : null))
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  const confidenceBasis = Number.isFinite(decision.confidence) && agentConfidences.length >= 5
    ? `heuristic-v1 ensemble: ${agentConfidences.length} agent confidences, MIND proposal ${(decision.confidence * 100).toFixed(0)}%, data-quality ceiling applied`
    : null;
  const confidence = available && confidenceBasis ? clamp(decision.confidence, 0, 1) : null;

  const evidence: string[] = [];
  const lastClose = decision.snapshotMeta?.lastClose;
  if (finitePositive(lastClose)) evidence.push(`Last validated close: ${formatPrice(lastClose!)} (${decision.dataSource})`);
  if (decision.features?.volatility?.atrPct != null && Number.isFinite(decision.features.volatility.atrPct)) {
    evidence.push(`ATR: ${decision.features.volatility.atrPct.toFixed(2)}% of price`);
  }
  if (decision.agents && typeof decision.agents === "object") {
    for (const [name, raw] of Object.entries(decision.agents).slice(0, 8)) {
      const agent = raw as { signal?: unknown; confidence?: unknown } | null;
      if (!agent || typeof agent.signal !== "string") continue;
      const pct = typeof agent.confidence === "number" && Number.isFinite(agent.confidence)
        ? ` ${Math.round(agent.confidence * 100)}%`
        : "";
      evidence.push(`AGENT ${name.toUpperCase()}: ${agent.signal}${pct}`);
    }
  }
  if (decision.risk?.checks && Array.isArray(decision.risk.checks)) {
    evidence.push(`${decision.risk.checks.length} deterministic risk checks recorded`);
  }
  if (decision.evidence?.reasonCodes && decision.evidence.reasonCodes.length > 0) {
    evidence.push(`Evidence reason codes: ${decision.evidence.reasonCodes.join(", ")}`);
  }
  evidence.push(`Provider: ${decision.dataSource}; timeframe: ${interval}; data quality: ${decision.dataQuality}`);

  return {
    available,
    noTradeReason,
    noTradeDetail,
    side: available ? side : null,
    entry: available ? entry : null,
    entryRange,
    stopLoss: available ? stop : null,
    targets,
    riskReward,
    entryConditions: available
      ? [
          `Enter only inside the quoted band around ${formatPrice(entry as number)} while the entry window is open.`,
          "Market data must remain valid and fresh at execution time.",
          "Deterministic risk checks must pass on the server at execution time.",
        ]
      : ["No entry: this analysis is NO TRADE."],
    entryWindowExpiresAt,
    entryWindowExpired,
    estimatedHoldingBars,
    estimatedHoldingHours,
    closeConditions: available
      ? [
          `Close immediately if price reaches the stop at ${formatPrice(stop as number)}.`,
          "Scale out at TP1/TP2; close the remainder at TP3 or when the thesis invalidation below occurs.",
          "Close if the thesis invalidation conditions are met or data becomes stale/invalid.",
          "Close at the end of the estimated holding window if the trade has not reached a target.",
        ]
      : ["No position exists, so there is nothing to close."],
    strategy: "ARISE decision pipeline (heuristic-v1 ensemble + MIND + evidence gate)",
    explanation: decision.thesis,
    evidence,
    dataQuality: decision.dataQuality,
    provider: decision.dataSource,
    interval,
    createdAt: decision.dataTimestamp,
    confidence,
    confidenceBasis,
    execution: "SIGNAL_ONLY",
  };
}

// ---------------------------------------------------------------- monitoring

export interface OpenPositionLike {
  _id?: string;
  symbol: string;
  side: string;
  qty: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  status: string;
  openedAt: number;
  closedAt?: number;
  exitPrice?: number;
  exitReason?: string;
  pnl?: number;
  entryFee?: number;
}

export interface MarkLike {
  symbol: string;
  price: number;
  time: number;
  interval: string;
  completed: boolean;
}

export type ThesisStatus = "INTACT" | "WEAKENED" | "INVALIDATED" | "TARGET_REACHED" | "UNKNOWN";

export interface MonitoringAssessment {
  status: "OK" | "UNAVAILABLE" | "STALE" | "PRE_ENTRY" | "INVALID";
  reason: string;
  monitoringAt: number;
  markTime: number | null;
  markAgeSec: number | null;
  currentPrice: number | null;
  predictedDirection: "LONG" | "SHORT" | "FLAT" | "UNKNOWN";
  currentDirection: "UP" | "DOWN" | "FLAT" | "UNKNOWN";
  followingPrediction: boolean | null;
  positionState: "OPEN" | "CLOSED" | "NONE";
  unrealizedPnl: number | null;
  unrealizedPct: number | null;
  realizedPnl: number | null;
  stopStatus: "NOT_HIT" | "HIT" | "UNKNOWN";
  targetStatus: "NOT_REACHED" | "REACHED" | "UNKNOWN";
  thesisStatus: ThesisStatus;
  invalidationReasons: string[];
  paperOnly: true;
}

/**
 * Compares one stored prediction (and its paper position, if any) with a mark that
 * occurred AFTER the entry. A bar older than the entry is never used: evaluating
 * post-entry performance with pre-entry candles is exactly the look-ahead error this
 * module exists to prevent. Stale or incomplete data yields UNAVAILABLE, never a
 * guessed result.
 */
export function assessMonitoring(input: {
  decision: DecisionLike;
  position?: OpenPositionLike | null;
  mark?: MarkLike | null;
  now: number;
  barStaleMultiplier?: number;
}): MonitoringAssessment {
  const { decision, position, mark, now } = input;
  const staleMultiplier = input.barStaleMultiplier ?? 3;
  const predictedDirection =
    decision.direction === "LONG" || decision.direction === "SHORT" || decision.direction === "FLAT"
      ? decision.direction
      : "UNKNOWN";

  const base: MonitoringAssessment = {
    status: "UNAVAILABLE",
    reason: "",
    monitoringAt: now,
    markTime: null,
    markAgeSec: null,
    currentPrice: null,
    predictedDirection,
    currentDirection: "UNKNOWN",
    followingPrediction: null,
    positionState: position ? (position.status === "CLOSED" ? "CLOSED" : "OPEN") : "NONE",
    unrealizedPnl: null,
    unrealizedPct: null,
    realizedPnl: position?.status === "CLOSED" ? positional(position.pnl) : null,
    stopStatus: "UNKNOWN",
    targetStatus: "UNKNOWN",
    thesisStatus: "UNKNOWN",
    invalidationReasons: [],
    paperOnly: true,
  };

  if (position?.status === "CLOSED") {
    return {
      ...base,
      status: "OK",
      reason: `Paper position closed (${position.exitReason ?? "UNKNOWN"}). Realised outcome is final.`,
      realizedPnl: positional(position.pnl),
      thesisStatus:
        position.exitReason === "STOP_LOSS"
          ? "INVALIDATED"
          : position.exitReason === "TAKE_PROFIT"
            ? "TARGET_REACHED"
            : "UNKNOWN",
    };
  }

  if (!mark) {
    return { ...base, reason: "No market observation is available; monitoring cannot be evaluated." };
  }
  if (!Number.isFinite(mark.price) || mark.price <= 0 || !Number.isFinite(mark.time) || mark.time <= 0) {
    return { ...base, status: "INVALID", reason: "The market observation is not a valid price/time." };
  }

  const entryTime = position?.openedAt ?? decision.dataTimestamp;
  if (mark.time < entryTime) {
    return {
      ...base,
      status: "PRE_ENTRY",
      reason: "The latest observation predates the paper entry; post-entry performance is not evaluated.",
      markTime: mark.time,
      currentPrice: mark.price,
    };
  }
  if (!mark.completed) {
    return {
      ...base,
      status: "STALE",
      reason: "The latest candle is still forming; it is not a completed observation.",
      markTime: mark.time,
      currentPrice: mark.price,
    };
  }

  const interval = mark.interval || decision.interval;
  const ageMs = now - mark.time;
  const ageSec = Math.max(0, ageMs / 1000);
  if (ageMs < 0) {
    return { ...base, status: "INVALID", reason: "The observation is future-dated.", markTime: mark.time, currentPrice: mark.price };
  }
  if (ageMs > staleMultiplier * intervalMs(interval)) {
    return {
      ...base,
      status: "STALE",
      reason: `The latest completed candle is ${Math.round(ageSec / 60)}m old (limit ${staleMultiplier}× ${interval}).`,
      markTime: mark.time,
      markAgeSec: ageSec,
      currentPrice: mark.price,
    };
  }

  const reference = position?.entryPrice ?? decision.snapshotMeta?.lastClose ?? null;
  if (!finitePositive(reference)) {
    return { ...base, reason: "No entry/reference price is available for a directional comparison." };
  }

  const delta = mark.price - reference;
  const flatBand = reference * 0.0005;
  const currentDirection = delta > flatBand ? "UP" : delta < -flatBand ? "DOWN" : "FLAT";
  const followingPrediction =
    predictedDirection === "FLAT"
      ? currentDirection === "FLAT"
      : predictedDirection === "LONG"
        ? currentDirection === "UP"
        : predictedDirection === "SHORT"
          ? currentDirection === "DOWN"
          : null;

  let unrealizedPnl: number | null = null;
  let unrealizedPct: number | null = null;
  let stopStatus: MonitoringAssessment["stopStatus"] = "UNKNOWN";
  let targetStatus: MonitoringAssessment["targetStatus"] = "UNKNOWN";
  let thesisStatus: ThesisStatus = "UNKNOWN";
  const invalidationReasons: string[] = [];

  if (position) {
    const side = position.side === "SHORT" ? "SHORT" : "LONG";
    const dir = side === "LONG" ? 1 : -1;
    const gross = (mark.price - position.entryPrice) * position.qty * dir;
    const estimatedExitFee = (mark.price * position.qty * 4) / 10_000;
    unrealizedPnl = gross - (position.entryFee ?? 0) - estimatedExitFee;
    const notional = position.entryPrice * position.qty;
    unrealizedPct = notional > 0 ? (unrealizedPnl / notional) * 100 : null;

    const riskDistance = Math.abs(position.entryPrice - position.stopLoss);
    const stopHit = side === "LONG" ? mark.price <= position.stopLoss : mark.price >= position.stopLoss;
    const targetHit = side === "LONG" ? mark.price >= position.takeProfit : mark.price <= position.takeProfit;
    stopStatus = stopHit ? "HIT" : "NOT_HIT";
    targetStatus = targetHit ? "REACHED" : "NOT_REACHED";
    if (stopHit) {
      thesisStatus = "INVALIDATED";
      invalidationReasons.push("Price is at/beyond the predefined stop-loss level.");
    } else if (targetHit) {
      thesisStatus = "TARGET_REACHED";
    } else if (riskDistance > 0) {
      const adverse = side === "LONG" ? position.entryPrice - mark.price : mark.price - position.entryPrice;
      if (adverse >= riskDistance * 0.5) {
        thesisStatus = "WEAKENED";
        invalidationReasons.push("Price has consumed at least half of the stop distance.");
      } else {
        thesisStatus = "INTACT";
      }
    }
  } else {
    thesisStatus = predictedDirection === "FLAT" ? "INTACT" : followingPrediction ? "INTACT" : "WEAKENED";
    if (predictedDirection !== "FLAT" && followingPrediction === false) {
      invalidationReasons.push("Price has moved against the original directional prediction since the analysis.");
    }
  }

  return {
    ...base,
    status: "OK",
    reason:
      thesisStatus === "INVALIDATED"
        ? "The original thesis is invalidated by the predefined stop; risk rules govern the exit."
        : thesisStatus === "WEAKENED"
          ? "The thesis is weakened but not invalidated; no new risk is added to defend it."
          : "Monitoring uses a completed, post-entry observation.",
    markTime: mark.time,
    markAgeSec: ageSec,
    currentPrice: mark.price,
    currentDirection,
    followingPrediction,
    unrealizedPnl,
    unrealizedPct,
    stopStatus,
    targetStatus,
    thesisStatus,
    invalidationReasons,
  };
}

// ---------------------------------------------------------------- risk preview

export interface RiskPreviewInput {
  side: AnalysisSide;
  entry: number;
  atr: number;
  equity: number;
  balance: number;
  dayStartEquity: number;
  highWaterMark: number;
  openNotional: number;
  openPositions: number;
  emergencyStop: boolean;
  config: {
    riskPerTradePct: number;
    maxPositionPct: number;
    maxGrossExposurePct: number;
    maxDailyLossPct: number;
    maxDrawdownPct: number;
  };
  feeBps?: number;
  slippageBps?: number;
}

export interface RiskCheckView {
  rule: string;
  pass: boolean;
  detail: string;
}

export interface RiskPreview {
  decision: "APPROVED" | "REDUCED" | "NO_TRADE";
  reasonCode: string;
  message: string;
  checks: RiskCheckView[];
  stopLoss: number | null;
  stopDistance: number | null;
  targets: PriceTarget[];
  riskReward: number | null;
  qty: number;
  notional: number;
  riskAmount: number;
  riskPct: number;
  exposurePct: number;
  estimatedCosts: number;
  assumptions: string[];
  engineVersion: string;
  /** The preview is descriptive; it never submits an order. */
  execution: "SIGNAL_ONLY";
}

/**
 * Deterministic risk preview. It mirrors the live risk engine's sizing convention
 * (ATR stop clamped to 0.4–6% of entry, risk-per-trade budget, position/exposure
 * caps, 1x leverage) and adds explicit fee/slippage costs. A failing hard control
 * returns NO_TRADE — there is no override parameter.
 */
export function computeRiskPreview(input: RiskPreviewInput): RiskPreview {
  const cfg = input.config;
  const feeBps = input.feeBps ?? 4;
  const slippageBps = input.slippageBps ?? 2;
  const checks: RiskCheckView[] = [];
  const add = (rule: string, pass: boolean, detail: string) => checks.push({ rule, pass, detail });

  const finite = [
    input.entry,
    input.atr,
    input.equity,
    input.balance,
    input.dayStartEquity,
    input.highWaterMark,
    input.openNotional,
  ].every((v) => Number.isFinite(v));
  add(
    "INPUT_VALID",
    finite && input.entry > 0 && input.equity > 0 && input.atr > 0,
    finite && input.entry > 0 && input.equity > 0 && input.atr > 0
      ? "entry, ATR, equity, balance and exposure are finite and positive"
      : "non-finite or non-positive risk input",
  );

  const dailyLoss = input.dayStartEquity > 0
    ? Math.max(0, ((input.dayStartEquity - input.equity) / input.dayStartEquity) * 100)
    : 0;
  const drawdown = input.highWaterMark > 0
    ? Math.max(0, ((input.highWaterMark - input.equity) / input.highWaterMark) * 100)
    : 0;
  const exposurePct = input.equity > 0 ? (input.openNotional / input.equity) * 100 : 0;

  add("EMERGENCY_STOP", !input.emergencyStop, input.emergencyStop ? "paper-trading pause is active" : "pause is clear");
  add("MAX_DAILY_LOSS", dailyLoss < cfg.maxDailyLossPct, `${dailyLoss.toFixed(2)}% vs ${cfg.maxDailyLossPct}% limit`);
  add("MAX_DRAWDOWN", drawdown < cfg.maxDrawdownPct, `${drawdown.toFixed(2)}% vs ${cfg.maxDrawdownPct}% limit`);
  add("MAX_POSITIONS", input.openPositions < 5, `${input.openPositions} open vs max 5`);
  add(
    "GROSS_EXPOSURE",
    exposurePct < cfg.maxGrossExposurePct,
    `${exposurePct.toFixed(1)}% vs ${cfg.maxGrossExposurePct}% limit`,
  );

  const stopDistance = clamp(input.atr * 1.5, input.entry * 0.004, input.entry * 0.06);
  const sideDir = input.side === "LONG" ? 1 : -1;
  const stopLoss = input.entry - sideDir * stopDistance;

  const costPerUnit = (input.entry * 2 * (feeBps + slippageBps)) / 10_000;
  const riskBudget = (cfg.riskPerTradePct / 100) * input.equity;
  const headroomPct = Math.max(0, cfg.maxGrossExposurePct - exposurePct);
  const exposureBudget = (headroomPct / 100) * input.equity;
  const positionBudget = (cfg.maxPositionPct / 100) * input.equity;

  const qtyByRisk = riskBudget / (stopDistance + costPerUnit);
  const qtyByExposure = exposureBudget / input.entry;
  const qtyByPosition = positionBudget / input.entry;
  const qtyByBalance = input.balance / (input.entry + costPerUnit);
  const rawQty = Math.min(qtyByRisk, qtyByExposure, qtyByPosition, qtyByBalance);
  const qty = Number.isFinite(rawQty) && rawQty > 0 ? Math.floor(rawQty * 1e6) / 1e6 : 0;
  const notional = qty * input.entry;
  const riskAmount = qty * (stopDistance + costPerUnit);
  const estimatedCosts = qty * costPerUnit;

  const hardFailure = checks.some((c) => !c.pass);
  const reduced = !hardFailure && qty > 0 && qty < qtyByRisk - 1e-9;
  const decision: RiskPreview["decision"] = hardFailure || qty <= 0 ? "NO_TRADE" : reduced ? "REDUCED" : "APPROVED";

  const targets: PriceTarget[] = decision === "NO_TRADE"
    ? []
    : [
        { label: "TP1", price: input.entry + sideDir * stopDistance, rMultiple: 1, derived: true },
        { label: "TP2", price: input.entry + sideDir * stopDistance * 2, rMultiple: 2, derived: true },
        { label: "TP3", price: input.entry + sideDir * stopDistance * 3, rMultiple: 3, derived: true },
      ];

  const firstFail = checks.find((c) => !c.pass);
  return {
    decision,
    reasonCode:
      decision === "NO_TRADE"
        ? firstFail?.rule ?? "SIZE_TOO_SMALL"
        : decision === "REDUCED"
          ? "SIZE_REDUCED"
          : "ALL_CHECKS_PASS",
    message:
      decision === "NO_TRADE"
        ? firstFail?.detail ?? "position size rounds to zero under the configured limits"
        : decision === "REDUCED"
          ? "approved at a reduced size by position/exposure/balance caps"
          : "all deterministic preview checks passed",
    checks,
    stopLoss: decision === "NO_TRADE" ? null : stopLoss,
    stopDistance,
    targets,
    riskReward: decision === "NO_TRADE" ? null : 2,
    qty: decision === "NO_TRADE" ? 0 : qty,
    notional: decision === "NO_TRADE" ? 0 : notional,
    riskAmount: decision === "NO_TRADE" ? 0 : riskAmount,
    riskPct: input.equity > 0 && decision !== "NO_TRADE" ? (riskAmount / input.equity) * 100 : 0,
    exposurePct: input.equity > 0 && decision !== "NO_TRADE" ? exposurePct + (notional / input.equity) * 100 : exposurePct,
    estimatedCosts: decision === "NO_TRADE" ? 0 : estimatedCosts,
    assumptions: [
      `ATR(14) × 1.5 stop, clamped to 0.4%–6% of entry (ATR ${input.atr.toPrecision(6)}).`,
      `Risk budget ${cfg.riskPerTradePct}% of equity; max position ${cfg.maxPositionPct}%; max gross exposure ${cfg.maxGrossExposurePct}%.`,
      `Costs modelled at ${feeBps} bps fee + ${slippageBps} bps slippage per side; 1x leverage, no compounding.`,
      "Position size is floored to 6 decimals; no stop is ever widened to avoid a loss.",
      "Preview only — no order is placed and the server re-checks every control at execution.",
    ],
    engineVersion: "risk-preview-v1",
    execution: "SIGNAL_ONLY",
  };
}

// ---------------------------------------------------------------- performance

// ---------------------------------------------------------------- arena risk gate

export interface ArenaRiskVeto {
  id: string;
  label: string;
  reasonCode: string;
  message: string;
}

/**
 * Stage 4 of the arena is a veto, not advice. When the deterministic risk review
 * returns NO_TRADE, the strongest historical strategy is NOT eligible: the caller
 * must clear the selection and report NO TRADE. Keeping the selection would let a
 * risk-blocked strategy be presented (and saved) as the winner.
 */
export function arenaRiskVeto(
  selected: { id: string; label: string } | null,
  review: { decision: string; reasonCode: string; message: string } | null,
): ArenaRiskVeto | null {
  if (!selected || !review || review.decision !== "NO_TRADE") return null;
  return {
    id: selected.id,
    label: selected.label,
    reasonCode: review.reasonCode,
    message: review.message,
  };
}

export interface PerformanceRecordLike {
  decisionId: string;
  symbol: string;
  interval: string;
  direction: string;
  status: string;
  confidence: number;
  dataTimestamp: number;
  snapshotMeta?: { lastClose?: number } | null;
  strategy?: { selectedId?: string; selectedLabel?: string } | null;
}

export interface PerformancePositionLike {
  _id: string;
  decisionId?: string;
  symbol: string;
  side: string;
  status: string;
  pnl?: number;
  entryFee?: number;
  exitFee?: number;
  openedAt: number;
  closedAt?: number;
  exitReason?: string;
}

export interface PerformanceMetrics {
  trades: number;
  evaluatedPredictions: number;
  accuracyPct: number | null;
  calibration: null;
  winRatePct: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  maxDrawdownPct: number | null;
  totalFees: number | null;
  periodStart: number | null;
  periodEnd: number | null;
  evidenceSufficient: boolean;
}

export interface PerformanceBreakdown extends PerformanceMetrics {
  key: string;
  label: string;
}

export interface PerformanceReport {
  overall: PerformanceMetrics;
  byStrategy: PerformanceBreakdown[];
  byMarket: PerformanceBreakdown[];
  byTimeframe: PerformanceBreakdown[];
  notes: string[];
  evidenceStandard: string;
}

/**
 * Measures saved predictions against later observations of the same market, and
 * paper trades against their realised P&L. It reports null (not zero) when no
 * observation/evaluation exists, and marks the sample insufficient below 20
 * predictions or 20 closed trades. No metric is estimated or back-filled.
 */
export function computePerformance(
  records: PerformanceRecordLike[],
  positions: PerformancePositionLike[],
  equityPoints: { t: number; equity: number }[] = [],
): PerformanceReport {
  const sorted = [...records].sort((a, b) => a.dataTimestamp - b.dataTimestamp);
  const predictions: { at: number; direction: string; reference: number | null; symbol: string }[] = [];

  for (const r of sorted) {
    const close = r.snapshotMeta?.lastClose;
    if (typeof close === "number" && Number.isFinite(close) && close > 0) {
      predictions.push({
        at: r.dataTimestamp,
        direction: r.direction,
        reference: close,
        symbol: r.symbol,
      });
    }
  }

  let hits = 0;
  let evaluated = 0;
  for (let i = 0; i < predictions.length; i++) {
    const p = predictions[i];
    if (p.direction !== "LONG" && p.direction !== "SHORT") continue;
    if (p.reference === null) continue;
    // The next observation of the SAME symbol that is strictly later. Records are
    // timestamped; no observation is ever reused as both prediction and outcome.
    const next = predictions
      .slice(i + 1)
      .find((candidate) => candidate.symbol === p.symbol && candidate.at > p.at && candidate.reference !== null);
    if (!next || next.reference === null) continue;
    evaluated += 1;
    const up = next.reference > p.reference;
    if ((p.direction === "LONG" && up) || (p.direction === "SHORT" && !up)) hits += 1;
  }

  const closed = positions.filter((p) => p.status === "CLOSED" && typeof p.pnl === "number");
  const summary = summarize(closed, predictions, evaluated > 0 ? (hits / evaluated) * 100 : null, evaluated, equityPoints);
  const insufficient = evaluated < 20 || closed.length < 20;

  const groups = (keyOf: (p: PerformancePositionLike) => string): PerformanceBreakdown[] => {
    const buckets = new Map<string, PerformancePositionLike[]>();
    for (const p of closed) {
      const key = keyOf(p);
      buckets.set(key, [...(buckets.get(key) ?? []), p]);
    }
    return [...buckets.entries()]
      .map(([key, rows]) => ({
        key,
        label: key,
        ...summarize(rows, predictions, null, 0, []),
        evidenceSufficient: rows.length >= 20,
      }))
      .sort((a, b) => b.trades - a.trades);
  };

  const strategyByDecision = new Map(records.map((r) => [r.decisionId, r.strategy?.selectedId ?? "pipeline"]));
  const intervalByDecision = new Map(records.map((r) => [r.decisionId, r.interval]));
  const notes = [
    "Directional accuracy compares a saved prediction with the next saved observation of the same symbol; NO TRADE predictions are excluded.",
    "A successful provider or AI response is not treated as predictive accuracy; only measured outcomes count.",
    "Calibration is not reported because the pipeline does not emit calibrated probabilities.",
    "Samples below 20 evaluated predictions or 20 closed trades are labelled insufficient, not 'working'.",
  ];
  if (evaluated === 0) notes.push("No later observation exists yet — directional accuracy is unavailable.");
  if (closed.length === 0) notes.push("No closed paper trades exist yet — trade metrics are unavailable.");

  return {
    overall: { ...summary, evidenceSufficient: !insufficient },
    byStrategy: groups((p) =>
      p.decisionId ? strategyByDecision.get(p.decisionId) ?? "unattributed" : "unattributed",
    ),
    byMarket: groups((p) => p.symbol),
    byTimeframe: groups((p) =>
      p.decisionId ? intervalByDecision.get(p.decisionId) ?? "unattributed" : "unattributed",
    ),
    notes,
    evidenceStandard: "Minimum 20 evaluated predictions AND 20 closed paper trades before performance is presented as evidence.",
  };
}

function summarize(
  closed: PerformancePositionLike[],
  predictions: { at: number; direction: string }[],
  accuracyPct: number | null,
  evaluatedPredictions: number,
  equityPoints: { t: number; equity: number }[],
): Omit<PerformanceMetrics, "evidenceSufficient"> {
  const pnls = closed.map((p) => p.pnl as number);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const times = [
    ...closed.flatMap((p) => [p.openedAt, p.closedAt ?? p.openedAt]),
    ...predictions.map((p) => p.at),
  ].filter((t) => Number.isFinite(t));

  const points = [...equityPoints].sort((a, b) => a.t - b.t);
  let peak = 0;
  let maxDd = 0;
  for (const point of points) {
    if (!Number.isFinite(point.equity) || point.equity <= 0) continue;
    peak = Math.max(peak, point.equity);
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - point.equity) / peak) * 100);
  }

  return {
    trades: closed.length,
    evaluatedPredictions,
    accuracyPct: evaluatedPredictions >= 5 ? accuracyPct : null,
    calibration: null,
    winRatePct: closed.length > 0 ? (wins.length / closed.length) * 100 : null,
    // Null (not Infinity) when there are no losing trades: a JSON-safe value that
    // the UI can label "n/a — no losses in sample" instead of a fake number.
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: closed.length > 0 ? pnls.reduce((a, b) => a + b, 0) / closed.length : null,
    avgWin: wins.length > 0 ? grossWin / wins.length : null,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : null,
    maxDrawdownPct: points.length > 1 ? maxDd : null,
    totalFees: closed.length > 0
      ? closed.reduce((a, p) => a + (p.entryFee ?? 0) + (p.exitFee ?? 0), 0)
      : null,
    periodStart: times.length > 0 ? Math.min(...times) : null,
    periodEnd: times.length > 0 ? Math.max(...times) : null,
  };
}

// ---------------------------------------------------------------- catalysts

export type CatalystCertainty = "CONFIRMED" | "FORECAST" | "SPECULATION";
export type CatalystImportance = "HIGH" | "MEDIUM" | "LOW";

export interface RawCatalyst {
  title?: unknown;
  scheduledAt?: unknown; // epoch ms or ISO string
  timeZone?: unknown;
  source?: unknown;
  sourceUrl?: unknown;
  lastUpdatedAt?: unknown;
  affectedAssets?: unknown;
  importance?: unknown;
  certainty?: unknown;
  consensus?: unknown;
  scenarios?: unknown;
  risks?: unknown;
}

export interface CatalystEvent {
  title: string;
  scheduledAt: number;
  timeZone: string;
  source: string;
  sourceUrl: string;
  lastUpdatedAt: number;
  affectedAssets: string[];
  importance: CatalystImportance;
  certainty: CatalystCertainty;
  consensus: string | null;
  scenarios: { bullish: string; bearish: string; uncertain: string } | null;
  risks: string[];
  ageSec: number;
  stale: boolean;
}

export type CatalystStatus = "CONFIGURED" | "UNCONFIGURED" | "EMPTY" | "STALE" | "INVALID";

export interface CatalystView {
  status: CatalystStatus;
  events: CatalystEvent[];
  notes: string[];
  fetchedAt: number;
  provider: string | null;
  configured: boolean;
  maxEvents: number;
}

/**
 * Validates an upcoming-catalyst feed. Every event must carry a source, a clickable
 * source URL, a scheduled timestamp and a timezone; undated/unverified items are
 * discarded rather than guessed. Events in the past, beyond 400 days, or with an
 * unparseable date are rejected. The view returns at most three items.
 */
export function buildCatalystView(input: {
  configured: boolean;
  provider?: string | null;
  raw?: unknown;
  now: number;
  fetchedAt?: number;
  maxEvents?: number;
}): CatalystView {
  const maxEvents = Math.max(1, Math.min(3, input.maxEvents ?? 3));
  const base: CatalystView = {
    status: input.configured ? "EMPTY" : "UNCONFIGURED",
    events: [],
    notes: [],
    fetchedAt: input.fetchedAt ?? input.now,
    provider: input.provider ?? null,
    configured: input.configured,
    maxEvents,
  };
  if (!input.configured) {
    return {
      ...base,
      notes: [
        "No economic-calendar provider is configured. No upcoming events are shown because none can be verified.",
        "Set ECONOMIC_CALENDAR_URL (and ECONOMIC_CALENDAR_API_KEY if required by the provider) to enable this feed.",
      ],
    };
  }
  if (input.raw === undefined || input.raw === null) {
    return { ...base, status: "INVALID", notes: ["The configured provider returned no usable payload."] };
  }

  const raw = input.raw as { events?: unknown } | unknown[];
  const rows: RawCatalyst[] = Array.isArray(raw)
    ? (raw as RawCatalyst[])
    : raw && typeof raw === "object" && Array.isArray((raw as { events?: unknown }).events)
      ? ((raw as { events: RawCatalyst[] }).events)
      : [];
  if (rows.length === 0) {
    return { ...base, status: "EMPTY", notes: ["The provider returned zero events; nothing is invented."] };
  }

  const notes: string[] = [];
  let invalid = 0;
  let past = 0;
  let farFuture = 0;
  const seen = new Set<string>();
  const events: CatalystEvent[] = [];

  for (const item of rows.slice(0, 100)) {
    const scheduledAt = toEpoch(item.scheduledAt);
    const lastUpdatedAt = toEpoch(item.lastUpdatedAt);
    const title = typeof item.title === "string" ? item.title.trim().slice(0, 300) : "";
    const source = typeof item.source === "string" ? item.source.trim().slice(0, 120) : "";
    const sourceUrl = typeof item.sourceUrl === "string" ? item.sourceUrl.trim() : "";
    const timeZone = typeof item.timeZone === "string" ? item.timeZone.trim().slice(0, 60) : "";
    if (
      title.length < 3 ||
      scheduledAt === null ||
      lastUpdatedAt === null ||
      !source ||
      !timeZone ||
      !/^https?:\/\//i.test(sourceUrl)
    ) {
      invalid += 1;
      continue;
    }
    if (scheduledAt < input.now - 60_000) {
      past += 1;
      continue;
    }
    if (scheduledAt > input.now + 400 * 86_400_000) {
      farFuture += 1;
      continue;
    }
    const key = `${title.toLowerCase()}|${scheduledAt}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const importance = normalizeImportance(item.importance);
    const certainty = normalizeCertainty(item.certainty);
    const scenarios = normalizeScenarios(item.scenarios);
    const affectedAssets = Array.isArray(item.affectedAssets)
      ? item.affectedAssets.filter((a): a is string => typeof a === "string").slice(0, 8)
      : [];
    events.push({
      title,
      scheduledAt,
      timeZone,
      source,
      sourceUrl,
      lastUpdatedAt,
      affectedAssets,
      importance,
      certainty,
      consensus: typeof item.consensus === "string" && item.consensus.trim() ? item.consensus.trim().slice(0, 300) : null,
      scenarios,
      risks: Array.isArray(item.risks) ? item.risks.filter((r): r is string => typeof r === "string").slice(0, 5) : [],
      ageSec: Math.max(0, (input.now - lastUpdatedAt) / 1000),
      stale: input.now - lastUpdatedAt > 7 * 86_400_000,
    });
  }

  if (invalid > 0) notes.push(`${invalid} event(s) rejected for missing/invalid title, timestamp, source, URL or timezone.`);
  if (past > 0) notes.push(`${past} past event(s) excluded — this feed is for upcoming catalysts only.`);
  if (farFuture > 0) notes.push(`${farFuture} event(s) beyond the 400-day horizon excluded.`);

  const early = events.filter((e) => !e.stale);
  const stale = events.filter((e) => e.stale);
  if (early.length === 0 && stale.length > 0) {
    return {
      ...base,
      status: "STALE",
      notes: [...notes, "All verified events are older than 7 days since last update and are not shown as current catalysts."],
    };
  }
  if (early.length === 0) {
    return {
      ...base,
      status: "EMPTY",
      notes: [...notes, "No verified upcoming event remains after validation."],
    };
  }
  if (stale.length > 0) notes.push(`${stale.length} stale event(s) excluded from the top three.`);

  const importanceRank: Record<CatalystImportance, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const ranked = [...early].sort(
    (a, b) => a.scheduledAt - b.scheduledAt || importanceRank[a.importance] - importanceRank[b.importance],
  );

  return {
    ...base,
    status: "CONFIGURED",
    events: ranked.slice(0, maxEvents),
    notes,
  };
}

// ---------------------------------------------------------------- module health

export type ModuleState = "HEALTHY" | "DEGRADED" | "STALE" | "UNCONFIGURED" | "OFFLINE" | "NOT_RUN";

export interface ModuleHealth {
  id: string;
  label: string;
  kind: "RULE_BASED" | "PROVIDER" | "DERIVED";
  state: ModuleState;
  configured: boolean;
  reachable: boolean;
  lastRunAt: number | null;
  lastRunOk: boolean | null;
  dataFresh: boolean | null;
  detail: string;
}

export interface ModuleHealthInput {
  now: number;
  latestDecision: DecisionLike | null;
  latestRecord: { createdAt: number; strategy?: { selectedId?: string } | null } | null;
  monitor: { state: string; lastTickAt: number | null; detail: string } | null;
  account: { emergencyStop: boolean } | null;
  catalysts: CatalystView | null;
  arenaRanAt: number | null;
  providerFailureCount: number;
  providerEventAt: number | null;
}

/**
 * Builds the honesty layer for the Analysis dashboard. Each statement requires its
 * own evidence: a configured module is not "reachable" until a run is on record, a
 * provider is not "healthy" because an API key exists, and an analysis is not
 * "accurate" because it succeeded.
 */
export function buildModuleHealth(input: ModuleHealthInput): ModuleHealth[] {
  const d = input.latestDecision;
  const decisionAge = d ? input.now - d.dataTimestamp : null;
  const dataFresh = d && decisionAge !== null
    ? decisionAge >= 0 && decisionAge <= 3 * intervalMs(d.interval) && (d.dataQuality === "valid" || d.dataQuality === "degraded")
    : null;
  const decisionOk = d ? d.status !== "ERROR" : null;
  const riskOk = d?.risk?.checks
    ? Array.isArray(d.risk.checks) && d.risk.checks.length > 0
    : null;

  const stateOf = (configured: boolean, reachable: boolean, ok: boolean | null, fresh: boolean | null): ModuleState => {
    if (!configured) return "UNCONFIGURED";
    if (!reachable) return "OFFLINE";
    if (ok === false) return "DEGRADED";
    if (fresh === false) return "STALE";
    return "HEALTHY";
  };

  const modules: ModuleHealth[] = [
    {
      id: "trade-analysis",
      label: "Trade Analysis AI",
      kind: "RULE_BASED",
      state: stateOf(true, Boolean(d), decisionOk, dataFresh),
      configured: true,
      reachable: Boolean(d),
      lastRunAt: d?.dataTimestamp ?? null,
      lastRunOk: decisionOk,
      dataFresh,
      detail: d
        ? `heuristic-v1 ensemble + MIND + evidence gate. Last decision ${d.status} on ${d.symbol}/${d.interval}; data ${d.dataQuality}.`
        : "No analysis has been run yet. Run one from the Trade Analysis tab.",
    },
    {
      id: "monitoring",
      label: "Monitoring AI",
      kind: "RULE_BASED",
      state: input.monitor ? (input.monitor.state as ModuleState) : "NOT_RUN",
      configured: true,
      reachable: Boolean(input.monitor?.lastTickAt),
      lastRunAt: input.monitor?.lastTickAt ?? null,
      lastRunOk: input.monitor ? input.monitor.state === "HEALTHY" : null,
      dataFresh: input.monitor?.lastTickAt ? input.now - input.monitor.lastTickAt < 15 * 60_000 : null,
      detail: input.monitor?.detail ?? "The background monitor has not recorded a run yet.",
    },
    {
      id: "risk",
      label: "Risk AI",
      kind: "RULE_BASED",
      state: stateOf(true, Boolean(d), riskOk, dataFresh),
      configured: true,
      reachable: Boolean(d),
      lastRunAt: d?.dataTimestamp ?? null,
      lastRunOk: riskOk,
      dataFresh,
      detail: d?.risk
        ? `Deterministic risk engine (not AI): ${d.risk.decision ?? "UNKNOWN"}${d.risk.reasonCode ? ` · ${d.risk.reasonCode}` : ""}. AI cannot override it.`
        : "No risk evaluation is on record yet.",
    },
    {
      id: "arena",
      label: "Strategy AI Arena",
      kind: "RULE_BASED",
      state: input.arenaRanAt ? "HEALTHY" : "NOT_RUN",
      configured: true,
      reachable: Boolean(input.arenaRanAt),
      lastRunAt: input.arenaRanAt,
      lastRunOk: input.arenaRanAt ? true : null,
      dataFresh: input.arenaRanAt ? input.now - input.arenaRanAt < 24 * 3_600_000 : null,
      detail: input.arenaRanAt
        ? `Ten rule-based strategies compared on one validated series. Last run ${new Date(input.arenaRanAt).toISOString()}.`
        : "No arena run on record. Rankings are not displayed until a run completes.",
    },
  ];

  if (input.catalysts) {
    modules.push({
      id: "news",
      label: "News AI",
      kind: "PROVIDER",
      state: input.catalysts.status === "CONFIGURED" ? "HEALTHY" : input.catalysts.status === "STALE" ? "STALE" : "UNCONFIGURED",
      configured: input.catalysts.configured,
      reachable: input.catalysts.status === "CONFIGURED" || input.catalysts.status === "EMPTY" || input.catalysts.status === "STALE",
      lastRunAt: input.catalysts.fetchedAt,
      lastRunOk: input.catalysts.status === "CONFIGURED" || input.catalysts.status === "EMPTY",
      dataFresh: input.catalysts.status === "CONFIGURED",
      detail:
        input.catalysts.status === "CONFIGURED"
          ? `${input.catalysts.events.length} verified upcoming catalyst(s) from ${input.catalysts.provider ?? "configured provider"}. Headline scoring is a fixed lexicon (news-v1), not an LLM.`
          : input.catalysts.notes[0] ?? "Upcoming-catalyst feed is not available.",
    });
  }

  modules.push({
    id: "market-data",
    label: "Market-data providers",
    kind: "PROVIDER",
    state: input.providerFailureCount > 0 ? "DEGRADED" : d ? "HEALTHY" : "OFFLINE",
    configured: true,
    reachable: Boolean(d),
    lastRunAt: input.providerEventAt ?? d?.dataTimestamp ?? null,
    lastRunOk: input.providerFailureCount === 0 ? true : false,
    dataFresh,
    detail: d
      ? `Provider ${d.dataSource} served the last analysis. ${input.providerFailureCount} recent data failure event(s); fallback data is never counted as primary evidence.`
      : "No provider fetch is on record yet.",
  });

  return modules;
}

// ---------------------------------------------------------------- helpers

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function positional(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatPrice(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function toEpoch(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function normalizeImportance(value: unknown): CatalystImportance {
  const level = typeof value === "string" ? value.toUpperCase() : "";
  return level === "HIGH" || level === "MEDIUM" || level === "LOW" ? level : "LOW";
}

function normalizeCertainty(value: unknown): CatalystCertainty {
  const level = typeof value === "string" ? value.toUpperCase() : "";
  return level === "CONFIRMED" || level === "FORECAST" || level === "SPECULATION" ? level : "SPECULATION";
}

function normalizeScenarios(value: unknown): CatalystEvent["scenarios"] {
  if (!value || typeof value !== "object") return null;
  const v = value as { bullish?: unknown; bearish?: unknown; uncertain?: unknown };
  if (typeof v.bullish !== "string" || typeof v.bearish !== "string" || typeof v.uncertain !== "string") {
    return null;
  }
  return {
    bullish: v.bullish.slice(0, 300),
    bearish: v.bearish.slice(0, 300),
    uncertain: v.uncertain.slice(0, 300),
  };
}

export const ANALYSIS_MODEL_VERSION = MODEL_VERSION;
