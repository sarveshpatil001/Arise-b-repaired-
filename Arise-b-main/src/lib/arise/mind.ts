// ARISE V1 — MIND: the central reasoning layer.
// MIND does NOT majority-vote. It normalizes evidence, detects contradictions,
// runs a challenge round, calibrates confidence, and emits a structured proposal.

import type {
  AgentAnalysis,
  AgentId,
  MindDebatePoint,
  MindDecision,
  QuantFeatures,
} from "./types";
import { clamp } from "./math";
import { NO_NEWS_ANALYSIS } from "./news";

const MIND_VERSION = "mind-v1";

const AGENT_LABEL: Record<AgentId, string> = {
  quant_ai: "Quant AI",
  technical_ai: "Technical AI",
  regime_ai: "Regime AI",
  anomaly_ai: "Anomaly AI",
  portfolio_ai: "Portfolio AI",
  risk_ai: "Risk AI",
  news_ai: "News AI",
};

function posOf(a: AgentAnalysis): "LONG" | "SHORT" | "NEUTRAL" | "OBJECTION" {
  if (a.signal === "LONG") return "LONG";
  if (a.signal === "SHORT") return "SHORT";
  if (a.signal === "RISK_FLAG") return "OBJECTION";
  if (a.signal === "CAUTION") return "OBJECTION";
  return "NEUTRAL";
}

