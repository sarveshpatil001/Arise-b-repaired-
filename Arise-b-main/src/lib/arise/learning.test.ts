// ARISE V1 — controlled learning proposal tests.
// These pin the guarantees the learning layer must never lose: no forbidden target,
// no relaxation of a safety limit, and nothing reaching APPLIED without a
// privileged approval plus a completed, passing evaluation.
//
// Lives outside src/convex/ on purpose: the Convex bundler walks that directory.

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config";
import {
  advanceProposal,
  createProposal,
  isForbiddenTarget,
  rollbackProposal,
  summarizeProposals,
  validateProposal,
  FORBIDDEN_TARGETS,
  type AdvanceContext,
  type LearningProposal,
  type ProposalEvaluation,
  type ProposalInput,
  type ProposalValue,
} from "./learning";

const T0 = 1_700_000_000_000;

function proposal(overrides: Partial<ProposalInput> = {}): LearningProposal {
  return createProposal({
    id: "p-1",
    createdAt: T0,
    trigger: "BACKTEST_VS_FORWARD_DIVERGENCE",
    target: "strategy.params.rsiPeriod",
    currentValue: 14,
    proposedValue: 10,
    rationale: "Forward test showed the 14-bar RSI lagging regime shifts.",
    evidence: ["forward paper run 2026-08-01..2026-09-01: expectancy -0.18R"],
    expectedEffect: "Earlier mean-reversion entries with the same stop policy.",
    riskOfChange: "More false signals in ranging markets.",
    evaluationPlan: "Re-run walk-forward on 24 months, then 4 weeks paper.",
    ...overrides,
  });
}

const privileged: AdvanceContext = {
  actor: { id: "admin-1", privileged: true },
  at: T0 + 1_000,
};

// Annotated on purpose: without the type the literal compiles even when it omits
// `completedAt`, and an unfinished evaluation must never count as a completed one.
const evaluation: ProposalEvaluation = {
  startedAt: T0 + 100,
  completedAt: T0 + 900,
  passed: true,
  reference: "wf-run-42",
};

describe("isForbiddenTarget", () => {
  it("covers every declared control boundary, including nested paths", () => {
    for (const target of FORBIDDEN_TARGETS) {
      expect(isForbiddenTarget(target)).toBe(true);
      expect(isForbiddenTarget(`${target}.anything`)).toBe(true);
    }
    expect(isForbiddenTarget("RISK.LIMITS")).toBe(true);
    expect(isForbiddenTarget("strategy.params.rsiPeriod")).toBe(false);
    expect(isForbiddenTarget("riskless.params")).toBe(false);
  });
});

describe("validateProposal — allowed work", () => {
  it("accepts a strategy parameter change that tightens behaviour", () => {
    expect(validateProposal(proposal()).ok).toBe(true);
  });

  it("keeps a risk-limits target out of bounds even when the change would tighten it", () => {
    // Risk limits are a human/admin control boundary, not a learning target, so
    // even a stricter value is refused here rather than quietly allowed through.
    const tighter = proposal({
      target: "risk.limits.riskPerTradePct",
      currentValue: DEFAULT_CONFIG.riskPerTradePct,
      proposedValue: 0.25,
    });
    expect(validateProposal(tighter).ok).toBe(false);
    expect(validateProposal(tighter).violations.map((v) => v.code)).toEqual([
      "FORBIDDEN_TARGET",
    ]);
  });

  it("accepts a minBars increase (more history required)", () => {
    const more = proposal({
      target: "evidence.thresholds.minBars",
      currentValue: 120,
      proposedValue: 200,
    });
    expect(validateProposal(more).ok).toBe(true);
  });
});

