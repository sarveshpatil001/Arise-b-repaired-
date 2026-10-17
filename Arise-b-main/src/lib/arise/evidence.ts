// ARISE V1 — Evidence & Decision Engine.
//
// The mandate for ARISE is explicit: the system is NOT built on the assumption
// that AI can predict the market. It collects evidence, separates what was
// OBSERVED from what was CALCULATED, from what was INFERRED, and from what is
// simply UNKNOWN, then lets deterministic gates decide authorization.
//
// Two rules drive this module:
//   1. AI confidence is not evidence strength. A confident opinion backed by a
//      hypothesis is weak evidence, and `confidenceCeiling` caps what the AI
//      layer is allowed to claim.
//   2. Gates can only ever LOWER authorization. `gateOutcome` takes the minimum
//      of the candidate outcome and the evidence verdict, so no downstream
//      module can reinterpret a rejection as permission to trade
//      (see the decision flow in the master prompt, step 10).
//
// Everything here is pure and deterministic: same inputs, same output. No I/O,
// no clock reads (callers pass `now`), no randomness.

import { clamp } from "./math";
import type {
  AgentAnalysis,
  DataQuality,
  MarketSnapshot,
  MindDecision,
  QuantFeatures,
  RiskDecision,
} from "./types";
import type { AriseConfig } from "./config";
import type { NewsAssessment } from "./news";

export const EVIDENCE_ENGINE_VERSION = "evidence-v1";

/** How a claim came to exist. The distinction is the whole point of the module. */
export type ClaimKind =
  /** Directly measured from a provider payload (a close price, a bar count). */
  | "OBSERVED"
  /** Derived from observed data by a deterministic formula we control (ATR, RSI). */
  | "CALCULATED"
  /** A judgement produced by an agent or model. Never treated as a fact. */
  | "INFERENCE"
  /** An unvalidated explanatory story. Useful for the audit trail, not for size. */
  | "HYPOTHESIS";

export type SourceReliability =
  /** The exchange/provider itself, first-hand. */
  | "PRIMARY"
  /** A secondary feed or aggregator repeating someone else's data. */
  | "SECONDARY"
  /** Our own derived series (indicator values, normalized features). */
  | "DERIVED";

export type ClaimDirection = "LONG" | "SHORT" | "NEUTRAL";

export interface EvidenceClaim {
  id: string;
  kind: ClaimKind;
  statement: string;
  source: string;
  sourceReliability: SourceReliability;
  /** Number of INDEPENDENT origins behind this statement. 1 = single source. */
  independentSources: number;
  /** 0..1 derived strength — see `claimStrength`. */
  strength: number;
  direction: ClaimDirection;
  /** Event time of the underlying fact (bar time), not the time we read it. */
  observedAt: number;
}

/** A required input we do not have. Unknowns are first-class, not omissions. */
export interface EvidenceUnknown {
  id: string;
  description: string;
  /**
   * BLOCKS_TRADE  — authorization must be refused.
   * REDUCES_SIZE  — authorization may proceed but size/confidence is reduced.
   * INFORMATIONAL — recorded only; zero influence on the decision.
   */
  impact: "BLOCKS_TRADE" | "REDUCES_SIZE" | "INFORMATIONAL";
}

export interface EvidenceContradiction {
  /** Claim id supporting one side. */
  a: string;
  /** Claim id supporting the other side. */
  b: string;
  note: string;
}

export interface EvidenceLedger {
  claims: EvidenceClaim[];
  unknowns: EvidenceUnknown[];
  contradictions: EvidenceContradiction[];
}

export type DecisionOutcome = "TRADE" | "WAIT" | "REJECT";

/**
 * BLOCK — the decision must be REJECT.
 * HOLD  — the decision may not exceed WAIT.
 * INFO  — recorded for the audit trail, no effect on authorization.
 */
export type ReasonLevel = "BLOCK" | "HOLD" | "INFO";

export interface OutcomeReason {
  code: string;
  level: ReasonLevel;
  detail: string;
}

export type EvidenceQuality = "STRONG" | "MODERATE" | "WEAK" | "ABSENT";

