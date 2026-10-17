// ARISE V1 — strategy fitness gate tests.
// Deterministic fixtures only: no network, no clock reads, no randomness. Every
// test states the measurement it supplies and the gate that must react to it.

import { describe, expect, it } from "vitest";
import {
  FITNESS_POLICY,
  canonicalSignature,
  detectDuplicateStrategies,
  evaluateStrategyFitness,
  promotionDecision,
  type ParameterVariant,
  type StrategyFitnessInput,
  type WalkForwardFold,
} from "./strategyFitness";
import { DEFAULT_BT_CONFIG, type BTMetrics } from "./backtest";

function metrics(overrides: Partial<BTMetrics> = {}): BTMetrics {
  return {
    tradeCount: 60,
    winRatePct: 52,
    totalReturnPct: 12,
    inSampleReturnPct: 8,
    outSampleReturnPct: 4,
    maxDrawdownPct: 9,
    profitFactor: 1.6,
    sharpe: 1.4,
    expectancy: 21,
    avgHoldingBars: 12,
    exposurePct: 30,
    feesTotal: 84.5,
    finalEquity: 11_200,
    ...overrides,
  };
}

function folds(returns: number[]): WalkForwardFold[] {
  return returns.map((returnPct, index) => ({ index, returnPct, tradeCount: 12 }));
}

function variants(returns: number[]): ParameterVariant[] {
  return returns.map((returnPct, i) => ({ label: `v${i}`, returnPct }));
}

/** A fully measured, genuinely strong evaluation: every gate should pass. */
function strongInput(overrides: Partial<StrategyFitnessInput> = {}): StrategyFitnessInput {
  return {
    strategyId: "sma-cross",
    strategyVersion: "1.0.0",
    metrics: metrics(),
    insufficientData: false,
    barCount: 5000,
    minBars: DEFAULT_BT_CONFIG.minBars,
    oosTradeCount: 18,
    walkForwardFolds: folds([3.1, 2.4, -0.8, 4.2]),
    parameterVariants: variants([4.0, 4.6, 3.7, 5.1, 4.2, 3.9]),
    costsApplied: { feeBps: DEFAULT_BT_CONFIG.feeBps, slippageBps: DEFAULT_BT_CONFIG.slippageBps },
    leakageGuard: { lookAheadChecked: true, usesNextBarOpenForFills: true, deterministicSeed: true },
    ...overrides,
  };
}

const gate = (input: StrategyFitnessInput, id: string) =>
  evaluateStrategyFitness(input).gates.find((g) => g.id === id)!;

describe("evaluateStrategyFitness — the happy path", () => {
  it("marks a fully measured strong result eligible with no blockers", () => {
    const result = evaluateStrategyFitness(strongInput());
    expect(result.eligible).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.score).toBe(100);
    expect(result.gates.every((g) => g.pass)).toBe(true);
  });

  it("records a threshold and a reason on every gate so a verdict is reviewable", () => {
    const result = evaluateStrategyFitness(strongInput());
    for (const g of result.gates) {
      expect(g.reason.length).toBeGreaterThan(0);
      expect(g.id).toMatch(/^[A-Z_]+$/);
    }
    expect(gate(strongInput(), "MAX_DRAWDOWN").threshold).toBe(
      FITNESS_POLICY.maxDrawdownPct.value,
    );
  });

  it("reports strategy lineage when a parent version is supplied", () => {
    const result = evaluateStrategyFitness(strongInput({ parentVersion: "0.9.0" }));
    expect(result.notes.join(" ")).toContain("0.9.0");
  });
});

describe("evaluateStrategyFitness — sample size gates", () => {
  it("fails the sample-size gate below the configured minimum trade count", () => {
    const input = strongInput({ metrics: metrics({ tradeCount: 9 }) });
    const g = gate(input, "SAMPLE_SIZE");
    expect(g.pass).toBe(false);
    expect(g.critical).toBe(true);
    expect(evaluateStrategyFitness(input).eligible).toBe(false);
  });

  it("fails closed when the out-of-sample trade count was never measured", () => {
    const input = strongInput({ oosTradeCount: null });
    const g = gate(input, "OOS_SAMPLE");
    expect(g.pass).toBe(false);
    expect(g.value).toBeNull();
    expect(g.reason).toContain("failing closed");
  });

  it("fails the OOS evidence gate when no out-of-sample trades exist", () => {
    const input = strongInput({ oosTradeCount: 0 });
    const g = gate(input, "OOS_EVIDENCE");
    expect(g.pass).toBe(false);
    expect(g.reason).toContain("no out-of-sample trades");
  });

  it("fails the data-adequacy gate when the engine reported insufficient data", () => {
    const input = strongInput({ insufficientData: true });
    expect(gate(input, "DATA_ADEQUACY").pass).toBe(false);
    expect(evaluateStrategyFitness(input).eligible).toBe(false);
  });

  it("fails data adequacy when the bar count was not measured", () => {
    const input = strongInput({ barCount: null });
    expect(gate(input, "DATA_ADEQUACY").pass).toBe(false);
  });
});

