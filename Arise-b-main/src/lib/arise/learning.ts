// ARISE V1 — controlled learning / improvement proposals.
//
// Learning may PROPOSE a change from measured evidence (a bad paper result, a
// calibration miss, a backtest-vs-forward divergence). It may never APPLY one by
// itself: every path here fails closed, and the only way to `APPLIED` is a
// privileged actor plus a completed, passing evaluation. Risk limits, execution
// mode, security policy and secrets are not proposable at all — an AI agent can
// recommend stricter behaviour, never looser behaviour (mandate §3.5, §6.L).

import { CONFIG_LIMITS, DEFAULT_CONFIG } from "./config";
import { ANOMALY_LEVEL_RANK } from "./risk";

export type LearningTrigger =
  | "PAPER_RESULT"
  | "PREDICTION_CALIBRATION"
  | "STRATEGY_FAILURE"
  | "REGIME_CHANGE"
  | "EXECUTION_DISCREPANCY"
  | "DATA_QUALITY_INCIDENT"
  | "INCORRECT_ASSUMPTION"
  | "MONITOR_ALERT"
  | "BACKTEST_VS_FORWARD_DIVERGENCE";

/** Targets learning is allowed to touch. */
export const ALLOWED_TARGETS = [
  "strategy.params",
  "strategy.version",
  "strategy.rollback",
  "evidence.thresholds",
  "fitness.policy",
] as const;
export type AllowedTarget = (typeof ALLOWED_TARGETS)[number];

/** Targets that must never be reachable through the learning path. Each of these
 *  is a control boundary: relaxing one is an authorization decision that belongs
 *  to a privileged human, not to a proposal derived from data. */
export const FORBIDDEN_TARGETS = [
  "risk.limits",
  "risk.engine",
  "execution.mode",
  "security.policy",
  "production.config",
  "secrets.rotation",
  "auth.policy",
  "admin.bootstrap",
  "evidence.gates.bypass",
] as const;
export type ForbiddenTarget = (typeof FORBIDDEN_TARGETS)[number];

/** Deliberately open (`string & {}`) so a dotted path such as
 *  `strategy.params.rsiPeriod` stays expressible while the known targets
 *  autocomplete — validation, not the type, is the enforcement point. */
export type ProposalTarget = AllowedTarget | ForbiddenTarget | (string & {});

export type ProposalValue = number | string | boolean;

export type ProposalStatus =
  | "PROPOSED"
  | "EVALUATING"
  | "APPROVED"
  | "REJECTED"
  | "APPLIED"
  | "ROLLED_BACK";

export interface ProposalEvaluation {
  startedAt?: number;
  completedAt?: number;
  /** A proposal that was evaluated and failed is evidence, not a green light. */
  passed?: boolean;
  reference?: string;
}

export interface LearningProposal {
  id: string;
  createdAt: number;
  trigger: LearningTrigger;
  target: string;
  currentValue: ProposalValue;
  proposedValue: ProposalValue;
  rationale: string;
  evidence: string[];
  expectedEffect: string;
  riskOfChange: string;
  evaluationPlan: string;
  status: ProposalStatus;
  /** Value in force before the change, captured at APPLIED so a rollback is exact. */
  previousValue?: ProposalValue;
  decidedBy?: string;
  appliedAt?: number;
  rolledBackAt?: number;
  evaluation?: ProposalEvaluation;
  /** Violation codes recorded when a proposal was rejected, for the audit view. */
  violations?: ProposalViolation[];
}

export interface ProposalViolation {
  code: string;
  detail: string;
}

export interface ProposalValidation {
  ok: boolean;
  violations: ProposalViolation[];
}

export interface ProposalInput {
  id: string;
  createdAt: number;
  trigger: LearningTrigger;
  target: string;
  currentValue: ProposalValue;
  proposedValue: ProposalValue;
  rationale: string;
  evidence: string[];
  expectedEffect: string;
  riskOfChange: string;
  evaluationPlan: string;
}

export function createProposal(input: ProposalInput): LearningProposal {
  return { ...input, status: "PROPOSED" };
}

/** True when `target` is (or is nested under) a forbidden control boundary. */
export function isForbiddenTarget(target: string): boolean {
  const normalized = target.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return FORBIDDEN_TARGETS.some(
    (forbidden) => normalized === forbidden || normalized.startsWith(`${forbidden}.`),
  );
}

// ---------------- Risk-direction policy ----------------
//
// Which way is "looser" is per-value and cannot be inferred from CONFIG_LIMITS
// alone (a higher `maxDrawdownPct` is looser, a lower `minBars` is looser), so the
// direction is declared explicitly. Tightening is always allowed; loosening is not.

type RiskDirection = "HIGHER_IS_LOOSER" | "LOWER_IS_LOOSER";

