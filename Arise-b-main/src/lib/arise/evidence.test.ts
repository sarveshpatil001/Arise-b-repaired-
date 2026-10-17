// ARISE V1 — Evidence & Decision Engine tests.
//
// The engine exists to make three things mechanically true, and each is tested
// directly rather than assumed:
//   1. Opinions (inferences/hypotheses) can never masquerade as facts.
//   2. A gate can only LOWER authorization — never raise it.
//   3. Missing or unusable inputs fail closed.
//
// Fixtures are deterministic: synthetic bars, a fixed clock, no network, no
// randomness. Lives outside src/convex/ so the Convex bundler never sees vitest.

import { describe, expect, it } from "vitest";
import {
  applyConfidenceCeiling,
  assessEvidence,
  buildEvidenceLedger,
  claimStrength,
  evaluateDecisionGate,
  gateOutcome,
  REASON,
  type ClaimDirection,
  type DecisionOutcome,
  type EvidenceClaim,
  type EvidenceLedger,
} from "@/lib/arise/evidence";
import { runAllAgents } from "@/lib/arise/agents";
import { runMind } from "@/lib/arise/mind";
import { computeQuantFeatures } from "@/lib/arise/quant";
import { DEFAULT_CONFIG } from "@/lib/arise/config";
import type { Bar, MarketSnapshot } from "@/lib/arise/types";

const NOW = 1_700_000_200_000;

function makeBars(n: number): Bar[] {
  const bars: Bar[] = [];
  const start = NOW - n * 3_600_000;
  let price = 30_000;
  for (let i = 0; i < n; i++) {
    const open = price;
    // Deterministic drift plus a slow oscillation so every indicator is defined.
    const close = price * 1.004 + Math.sin(i / 5) * price * 0.001;
    bars.push({
      symbol: "BTCUSDT",
      assetClass: "crypto",
      interval: "1h",
      time: start + i * 3_600_000,
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
      volume: 1000 + (i % 7) * 10,
      source: "test:provider",
      quality: "valid",
    });
    price = close;
  }
  return bars;
}

function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  const bars = makeBars(200);
  const latest = bars[bars.length - 1];
  return {
    symbol: "BTCUSDT",
    assetClass: "crypto",
    interval: "1h",
    bars,
    latest,
    quoteAgeSec: 30,
    bestBid: latest.close - 0.5,
    bestAsk: latest.close + 0.5,
    spreadPct: (1 / latest.close) * 100,
    source: "test:provider",
    quality: "valid",
    qualityNotes: [],
    ...overrides,
  };
}

/** A complete, healthy decision context built through the real pipeline stages. */
function healthyContext(overrides: Partial<MarketSnapshot> = {}) {
  const snapshot = makeSnapshot(overrides);
  const features = computeQuantFeatures(snapshot);
  const agents = runAllAgents({
    features,
    openPositionExposurePct: 0,
    openPositions: 0,
    regime: "UNCERTAIN",
    manipulation: "NORMAL",
    config: DEFAULT_CONFIG,
    now: NOW,
  });
  const mind = runMind(agents, features, NOW);
  return { snapshot, features, agents, mind, news: null, config: DEFAULT_CONFIG, now: NOW };
}

let claimSeq = 0;
function claim(
  over: Partial<EvidenceClaim> & { id: string },
  kind: EvidenceClaim["kind"] = "CALCULATED",
  direction: ClaimDirection = "NEUTRAL",
): EvidenceClaim {
  claimSeq += 1;
  const reliability = over.sourceReliability ?? "DERIVED";
  const sources = over.independentSources ?? 1;
  return {
    statement: `statement ${claimSeq}`,
    source: over.source ?? "arise:quant",
    sourceReliability: reliability,
    independentSources: sources,
    strength: claimStrength(kind, reliability, sources),
    direction,
    observedAt: NOW,
    ...over,
    kind: over.kind ?? kind,
  };
}

function ledger(partial: Partial<EvidenceLedger>): EvidenceLedger {
  return { claims: [], unknowns: [], contradictions: [], ...partial };
}