export interface EvidenceAssessment {
  outcome: DecisionOutcome;
  reasons: OutcomeReason[];
  reasonCodes: string[];
  evidenceQuality: EvidenceQuality;
  /**
   * The strongest conclusion the evidence can support. The AI layer's own
   * confidence is capped by this — a 0.9-confidence opinion resting on one
   * inference cannot claim more than the evidence justifies.
   */
  confidenceCeiling: number;
  supporting: string[];
  contradicting: string[];
  unknowns: EvidenceUnknown[];
  totals: Record<ClaimKind, number>;
  deterministic: true;
  engineVersion: string;
}

/** Reason codes. Stable strings — they are persisted and shown to operators. */
export const REASON = {
  DATA_QUALITY_INVALID: "DATA_QUALITY_INVALID",
  DATA_QUALITY_DEGRADED: "DATA_QUALITY_DEGRADED",
  DATA_STALE: "DATA_STALE",
  INSUFFICIENT_SAMPLE: "INSUFFICIENT_SAMPLE",
  EVIDENCE_ABSENT: "EVIDENCE_ABSENT",
  UNRESOLVED_CRITICAL_UNKNOWN: "UNRESOLVED_CRITICAL_UNKNOWN",
  MISSING_SPREAD: "MISSING_SPREAD",
  INFERENCE_WITHOUT_CALCULATION: "INFERENCE_WITHOUT_CALCULATION",
  UNCORROBORATED_SOURCE: "UNCORROBORATED_SOURCE",
  CONTRADICTORY_EVIDENCE: "CONTRADICTORY_EVIDENCE",
  NEWS_UNAVAILABLE: "NEWS_UNAVAILABLE",
  NEWS_POLICY_OVERRIDE_ATTEMPT: "NEWS_POLICY_OVERRIDE_ATTEMPT",
  RISK_VETO: "RISK_VETO",
  EXECUTION_MODE_NOT_PAPER: "EXECUTION_MODE_NOT_PAPER",
  EVIDENCE_SUFFICIENT: "EVIDENCE_SUFFICIENT",
} as const;

/** Confidence a claim kind can earn before reliability and corroboration. */
const KIND_BASE: Record<ClaimKind, number> = {
  OBSERVED: 0.9,
  CALCULATED: 0.7,
  INFERENCE: 0.45,
  HYPOTHESIS: 0.25,
};

const RELIABILITY_FACTOR: Record<SourceReliability, number> = {
  PRIMARY: 1,
  SECONDARY: 0.8,
  DERIVED: 0.9,
};

/** A quiet market is not a contradiction to act on. */
const CONTRADICTION_STRENGTH_FLOOR = 0.4;

/** Claims this strong on both sides make the direction untrustworthy. */
const CONTRADICTION_MIN_TOTAL = 0.9;

/**
 * Claim strength = kind ceiling × source reliability × corroboration bonus.
 * The corroboration bonus is deliberately sub-linear and capped, because five
 * feeds republishing one wire story are not five independent facts.
 */
export function claimStrength(
  kind: ClaimKind,
  sourceReliability: SourceReliability,
  independentSources: number,
): number {
  const sources = Number.isFinite(independentSources)
    ? Math.max(1, Math.floor(independentSources))
    : 1;
  const corroboration = Math.min((sources - 1) * 0.15, 0.3);
  return clamp(KIND_BASE[kind] * RELIABILITY_FACTOR[sourceReliability] + corroboration, 0, 1);
}

function outcomeRank(outcome: DecisionOutcome): number {
  if (outcome === "TRADE") return 2;
  if (outcome === "WAIT") return 1;
  return 0;
}

function rankToOutcome(rank: number): DecisionOutcome {
  if (rank >= 2) return "TRADE";
  if (rank >= 1) return "WAIT";
  return "REJECT";
}

/**
 * The gate. It can only ever lower authorization: `TRADE` candidate + a `HOLD`
 * verdict yields `WAIT`, and a `REJECT` candidate can never be raised by a
 * permissive verdict. This is what makes "no downstream module may reinterpret
 * a rejection as permission to trade" mechanically true rather than a promise.
 */
export function gateOutcome(
  candidate: DecisionOutcome,
  assessment: EvidenceAssessment,
): DecisionOutcome {
  return rankToOutcome(Math.min(outcomeRank(candidate), outcomeRank(assessment.outcome)));
}