describe("validateProposal — forbidden targets", () => {
  it("rejects every forbidden target with FORBIDDEN_TARGET", () => {
    for (const target of FORBIDDEN_TARGETS) {
      const result = validateProposal(proposal({ target, proposedValue: "x" }));
      expect(result.ok).toBe(false);
      expect(result.violations.map((v) => v.code)).toContain("FORBIDDEN_TARGET");
    }
  });

  it("rejects a change to the execution mode", () => {
    const result = validateProposal(
      proposal({ target: "runtime.executionMode", proposedValue: "live" }),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("EXECUTION_MODE_CHANGE");
  });

  it("does not object to restating paper mode", () => {
    const result = validateProposal(
      proposal({ target: "runtime.executionMode", proposedValue: "paper" }),
    );
    expect(result.violations.map((v) => v.code)).not.toContain("EXECUTION_MODE_CHANGE");
  });
});

describe("validateProposal — safety limits", () => {
  it("rejects raising riskPerTradePct", () => {
    const result = validateProposal(
      proposal({
        target: "risk.perTrade.riskPerTradePct",
        currentValue: DEFAULT_CONFIG.riskPerTradePct,
        proposedValue: 1.5,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("RISK_LIMIT_RELAXATION");
  });

  it("rejects a risk limit outside the configured policy range", () => {
    const result = validateProposal(
      proposal({
        target: "risk.limits.riskPerTradePct",
        currentValue: 0.5,
        proposedValue: 5,
      }),
    );
    const codes = result.violations.map((v) => v.code);
    expect(codes).toContain("OUT_OF_POLICY_RANGE");
    expect(codes).toContain("RISK_LIMIT_RELAXATION");
  });

  it("rejects loosening minBars, maxDrawdownPct and staleDataSec", () => {
    for (const [target, currentValue, proposedValue] of [
      ["evidence.thresholds.minBars", 120, 60],
      ["strategy.params.maxDrawdownPct", 10, 20],
      ["evidence.thresholds.staleDataSec", 180, 600],
    ] as [string, number, number][]) {
      const result = validateProposal(proposal({ target, currentValue, proposedValue }));
      expect(result.ok).toBe(false);
      expect(result.violations.map((v) => v.code)).toContain("RISK_LIMIT_RELAXATION");
    }
  });

  it("rejects a value that is still looser than the shipped default", () => {
    const result = validateProposal(
      proposal({ target: "risk.limits.riskPerTradePct", currentValue: 1.8, proposedValue: 1.6 }),
    );
    expect(result.violations.map((v) => v.code)).toContain("WEAKER_THAN_SHIPPED_DEFAULT");
  });

  it("rejects a weaker maxAnomalyLevelForTrade", () => {
    const result = validateProposal(
      proposal({
        target: "risk.limits.maxAnomalyLevelForTrade",
        currentValue: "NORMAL",
        proposedValue: "WATCH",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("RISK_LIMIT_RELAXATION");
  });

  it("rejects a safety limit given non-numeric values", () => {
    const result = validateProposal(
      proposal({ target: "risk.limits.maxLeverage", currentValue: "1", proposedValue: "2" }),
    );
    expect(result.violations.map((v) => v.code)).toContain("INVALID_VALUE");
  });
});

describe("validateProposal — evidence discipline", () => {
  it("rejects a proposal with no evidence", () => {
    const result = validateProposal(proposal({ evidence: ["   "] }));
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("EMPTY_EVIDENCE");
  });

  it("rejects a proposal with no rationale", () => {
    const result = validateProposal(proposal({ rationale: "  " }));
    expect(result.violations.map((v) => v.code)).toContain("MISSING_RATIONALE");
  });

  it("rejects a proposal with no evaluation plan", () => {
    const result = validateProposal(proposal({ evaluationPlan: "" }));
    expect(result.violations.map((v) => v.code)).toContain("MISSING_EVALUATION_PLAN");
  });

  it("rejects a no-op change and a non-finite value", () => {
    expect(
      validateProposal(proposal({ proposedValue: 14 })).violations.map((v) => v.code),
    ).toContain("NO_CHANGE");
    expect(
      validateProposal(proposal({ proposedValue: Number.NaN })).violations.map((v) => v.code),
    ).toContain("INVALID_VALUE");
  });
});

describe("advanceProposal — state machine", () => {
  it("cannot jump from PROPOSED to APPLIED", () => {
    const result = advanceProposal(proposal(), "APPLIED", {
      ...privileged,
      evaluation,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("ILLEGAL_TRANSITION");
  });

  it("cannot be approved by a non-privileged actor", () => {
    const evaluating = advanceProposal(proposal(), "EVALUATING", privileged);
    expect(evaluating.ok).toBe(true);
    const denied = advanceProposal(evaluating.proposal, "APPROVED", {
      actor: { id: "agent-9", privileged: false },
      at: T0 + 2_000,
    });
    expect(denied.ok).toBe(false);
    expect(denied.violations.map((v) => v.code)).toContain("NOT_PRIVILEGED");
  });

  it("cannot be applied before the evaluation completes or after it fails", () => {
    const approved = advanceProposal(
      advanceProposal(proposal(), "EVALUATING", privileged).proposal,
      "APPROVED",
      privileged,
    ).proposal;

    const tooEarly = advanceProposal(approved, "APPLIED", privileged);
    expect(tooEarly.violations.map((v) => v.code)).toContain("EVALUATION_NOT_COMPLETED");

    const failed = advanceProposal(approved, "APPLIED", {
      ...privileged,
      evaluation: { completedAt: 1_700_000_000_000, passed: false },
    });
    expect(failed.violations.map((v) => v.code)).toContain("EVALUATION_FAILED");
    expect(failed.proposal.status).toBe("APPROVED");
  });

  it("re-validates on apply so a since-forbidden target cannot slip through", () => {
    const tampered: LearningProposal = {
      ...proposal({ target: "risk.limits.maxLeverage", currentValue: 1, proposedValue: 2 }),
      status: "APPROVED",
    };
    const result = advanceProposal(tampered, "APPLIED", { ...privileged, evaluation });
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("INVALID_PROPOSAL");
  });

  it("applies an approved, evaluated proposal and records the previous value", () => {
    const approved = advanceProposal(
      advanceProposal(proposal(), "EVALUATING", privileged).proposal,
      "APPROVED",
      privileged,
    ).proposal;
    const applied = advanceProposal(approved, "APPLIED", { ...privileged, evaluation });

    expect(applied.ok).toBe(true);
    expect(applied.proposal.status).toBe("APPLIED");
    expect(applied.proposal.previousValue).toBe(14);
    expect(applied.proposal.currentValue).toBe(10);
    expect(applied.proposal.decidedBy).toBe("admin-1");
    expect(applied.proposal.appliedAt).toBe(T0 + 1_000);
    // The input is never mutated — the audit trail keeps the original record.
    expect(approved.currentValue).toBe(14);
  });

  it("rolls back to the previous value only from APPLIED", () => {
    const notApplied = rollbackProposal(proposal(), privileged);
    expect(notApplied.ok).toBe(false);
    expect(notApplied.violations.map((v) => v.code)).toContain("NO_PREVIOUS_VALUE");

    const approved = advanceProposal(
      advanceProposal(proposal(), "EVALUATING", privileged).proposal,
      "APPROVED",
      privileged,
    ).proposal;
    const applied = advanceProposal(approved, "APPLIED", { ...privileged, evaluation }).proposal;
    const rolled = rollbackProposal(applied, { ...privileged, at: T0 + 5_000 });

    expect(rolled.ok).toBe(true);
    expect(rolled.proposal.status).toBe("ROLLED_BACK");
    expect(rolled.proposal.currentValue).toBe(14);
    expect(rolled.proposal.rolledBackAt).toBe(T0 + 5_000);
  });

  it("keeps rejection reasons on the record", () => {
    const rejected = advanceProposal(
      proposal({ target: "risk.limits.maxLeverage", currentValue: 1, proposedValue: 3 }),
      "REJECTED",
      { actor: { id: "reviewer-2", privileged: false }, at: T0 + 3_000 },
    );
    expect(rejected.ok).toBe(true);
    expect(rejected.proposal.violations?.map((v) => v.code)).toContain("FORBIDDEN_TARGET");
  });
});

describe("summarizeProposals", () => {
  it("counts by status, lists rejected codes and orders deterministically", () => {
    const applied = advanceProposal(
      advanceProposal(proposal({ id: "p-1" }), "EVALUATING", privileged).proposal,
      "APPROVED",
      privileged,
    ).proposal;
    const appliedFinal = advanceProposal(applied, "APPLIED", { ...privileged, evaluation }).proposal;

    const rejected = advanceProposal(
      proposal({
        id: "p-2",
        createdAt: T0 + 1,
        target: "execution.mode",
        proposedValue: "live" as ProposalValue,
      }),
      "REJECTED",
      { actor: { id: "reviewer-2", privileged: false }, at: T0 + 10 },
    ).proposal;

    // Deliberately unsorted input, including two proposals on the same target.
    const list: LearningProposal[] = [rejected, appliedFinal, proposal({ id: "p-0", createdAt: T0 - 5 })];
    const summary = summarizeProposals(list);

    expect(summary.counts).toEqual({
      PROPOSED: 1,
      EVALUATING: 0,
      APPROVED: 0,
      REJECTED: 1,
      APPLIED: 1,
      ROLLED_BACK: 0,
    });
    // Both codes are true and both must be reported: `execution.mode` is a
    // forbidden target *and* this is an attempt to leave paper mode. Reporting
    // only one would understate the audit record.
    expect(summary.rejected).toEqual([
      {
        id: "p-2",
        target: "execution.mode",
        violations: ["FORBIDDEN_TARGET", "EXECUTION_MODE_CHANGE"],
      },
    ]);
    // Latest entry per target, in first-seen (createdAt) order.
    expect(summary.latestByTarget.map((t) => t.id)).toEqual(["p-1", "p-2"]);

    // Stable across re-runs and independent of input order.
    expect(summarizeProposals([...list].reverse())).toEqual(summary);
  });
});
