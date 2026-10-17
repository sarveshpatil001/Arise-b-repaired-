// ARISE V1 — strategy fitness gates.
//
// WHY this module exists separately from `backtest.ts`: the backtest produces
// *measurements* (returns, drawdown, trade counts). This module turns those
// measurements into an explicit, configurable, auditable *admission decision*.
// A strategy may only be promoted when every gate below is satisfied by a
// measured, finite number. Anything unmeasured FAILS — a gate never passes
// because evidence is missing.
//
// The thresholds are ARISE policy, not universal truths. Each carries a
// `rationale` documenting why the value was chosen and what its limitation is,
// because "the strategy passed" is only meaningful next to the bar it passed.

import { clamp } from "./math";
import type { BTMetrics, StrategyId } from "./backtest";

/** A single admission check. `value === null` means the measurement was absent
 *  or non-finite, which is always a failure — see `evaluateStrategyFitness`. */
export interface FitnessGate {
  id: string;
  label: string;
  pass: boolean;
  value: number | null;
  threshold: number | null;
  /** Critical gates additionally move a strategy out of ACTIVE when they fail. */
  critical: boolean;
  reason: string;
}

export interface ThresholdSpec {
  value: number;
  rationale: string;
}

export interface FitnessPolicy {
  /** Minimum closed trades across the whole run before any statistic is trusted. */
  minTrades: ThresholdSpec;
  /** Minimum trades that occurred strictly AFTER the in-sample split. */
  minOosTrades: ThresholdSpec;
  /** Minimum independent walk-forward folds that must have been evaluated. */
  minWalkForwardFolds: ThresholdSpec;
  /** Minimum fraction of walk-forward folds with a positive net return. */
  minProfitableFoldFraction: ThresholdSpec;
  /** Maximum allowed in-sample minus out-of-sample return, in percentage points. */
  maxOverfitDegradationPct: ThresholdSpec;
  /** Maximum allowed peak-to-trough equity drawdown, in percent. */
  maxDrawdownPct: ThresholdSpec;
  /** Maximum allowed spread of results across parameter perturbations, in
   *  percentage points — a fragile optimum shows up here first. */
  maxParameterSpreadPct: ThresholdSpec;
  /** Minimum distinct parameter variants that must have been measured. */
  minParameterVariants: ThresholdSpec;
  /** Minimum gross profit / gross loss from the backtest. */
  minProfitFactor: ThresholdSpec;
  /** Minimum net expectancy per trade, in quote currency (> 0 required). */
  minExpectancy: ThresholdSpec;
}

/**
 * Default ARISE admission policy.
 *
 * These are deliberately conservative for a paper-only research pipeline: it is
 * far cheaper to reject a good strategy than to promote an overfit one. They are
 * NOT universal trading thresholds and must be re-derived for any instrument,
 * timeframe or cost regime where the sample sizes below cannot be reached.
 */