/**
 * Cap an AI confidence value at what the evidence can actually support.
 * Both arguments fail CLOSED: an unrepresentable confidence or an
 * unrepresentable ceiling becomes 0 rather than passing NaN downstream, where it
 * would silently poison every comparison it touches.
 */
export function applyConfidenceCeiling(aiConfidence: number, ceiling: number): number {
  const base = Number.isFinite(aiConfidence) ? aiConfidence : 0;
  const cap = Number.isFinite(ceiling) ? clamp(ceiling, 0, 1) : 0;
  return clamp(Math.min(base, cap), 0, 1);
}

function strength(claims: EvidenceClaim[], direction: ClaimDirection): number {
  return claims
    .filter((c) => c.direction === direction)
    .reduce((acc, c) => acc + c.strength, 0);
}

function counted(claims: EvidenceClaim[]) {
  const totals: Record<ClaimKind, number> = {
    OBSERVED: 0,
    CALCULATED: 0,
    INFERENCE: 0,
    HYPOTHESIS: 0,
  };
  for (const claim of claims) totals[claim.kind] += 1;
  return totals;
}

/**
 * Convert a ledger into a verdict.
 *
 * Precedence is fixed and documented rather than emergent: any BLOCK rejects,
 * otherwise any HOLD waits, otherwise the evidence is sufficient. Ordering the
 * checks keeps the verdict reproducible when several problems coexist.
 */
export function assessEvidence(ledger: EvidenceLedger): EvidenceAssessment {
  const reasons: OutcomeReason[] = [];
  const block = (code: string, detail: string) => reasons.push({ code, level: "BLOCK", detail });
  const hold = (code: string, detail: string) => reasons.push({ code, level: "HOLD", detail });
  const info = (code: string, detail: string) => reasons.push({ code, level: "INFO", detail });

  const claims = ledger.claims;
  const totals = counted(claims);

  // 1. Unresolved unknowns that demand a refusal. Absence of a required input is
  //    a reason to refuse, never a reason to proceed.
  for (const unknown of ledger.unknowns) {
    if (unknown.impact === "BLOCKS_TRADE") {
      block(REASON.UNRESOLVED_CRITICAL_UNKNOWN, `${unknown.id}: ${unknown.description}`);
    } else if (unknown.impact === "REDUCES_SIZE") {
      hold(REASON.MISSING_SPREAD, `${unknown.id}: ${unknown.description}`);
    }
  }

  // 2. There must be at least one grounded claim. Opinions alone are not evidence.
  const grounded = totals.OBSERVED + totals.CALCULATED;
  if (grounded === 0) {
    block(
      REASON.EVIDENCE_ABSENT,
      "no observed or calculated evidence — only opinions/hypotheses were available",
    );
  }

  // 3. A directional conclusion must rest on a calculation, not only on inference.
  const hasDirectional = claims.some((c) => c.direction === "LONG" || c.direction === "SHORT");
  if (hasDirectional && totals.CALCULATED === 0) {
    hold(
      REASON.INFERENCE_WITHOUT_CALCULATION,
      "direction is asserted without any calculated indicator supporting it",
    );
  }

  // 4. Corroboration of the DIRECTION. A lone agent's opinion is not enough: the
  //    direction must be backed either by a non-opinion claim (an observed factor
  //    or one of our own calculations pointing the same way) or by at least two
  //    agents independently arriving at it. Note what this does NOT do — a missing
  //    news layer is not treated as a veto, because absent news is one neutral
  //    input, not evidence against the direction (see news.ts design rule 5).
  const strongest = claims.reduce((acc, c) => Math.max(acc, c.strength), 0);
  const nonOpinionDirectional = claims.filter(
    (c) => c.direction !== "NEUTRAL" && (c.kind === "OBSERVED" || c.kind === "CALCULATED"),
  );
  const agreeingAgents = claims.some((c) => c.kind === "INFERENCE" && c.independentSources > 1);
  if (hasDirectional && nonOpinionDirectional.length === 0 && !agreeingAgents) {
    hold(
      REASON.UNCORROBORATED_SOURCE,
      "direction rests on a single opinion with no independent corroboration",
    );
  }

  // 5. Contradiction: strong evidence on both sides means the direction is not
  //    trustworthy, whatever the weighted totals say.
  const longStrength = strength(claims, "LONG");
  const shortStrength = strength(claims, "SHORT");
  if (ledger.contradictions.length > 0) {
    const bothStrong =
      longStrength >= CONTRADICTION_STRENGTH_FLOOR &&
      shortStrength >= CONTRADICTION_STRENGTH_FLOOR &&
      longStrength + shortStrength >= CONTRADICTION_MIN_TOTAL;
    hold(
      REASON.CONTRADICTORY_EVIDENCE,
      bothStrong
        ? `opposing evidence is comparably strong (long ${longStrength.toFixed(2)} vs short ${shortStrength.toFixed(2)})`
        : `${ledger.contradictions.length} contradiction(s) recorded`,
    );
  }

  const blocks = reasons.filter((r) => r.level === "BLOCK");
  const holds = reasons.filter((r) => r.level === "HOLD");
  const outcome: DecisionOutcome =
    blocks.length > 0 ? "REJECT" : holds.length > 0 ? "WAIT" : "TRADE";
  if (outcome === "TRADE" && grounded > 0) {
    info(REASON.EVIDENCE_SUFFICIENT, "observed + calculated evidence present without contradiction");
  }

  // Evidence quality describes the evidence, NOT the direction's attractiveness.
  const contradictionPenalty = ledger.contradictions.length > 0 ? 0.75 : 1;
  const breadth = clamp(grounded / 6, 0, 1);
  const evidenceQuality: EvidenceQuality =
    grounded === 0
      ? "ABSENT"
      : strongest >= 0.75 && breadth >= 0.5
        ? "STRONG"
        : strongest >= 0.5
          ? "MODERATE"
          : "WEAK";

  // The ceiling rises with strong, broad, uncontradicted evidence. It is a cap on
  // claims, never an endorsement of a direction.
  const confidenceCeiling = clamp(strongest * 0.7 * contradictionPenalty + breadth * 0.2, 0, 0.95);

  const directionalClaims = claims.filter((c) => c.direction !== "NEUTRAL");
  const dominant: ClaimDirection = longStrength >= shortStrength ? "LONG" : "SHORT";
  const supporting = directionalClaims
    .filter((c) => c.direction === dominant)
    .map((c) => c.id);
  const contradicting = directionalClaims
    .filter((c) => c.direction !== dominant)
    .map((c) => c.id);

  return {
    outcome,
    reasons,
    reasonCodes: reasons.map((r) => r.code),
    evidenceQuality,
    confidenceCeiling,
    supporting,
    contradicting,
    unknowns: ledger.unknowns,
    totals,
    deterministic: true,
    engineVersion: EVIDENCE_ENGINE_VERSION,
  };
}