const SAFETY_LIMITS: Record<string, RiskDirection> = {
  riskpertradepct: "HIGHER_IS_LOOSER",
  maxpositionpct: "HIGHER_IS_LOOSER",
  maxgrossexposurepct: "HIGHER_IS_LOOSER",
  maxdailylosspct: "HIGHER_IS_LOOSER",
  maxdrawdownpct: "HIGHER_IS_LOOSER",
  maxleverage: "HIGHER_IS_LOOSER",
  // A wider tolerated spread degrades fill realism, so it is loosening.
  maxspreadpct: "HIGHER_IS_LOOSER",
  // Accepting older data is loosening.
  staledatasec: "HIGHER_IS_LOOSER",
  barstalemultiplier: "HIGHER_IS_LOOSER",
  // Requiring less history / less liquidity / less deliberation is loosening.
  minbars: "LOWER_IS_LOOSER",
  minliquiditynotional: "LOWER_IS_LOOSER",
  aitimeoutms: "LOWER_IS_LOOSER",
};

/** Ordering of the anomaly policy: WATCH tolerates more than NORMAL. */
// Ranking comes from the risk engine so proposal validation and the runtime gate agree
// on the vocabulary; only NORMAL and WATCH are tradeable levels, so anything else
// (including a stronger level such as HIGH) is an invalid proposal value.
const TRADEABLE_ANOMALY_LEVELS = new Set(["NORMAL", "WATCH"]);

/** CONFIG_LIMITS keys are camelCase but every lookup here is on a lowercased
 *  segment, so the map is re-keyed. A case-sensitive lookup silently returned
 *  `undefined` and turned the policy-range gate off — a fail-open hole, not a
 *  cosmetic mismatch. */
const CONFIG_LIMIT_BY_KEY: Record<string, { min?: number; max?: number } | undefined> =
  Object.fromEntries(
    Object.entries(CONFIG_LIMITS).map(([k, v]) => [k.toLowerCase(), v as { min?: number; max?: number }]),
  );

/** Shipped defaults, keyed the same way as SAFETY_LIMITS, so the safety baseline
 *  can be compared case-insensitively without a lookup on every call. */
const DEFAULT_BY_KEY: Record<string, ProposalValue> = Object.fromEntries(
  Object.entries(DEFAULT_CONFIG).map(([k, v]) => [k.toLowerCase(), v as ProposalValue]),
);

/** Execution-mode field names. Any of these in a target is out of bounds for learning. */
const MODE_KEYS = new Set([
  "mode",
  "executionmode",
  "tradingmode",
  "livetrading",
  "livetradingenabled",
]);

function segments(target: string): string[] {
  return target
    .trim()
    .toLowerCase()
    .split(".")
    .filter((s) => s.length > 0);
}