export const FITNESS_POLICY: FitnessPolicy = {
  minTrades: {
    value: 30,
    rationale:
      "Below ~30 closed trades, win rate, profit factor and Sharpe are dominated by " +
      "individual outcomes. Limitation: 30 trades is still a small sample; it is a " +
      "minimum credibility bar, not statistical significance.",
  },
  minOosTrades: {
    value: 10,
    rationale:
      "Out-of-sample evidence is the only defence against overfitting, so it needs its " +
      "own sample. Limitation: a 70/30 split of a small run may never reach 10 OOS trades, " +
      "and the correct outcome then is 'not yet promotable', not a relaxed threshold.",
  },
  minWalkForwardFolds: {
    value: 3,
    rationale:
      "Stability cannot be inferred from a single split — two folds have a 50% chance of " +
      "agreeing by luck. Limitation: folds share overlapping history, so fold count " +
      "overstates independent evidence.",
  },
  minProfitableFoldFraction: {
    value: 0.6,
    rationale:
      "Requires a clear majority of folds positive so one lucky fold cannot carry the " +
      "verdict. Limitation: a genuinely regime-dependent edge can fail this legitimately; " +
      "that is a reason to record a regime condition, not to lower the bar.",
  },
  maxOverfitDegradationPct: {
    value: 15,
    rationale:
      "In-sample beating out-of-sample by more than 15 percentage points is the classic " +
      "overfit signature. Limitation: real edges also decay out-of-sample, so this gate " +
      "rejects some genuine strategies — accepted, because mis-promotion is worse.",
  },
  maxDrawdownPct: {
    value: 20,
    rationale:
      "A paper strategy whose simulated drawdown already exceeds 20% leaves no headroom " +
      "for the real-world fills that ARISE's simulator does not model. Limitation: " +
      "simulated drawdown excludes gap slippage, so true drawdown would be larger.",
  },
  maxParameterSpreadPct: {
    value: 8,
    rationale:
      "An edge that only exists at one exact parameter set is curve-fitted. Limitation: " +
      "the spread depends on how far the perturbation walks; ARISE records the variants " +
      "used so the number stays interpretable.",
  },
  minParameterVariants: {
    value: 5,
    rationale:
      "Fewer than five perturbations cannot establish stability — the spread is " +
      "meaningless with two points. Limitation: variants are perturbations of one " +
      "strategy, not independent strategies.",
  },
  minProfitFactor: {
    value: 1.2,
    rationale:
      "Gross profit must exceed gross loss by a margin wide enough to absorb modelling " +
      "error in fees and slippage. Limitation: profit factor ignores trade frequency and " +
      "says nothing about capital efficiency.",
  },
  minExpectancy: {
    value: 0,
    rationale:
      "Exclusive: a strategy must show a positive per-trade expectancy after fees and " +
      "slippage, so zero is only the boundary of acceptability. Limitation: positive " +
      "expectancy on a small sample is not proof of an edge.",
  },
};

/** Lifecycle of a strategy definition. Only ACTIVE strategies may be evaluated for
 *  paper execution, and only a privileged actor may move a strategy into ACTIVE. */
export type StrategyLifecycleStatus =
  | "DRAFT"
  | "CANDIDATE"
  | "ACTIVE"
  | "DEMOTED"
  | "RETIRED";

export interface WalkForwardFold {
  index: number;
  returnPct: number;
  tradeCount: number;
}

export interface ParameterVariant {
  label: string;
  returnPct: number;
}

/** Everything the gates are allowed to look at. Every measured field is nullable
 *  on purpose: "not measured" and "measured as bad" must stay distinguishable. */
export interface StrategyFitnessInput {
  strategyId: StrategyId | string;
  /** Version of the strategy definition these measurements belong to. */
  strategyVersion: string;
  /** Version this one descends from, for lineage. */
  parentVersion?: string | null;
  metrics: BTMetrics;
  /** True when the backtest itself reported it could not evaluate the data. */
  insufficientData: boolean;
  /** Bars actually evaluated, used for the data-adequacy gate. */
  barCount: number | null;
  /** Minimum bars the engine required. */
  minBars: number | null;
  /** Trades that occurred after the in-sample split. Null ⇒ not measured. */
  oosTradeCount: number | null;
  /** Walk-forward folds. An empty array or null ⇒ stability not established. */
  walkForwardFolds: WalkForwardFold[] | null;
  /** Parameter perturbations. Null ⇒ sensitivity not measured. */
  parameterVariants: ParameterVariant[] | null;
  /** Costs actually applied by the engine that produced these metrics. */
  costsApplied: { feeBps: number; slippageBps: number } | null;
  /** Evidence that the evaluation path cannot see the future. Must be supplied
   *  explicitly: a missing leakage check is treated as an unsafe evaluation. */
  leakageGuard: {
    lookAheadChecked: boolean;
    usesNextBarOpenForFills: boolean;
    deterministicSeed: boolean;
  } | null;
}