export interface LedgerInput {
  snapshot: MarketSnapshot;
  features: QuantFeatures;
  agents: {
    quant: AgentAnalysis;
    technical: AgentAnalysis;
    regime: AgentAnalysis;
    anomaly: AgentAnalysis;
    portfolio: AgentAnalysis;
    risk: AgentAnalysis;
    news?: AgentAnalysis;
  };
  mind: Pick<MindDecision, "direction" | "confidence" | "thesis">;
  news?: NewsAssessment | null;
  config: AriseConfig;
  now: number;
  /** Symbols whose fresh completed marks were unavailable (when known). */
  marksUnavailable?: string[];
}

const AGENT_ORDER: { id: string; analysis: (a: LedgerInput["agents"]) => AgentAnalysis }[] = [
  { id: "quant_ai", analysis: (a) => a.quant },
  { id: "technical_ai", analysis: (a) => a.technical },
  { id: "regime_ai", analysis: (a) => a.regime },
  { id: "anomaly_ai", analysis: (a) => a.anomaly },
  { id: "portfolio_ai", analysis: (a) => a.portfolio },
  { id: "risk_ai", analysis: (a) => a.risk },
];

/**
 * Build the ledger from the pipeline's own outputs.
 *
 * Note what is deliberately NOT claimed here: funding, open interest, sentiment
 * or macro data are absent from ARISE's providers, so they appear as nothing at
 * all rather than as fabricated observations.
 */
