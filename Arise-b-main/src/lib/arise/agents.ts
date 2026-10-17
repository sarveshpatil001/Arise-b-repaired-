// ARISE V1 — specialized AI agents (deterministic heuristic engines, "ai v1").
// Each agent has a NARROW responsibility, a fixed input context, and a structured
// output schema. Every output is audited with data timestamps. No agent may trade.

import type {
  AgentAnalysis,
  AgentId,
  ManipulationLevel,
  MarketRegime,
  QuantFeatures,
} from "./types";
import { clamp } from "./math";
import type { AriseConfig } from "./config";

export const AI_VERSION = "heuristic-v1";

interface Ctx {
  features: QuantFeatures;
  openPositionExposurePct: number;
  openPositions: number;
  regime: MarketRegime;
  manipulation: ManipulationLevel;
  anomalyEvidence?: string[];
  config: AriseConfig;
  now: number;
}

function base(id: AgentId, ctx: Ctx, signal: AgentAnalysis["signal"], confidence: number, summary: string): AgentAnalysis {
  return {
    agent: id,
    signal,
    confidence: clamp(confidence, 0, 1),
    summary,
    evidence: [],
    risks: [],
    invalidation: [],
    dataQuality: ctx.features.dataQuality,
    dataTimestamp: ctx.features.symbol ? ctx.now : ctx.now,
    modelVersion: AI_VERSION,
  };
}

// ---------------- QUANT AI — interprets statistical evidence ----------------
export function quantAI(ctx: Ctx): AgentAnalysis {
  const f = ctx.features;
  const a = base("quant_ai", ctx, "NEUTRAL", f.confidence, "");
  const z = f.statistics.zScore20;
  const mom = f.momentum.momentumScore;

  if (mom > 0.25 && f.trend.slopePerBarPct > 0.02) {
    a.signal = "LONG";
    a.confidence = clamp(0.5 + mom * 0.3 + Math.min(Math.abs(f.trend.slopePerBarPct) / 0.2, 0.2), 0.3, 0.9);
    a.summary = `Positive drift: ROC10 ${f.momentum.roc10Pct.toFixed(2)}%, slope ${f.trend.slopePerBarPct.toFixed(3)}%/bar, momentum score ${mom.toFixed(2)}`;
    a.evidence = [
      `10-bar rate of change ${f.momentum.roc10Pct.toFixed(2)}%`,
      `trend slope ${f.trend.slopePerBarPct.toFixed(3)}% per bar`,
      `price z-score ${z.toFixed(2)}σ vs SMA20`,
      `realized vol ${f.volatility.realizedVolPct.toFixed(2)}% (${f.volatility.volRegime})`,
    ];
    a.invalidation = [`momentum score falls below -0.2`, `close below SMA20 (${f.trend.sma20.toFixed(2)})`];
  } else if (mom < -0.25 && f.trend.slopePerBarPct < -0.02) {
    a.signal = "SHORT";
    a.confidence = clamp(0.5 + Math.abs(mom) * 0.3 + Math.min(Math.abs(f.trend.slopePerBarPct) / 0.2, 0.2), 0.3, 0.9);
    a.summary = `Negative drift: ROC10 ${f.momentum.roc10Pct.toFixed(2)}%, slope ${f.trend.slopePerBarPct.toFixed(3)}%/bar, momentum score ${mom.toFixed(2)}`;
    a.evidence = [
      `10-bar rate of change ${f.momentum.roc10Pct.toFixed(2)}%`,
      `trend slope ${f.trend.slopePerBarPct.toFixed(3)}% per bar`,
      `price z-score ${z.toFixed(2)}σ vs SMA20`,
    ];
    a.invalidation = [`momentum score rises above +0.2`, `close above SMA20 (${f.trend.sma20.toFixed(2)})`];
  } else if (Math.abs(z) > 2) {
    a.signal = z > 0 ? "CAUTION" : "CAUTION";
    a.confidence = 0.6;
    a.summary = `Statistical extension: price ${z.toFixed(2)}σ from SMA20 — mean-reversion pressure`;
    a.evidence = [`z-score ${z.toFixed(2)}σ`, `autocorr(1) ${f.statistics.autocorr1.toFixed(2)}`];
    a.risks = ["extended moves often retrace", "chasing extended price has poor entry"];
  } else {
    a.summary = `No statistical edge: momentum ${mom.toFixed(2)}, z-score ${z.toFixed(2)}σ, mixed evidence`;
    a.evidence = [`ROC10 ${f.momentum.roc10Pct.toFixed(2)}%`, `z-score ${z.toFixed(2)}σ`];
  }
  if (f.volatility.volRegime === "EXTREME") a.risks.push("extreme volatility widens outcome distribution");
  return a;
}