export interface StrategyFitnessResult {
  eligible: boolean;
  score: number;
  gates: FitnessGate[];
  /** Gate ids whose failure must also demote a currently ACTIVE strategy. */
  blockers: string[];
  notes: string[];
}

/** Weights are explicit so `score` is reproducible and reviewable. */
const GATE_WEIGHTS: Record<string, number> = {
  DATA_ADEQUACY: 2,
  SAMPLE_SIZE: 2,
  OOS_SAMPLE: 3,
  OOS_EVIDENCE: 3,
  OVERFIT_DEGRADATION: 3,
  WALK_FORWARD_STABILITY: 2,
  PARAMETER_STABILITY: 2,
  MAX_DRAWDOWN: 2,
  COST_REALISM: 2,
  LEAKAGE_GUARD: 3,
  PROFIT_FACTOR: 1,
  EXPECTANCY: 1,
};

/** Gate ids that make a strategy ineligible for ACTIVE status when they fail. */
const CRITICAL_GATES = new Set([
  "DATA_ADEQUACY",
  "SAMPLE_SIZE",
  "OOS_SAMPLE",
  "OOS_EVIDENCE",
  "OVERFIT_DEGRADATION",
  "LEAKAGE_GUARD",
  "COST_REALISM",
]);

/** Finite-number guard. Returns null for anything unusable, including NaN and
 *  Infinity, so the caller is forced to treat it as "not measured". */
function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pass(id: string, label: string, value: number | null, threshold: number | null, reason: string): FitnessGate {
  return { id, label, pass: true, value, threshold, critical: CRITICAL_GATES.has(id), reason };
}

function fail(id: string, label: string, value: number | null, threshold: number | null, reason: string): FitnessGate {
  return { id, label, pass: false, value, threshold, critical: CRITICAL_GATES.has(id), reason };
}

/** Missing measurement ⇒ failure that is always a blocker. Absent evidence must
 *  demote a live strategy exactly like a failed critical gate — a gate never
 *  passes (or softens) because its evidence is missing. Kept as one helper so the
 *  rule is enforced in a single place and cannot be forgotten by an individual
 *  gate. */
function missing(id: string, label: string, threshold: number | null, what: string): FitnessGate {
  return {
    ...fail(id, label, null, threshold, `${what} was not measured — failing closed`),
    critical: true,
  };
}

/**
 * Evaluate a strategy against the admission policy.
 *
 * A strategy is `eligible` only when EVERY gate passes. Failure of a critical
 * gate — or of any gate whose measurement is missing, which fails closed as a
 * blocker — is additionally reported in `blockers`, which is what drives demotion
 * of a currently ACTIVE strategy.
 */