export function buildEvidenceLedger(input: LedgerInput): EvidenceLedger {
  const { snapshot, features, agents, config, now } = input;
  const claims: EvidenceClaim[] = [];
  const unknowns: EvidenceUnknown[] = [];
  const contradictions: EvidenceContradiction[] = [];

  const marketSource = `${snapshot.source}:${snapshot.symbol}:${snapshot.interval}`;
  const barTime = snapshot.latest.time;

  // ---- OBSERVED: things read straight out of the validated provider payload ----
  claims.push({
    id: "observed.last_close",
    kind: "OBSERVED",
    statement: `last validated close ${snapshot.latest.close} at bar ${new Date(barTime).toISOString()}`,
    source: marketSource,
    sourceReliability: "PRIMARY",
    independentSources: 1,
    strength: claimStrength("OBSERVED", "PRIMARY", 1),
    direction: "NEUTRAL",
    observedAt: barTime,
  });
  claims.push({
    id: "observed.bar_count",
    kind: "OBSERVED",
    statement: `${features.barCount} bars passed validation (minimum ${config.minBars})`,
    source: marketSource,
    sourceReliability: "PRIMARY",
    independentSources: 1,
    strength: claimStrength("OBSERVED", "PRIMARY", 1),
    direction: "NEUTRAL",
    observedAt: barTime,
  });
  claims.push({
    id: "observed.quote_age",
    kind: "OBSERVED",
    statement: `quote age ${snapshot.quoteAgeSec}s (stale beyond ${config.staleDataSec}s)`,
    source: marketSource,
    sourceReliability: "PRIMARY",
    independentSources: 1,
    strength: claimStrength("OBSERVED", "PRIMARY", 1),
    direction: "NEUTRAL",
    observedAt: now,
  });

  // ---- CALCULATED: ours, deterministic, reproducible from the bars above ----
  const calculated: { id: string; statement: string; direction: ClaimDirection }[] = [
    {
      id: "calculated.atr_pct",
      statement: `ATR14 ${features.volatility.atrPct.toFixed(3)}% of price (${features.volatility.volRegime})`,
      direction: "NEUTRAL",
    },
    {
      id: "calculated.rsi14",
      statement: `RSI14 ${features.momentum.rsi14.toFixed(1)} (${features.momentum.rsiState})`,
      direction: "NEUTRAL",
    },
    {
      id: "calculated.adx",
      statement: `ADX ${features.trend.adx.toFixed(1)} (${features.trend.trendStrength}), EMA structure ${features.trend.emaStructure}`,
      direction: "NEUTRAL",
    },
    {
      id: "calculated.vol_percentile",
      statement: `realized volatility ${features.volatility.realizedVolPct.toFixed(3)}% at percentile ${features.volatility.volPercentile.toFixed(0)}`,
      direction: "NEUTRAL",
    },
  ];
  for (const item of calculated) {
    claims.push({
      id: item.id,
      kind: "CALCULATED",
      statement: item.statement,
      source: "arise:quant",
      sourceReliability: "DERIVED",
      independentSources: 1,
      strength: claimStrength("CALCULATED", "DERIVED", 1),
      direction: item.direction,
      observedAt: barTime,
    });
  }
  if (snapshot.spreadPct !== null) {
    claims.push({
      id: "calculated.spread",
      kind: "CALCULATED",
      statement: `spread ${snapshot.spreadPct.toFixed(4)}% (limit ${config.maxSpreadPct}%)`,
      source: "arise:quant",
      sourceReliability: "DERIVED",
      independentSources: 1,
      strength: claimStrength("CALCULATED", "DERIVED", 1),
      direction: "NEUTRAL",
      observedAt: now,
    });
  } else {
    unknowns.push({
      id: "unknown.spread",
      description: "no quote book for this instrument — spread cost is unverified",
      impact: "REDUCES_SIZE",
    });
  }

  // ---- INFERENCE: every directional agent opinion, corroborated by agreement ----
  const directionalAnalyses = AGENT_ORDER.map((entry) => ({
    id: entry.id,
    a: entry.analysis(agents),
  })).filter((x) => x.a.signal === "LONG" || x.a.signal === "SHORT");

  const longAgents = directionalAnalyses.filter((x) => x.a.signal === "LONG").length;
  const shortAgents = directionalAnalyses.filter((x) => x.a.signal === "SHORT").length;

  for (const { id, a } of directionalAnalyses) {
    const agree = a.signal === "LONG" ? longAgents : shortAgents;
    claims.push({
      id: `inference.${id}`,
      kind: "INFERENCE",
      statement: a.summary,
      source: `agent:${id}:${a.modelVersion}`,
      sourceReliability: "DERIVED",
      // Agents read the same price series, so agreement is corroboration of the
      // reading, NOT independent confirmation of the market. Capped below the
      // level that a genuinely independent source would reach.
      independentSources: agree,
      strength: claimStrength("INFERENCE", "DERIVED", Math.min(agree, 2)),
      direction: a.signal === "LONG" ? "LONG" : "SHORT",
      observedAt: a.dataTimestamp,
    });
  }

  // Objections are evidence AGAINST acting, even though they carry no direction.
  for (const { id, a } of AGENT_ORDER.map((entry) => ({ id: entry.id, a: entry.analysis(agents) }))) {
    if (a.signal === "RISK_FLAG") {
      claims.push({
        id: `objection.${id}`,
        kind: "CALCULATED",
        statement: `${id} flagged a risk condition: ${a.summary}`,
        source: `agent:${id}`,
        sourceReliability: "DERIVED",
        independentSources: 1,
        strength: claimStrength("CALCULATED", "DERIVED", 1),
        direction: "NEUTRAL",
        observedAt: a.dataTimestamp,
      });
    }
  }

  // ---- HYPOTHESIS: MIND's narrative. Never used to justify size. ----
  if (input.mind.direction !== "FLAT") {
    claims.push({
      id: "hypothesis.mind_thesis",
      kind: "HYPOTHESIS",
      statement: input.mind.thesis,
      source: "mind:mind-v1",
      sourceReliability: "DERIVED",
      independentSources: 1,
      strength: claimStrength("HYPOTHESIS", "DERIVED", 1),
      direction: input.mind.direction,
      observedAt: now,
    });
  }

  // ---- News: real headlines only, and never a policy channel. ----
  const news = input.news;
  if (news && news.status === "AVAILABLE" && news.score !== null) {
    const direction: ClaimDirection =
      news.score > 0.15 ? "LONG" : news.score < -0.15 ? "SHORT" : "NEUTRAL";
    // Corroboration is the number of DISTINCT publishers behind the scored
    // headlines, not the number of headlines: five rewrites of one wire story
    // are still one source, and must not inflate claim strength.
    const distinctSources = new Set(news.items.map((item) => item.sourceId)).size;
    claims.push({
      id: "observed.news_sentiment",
      kind: "OBSERVED",
      statement: `${news.freshCount} fresh headline(s) from ${distinctSources} source(s) scoring ${news.score.toFixed(2)}`,
      source: "news:feed",
      sourceReliability: "SECONDARY",
      independentSources: Math.max(1, distinctSources),
      strength: claimStrength("OBSERVED", "SECONDARY", Math.max(1, distinctSources)),
      direction,
      observedAt: now,
    });
  } else {
    // Zero-influence by design: an unavailable news layer must not fabricate a
    // neutral reading, and must not be silently treated as bullish or bearish.
    unknowns.push({
      id: "unknown.news",
      description: `news layer ${news ? news.status : "UNAVAILABLE"} — no headline evidence available`,
      impact: "INFORMATIONAL",
    });
  }

  if (input.marksUnavailable && input.marksUnavailable.length > 0) {
    unknowns.push({
      id: "unknown.marks",
      description: `fresh completed marks unavailable for ${input.marksUnavailable.join(", ")} — account equity cannot be trusted`,
      impact: "BLOCKS_TRADE",
    });
  }

  // ---- Contradictions: opposite directional claims. ----
  const longs = claims.filter((c) => c.direction === "LONG");
  const shorts = claims.filter((c) => c.direction === "SHORT");
  for (const l of longs) {
    for (const s of shorts) {
      contradictions.push({
        a: l.id,
        b: s.id,
        note: `${l.source} argues LONG while ${s.source} argues SHORT`,
      });
    }
  }

  return { claims, unknowns, contradictions };
}

