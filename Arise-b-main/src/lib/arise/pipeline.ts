// ARISE V1 — decision pipeline orchestrator.
// MARKET → VALIDATION → QUANT → AGENTS → MIND → RISK → EXECUTION VALIDATION.
// Every stage is recorded for audit. Fail-closed at every gate.

import { runAllAgents, type AgentBundle } from "./agents";
import { runMind } from "./mind";
import {
  buildTradePlan,
  evaluateRisk,
  validateExecution,
  type RiskEngineInput,
} from "./risk";
import { computeQuantFeatures, intervalMs } from "./quant";
import { evaluateDecisionGate, type DecisionGateResult } from "./evidence";
import { assessFreshness, validateBars, type RawBar } from "./validate";
import { assessNews, newsAI, type NewsAssessment, type RawNewsItem } from "./news";
import type {
  AgentAnalysis,
  Bar,
  MarketSnapshot,
  QuantFeatures,
  TradePlan,
} from "./types";
import type { AriseConfig } from "./config";

export interface PipelineAccount {
  equity: number;
  balance: number;
  dayStartEquity: number;
  highWaterMark: number;
  openPositions: number;
  openPositionNotional: number;
  emergencyStop: boolean;
}

/** The six deterministic agents plus the news agent, which is assembled from real
 *  headlines rather than from the price snapshot. */
export interface DecisionAgents extends AgentBundle {
  news: AgentAnalysis;
}

export interface PipelineResult {
  ok: boolean;
  errorCode: string | null;
  snapshot: MarketSnapshot | null;
  features: QuantFeatures | null;
  agents: DecisionAgents | null;
  news: NewsAssessment | null;
  mind: ReturnType<typeof runMind> | null;
  plan: TradePlan | null;
  riskDecision: ReturnType<typeof evaluateRisk> | null;
  /** Stage 7: the deterministic evidence verdict and the ledger behind it. */
  evidence: DecisionGateResult | null;
  notes: string[];
  timings: Record<string, number>;
}

/** Stage 1+2: fetch-independent — validate raw bars into a MarketSnapshot. */
export function buildSnapshot(
  raw: RawBar[],
  opts: {
    symbol: string;
    assetClass: Bar["assetClass"];
    interval: string;
    now: number;
    config: AriseConfig;
    bestBid: number | null;
    bestAsk: number | null;
    source: string;
  },
): { snapshot: MarketSnapshot | null; notes: string[]; errorCode: string | null } {
  const validation = validateBars(raw, {
    symbol: opts.symbol,
    assetClass: opts.assetClass,
    interval: opts.interval,
    now: opts.now,
    config: opts.config,
    source: opts.source,
  });
  const notes = [...validation.notes];

  if (validation.bars.length === 0) {
    return { snapshot: null, notes, errorCode: "NO_VALID_DATA" };
  }

  // A decision may only use COMPLETED candles. Providers include the currently
  // forming candle, whose close keeps moving; using it authorized a trade on a price
  // that did not exist yet. The chart endpoint may still display forming bars, but
  // every decision/mark snapshot is built from completed bars only.
  const completedBars = validation.bars.filter(
    (bar) => bar.time + intervalMs(opts.interval) <= opts.now,
  );
  if (completedBars.length === 0) {
    notes.push("no completed candles in the returned series");
    return { snapshot: null, notes, errorCode: "NO_COMPLETED_DATA" };
  }
  if (completedBars.length !== validation.bars.length) {
    notes.push(`${validation.bars.length - completedBars.length} forming bar(s) excluded`);
  }

  const freshness = assessFreshness(completedBars, {
    interval: opts.interval,
    now: opts.now,
    config: opts.config,
    bestBid: opts.bestBid,
    bestAsk: opts.bestAsk,
  });
  notes.push(...freshness.notes);

  const quality =
    validation.quality === "valid" && freshness.quality === "valid"
      ? "valid"
      : freshness.quality === "invalid"
        ? "invalid"
        : validation.quality === "degraded" || freshness.quality === "degraded"
          ? "degraded"
          : freshness.quality;

  const last = completedBars[completedBars.length - 1];
  const snapshot: MarketSnapshot = {
    symbol: opts.symbol,
    assetClass: opts.assetClass,
    interval: opts.interval,
    bars: completedBars,
    latest: last,
    quoteAgeSec: freshness.quoteAgeSec,
    bestBid: opts.bestBid,
    bestAsk: opts.bestAsk,
    spreadPct:
      opts.bestBid !== null && opts.bestAsk !== null && opts.bestBid > 0
        ? ((opts.bestAsk - opts.bestBid) / opts.bestBid) * 100
        : null,
    source: opts.source,
    quality,
    qualityNotes: notes,
  };
  return { snapshot, notes, errorCode: null };
}