export function evaluateStrategyFitness(
  input: StrategyFitnessInput,
  policy: FitnessPolicy = FITNESS_POLICY,
): StrategyFitnessResult {
  const gates: FitnessGate[] = [];
  const notes: string[] = [];
  const m = input.metrics;

  // ---- data adequacy: did the engine even have enough history? ----
  const barCount = num(input.barCount);
  const minBars = num(input.minBars);
  if (input.insufficientData) {
    gates.push(fail("DATA_ADEQUACY", "Data adequacy", barCount, minBars, "backtest reported insufficient data"));
  } else if (barCount === null || minBars === null) {
    gates.push(missing("DATA_ADEQUACY", "Data adequacy", minBars, "bar count / minimum bars"));
  } else if (barCount < minBars) {
    gates.push(fail("DATA_ADEQUACY", "Data adequacy", barCount, minBars, `${barCount} bars < ${minBars} required`));
  } else {
    gates.push(pass("DATA_ADEQUACY", "Data adequacy", barCount, minBars, `${barCount} bars ≥ ${minBars} required`));
  }

  // ---- total sample ----
  const tradeCount = num(m?.tradeCount);
  if (tradeCount === null) {
    gates.push(missing("SAMPLE_SIZE", "Trade sample size", policy.minTrades.value, "trade count"));
  } else if (tradeCount < policy.minTrades.value) {
    gates.push(fail("SAMPLE_SIZE", "Trade sample size", tradeCount, policy.minTrades.value, `${tradeCount} trades < ${policy.minTrades.value} minimum`));
  } else {
    gates.push(pass("SAMPLE_SIZE", "Trade sample size", tradeCount, policy.minTrades.value, `${tradeCount} trades ≥ ${policy.minTrades.value} minimum`));
  }

  // ---- out-of-sample sample ----
  const oosTrades = num(input.oosTradeCount);
  if (oosTrades === null) {
    gates.push(missing("OOS_SAMPLE", "Out-of-sample trade count", policy.minOosTrades.value, "out-of-sample trade count"));
  } else if (oosTrades < policy.minOosTrades.value) {
    gates.push(fail("OOS_SAMPLE", "Out-of-sample trade count", oosTrades, policy.minOosTrades.value, `${oosTrades} out-of-sample trades < ${policy.minOosTrades.value} minimum`));
  } else {
    gates.push(pass("OOS_SAMPLE", "Out-of-sample trade count", oosTrades, policy.minOosTrades.value, `${oosTrades} out-of-sample trades ≥ ${policy.minOosTrades.value} minimum`));
  }

  // ---- out-of-sample evidence actually exists (explicit, never inferred) ----
  const isReturn = num(m?.inSampleReturnPct);
  const oosReturn = num(m?.outSampleReturnPct);
  if (isReturn === null || oosReturn === null) {
    gates.push(missing("OOS_EVIDENCE", "Out-of-sample evidence present", null, "in/out-of-sample returns"));
  } else if (oosTrades === null || oosTrades <= 0) {
    gates.push(fail("OOS_EVIDENCE", "Out-of-sample evidence present", oosTrades, 1, "no out-of-sample trades were produced, so no out-of-sample result exists"));
  } else {
    gates.push(pass("OOS_EVIDENCE", "Out-of-sample evidence present", oosReturn, null, `out-of-sample return ${oosReturn.toFixed(2)}% over ${oosTrades} trades`));
  }

  // ---- overfitting: degradation and outright OOS loss ----
  if (isReturn === null || oosReturn === null) {
    gates.push(missing("OVERFIT_DEGRADATION", "In/out-of-sample degradation", policy.maxOverfitDegradationPct.value, "degradation"));
  } else {
    const degradation = isReturn - oosReturn;
    if (isReturn > 0 && oosReturn < 0) {
      gates.push(
        fail(
          "OVERFIT_DEGRADATION",
          "In/out-of-sample degradation",
          degradation,
          policy.maxOverfitDegradationPct.value,
          `in-sample ${isReturn.toFixed(2)}% is positive while out-of-sample ${oosReturn.toFixed(2)}% is negative — classic overfit signature`,
        ),
      );
    } else if (degradation > policy.maxOverfitDegradationPct.value) {
      gates.push(fail("OVERFIT_DEGRADATION", "In/out-of-sample degradation", degradation, policy.maxOverfitDegradationPct.value, `degradation ${degradation.toFixed(2)}pp > ${policy.maxOverfitDegradationPct.value}pp allowed`));
    } else {
      gates.push(pass("OVERFIT_DEGRADATION", "In/out-of-sample degradation", degradation, policy.maxOverfitDegradationPct.value, `degradation ${degradation.toFixed(2)}pp within ${policy.maxOverfitDegradationPct.value}pp`));
    }
  }

  // ---- walk-forward stability ----
  const folds = input.walkForwardFolds;
  if (!folds || folds.length === 0) {
    gates.push(missing("WALK_FORWARD_STABILITY", "Walk-forward stability", policy.minProfitableFoldFraction.value, "walk-forward folds"));
  } else if (folds.length < policy.minWalkForwardFolds.value) {
    gates.push(fail("WALK_FORWARD_STABILITY", "Walk-forward stability", folds.length, policy.minWalkForwardFolds.value, `${folds.length} folds < ${policy.minWalkForwardFolds.value} required`));
  } else {
    const measured = folds.map((f) => num(f?.returnPct));
    if (measured.some((v) => v === null)) {
      gates.push(missing("WALK_FORWARD_STABILITY", "Walk-forward stability", policy.minProfitableFoldFraction.value, "fold return"));
    } else {
      const profitable = (measured as number[]).filter((v) => v > 0).length;
      const fraction = profitable / measured.length;
      if (fraction < policy.minProfitableFoldFraction.value) {
        gates.push(fail("WALK_FORWARD_STABILITY", "Walk-forward stability", fraction, policy.minProfitableFoldFraction.value, `${profitable}/${measured.length} folds profitable < ${policy.minProfitableFoldFraction.value} required`));
      } else {
        gates.push(pass("WALK_FORWARD_STABILITY", "Walk-forward stability", fraction, policy.minProfitableFoldFraction.value, `${profitable}/${measured.length} folds profitable`));
      }
    }
  }

  // ---- parameter sensitivity ----
  const variants = input.parameterVariants;
  if (!variants || variants.length === 0) {
    gates.push(missing("PARAMETER_STABILITY", "Parameter stability", policy.maxParameterSpreadPct.value, "parameter perturbations"));
  } else if (variants.length < policy.minParameterVariants.value) {
    gates.push(fail("PARAMETER_STABILITY", "Parameter stability", variants.length, policy.minParameterVariants.value, `${variants.length} parameter variants < ${policy.minParameterVariants.value} required`));
  } else {
    const returns = variants.map((v) => num(v?.returnPct));
    if (returns.some((v) => v === null)) {
      gates.push(missing("PARAMETER_STABILITY", "Parameter stability", policy.maxParameterSpreadPct.value, "variant return"));
    } else {
      const values = returns as number[];
      const spread = Math.max(...values) - Math.min(...values);
      if (spread > policy.maxParameterSpreadPct.value) {
        gates.push(fail("PARAMETER_STABILITY", "Parameter stability", spread, policy.maxParameterSpreadPct.value, `result spread ${spread.toFixed(2)}pp across ${values.length} variants exceeds ${policy.maxParameterSpreadPct.value}pp — fragile optimum`));
      } else {
        gates.push(pass("PARAMETER_STABILITY", "Parameter stability", spread, policy.maxParameterSpreadPct.value, `result spread ${spread.toFixed(2)}pp across ${values.length} variants`));
      }
    }
  }

  // ---- drawdown ----
  const dd = num(m?.maxDrawdownPct);
  if (dd === null) {
    gates.push(missing("MAX_DRAWDOWN", "Maximum drawdown", policy.maxDrawdownPct.value, "max drawdown"));
  } else if (dd > policy.maxDrawdownPct.value) {
    gates.push(fail("MAX_DRAWDOWN", "Maximum drawdown", dd, policy.maxDrawdownPct.value, `drawdown ${dd.toFixed(2)}% > ${policy.maxDrawdownPct.value}% allowed`));
  } else {
    gates.push(pass("MAX_DRAWDOWN", "Maximum drawdown", dd, policy.maxDrawdownPct.value, `drawdown ${dd.toFixed(2)}% within ${policy.maxDrawdownPct.value}%`));
  }

  // ---- cost realism: a "cost-free" backtest is not evidence ----
  const fees = num(m?.feesTotal);
  const costs = input.costsApplied;
  if (costs === null) {
    gates.push(missing("COST_REALISM", "Cost realism", null, "applied fee/slippage settings"));
  } else {
    const feeBps = num(costs.feeBps);
    const slipBps = num(costs.slippageBps);
    if (feeBps === null || slipBps === null || feeBps <= 0 || slipBps < 0) {
      gates.push(fail("COST_REALISM", "Cost realism", feeBps, 0, "fees/slippage were zero, negative or unmeasurable — results are not cost-realistic"));
    } else if (fees === null || fees <= 0) {
      gates.push(fail("COST_REALISM", "Cost realism", fees, 0, "no fees were charged across the run, so the engine did not apply costs"));
    } else {
      gates.push(pass("COST_REALISM", "Cost realism", fees, 0, `fees charged ${fees.toFixed(2)} at ${feeBps}bps fee + ${slipBps}bps slippage`));
    }
  }

  // ---- leakage guard: absent proof of no-look-ahead is a failure ----
  const guard = input.leakageGuard;
  if (guard === null) {
    gates.push(missing("LEAKAGE_GUARD", "Look-ahead / leakage guard", null, "leakage-check evidence"));
  } else if (!guard.lookAheadChecked || !guard.usesNextBarOpenForFills || !guard.deterministicSeed) {
    gates.push(fail("LEAKAGE_GUARD", "Look-ahead / leakage guard", null, null, "evaluation did not prove no-future-data, next-open fills and a deterministic seed"));
  } else {
    gates.push(pass("LEAKAGE_GUARD", "Look-ahead / leakage guard", null, null, "signals use closed history only, fills at next open, seeded jitter"));
  }

  // ---- profitability, but never as the sole basis for promotion ----
  const pf = num(m?.profitFactor);
  if (pf === null) {
    gates.push(missing("PROFIT_FACTOR", "Profit factor", policy.minProfitFactor.value, "profit factor"));
  } else if (pf < policy.minProfitFactor.value) {
    gates.push(fail("PROFIT_FACTOR", "Profit factor", pf, policy.minProfitFactor.value, `profit factor ${pf.toFixed(2)} < ${policy.minProfitFactor.value}`));
  } else {
    gates.push(pass("PROFIT_FACTOR", "Profit factor", pf, policy.minProfitFactor.value, `profit factor ${pf.toFixed(2)} ≥ ${policy.minProfitFactor.value}`));
  }

  const expectancy = num(m?.expectancy);
  if (expectancy === null) {
    gates.push(missing("EXPECTANCY", "Expectancy per trade", policy.minExpectancy.value, "expectancy"));
  } else if (expectancy <= policy.minExpectancy.value) {
    gates.push(fail("EXPECTANCY", "Expectancy per trade", expectancy, policy.minExpectancy.value, `expectancy ${expectancy.toFixed(4)} is not positive`));
  } else {
    gates.push(pass("EXPECTANCY", "Expectancy per trade", expectancy, policy.minExpectancy.value, `expectancy ${expectancy.toFixed(4)} per trade`));
  }

  // ---- aggregate ----
  const totalWeight = gates.reduce((acc, g) => acc + (GATE_WEIGHTS[g.id] ?? 1), 0);
  const passedWeight = gates
    .filter((g) => g.pass)
    .reduce((acc, g) => acc + (GATE_WEIGHTS[g.id] ?? 1), 0);
  const score = totalWeight > 0 ? clamp(Math.round((passedWeight / totalWeight) * 100), 0, 100) : 0;

  const blockers = gates.filter((g) => !g.pass && g.critical).map((g) => g.id);
  const softFailures = gates.filter((g) => !g.pass && !g.critical).map((g) => g.id);

  if (blockers.length > 0) {
    notes.push(`blocking gates failed: ${blockers.join(", ")} — strategy is not eligible for promotion`);
  }
  if (softFailures.length > 0) {
    notes.push(`non-blocking gates failed: ${softFailures.join(", ")} — still ineligible, since every gate must pass`);
  }
  if (input.parentVersion) {
    notes.push(`lineage: ${input.strategyId}@${input.strategyVersion} descends from ${input.parentVersion}`);
  }

  return {
    eligible: gates.every((g) => g.pass),
    score,
    gates,
    blockers,
    notes,
  };
}