// ---------------- TECHNICAL AI — market structure ----------------
export function technicalAI(ctx: Ctx): AgentAnalysis {
  const f = ctx.features;
  const a = base("technical_ai", ctx, "NEUTRAL", f.confidence, "");
  const aboveEma = f.trend.ema20 > f.trend.ema50;
  const aboveSma = f.trend.distFromSma20Pct > 0;
  const rsi = f.momentum.rsi14;

  const bullCount = [aboveEma, aboveSma, f.momentum.macdHist > 0, rsi > 52].filter(Boolean).length;
  const bearCount = [!aboveEma, !aboveSma, f.momentum.macdHist < 0, rsi < 48].filter(Boolean).length;

  const rangePos = f.statistics.rangePositionPct;

  if (bullCount >= 3) {
    a.signal = "LONG";
    a.confidence = clamp(0.45 + bullCount * 0.11, 0.3, 0.9);
    a.summary = `Bullish structure: ${bullCount}/4 technical factors aligned`;
    a.evidence = [
      `EMA20 ${aboveEma ? ">" : "<"} EMA50 (${f.trend.emaStructure})`,
      `price ${f.trend.distFromSma20Pct.toFixed(2)}% vs SMA20`,
      `MACD histogram ${f.momentum.macdHist > 0 ? "positive" : "negative"}`,
      `RSI14 ${rsi.toFixed(1)} (${f.momentum.rsiState})`,
      `range position ${rangePos.toFixed(0)}% of 60-bar range`,
    ];
    a.invalidation = [`EMA structure flips bearish`, `close below EMA20 (${f.trend.ema20.toFixed(2)})`];
  } else if (bearCount >= 3) {
    a.signal = "SHORT";
    a.confidence = clamp(0.45 + bearCount * 0.11, 0.3, 0.9);
    a.summary = `Bearish structure: ${bearCount}/4 technical factors aligned`;
    a.evidence = [
      `EMA20 ${aboveEma ? ">" : "<"} EMA50 (${f.trend.emaStructure})`,
      `price ${f.trend.distFromSma20Pct.toFixed(2)}% vs SMA20`,
      `MACD histogram ${f.momentum.macdHist > 0 ? "positive" : "negative"}`,
      `RSI14 ${rsi.toFixed(1)} (${f.momentum.rsiState})`,
    ];
    a.invalidation = [`EMA structure flips bullish`, `close above EMA20 (${f.trend.ema20.toFixed(2)})`];
  } else if (rsi >= 70) {
    a.signal = "CAUTION";
    a.confidence = 0.62;
    a.summary = `Overbought: RSI ${rsi.toFixed(1)} with price near range top (${rangePos.toFixed(0)}%)`;
    a.risks = ["overbought pullback risk"];
  } else if (rsi <= 30) {
    a.signal = "CAUTION";
    a.confidence = 0.62;
    a.summary = `Oversold: RSI ${rsi.toFixed(1)} with price near range bottom (${rangePos.toFixed(0)}%)`;
    a.risks = ["oversold continuation risk in strong trends"];
  } else {
    a.summary = `Mixed structure: ${bullCount} bullish vs ${bearCount} bearish factors`;
    a.evidence = [`RSI14 ${rsi.toFixed(1)}`, `EMA structure ${f.trend.emaStructure}`, `ADX ${f.trend.adx.toFixed(1)} (${f.trend.trendStrength})`];
  }
  return a;
}