/** Stages 3–6: quant → agents → MIND → risk. Deterministic given snapshot+account.
 *
 *  `newsItems` are real headlines fetched by the caller (the Convex news action).
 *  Omitting them — or supplying an empty/stale set — yields an UNAVAILABLE news
 *  assessment, which contributes exactly zero directional influence. */
export function runDecisionPipeline(
  snapshot: MarketSnapshot,
  account: PipelineAccount,
  config: AriseConfig,
  now: number,
  newsItems: RawNewsItem[] = [],
  /** Authorization context the analyst stages cannot know on their own. */
  gate: { paperMode: boolean },
): PipelineResult {
  const timings: Record<string, number> = {};
  const t0 = performance.now();

  const features = computeQuantFeatures(snapshot);
  timings.quant = performance.now() - t0;

  const t1 = performance.now();
  const agents = runAllAgents({
    features,
    openPositionExposurePct: account.openPositionNotional > 0 && account.equity > 0
      ? (account.openPositionNotional / account.equity) * 100
      : 0,
    openPositions: account.openPositions,
    regime: "UNCERTAIN", // resolved inside regimeAI
    manipulation: "NORMAL", // anomalyAI resolves
    config,
    now,
  });
  timings.agents = performance.now() - t1;

  // News: real headlines in, deterministic assessment out. No headlines ⇒ status
  // UNAVAILABLE, score null, and a NEUTRAL/0-confidence agent.
  const news = assessNews(newsItems, {
    symbol: snapshot.symbol,
    assetClass: snapshot.assetClass,
    now,
  });
  const bundle: DecisionAgents = { ...agents, news: newsAI(news, features.dataQuality, now) };

  const t2 = performance.now();
  const mind = runMind(bundle, features, now);
  timings.mind = performance.now() - t2;

  const t3 = performance.now();
  const entryCandidate =
    snapshot.bestBid !== null && snapshot.bestAsk !== null
      ? (snapshot.bestBid + snapshot.bestAsk) / 2
      : snapshot.latest.close;

  const riskInput: RiskEngineInput = {
    mind,
    features,
    config,
    equity: account.equity,
    balance: account.balance,
    dayStartEquity: account.dayStartEquity,
    highWaterMark: account.highWaterMark,
    openPositions: account.openPositions,
    openPositionNotional: account.openPositionNotional,
    openPositionExposurePct:
      account.equity > 0 ? (account.openPositionNotional / account.equity) * 100 : 0,
    symbol: snapshot.symbol,
    assetClass: snapshot.assetClass,
    entryPrice: entryCandidate,
    spreadPct: snapshot.spreadPct,
    notionalPerBar: features.liquidity.notionalPerBar,
    dataQuality: snapshot.quality,
    quoteAgeSec: snapshot.quoteAgeSec,
    manipulationLevel: agents.anomaly.manipulationLevel ?? "NORMAL",
    emergencyStop: account.emergencyStop,
    now,
  };
  const riskDecision = evaluateRisk(riskInput);

  const plan =
    riskDecision.decision === "APPROVED" || riskDecision.decision === "REDUCED"
      ? buildTradePlan(mind, features, config, account.equity, entryCandidate)
      : null;
  timings.risk = performance.now() - t3;

  // Stage 7 — EVIDENCE → DECISION. The gate sees only what this run actually
  // established: observed bars, our own calculations, agent inferences and
  // MIND's hypothesis. It can only LOWER the candidate outcome, so a rejection
  // can never be reinterpreted downstream as permission to trade.
  const t4 = performance.now();
  const evidence = evaluateDecisionGate({
    snapshot,
    features,
    agents: bundle,
    mind,
    news,
    config,
    now,
    riskDecision,
    paperMode: gate.paperMode,
  });
  timings.evidence = performance.now() - t4;

  return {
    ok: true,
    errorCode: null,
    snapshot,
    features,
    agents: bundle,
    news,
    mind,
    plan,
    riskDecision,
    evidence,
    notes: snapshot.qualityNotes,
    timings,
  };
}

export { validateExecution };