describe("evaluateStrategyFitness — overfitting and stability", () => {
  it("fails when in-sample is positive and out-of-sample is negative", () => {
    const input = strongInput({
      metrics: metrics({ inSampleReturnPct: 22, outSampleReturnPct: -4 }),
    });
    const g = gate(input, "OVERFIT_DEGRADATION");
    expect(g.pass).toBe(false);
    expect(g.reason).toContain("overfit");
  });

  it("fails when degradation exceeds the policy allowance", () => {
    const input = strongInput({
      metrics: metrics({ inSampleReturnPct: 30, outSampleReturnPct: 5 }),
    });
    const g = gate(input, "OVERFIT_DEGRADATION");
    expect(g.pass).toBe(false);
    expect(g.value).toBeCloseTo(25, 6);
  });

  it("accepts degradation inside the allowance", () => {
    const input = strongInput({
      metrics: metrics({ inSampleReturnPct: 12, outSampleReturnPct: 4 }),
    });
    expect(gate(input, "OVERFIT_DEGRADATION").pass).toBe(true);
  });

  it("fails closed when walk-forward folds were not measured", () => {
    const input = strongInput({ walkForwardFolds: null });
    const g = gate(input, "WALK_FORWARD_STABILITY");
    expect(g.pass).toBe(false);
    expect(g.reason).toContain("not measured");
  });

  it("reports unmeasured walk-forward and parameter evidence as blockers, not soft failures", () => {
    const input = strongInput({ walkForwardFolds: null, parameterVariants: null });
    const result = evaluateStrategyFitness(input);
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain("WALK_FORWARD_STABILITY");
    expect(result.blockers).toContain("PARAMETER_STABILITY");
  });

  it("fails with too few walk-forward folds", () => {
    const input = strongInput({ walkForwardFolds: folds([3.1, -0.4]) });
    const g = gate(input, "WALK_FORWARD_STABILITY");
    expect(g.pass).toBe(false);
    expect(g.value).toBe(2);
  });

  it("fails an unstable walk-forward run even when the headline return is good", () => {
    const input = strongInput({ walkForwardFolds: folds([5.0, -3.2, -1.4, -2.0]) });
    const g = gate(input, "WALK_FORWARD_STABILITY");
    expect(g.pass).toBe(false);
    expect(g.value).toBeCloseTo(0.25, 6);
    expect(evaluateStrategyFitness(input).eligible).toBe(false);
  });

  it("fails closed when a fold return is non-finite", () => {
    const input = strongInput({ walkForwardFolds: folds([3.1, Number.NaN, -0.4]) });
    expect(gate(input, "WALK_FORWARD_STABILITY").pass).toBe(false);
  });

  it("fails with too few parameter variants", () => {
    const input = strongInput({ parameterVariants: variants([4.0, 4.2]) });
    const g = gate(input, "PARAMETER_STABILITY");
    expect(g.pass).toBe(false);
    expect(g.value).toBe(2);
  });

  it("fails a fragile optimum whose result collapses under small parameter changes", () => {
    const input = strongInput({ parameterVariants: variants([18, 1, -6, 9, 4, 2]) });
    const g = gate(input, "PARAMETER_STABILITY");
    expect(g.pass).toBe(false);
    expect(g.reason).toContain("fragile");
  });
});

describe("evaluateStrategyFitness — drawdown and cost realism", () => {
  it("fails when drawdown exceeds the policy maximum", () => {
    const input = strongInput({ metrics: metrics({ maxDrawdownPct: 27 }) });
    const g = gate(input, "MAX_DRAWDOWN");
    expect(g.pass).toBe(false);
    expect(g.threshold).toBe(FITNESS_POLICY.maxDrawdownPct.value);
  });

  it("fails closed when drawdown was not measured", () => {
    const input = strongInput({ metrics: metrics({ maxDrawdownPct: Number.NaN }) });
    expect(gate(input, "MAX_DRAWDOWN").pass).toBe(false);
  });

  it("rejects a cost-free backtest as not evidence", () => {
    const input = strongInput({ costsApplied: { feeBps: 0, slippageBps: 0 } });
    const g = gate(input, "COST_REALISM");
    expect(g.pass).toBe(false);
    expect(g.reason).toContain("not cost-realistic");
  });

  it("rejects a run that charged no fees at all", () => {
    const input = strongInput({ metrics: metrics({ feesTotal: 0 }) });
    expect(gate(input, "COST_REALISM").pass).toBe(false);
  });

  it("fails closed when applied costs were not recorded", () => {
    const input = strongInput({ costsApplied: null });
    expect(gate(input, "COST_REALISM").pass).toBe(false);
  });
});