describe("claimStrength", () => {
  it("ranks observations above calculations above inferences above hypotheses", () => {
    const observed = claimStrength("OBSERVED", "PRIMARY", 1);
    const calculated = claimStrength("CALCULATED", "DERIVED", 1);
    const inference = claimStrength("INFERENCE", "DERIVED", 1);
    const hypothesis = claimStrength("HYPOTHESIS", "DERIVED", 1);
    expect(observed).toBeGreaterThan(calculated);
    expect(calculated).toBeGreaterThan(inference);
    expect(inference).toBeGreaterThan(hypothesis);
  });

  it("never lets a confident opinion outrank a plain fact", () => {
    // An inference agreed on by five agents must still not beat a primary observation.
    expect(claimStrength("INFERENCE", "DERIVED", 5)).toBeLessThan(
      claimStrength("OBSERVED", "PRIMARY", 1),
    );
  });

  it("caps the corroboration bonus and stays inside 0..1", () => {
    expect(claimStrength("OBSERVED", "PRIMARY", 100)).toBeLessThanOrEqual(1);
    expect(claimStrength("OBSERVED", "PRIMARY", 2)).toBeGreaterThan(
      claimStrength("OBSERVED", "PRIMARY", 1),
    );
  });

  it("fails safe on non-finite or nonsensical source counts", () => {
    for (const bad of [NaN, Infinity, -Infinity, 0, -3]) {
      const value = claimStrength("CALCULATED", "DERIVED", bad);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe("assessEvidence — fail-closed verdicts", () => {
  it("rejects an empty ledger instead of defaulting to permission", () => {
    const result = assessEvidence(ledger({}));
    expect(result.outcome).toBe("REJECT");
    expect(result.reasonCodes).toContain(REASON.EVIDENCE_ABSENT);
    expect(result.evidenceQuality).toBe("ABSENT");
    expect(result.confidenceCeiling).toBeLessThanOrEqual(0.2);
  });

  it("rejects when a required input is unknown", () => {
    const result = assessEvidence(
      ledger({
        claims: [claim({ id: "c1", kind: "OBSERVED", sourceReliability: "PRIMARY" })],
        unknowns: [
          { id: "unknown.account", description: "equity unavailable", impact: "BLOCKS_TRADE" },
        ],
      }),
    );
    expect(result.outcome).toBe("REJECT");
    expect(result.reasonCodes).toContain(REASON.UNRESOLVED_CRITICAL_UNKNOWN);
  });

  it("holds (does not reject) when a mere size-reducing input is missing", () => {
    const result = assessEvidence(
      ledger({
        claims: [
          claim({ id: "c1", kind: "OBSERVED", sourceReliability: "PRIMARY", direction: "LONG" }),
          claim({ id: "c2", kind: "CALCULATED", direction: "LONG" }),
        ],
        unknowns: [{ id: "unknown.spread", description: "no quote book", impact: "REDUCES_SIZE" }],
      }),
    );
    expect(result.outcome).toBe("WAIT");
    expect(result.reasonCodes).toContain(REASON.MISSING_SPREAD);
  });

  it("rejects evidence made only of opinions", () => {
    const result = assessEvidence(
      ledger({
        claims: [
          claim({ id: "i1", kind: "INFERENCE", direction: "LONG", independentSources: 3 }),
          claim({ id: "h1", kind: "HYPOTHESIS", direction: "LONG" }),
        ],
      }),
    );
    expect(result.outcome).toBe("REJECT");
    expect(result.reasonCodes).toContain(REASON.EVIDENCE_ABSENT);
  });

  it("holds a direction asserted by a single uncorroborated opinion", () => {
    const result = assessEvidence(
      ledger({
        claims: [
          claim({ id: "o1", kind: "OBSERVED", sourceReliability: "PRIMARY" }),
          claim({ id: "c1", kind: "CALCULATED" }),
          claim({ id: "i1", kind: "INFERENCE", direction: "LONG", independentSources: 1 }),
        ],
      }),
    );
    expect(result.outcome).toBe("WAIT");
    expect(result.reasonCodes).toContain(REASON.UNCORROBORATED_SOURCE);
  });

  it("holds when agents disagree strongly in both directions", () => {
    const result = assessEvidence(
      ledger({
        claims: [
          claim({ id: "o1", kind: "OBSERVED", sourceReliability: "PRIMARY" }),
          claim({ id: "l1", kind: "CALCULATED", direction: "LONG" }),
          claim({ id: "s1", kind: "INFERENCE", direction: "SHORT", independentSources: 2 }),
        ],
        contradictions: [{ a: "l1", b: "s1", note: "opposed readings" }],
      }),
    );
    expect(result.outcome).toBe("WAIT");
    expect(result.reasonCodes).toContain(REASON.CONTRADICTORY_EVIDENCE);
  });

  it("reaches TRADE only with grounded, corroborated, uncontradicted evidence", () => {
    const result = assessEvidence(
      ledger({
        claims: [
          claim({ id: "o1", kind: "OBSERVED", sourceReliability: "PRIMARY" }),
          claim({ id: "o2", kind: "OBSERVED", sourceReliability: "PRIMARY" }),
          claim({ id: "o3", kind: "OBSERVED", sourceReliability: "PRIMARY" }),
          claim({ id: "c1", kind: "CALCULATED", direction: "LONG" }),
          claim({ id: "i1", kind: "INFERENCE", direction: "LONG", independentSources: 3 }),
        ],
      }),
    );
    expect(result.outcome).toBe("TRADE");
    expect(result.reasonCodes).toContain(REASON.EVIDENCE_SUFFICIENT);
    expect(result.evidenceQuality).toBe("STRONG");
    expect(result.confidenceCeiling).toBeGreaterThan(0.5);
    expect(result.deterministic).toBe(true);
  });

  it("reports absent news as an unknown without treating it as a veto", () => {
    const result = assessEvidence(
      ledger({
        claims: [
          claim({ id: "o1", kind: "OBSERVED", sourceReliability: "PRIMARY" }),
          claim({ id: "c1", kind: "CALCULATED", direction: "LONG" }),
        ],
        unknowns: [{ id: "unknown.news", description: "news UNAVAILABLE", impact: "INFORMATIONAL" }],
      }),
    );
    expect(result.outcome).toBe("TRADE");
    expect(result.unknowns.map((u) => u.id)).toContain("unknown.news");
  });

  it("produces unique, stable reason codes for the same ledger", () => {
    const input = ledger({
      claims: [claim({ id: "o1", kind: "OBSERVED", sourceReliability: "PRIMARY" })],
      unknowns: [{ id: "u", description: "x", impact: "BLOCKS_TRADE" }],
    });
    const a = assessEvidence(input);
    const b = assessEvidence(input);
    expect(a.reasonCodes).toEqual(b.reasonCodes);
    expect(new Set(a.reasonCodes).size).toBe(a.reasonCodes.length);
    expect(a).toEqual(b);
  });
});

describe("gateOutcome — downgrade only", () => {
  const withOutcome = (outcome: DecisionOutcome) =>
    assessEvidence(ledger({
      // A direction must rest on a calculation as well as an observation, so the
      // TRADE fixture deliberately carries both.
      claims: [
        claim({ id: "o", kind: "OBSERVED", sourceReliability: "PRIMARY", direction: "LONG" }),
        claim({ id: "c", kind: "CALCULATED", direction: "LONG" }),
      ],
      unknowns:
        outcome === "REJECT"
          ? [{ id: "u", description: "missing", impact: "BLOCKS_TRADE" }]
          : outcome === "WAIT"
            ? [{ id: "u", description: "missing", impact: "REDUCES_SIZE" }]
            : [],
    }));

  it("maps verdicts to the expected outcome so the fixture is meaningful", () => {
    expect(withOutcome("REJECT").outcome).toBe("REJECT");
    expect(withOutcome("WAIT").outcome).toBe("WAIT");
    expect(withOutcome("TRADE").outcome).toBe("TRADE");
  });

  it("lowers a candidate but never raises it", () => {
    expect(gateOutcome("TRADE", withOutcome("WAIT"))).toBe("WAIT");
    expect(gateOutcome("TRADE", withOutcome("REJECT"))).toBe("REJECT");
    expect(gateOutcome("WAIT", withOutcome("TRADE"))).toBe("WAIT");
    expect(gateOutcome("REJECT", withOutcome("TRADE"))).toBe("REJECT");
    expect(gateOutcome("WAIT", withOutcome("REJECT"))).toBe("REJECT");
    expect(gateOutcome("TRADE", withOutcome("TRADE"))).toBe("TRADE");
  });

  it("keeps a rejection rejected even when the evidence looks permissive", () => {
    expect(gateOutcome("REJECT", withOutcome("TRADE"))).toBe("REJECT");
  });
});

describe("applyConfidenceCeiling", () => {
  it("caps a confident opinion at what the evidence supports", () => {
    expect(applyConfidenceCeiling(0.9, 0.4)).toBe(0.4);
    expect(applyConfidenceCeiling(0.3, 0.4)).toBe(0.3);
  });

  it("treats non-finite input as no confidence rather than maximum", () => {
    // Fail closed: an unrepresentable confidence is no confidence, never maximum.
    expect(applyConfidenceCeiling(NaN, 0.8)).toBe(0);
    expect(applyConfidenceCeiling(Infinity, 0.8)).toBe(0);
    expect(applyConfidenceCeiling(-Infinity, 0.8)).toBe(0);
    expect(applyConfidenceCeiling(0.5, NaN)).toBe(0);
  });
});

describe("buildEvidenceLedger", () => {
  it("labels provenance honestly and never claims unavailable inputs", () => {
    const context = healthyContext();
    const built = buildEvidenceLedger(context);
    const kinds = new Set(built.claims.map((c) => c.kind));
    expect(kinds.has("OBSERVED")).toBe(true);
    expect(kinds.has("CALCULATED")).toBe(true);
    // No news was supplied, so there must be an explicit unknown rather than a
    // fabricated neutral headline reading.
    expect(built.unknowns.map((u) => u.id)).toContain("unknown.news");
    // Funding, open interest and macro data have no provider at all: they must
    // appear as nothing, not as zero-valued observations.
    expect(built.claims.some((c) => c.id.includes("funding"))).toBe(false);
  });

  it("records a critical unknown when account marks are unavailable", () => {
    const built = buildEvidenceLedger({ ...healthyContext(), marksUnavailable: ["ETHUSDT"] });
    const marks = built.unknowns.find((u) => u.id === "unknown.marks");
    expect(marks?.impact).toBe("BLOCKS_TRADE");
  });

  it("records a contradiction whenever both directions are argued", () => {
    const built = buildEvidenceLedger(healthyContext());
    const hasLong = built.claims.some((c) => c.direction === "LONG");
    const hasShort = built.claims.some((c) => c.direction === "SHORT");
    if (hasLong && hasShort) {
      expect(built.contradictions.length).toBeGreaterThan(0);
    } else {
      expect(built.contradictions).toHaveLength(0);
    }
  });
});

describe("evaluateDecisionGate — end-to-end authorization", () => {
  it("rejects a non-paper execution mode regardless of how good the analysis looks", () => {
    const result = evaluateDecisionGate({
      ...healthyContext(),
      riskDecision: { decision: "APPROVED", reasonCode: "OK" },
      paperMode: false,
    });
    expect(result.outcome).toBe("REJECT");
    expect(result.assessment.reasonCodes).toContain(REASON.EXECUTION_MODE_NOT_PAPER);
  });

  it("rejects a stale snapshot instead of trading on aged data", () => {
    const result = evaluateDecisionGate({
      ...healthyContext({ quality: "stale", quoteAgeSec: 900 }),
      riskDecision: { decision: "APPROVED", reasonCode: "OK" },
      paperMode: true,
    });
    expect(result.outcome).toBe("REJECT");
    expect(result.assessment.reasonCodes).toContain(REASON.DATA_STALE);
  });

  it("rejects an invalid snapshot", () => {
    const result = evaluateDecisionGate({
      ...healthyContext({ quality: "invalid" }),
      riskDecision: { decision: "APPROVED", reasonCode: "OK" },
      paperMode: true,
    });
    expect(result.outcome).toBe("REJECT");
    expect(result.assessment.reasonCodes).toContain(REASON.DATA_QUALITY_INVALID);
  });

  // Regression: a gap or removed bar used to be a diagnostic note only, so a
  // high-scoring signal could still produce an actionable TRADE on incomplete data.
  it("withholds an actionable decision on a degraded snapshot", () => {
    const result = evaluateDecisionGate({
      ...healthyContext({ quality: "degraded" }),
      riskDecision: { decision: "APPROVED", reasonCode: "OK" },
      paperMode: true,
    });
    expect(result.outcome).not.toBe("TRADE");
    expect(result.outcome).toBe("WAIT");
    expect(result.assessment.reasonCodes).toContain(REASON.DATA_QUALITY_DEGRADED);
  });

  it("rejects whenever the risk engine vetoes, and never overrides it", () => {
    const result = evaluateDecisionGate({
      ...healthyContext(),
      riskDecision: { decision: "VETOED", reasonCode: "MAX_DAILY_LOSS" },
      paperMode: true,
    });
    expect(result.outcome).toBe("REJECT");
    expect(result.assessment.reasonCodes).toContain(REASON.RISK_VETO);
    expect(result.candidate).toBe("REJECT");
  });

  it("rejects when the sample is too small to analyse", () => {
    const result = evaluateDecisionGate({
      ...healthyContext(),
      config: { ...DEFAULT_CONFIG, minBars: 5_000 },
      riskDecision: { decision: "APPROVED", reasonCode: "OK" },
      paperMode: true,
    });
    expect(result.outcome).toBe("REJECT");
    expect(result.assessment.reasonCodes).toContain(REASON.INSUFFICIENT_SAMPLE);
  });

  it("never authorizes more than the evidence supports on a healthy fixture", () => {
    const result = evaluateDecisionGate({
      ...healthyContext(),
      riskDecision: { decision: "APPROVED", reasonCode: "OK" },
      paperMode: true,
    });
    expect(["TRADE", "WAIT", "REJECT"]).toContain(result.outcome);
    expect(result.assessment.reasonCodes).not.toContain(REASON.DATA_QUALITY_INVALID);
    expect(result.assessment.reasonCodes).not.toContain(REASON.INSUFFICIENT_SAMPLE);
    // downgraded is true exactly when the gate withheld the candidate outcome.
    const rank = (o: DecisionOutcome) => (o === "TRADE" ? 2 : o === "WAIT" ? 1 : 0);
    expect(result.downgraded).toBe(rank(result.outcome) < rank(result.candidate));
  });

  it("is reproducible: the same context yields the same verdict", () => {
    const context = healthyContext();
    const first = evaluateDecisionGate({
      ...context,
      riskDecision: { decision: "APPROVED", reasonCode: "OK" },
      paperMode: true,
    });
    const second = evaluateDecisionGate({
      ...context,
      riskDecision: { decision: "APPROVED", reasonCode: "OK" },
      paperMode: true,
    });
    expect(first.outcome).toBe(second.outcome);
    expect(first.assessment.reasonCodes).toEqual(second.assessment.reasonCodes);
    expect(first.assessment.confidenceCeiling).toBe(second.assessment.confidenceCeiling);
  });

  it("records an instruction-like headline as an auditable attempt only", () => {
    const result = evaluateDecisionGate({
      ...healthyContext(),
      news: {
        status: "UNAVAILABLE",
        symbol: "BTCUSDT",
        assetClass: "crypto",
        signal: "NEUTRAL",
        score: null,
        confidence: 0,
        fetchedCount: 1,
        relevantCount: 0,
        freshCount: 0,
        freshestAt: null,
        freshestAgeSec: null,
        drivers: [],
        evidence: [],
        risks: [],
        notes: ["instruction-like text treated as data only"],
        items: [],
        policyOverrideAttempt: true,
      } as never,
      riskDecision: { decision: "APPROVED", reasonCode: "OK" },
      paperMode: true,
    });
    const attempt = result.assessment.reasons.find(
      (r) => r.code === REASON.NEWS_POLICY_OVERRIDE_ATTEMPT,
    );
    // Recorded for operators, but INFO only: an external string never blocks or
    // grants authorization on its own.
    expect(attempt?.level).toBe("INFO");
  });
});