export type PromotionAction = "PROMOTE" | "HOLD" | "DEMOTE" | "RETIRE";

export interface PromotionDecision {
  action: PromotionAction;
  reason: string;
  /** Promotion is a privileged act in ARISE: a deterministic validator may only
   *  *recommend* it, and a human/privileged service must confirm it. */
  requiresHumanApproval: boolean;
  blockers: string[];
}

/**
 * Map a fitness result onto a lifecycle action.
 *
 * Promotion requires `eligible`; that is the one-way constraint this function
 * exists to enforce. A failed critical gate demotes an ACTIVE strategy, and a
 * second failure retires it rather than leaving a broken strategy live.
 */
export function promotionDecision(
  currentStatus: StrategyLifecycleStatus,
  result: StrategyFitnessResult,
): PromotionDecision {
  if (currentStatus === "RETIRED") {
    return {
      action: "RETIRE",
      reason: "retired strategies are never revived in place — a new version must be registered and re-validated",
      requiresHumanApproval: true,
      blockers: result.blockers,
    };
  }

  if (!result.eligible) {
    if (currentStatus === "ACTIVE") {
      return {
        action: "DEMOTE",
        reason: `active strategy no longer meets its gates (${result.blockers.length > 0 ? result.blockers.join(", ") : "soft gate failure"}) — demote to stop new entries`,
        requiresHumanApproval: true,
        blockers: result.blockers,
      };
    }
    if (currentStatus === "DEMOTED") {
      return {
        action: "RETIRE",
        reason: "strategy failed re-validation after a previous demotion",
        requiresHumanApproval: true,
        blockers: result.blockers,
      };
    }
    return {
      action: "HOLD",
      reason: `not eligible (${result.gates.filter((g) => !g.pass).map((g) => g.id).join(", ")}) — remains ${currentStatus}`,
      requiresHumanApproval: true,
      blockers: result.blockers,
    };
  }

  if (currentStatus === "DRAFT" || currentStatus === "CANDIDATE" || currentStatus === "DEMOTED") {
    return {
      action: "PROMOTE",
      reason: "all gates passed, including out-of-sample, walk-forward, parameter-stability, cost and leakage gates",
      requiresHumanApproval: true,
      blockers: [],
    };
  }

  return {
    action: "HOLD",
    reason: "already ACTIVE and still passing its gates",
    requiresHumanApproval: true,
    blockers: [],
  };
}