describe("evaluateStrategyFitness — leakage and profitability", () => {
  it("fails closed when no leakage evidence is supplied", () => {
    const input = strongInput({ leakageGuard: null });
    const g = gate(input, "LEAKAGE_GUARD");
    expect(g.pass).toBe(false);
    expect(g.critical).toBe(true);
    expect(evaluateStrategyFitness(input).blockers).toContain("LEAKAGE_GUARD");
  });

  it("fails when the leakage guard is incomplete", () => {
    const input = strongInput({
      leakageGuard: { lookAheadChecked: true, usesNextBarOpenForFills: false, deterministicSeed: true },
    });
    expect(gate(input, "LEAKAGE_GUARD").pass).toBe(false);
  });

  it("fails a profit factor below the policy minimum", () => {
    const input = strongInput({ metrics: metrics({ profitFactor: 1.05 }) });
    expect(gate(input, "PROFIT_FACTOR").pass).toBe(false);
  });

  it("fails a non-positive expectancy", () => {
    const input = strongInput({ metrics: metrics({ expectancy: 0 }) });
    expect(gate(input, "EXPECTANCY").pass).toBe(false);
  });

  it("keeps a non-critical failure blocking eligibility while excluding it from blockers", () => {
    const input = strongInput({ metrics: metrics({ profitFactor: 1.05 }) });
    const result = evaluateStrategyFitness(input);
    expect(result.eligible).toBe(false);
    expect(result.blockers).toEqual([]);
    expect(result.score).toBeLessThan(100);
  });

  it("fails closed when whole metrics are absent", () => {
    const input = strongInput({ metrics: undefined as unknown as BTMetrics });
    const result = evaluateStrategyFitness(input);
    expect(result.eligible).toBe(false);
    expect(result.score).toBeLessThan(100);
  });
});

describe("promotionDecision", () => {
  const strong = evaluateStrategyFitness(strongInput());

  it("recommends promotion for an eligible candidate but always requires human approval", () => {
    const d = promotionDecision("CANDIDATE", strong);
    expect(d.action).toBe("PROMOTE");
    expect(d.requiresHumanApproval).toBe(true);
  });

  it("never promotes when the strategy is not eligible", () => {
    const weak = evaluateStrategyFitness(strongInput({ oosTradeCount: 0 }));
    const d = promotionDecision("CANDIDATE", weak);
    expect(d.action).toBe("HOLD");
    expect(d.requiresHumanApproval).toBe(true);
  });

  it("demotes an ACTIVE strategy whose critical gate now fails", () => {
    const weak = evaluateStrategyFitness(strongInput({ costsApplied: { feeBps: 0, slippageBps: 0 } }));
    const d = promotionDecision("ACTIVE", weak);
    expect(d.action).toBe("DEMOTE");
    expect(d.blockers).toContain("COST_REALISM");
  });

  it("retires a previously demoted strategy that fails again", () => {
    const weak = evaluateStrategyFitness(strongInput({ walkForwardFolds: null }));
    expect(promotionDecision("DEMOTED", weak).action).toBe("RETIRE");
  });

  it("holds an already active strategy that still passes", () => {
    expect(promotionDecision("ACTIVE", strong).action).toBe("HOLD");
  });

  it("never revives a retired strategy in place", () => {
    const d = promotionDecision("RETIRED", strong);
    expect(d.action).toBe("RETIRE");
    expect(d.reason).toContain("new version");
  });
});

describe("duplicate strategy detection", () => {
  it("treats reordered parameter keys as the same strategy", () => {
    const a = { id: "sma-cross", params: { fast: 20, slow: 50, allowShort: true } };
    const b = { id: "sma-cross-copy", params: { allowShort: true, slow: 50, fast: 20 } };
    expect(canonicalSignature(a)).toBe(canonicalSignature(b));
    const d = detectDuplicateStrategies(a, b);
    expect(d.duplicate).toBe(true);
    expect(d.reason).toContain("identical parameter signature");
  });

  it("normalises floating-point representation noise", () => {
    const a = { id: "x", params: { stopPct: 0.3 } };
    const b = { id: "y", params: { stopPct: 0.1 + 0.2 } };
    expect(canonicalSignature(a)).toBe(canonicalSignature(b));
    expect(detectDuplicateStrategies(a, b).duplicate).toBe(true);
  });

  it("does not flag genuinely different parameters", () => {
    const a = { id: "sma-cross", params: { fast: 20, slow: 50 } };
    const b = { id: "sma-cross-alt", params: { fast: 12, slow: 50 } };
    const d = detectDuplicateStrategies(a, b);
    expect(d.duplicate).toBe(false);
    expect(d.reason).toContain("differ");
  });

  it("ignores the version when comparing structure", () => {
    const a = { id: "s", version: "1.0.0", params: { fast: 20 } };
    const b = { id: "s", version: "1.1.0", params: { fast: 20 } };
    expect(detectDuplicateStrategies(a, b).duplicate).toBe(true);
  });
});