// ---------------- REGIME AI — market state classification ----------------
export function regimeAI(ctx: Ctx): { analysis: AgentAnalysis; regime: MarketRegime } {
  const f = ctx.features;
  const adx = f.trend.adx;
  const slope = f.trend.slopePerBarPct;
  let regime: MarketRegime;
  let confidence: number;
  let summary: string;
  const evidence: string[] = [];

  if (f.volatility.volRegime === "EXTREME") {
    regime = "HIGH_VOLATILITY";
    confidence = 0.78;
    summary = `Extreme volatility regime (vol percentile ${f.volatility.volPercentile.toFixed(0)})`;
    evidence.push(`realized vol ${f.volatility.realizedVolPct.toFixed(2)}% per bar`, `ATR ${f.volatility.atrPct.toFixed(2)}% of price`);
  } else if (adx >= 25 && slope > 0.01) {
    regime = "TRENDING_UP";
    confidence = clamp(0.55 + adx / 200, 0.4, 0.9);
    summary = `Trending up: ADX ${adx.toFixed(1)}, positive slope`;
    evidence.push(`ADX ${adx.toFixed(1)} (${f.trend.trendStrength})`, `EMA structure ${f.trend.emaStructure}`, `slope ${slope.toFixed(3)}%/bar`);
  } else if (adx >= 25 && slope < -0.01) {
    regime = "TRENDING_DOWN";
    confidence = clamp(0.55 + adx / 200, 0.4, 0.9);
    summary = `Trending down: ADX ${adx.toFixed(1)}, negative slope`;
    evidence.push(`ADX ${adx.toFixed(1)} (${f.trend.trendStrength})`, `EMA structure ${f.trend.emaStructure}`);
  } else if (Math.abs(f.statistics.autocorr1) < 0.1 && adx < 20) {
    regime = "RANGE";
    confidence = 0.7;
    summary = `Ranging: weak directional movement (ADX ${adx.toFixed(1)})`;
    evidence.push(`ADX ${adx.toFixed(1)}`, `autocorrelation ${f.statistics.autocorr1.toFixed(2)}`, `range position ${f.statistics.rangePositionPct.toFixed(0)}%`);
  } else if (f.volatility.volRegime === "LOW") {
    regime = "LOW_VOLATILITY";
    confidence = 0.65;
    summary = `Low volatility compression (vol percentile ${f.volatility.volPercentile.toFixed(0)})`;
    evidence.push(`realized vol ${f.volatility.realizedVolPct.toFixed(2)}%`);
  } else {
    regime = "UNCERTAIN";
    confidence = 0.45;
    summary = `Uncertain regime: ADX ${adx.toFixed(1)}, vol ${f.volatility.volRegime}`;
    evidence.push(`conflicting trend/volatility signals`);
  }

  const analysis = base("regime_ai", ctx, "NEUTRAL", confidence, summary);
  analysis.regime = regime;
  analysis.evidence = evidence;
  if (regime === "HIGH_VOLATILITY") analysis.risks.push("stop distances unreliable, size down");
  if (regime === "RANGE") analysis.risks.push("breakout entries prone to failure");
  if (regime === "TRENDING_UP") analysis.invalidation.push("ADX collapse below 20");
  if (regime === "TRENDING_DOWN") analysis.invalidation.push("ADX collapse below 20");
  return { analysis, regime };
}

// ---------------- ANOMALY AI — suspicious/abnormal conditions ----------------
export function anomalyAI(ctx: Ctx): AgentAnalysis {
  const f = ctx.features;
  const a = base("anomaly_ai", ctx, "NEUTRAL", 0.7, "");
  const risks: string[] = [];
  let level: ManipulationLevel = "NORMAL";

  if (Math.abs(f.liquidity.volumeZ) > 5 || (f.liquidity.spreadPct !== null && f.liquidity.spreadPct > ctx.config.maxSpreadPct * 3)) {
    level = "HIGH_RISK";
    risks.push(`extreme abnormality: volume ${f.liquidity.volumeZ.toFixed(1)}σ / spread ${f.liquidity.spreadPct?.toFixed(3)}%`);
  } else if (Math.abs(f.liquidity.volumeZ) > 3) {
    level = "ELEVATED";
    risks.push(`volume ${f.liquidity.volumeZ.toFixed(1)}σ from mean — unusual activity`);
  } else if (Math.abs(f.liquidity.volumeZ) > 2) {
    if (level === "NORMAL") level = "WATCH";
    risks.push(`volume ${f.liquidity.volumeZ.toFixed(1)}σ from mean`);
  }
  if (f.liquidity.spreadPct !== null && f.liquidity.spreadPct > ctx.config.maxSpreadPct) {
    level = level === "NORMAL" ? "WATCH" : "ELEVATED";
    risks.push(`spread ${f.liquidity.spreadPct.toFixed(3)}% exceeds ${ctx.config.maxSpreadPct}% limit`);
  }
  if (f.volatility.volRegime === "EXTREME") {
    level = level === "NORMAL" ? "WATCH" : "ELEVATED";
    risks.push(`volatility spike: ${f.volatility.realizedVolPct.toFixed(2)}% per bar (p${f.volatility.volPercentile.toFixed(0)})`);
  }
  if (f.statistics.autocorr1 < -0.35) {
    if (level === "NORMAL") level = "WATCH";
    risks.push(`strong mean-reversion signature (autocorr ${f.statistics.autocorr1.toFixed(2)}) — possible liquidity-driven oscillation`);
  }
  risks.push(...(ctx.anomalyEvidence ?? []));

  a.manipulationLevel = level;
  a.signal = level === "HIGH_RISK" || level === "ELEVATED" ? "RISK_FLAG" : level === "WATCH" ? "CAUTION" : "NEUTRAL";
  a.confidence = level === "NORMAL" ? 0.65 : 0.75;
  a.summary =
    level === "NORMAL"
      ? "No abnormal market conditions detected"
      : `${level}: ${risks.length} abnormal condition(s) detected`;
  a.risks = risks;
  if (level !== "NORMAL") {
    a.invalidation = ["abnormal conditions normalize for 3+ consecutive bars"];
  }
  return a;
}