export function runMind(
  bundle: {
    quant: AgentAnalysis;
    technical: AgentAnalysis;
    regime: AgentAnalysis;
    anomaly: AgentAnalysis;
    portfolio: AgentAnalysis;
    risk: AgentAnalysis;
    /** Real-headline news read. Optional: absent input is zero-influence, not a veto. */
    news?: AgentAnalysis;
  },
  features: QuantFeatures,
  now: number,
): MindDecision {
  const order: AgentId[] = [
    "quant_ai",
    "technical_ai",
    "regime_ai",
    "anomaly_ai",
    "portfolio_ai",
    "risk_ai",
    "news_ai",
  ];
  const analyses: Record<AgentId, AgentAnalysis> = {
    quant_ai: bundle.quant,
    technical_ai: bundle.technical,
    regime_ai: bundle.regime,
    anomaly_ai: bundle.anomaly,
    portfolio_ai: bundle.portfolio,
    risk_ai: bundle.risk,
    // Without a news layer the agent is NEUTRAL/0-confidence, so it never enters
    // the directional weighting below.
    news_ai: bundle.news ?? NO_NEWS_ANALYSIS,
  };

  // ---------- Evidence normalization ----------
  const directional = order
    .map((id) => ({ id, a: analyses[id], pos: posOf(analyses[id]) }))
    .filter((x) => x.pos === "LONG" || x.pos === "SHORT") as {
    id: AgentId;
    a: AgentAnalysis;
    pos: "LONG" | "SHORT";
  }[];

  const longWeight = directional
    .filter((d) => d.pos === "LONG")
    .reduce((acc, d) => acc + d.a.confidence, 0);
  const shortWeight = directional
    .filter((d) => d.pos === "SHORT")
    .reduce((acc, d) => acc + d.a.confidence, 0);
  const objections = order.filter((id) =>
    ["anomaly_ai", "portfolio_ai", "risk_ai"].includes(id),
  );
  const objectionCount = objections.filter(
    (id) => posOf(analyses[id]) === "OBJECTION",
  ).length;

  // ---------- Thesis generation ----------
  let direction: MindDecision["direction"] = "FLAT";
  if (longWeight > shortWeight && longWeight > 0) direction = "LONG";
  else if (shortWeight > longWeight && shortWeight > 0) direction = "SHORT";

  // ---------- Contradiction detection ----------
  const debate: MindDebatePoint[] = [];
  const bull = directional.filter((d) => d.pos === "LONG");
  const bear = directional.filter((d) => d.pos === "SHORT");

  if (bull.length > 0 && bear.length > 0) {
    debate.push({
      topic: "Directional disagreement",
      agents: [
        ...bull.map((d) => ({ agent: d.id, position: "LONG", confidence: d.a.confidence })),
        ...bear.map((d) => ({ agent: d.id, position: "SHORT", confidence: d.a.confidence })),
      ],
      resolution:
        "Both directional camps carry weight. MIND requires alignment with regime before acting on direction.",
    });
  }

  const anomalyLevel = bundle.anomaly.manipulationLevel ?? "NORMAL";
  if (anomalyLevel === "ELEVATED" || anomalyLevel === "HIGH_RISK") {
    debate.push({
      topic: "Abnormal market conditions",
      agents: [{ agent: "anomaly_ai", position: anomalyLevel, confidence: bundle.anomaly.confidence }],
      resolution:
        "Anomaly AI reports elevated abnormal-conditions risk. MIND discounts directional confidence rather than ignoring it.",
    });
  }
  if (features.volatility.volRegime === "EXTREME") {
    debate.push({
      topic: "Volatility regime vs directional thesis",
      agents: [
        { agent: "regime_ai", position: "HIGH_VOLATILITY", confidence: bundle.regime.confidence },
        ...directional.map((d) => ({ agent: d.id, position: d.pos, confidence: d.a.confidence })),
      ],
      resolution: "Extreme volatility reduces the reliability of stop placement. MIND shrinks size instead of widening stops.",
    });
  }
  if (objectionCount >= 2) {
    debate.push({
      topic: "Risk cohort alignment",
      agents: objections.map((id) => ({ agent: id, position: posOf(analyses[id]), confidence: analyses[id].confidence })),
      resolution: "Multiple risk-perspective agents object. MIND treats this as correlated, not independent, evidence.",
    });
  }

  // ---------- Challenge round: strongest counter-argument ----------
  const supportingEvidence: string[] = [];
  const contradictingEvidence: string[] = [];
  const invalidationConditions: string[] = [];
  const keyRisks: string[] = [];

  const dirAgents = direction === "LONG" ? bull : bear;
  for (const d of dirAgents) {
    supportingEvidence.push(`${AGENT_LABEL[d.id]}: ${d.a.summary}`);
    invalidationConditions.push(...d.a.invalidation.slice(0, 2));
  }
  const oppAgents = direction === "LONG" ? bear : bull;
  for (const d of oppAgents) {
    contradictingEvidence.push(`${AGENT_LABEL[d.id]}: ${d.a.summary}`);
  }
  for (const id of objections) {
    const a = analyses[id];
    if (posOf(a) === "OBJECTION") contradictingEvidence.push(`${AGENT_LABEL[id]}: ${a.summary}`);
    keyRisks.push(...a.risks.slice(0, 2));
  }
  if (anomalyLevel === "WATCH") keyRisks.push("anomaly AI in WATCH state — abnormal conditions present");

  // ---------- Confidence calibration ----------
  const totalDirWeight = longWeight + shortWeight;
  const agreement = totalDirWeight > 0 ? (Math.max(longWeight, shortWeight) / totalDirWeight) * 100 : 0;
  let confidence = direction === "FLAT" ? 0.3 : 0.25;
  if (direction !== "FLAT") {
    const dirConf = Math.max(longWeight, shortWeight) / Math.max(dirAgents.length, 1);
    confidence = 0.2 + dirConf * 0.45; // raw directional conviction
    confidence *= clamp(agreement / 100, 0.3, 1); // discount for disagreement
    confidence *= clamp(1 - objectionCount * 0.18, 0.2, 1); // discount for risk objections
    confidence *= clamp(0.6 + features.confidence * 0.4, 0.4, 1); // data-quality discount
    if (anomalyLevel === "ELEVATED" || anomalyLevel === "HIGH_RISK") confidence *= 0.7;
    if (features.volatility.volRegime === "EXTREME") confidence *= 0.75;
    confidence = clamp(confidence, 0.05, 0.95);
  }

  // ---------- Recommended action ----------
  let recommendedAction: MindDecision["recommendedAction"] = "WAIT";
  let positionSizeRecommendation = 0;
  if (direction !== "FLAT") {
    const sizeFraction = clamp((confidence - 0.45) / 0.45, 0, 1);
    if (confidence >= 0.6 && objectionCount === 0) {
      recommendedAction = "TRADE";
      positionSizeRecommendation = sizeFraction;
    } else if (confidence >= 0.45) {
      recommendedAction = objectionCount > 0 ? "REDUCE" : "TRADE";
      positionSizeRecommendation = objectionCount > 0 ? sizeFraction * 0.5 : sizeFraction * 0.75;
    }
  }

  const agreeCount = dirAgents.length;
  const dissentCount = oppAgents.length + objectionCount;

  const thesis =
    direction === "FLAT"
      ? `No directional edge: ${agreeCount} directional agent(s) neutral, ${dissentCount} objection(s). ARISE waits.`
      : `Moderate ${direction === "LONG" ? "bullish" : "bearish"} case: ${agreeCount} agent(s) support ${direction} with ${(agreement).toFixed(0)}% weighted agreement; ${dissentCount} dissenting voice(s) discount conviction.`;

  return {
    direction,
    confidence,
    thesis,
    supportingEvidence,
    contradictingEvidence,
    invalidationConditions,
    keyRisks: Array.from(new Set(keyRisks)).slice(0, 5),
    recommendedAction,
    positionSizeRecommendation,
    agreementPct: agreement,
    debate,
    dataTimestamp: now,
    mindVersion: MIND_VERSION,
  };
}