export interface StrategySignature {
  id: string;
  /** Optional version, for lineage reporting only — it never affects duplication. */
  version?: string;
  /** Canonical parameter set. Key order and numeric formatting are normalised. */
  params: Record<string, unknown>;
}

/**
 * Canonical signature: sorted keys, sorted array order preserved as written,
 * numbers rendered through a stable representation. Two definitions that differ
 * only in key order produce the same signature.
 */
export function canonicalSignature(signature: StrategySignature): string {
  const normalize = (v: unknown): unknown => {
    if (typeof v === "number") return Number.isFinite(v) ? Number(v.toPrecision(12)) : String(v);
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      return Object.keys(obj)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = normalize(obj[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(normalize(signature.params));
}

/** Structural duplicate detection. Returns true only for an identical canonical
 *  parameter signature — a reordered key set is still a duplicate, because it is
 *  the same strategy definition and must not be registered twice. */
export function detectDuplicateStrategies(
  a: StrategySignature,
  b: StrategySignature,
): { duplicate: boolean; reason: string } {
  const sa = canonicalSignature(a);
  const sb = canonicalSignature(b);
  if (sa === sb) {
    return {
      duplicate: true,
      reason: `${a.id} and ${b.id} share an identical parameter signature (${sa})`,
    };
  }
  return {
    duplicate: false,
    reason: `${a.id} and ${b.id} differ in parameters`,
  };
}