/** Everything the decision pipeline knows at the moment authorization is decided. */
export interface DecisionGateInput extends LedgerInput {
  riskDecision: Pick<RiskDecision, "decision" | "reasonCode">;
  /** True only when the configured execution mode is paper. */
  paperMode: boolean;
}

export interface DecisionGateResult {
  candidate: DecisionOutcome;
  outcome: DecisionOutcome;
  assessment: EvidenceAssessment;
  ledger: EvidenceLedger;
  /** True when the gates lowered the candidate outcome. */
  downgraded: boolean;
}

/**
 * The full deterministic gate used by the pipeline: build the ledger, verdict it,
 * then let it lower (never raise) the candidate outcome. Fail-closed by
 * construction — a missing or unusable input becomes a BLOCK or HOLD reason.
 */
export function evaluateDecisionGate(input: DecisionGateInput): DecisionGateResult {
  const ledger = buildEvidenceLedger(input);
  const assessment = assessEvidence(ledger);
  const reasons = [...assessment.reasons];

  // Data-quality gates live here rather than in the ledger because they are
  // properties of the snapshot as a whole, not of an individual claim.
  const quality: DataQuality = input.snapshot.quality;
  if (quality === "invalid") {
    reasons.push({
      code: REASON.DATA_QUALITY_INVALID,
      level: "BLOCK",
      detail: "snapshot quality is invalid — no observation can be trusted",
    });
  } else if (quality === "stale") {
    reasons.push({
      code: REASON.DATA_STALE,
      level: "BLOCK",
      detail: `snapshot is stale (quote age ${input.snapshot.quoteAgeSec}s)`,
    });
  } else if (quality === "degraded") {
    // Degraded snapshots (an unexplained gap or bars removed as structurally
    // invalid) still carry usable information, but not enough to authorise an
    // action. HOLD makes the pipeline WAIT instead of TRADE; a high signal score
    // can never override missing data.
    reasons.push({
      code: REASON.DATA_QUALITY_DEGRADED,
      level: "HOLD",
      detail: "snapshot quality is degraded (unexplained gap or removed bars) — no actionable decision",
    });
  }
  if (input.features.barCount < input.config.minBars) {
    reasons.push({
      code: REASON.INSUFFICIENT_SAMPLE,
      level: "BLOCK",
      detail: `${input.features.barCount} bars validated, ${input.config.minBars} required`,
    });
  }
  if (input.riskDecision.decision === "VETOED") {
    reasons.push({
      code: REASON.RISK_VETO,
      level: "BLOCK",
      detail: `risk engine vetoed: ${input.riskDecision.reasonCode}`,
    });
  }
  if (!input.paperMode) {
    reasons.push({
      code: REASON.EXECUTION_MODE_NOT_PAPER,
      level: "BLOCK",
      detail: "execution mode is not paper — ARISE V1 refuses to authorize",
    });
  }
  if (input.news && input.news.policyOverrideAttempt === true) {
    // External text tried to act as an instruction. The headline never had
    // authority; recording it here makes the attempt auditable.
    reasons.push({
      code: REASON.NEWS_POLICY_OVERRIDE_ATTEMPT,
      level: "INFO",
      detail: "external text contained an instruction-like policy override attempt",
    });
  }

  const gated: EvidenceAssessment = {
    ...assessment,
    reasons,
    reasonCodes: Array.from(new Set(reasons.map((r) => r.code))),
  };

  const blocks = gated.reasons.filter((r) => r.level === "BLOCK");
  const holds = gated.reasons.filter((r) => r.level === "HOLD");
  const verdict: DecisionOutcome =
    blocks.length > 0 ? "REJECT" : holds.length > 0 ? "WAIT" : "TRADE";

  const candidate: DecisionOutcome =
    input.riskDecision.decision === "VETOED"
      ? "REJECT"
      : input.mind.direction === "FLAT"
        ? "WAIT"
        : "TRADE";

  const assessmentWithVerdict: EvidenceAssessment = { ...gated, outcome: verdict };
  const outcome = gateOutcome(candidate, assessmentWithVerdict);
  assessmentWithVerdict.outcome = outcome;

  return {
    candidate,
    outcome,
    assessment: assessmentWithVerdict,
    ledger,
    downgraded: outcomeRank(outcome) < outcomeRank(candidate),
  };
}