function lastSegment(target: string): string {
  const s = segments(target);
  return s.length > 0 ? s[s.length - 1] : "";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Rejects a change that weakens `key` relative to `reference`. Fail-closed: an
 *  unreadable pair of values on a safety key is a violation, not a pass. */
function loosens(
  direction: RiskDirection,
  proposed: ProposalValue,
  reference: number,
): boolean {
  if (!isFiniteNumber(proposed)) return true;
  return direction === "HIGHER_IS_LOOSER" ? proposed > reference : proposed < reference;
}

export function validateProposal(proposal: LearningProposal): ProposalValidation {
  const violations: ProposalViolation[] = [];
  const target = proposal.target ?? "";

  // ---- Control boundaries first: a forbidden target ends the discussion. ----
  if (isForbiddenTarget(target)) {
    violations.push({
      code: "FORBIDDEN_TARGET",
      detail: `"${target}" is a control boundary; it cannot be changed through the learning path.`,
    });
  }

  const key = lastSegment(target);
  if (MODE_KEYS.has(key)) {
    const value = proposal.proposedValue;
    const stillPaper =
      typeof value === "string" && value.trim().toLowerCase() === "paper";
    if (!stillPaper) {
      violations.push({
        code: "EXECUTION_MODE_CHANGE",
        detail: `"${target}" would set the execution mode to ${JSON.stringify(value)}; ARISE is paper-only.`,
      });
    }
  }

  // ---- Evidence discipline: no rationale, evidence or plan means no proposal. ----
  if (proposal.rationale.trim().length === 0) {
    violations.push({ code: "MISSING_RATIONALE", detail: "A rationale is required." });
  }
  const evidence = (proposal.evidence ?? []).filter((e) => e.trim().length > 0);
  if (evidence.length === 0) {
    violations.push({
      code: "EMPTY_EVIDENCE",
      detail: "Proposals must cite at least one piece of measured evidence.",
    });
  }
  if (proposal.evaluationPlan.trim().length === 0) {
    violations.push({
      code: "MISSING_EVALUATION_PLAN",
      detail: "An isolated evaluation plan is required before approval.",
    });
  }

  // ---- Value sanity ----
  const proposed = proposal.proposedValue;
  const invalidValue =
    (typeof proposed === "number" && !Number.isFinite(proposed)) ||
    (typeof proposed === "string" && proposed.trim().length === 0);
  if (invalidValue) {
    violations.push({
      code: "INVALID_VALUE",
      detail: `Proposed value ${JSON.stringify(proposed)} is not usable.`,
    });
  } else if (proposed === proposal.currentValue) {
    violations.push({ code: "NO_CHANGE", detail: "Proposed value equals the current value." });
  }

  // ---- Anomaly policy ----
  if (key === "maxanomalylevelfortrade") {
    const proposedLevel = String(proposed).toUpperCase();
    const proposedRank = ANOMALY_LEVEL_RANK[proposedLevel];
    if (proposedRank === undefined || !TRADEABLE_ANOMALY_LEVELS.has(proposedLevel)) {
      violations.push({
        code: "INVALID_VALUE",
        detail: `Anomaly level ${JSON.stringify(proposed)} is not NORMAL or WATCH.`,
      });
    } else {
      const currentRank = ANOMALY_LEVEL_RANK[String(proposal.currentValue).toUpperCase()];
      const defaultRank = ANOMALY_LEVEL_RANK[DEFAULT_CONFIG.maxAnomalyLevelForTrade];
      if (currentRank !== undefined && proposedRank > currentRank) {
        violations.push({
          code: "RISK_LIMIT_RELAXATION",
          detail: `Anomaly policy would be weakened from ${proposal.currentValue} to ${proposed}.`,
        });
      }
      if (proposedRank > defaultRank) {
        violations.push({
          code: "WEAKER_THAN_SHIPPED_DEFAULT",
          detail: `Anomaly policy would be looser than the shipped default (${DEFAULT_CONFIG.maxAnomalyLevelForTrade}).`,
        });
      }
    }
  }

  // ---- Numeric safety limits ----
  const direction = SAFETY_LIMITS[key];
  if (direction) {
    if (!isFiniteNumber(proposal.currentValue) || !isFiniteNumber(proposed)) {
      violations.push({
        code: "INVALID_VALUE",
        detail: `Safety limit "${key}" needs finite numeric values on both sides.`,
      });
    } else {
      if (loosens(direction, proposed, proposal.currentValue)) {
        violations.push({
          code: "RISK_LIMIT_RELAXATION",
          detail: `"${key}" would be loosened from ${proposal.currentValue} to ${proposed}.`,
        });
      }
      // Weakening a limit that is still looser than the shipped default is refused
      // even when it technically tightens the live value: the safety baseline is
      // the default, not whatever an earlier change left behind.
      const defaultRaw = DEFAULT_BY_KEY[key];
      if (isFiniteNumber(defaultRaw) && loosens(direction, proposed, defaultRaw)) {
        violations.push({
          code: "WEAKER_THAN_SHIPPED_DEFAULT",
          detail: `"${key}" would be looser than the shipped default (${defaultRaw}).`,
        });
      }
    }

    // CONFIG_LIMITS bounds the value the platform will even entertain. The repo
    // spells the liquidity bound as `maxLiquidityNotional`, so that one key has no
    // matching entry here and is validated by direction only.
    const limit = CONFIG_LIMIT_BY_KEY[key];
    if (
      limit &&
      isFiniteNumber(proposed) &&
      ((limit.min !== undefined && proposed < limit.min) ||
        (limit.max !== undefined && proposed > limit.max))
    ) {
      violations.push({
        code: "OUT_OF_POLICY_RANGE",
        detail: `"${key}"=${proposed} is outside the configured range ${
          limit.min ?? "-∞"
        }..${limit.max ?? "∞"}.`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

// ---------------- State machine ----------------

/** Nothing may skip a stage: evidence must be evaluated before it is approved,
 *  and approved before it is applied (mandate §6.F promotion rules). */
const TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  PROPOSED: ["EVALUATING", "REJECTED"],
  EVALUATING: ["APPROVED", "REJECTED"],
  APPROVED: ["APPLIED", "REJECTED"],
  APPLIED: ["ROLLED_BACK"],
  REJECTED: [],
  ROLLED_BACK: [],
};

export interface AdvanceContext {
  actor: { id: string; privileged: boolean };
  at: number;
  /** Required to reach APPLIED: the isolated evaluation must be finished and passed. */
  evaluation?: ProposalEvaluation;
  note?: string;
}

export interface AdvanceResult {
  ok: boolean;
  proposal: LearningProposal;
  violations: ProposalViolation[];
}

export function advanceProposal(
  proposal: LearningProposal,
  next: ProposalStatus,
  ctx: AdvanceContext,
): AdvanceResult {
  const violations: ProposalViolation[] = [];

  if (!TRANSITIONS[proposal.status].includes(next)) {
    violations.push({
      code: "ILLEGAL_TRANSITION",
      detail: `${proposal.status} → ${next} is not a permitted transition.`,
    });
  }

  // Approval and application are privileged acts; rejection is not, so a reviewer
  // can always stop a proposal without extra authority.
  if ((next === "APPROVED" || next === "APPLIED") && !ctx.actor.privileged) {
    violations.push({
      code: "NOT_PRIVILEGED",
      detail: `Actor ${ctx.actor.id} is not privileged to ${next.toLowerCase()} a proposal.`,
    });
  }

  if (next === "APPLIED") {
    if (!ctx.evaluation || ctx.evaluation.completedAt === undefined) {
      violations.push({
        code: "EVALUATION_NOT_COMPLETED",
        detail: "The evaluation plan must finish before a proposal can be applied.",
      });
    } else if (!ctx.evaluation.passed) {
      violations.push({
        code: "EVALUATION_FAILED",
        detail: "The evaluation completed but did not pass; the proposal cannot be applied.",
      });
    }
    const revalidated = validateProposal(proposal);
    if (!revalidated.ok) {
      violations.push(
        ...revalidated.violations.map((v) => ({
          code: "INVALID_PROPOSAL",
          detail: `${v.code}: ${v.detail}`,
        })),
      );
    }
  }

  // Rejections keep their reasons so the audit view can explain them.
  const rejectionViolations =
    next === "REJECTED" ? validateProposal(proposal).violations : [];

  if (violations.length > 0) {
    return { ok: false, proposal, violations };
  }

  const updated: LearningProposal = { ...proposal, status: next };

  if (next === "APPLIED") {
    // Capture the value being replaced BEFORE overwriting it — a rollback must be
    // able to restore exactly what was in force.
    updated.previousValue = proposal.currentValue;
    updated.currentValue = proposal.proposedValue;
    updated.appliedAt = ctx.at;
    updated.evaluation = ctx.evaluation ?? proposal.evaluation;
  }
  if (next === "APPROVED" || next === "APPLIED") {
    updated.decidedBy = ctx.actor.id;
  }
  if (next === "REJECTED") {
    updated.decidedBy = ctx.actor.id;
    updated.violations = rejectionViolations;
  }

  return { ok: true, proposal: updated, violations: [] };
}

/** Restores the value in force before APPLIED. Deliberately not gated on privilege:
 *  a rollback returns the system to a previously accepted state, so delaying it
 *  behind an approval would leave a bad change live. */
export function rollbackProposal(
  proposal: LearningProposal,
  ctx: AdvanceContext,
): AdvanceResult {
  if (proposal.previousValue === undefined) {
    return {
      ok: false,
      proposal,
      violations: [
        {
          code: "NO_PREVIOUS_VALUE",
          detail: "Nothing to roll back: the proposal was never applied.",
        },
      ],
    };
  }
  const result = advanceProposal(proposal, "ROLLED_BACK", ctx);
  if (!result.ok) return result;
  return {
    ok: true,
    proposal: {
      ...result.proposal,
      currentValue: proposal.previousValue,
      rolledBackAt: ctx.at,
    },
    violations: [],
  };
}

// ---------------- Audit view ----------------

export interface ProposalSummary {
  counts: Record<ProposalStatus, number>;
  rejected: { id: string; target: string; violations: string[] }[];
  latestByTarget: { target: string; id: string; status: ProposalStatus; createdAt: number }[];
}

/** Deterministic (createdAt, then id) so the audit view is stable between reads. */
export function summarizeProposals(list: LearningProposal[]): ProposalSummary {
  const counts: Record<ProposalStatus, number> = {
    PROPOSED: 0,
    EVALUATING: 0,
    APPROVED: 0,
    REJECTED: 0,
    APPLIED: 0,
    ROLLED_BACK: 0,
  };
  const ordered = [...list].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.createdAt - b.createdAt,
  );

  const rejected: ProposalSummary["rejected"] = [];
  const latestByTarget = new Map<string, ProposalSummary["latestByTarget"][number]>();

  for (const p of ordered) {
    counts[p.status] += 1;
    if (p.status === "REJECTED") {
      const codes = p.violations?.length
        ? p.violations.map((v) => v.code)
        : validateProposal(p).violations.map((v) => v.code);
      rejected.push({ id: p.id, target: p.target, violations: codes });
    }
    latestByTarget.set(p.target, {
      target: p.target,
      id: p.id,
      status: p.status,
      createdAt: p.createdAt,
    });
  }

  return { counts, rejected, latestByTarget: [...latestByTarget.values()] };
}