// ---------------- PORTFOLIO AI — whole-book view ----------------
export function portfolioAI(ctx: Ctx): AgentAnalysis {
  const a = base("portfolio_ai", ctx, "NEUTRAL", 0.7, "");
  const exposure = ctx.openPositionExposurePct;
  a.evidence = [
    `open positions: ${ctx.openPositions}`,
    `current exposure: ${exposure.toFixed(1)}% of equity`,
    `gross exposure limit: ${ctx.config.maxGrossExposurePct}%`,
  ];
  if (exposure + ctx.config.maxPositionPct > ctx.config.maxGrossExposurePct) {
    a.signal = "RISK_FLAG";
    a.confidence = 0.8;
    a.summary = `New position would breach gross exposure limit (${(exposure + ctx.config.maxPositionPct).toFixed(0)}% > ${ctx.config.maxGrossExposurePct}%)`;
    a.risks = ["portfolio concentration beyond policy"];
  } else if (exposure > ctx.config.maxGrossExposurePct * 0.7) {
    a.signal = "CAUTION";
    a.confidence = 0.72;
    a.summary = `Exposure elevated: ${exposure.toFixed(1)}% used of ${ctx.config.maxGrossExposurePct}% budget`;
    a.risks = ["limited remaining risk budget"];
  } else {
    a.summary = `Portfolio risk acceptable: ${exposure.toFixed(1)}% of ${ctx.config.maxGrossExposurePct}% exposure budget used`;
  }
  if (ctx.openPositions >= 4) {
    a.signal = a.signal === "RISK_FLAG" ? a.signal : "CAUTION";
    a.risks.push(`${ctx.openPositions} concurrent positions — correlated-bet risk in crypto majors`);
  }
  return a;
}

// ---------------- RISK AI — advisory only, no authority ----------------
export function riskAI(ctx: Ctx): AgentAnalysis {
  const a = base("risk_ai", ctx, "NEUTRAL", 0.8, "");
  const f = ctx.features;
  const notes: string[] = [];
  let rec: AgentAnalysis["signal"] = "NEUTRAL";

  if (f.volatility.volRegime === "EXTREME") {
    rec = "CAUTION";
    notes.push("extreme volatility — recommend reduced size");
  }
  if (ctx.manipulation === "ELEVATED" || ctx.manipulation === "HIGH_RISK") {
    rec = "CAUTION";
    notes.push(`${ctx.manipulation} anomaly level — recommend wait or reduced size`);
  }
  if (f.dataQuality === "degraded") {
    rec = "CAUTION";
    notes.push("degraded data quality — confidence in any reading is reduced");
  }
  if (f.liquidity.liquidityState === "LOW") {
    rec = "CAUTION";
    notes.push("low liquidity conditions — slippage risk");
  }
  a.signal = rec;
  a.summary = notes.length === 0 ? "No risk objections to new positioning" : `Advisory: ${notes.length} risk note(s)`;
  a.evidence = notes.length > 0 ? notes : ["all monitored risk factors within normal bounds"];
  a.risks = notes;
  return a;
}

export interface AgentBundle {
  quant: AgentAnalysis;
  technical: AgentAnalysis;
  regime: AgentAnalysis;
  anomaly: AgentAnalysis;
  portfolio: AgentAnalysis;
  risk: AgentAnalysis;
  regimeResolved: MarketRegime;
}

export function runAllAgents(ctx: Ctx): AgentBundle {
  const reg = regimeAI(ctx);
  const manipulation = reg.regime === "HIGH_VOLATILITY" ? "ELEVATED" : ctx.manipulation;
  const ctx2: Ctx = { ...ctx, manipulation, regime: reg.regime };
  return {
    quant: quantAI(ctx2),
    technical: technicalAI(ctx2),
    regime: reg.analysis,
    anomaly: anomalyAI(ctx2),
    portfolio: portfolioAI(ctx2),
    risk: riskAI(ctx2),
    regimeResolved: reg.regime,
  };
}
