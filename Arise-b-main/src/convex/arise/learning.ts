// ARISE V1 — controlled learning proposals (Convex boundary).
//
// This file is a *thin* persistence boundary. Every rule that matters lives in
// src/lib/arise/learning.ts (pure, unit-tested, no Convex dependency): forbidden
// targets, safety-limit direction, evidence discipline, the transition map and the
// privileged-approval requirement. Nothing here may loosen those rules — the layer
// only stores what the policy produced, so a bug in this file cannot widen policy.
//
// Consequences worth stating plainly:
//   * A proposal that fails validation is still STORED, as REJECTED with its reason
//     codes. An attempt to change a risk limit is evidence of a boundary probe; the
//     operator should be able to see it, not have the write silently dropped.
//   * Only a privileged actor (admin | operator) may read or move a proposal.
//   * Learning can never APPLY itself: reaching APPLIED requires this mutation
//     (human-initiated) plus a completed, passing evaluation.

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  advanceProposal,
  createProposal,
  rollbackProposal,
  summarizeProposals,
  validateProposal,
  type LearningProposal,
  type LearningTrigger,
  type ProposalStatus,
  type ProposalValue,
  type ProposalViolation,
} from "../../lib/arise/learning";

type DbCtx = QueryCtx | MutationCtx;

const MAX_LIST = 200;
const DEFAULT_LIST = 50;

const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  "PROPOSED",
  "EVALUATING",
  "APPROVED",
  "REJECTED",
  "APPLIED",
  "ROLLED_BACK",
];

const statusValidator = v.union(
  v.literal("EVALUATING"),
  v.literal("APPROVED"),
  v.literal("REJECTED"),
  v.literal("APPLIED"),
);

const valueValidator = v.union(v.number(), v.string(), v.boolean());

/** Closed set: an unlisted trigger is a bug in the caller, not a new class of
 *  learning, so Convex rejects it before anything is stored. */
const triggerValidator = v.union(
  v.literal("PAPER_RESULT"),
  v.literal("PREDICTION_CALIBRATION"),
  v.literal("STRATEGY_FAILURE"),
  v.literal("REGIME_CHANGE"),
  v.literal("EXECUTION_DISCREPANCY"),
  v.literal("DATA_QUALITY_INCIDENT"),
  v.literal("INCORRECT_ASSUMPTION"),
  v.literal("MONITOR_ALERT"),
  v.literal("BACKTEST_VS_FORWARD_DIVERGENCE"),
);

const evaluationValidator = v.object({
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  passed: v.optional(v.boolean()),
  reference: v.optional(v.string()),
});

/**
 * Learning is an operational control plane, not a user feature: proposals describe
 * internal thresholds and carry the authority to change them. `analyst` and `user`
 * are read-denied as well, so nobody can mine the audit trail for internal limits.
 */
async function requireOperator(ctx: DbCtx): Promise<{ userId: Id<"users">; email?: string }> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Not authenticated");
  const user = await ctx.db.get(userId);
  const role = user?.role;
  if (!user || user.disabled === true || (role !== "admin" && role !== "operator")) {
    throw new Error("FORBIDDEN: operator or administrator role required");
  }
  return { userId, email: user.email ?? undefined };
}

/** Fail closed: a stored value that is not a readable primitive is a corrupt row,
 *  not a permissive one. Objects/arrays are refused rather than coerced. */
function readValue(raw: unknown): ProposalValue {
  if (typeof raw === "number" || typeof raw === "string" || typeof raw === "boolean") return raw;
  throw new Error("INVALID_STORED_VALUE: proposal row holds an unreadable value");
}

function readStatus(raw: string): ProposalStatus {
  const found = PROPOSAL_STATUSES.find((s) => s === raw);
  if (!found) throw new Error(`INVALID_STORED_STATUS: ${raw}`);
  return found;
}

function readViolations(raw: unknown): ProposalViolation[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((v): v is { code: string; detail: string } =>
      typeof v === "object" && v !== null && typeof (v as { code?: unknown }).code === "string",
    )
    .map((v) => ({ code: v.code, detail: String(v.detail ?? "") }));
}

/** Stored row → the pure policy's shape, so the policy re-validates real state. */
function toProposal(row: Doc<"learningProposals">): LearningProposal {
  return {
    id: row.proposalId,
    createdAt: row.createdAt,
    trigger: row.trigger as LearningTrigger,
    target: row.target,
    currentValue: readValue(row.currentValue),
    proposedValue: readValue(row.proposedValue),
    rationale: row.rationale,
    evidence: row.evidence,
    expectedEffect: row.expectedEffect,
    riskOfChange: row.riskOfChange,
    evaluationPlan: row.evaluationPlan,
    status: readStatus(row.status),
    previousValue: row.previousValue === undefined ? undefined : readValue(row.previousValue),
    decidedBy: row.decidedBy,
    appliedAt: row.appliedAt,
    rolledBackAt: row.rolledBackAt,
    evaluation: row.evaluation as LearningProposal["evaluation"],
    violations: readViolations(row.violations),
  };
}

function codesOf(violations: ProposalViolation[]): string[] {
  return violations.map((x) => x.code);
}

/** `patch` only writes the keys we actually decided on: an explicit `undefined`
 *  must never be an instruction to clear a column (that would silently drop the
 *  audit trail for a rejection reason or a rollback target). */
function compact<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<T>;
}

async function findByProposalId(
  ctx: DbCtx,
  proposalId: string,
): Promise<Doc<"learningProposals"> | null> {
  return await ctx.db
    .query("learningProposals")
    .withIndex("proposalId", (q) => q.eq("proposalId", proposalId))
    .unique();
}

/** Operator-visible event so a promotion, demotion or rollback shows up in the
 *  System audit log even if nobody opens the learning panel. */
async function note(
  ctx: MutationCtx,
  level: "INFO" | "WARN",
  code: string,
  message: string,
): Promise<void> {
  await ctx.db.insert("systemEvents", {
    level,
    area: "SYSTEM",
    code,
    message,
    at: Date.now(),
  });
}

// ---------------- write path ----------------

export const propose = mutation({
  args: {
    proposalId: v.string(),
    trigger: triggerValidator,
    target: v.string(),
    currentValue: valueValidator,
    proposedValue: valueValidator,
    rationale: v.string(),
    evidence: v.array(v.string()),
    expectedEffect: v.string(),
    riskOfChange: v.string(),
    evaluationPlan: v.string(),
  },
  handler: async (
    ctx,
    a,
  ): Promise<{ ok: boolean; proposalId: string; status: string; violations: string[] }> => {
    const { userId, email } = await requireOperator(ctx);
    const now = Date.now();

    const existing = await findByProposalId(ctx, a.proposalId);
    if (existing) throw new Error(`DUPLICATE_PROPOSAL: ${a.proposalId} already exists`);

    const candidate = createProposal({
      id: a.proposalId,
      createdAt: now,
      trigger: a.trigger as LearningTrigger,
      target: a.target,
      currentValue: a.currentValue,
      proposedValue: a.proposedValue,
      rationale: a.rationale,
      evidence: a.evidence,
      expectedEffect: a.expectedEffect,
      riskOfChange: a.riskOfChange,
      evaluationPlan: a.evaluationPlan,
    });

    // The policy decides, not this layer. An invalid proposal is recorded as
    // REJECTED with the codes rather than dropped, so boundary probes stay visible.
    const validation = validateProposal(candidate);
    const status: ProposalStatus = validation.ok ? "PROPOSED" : "REJECTED";

    await ctx.db.insert("learningProposals", {
      proposalId: a.proposalId,
      createdBy: userId,
      createdByEmail: email,
      createdAt: now,
      at: now,
      trigger: a.trigger,
      target: a.target,
      currentValue: a.currentValue,
      proposedValue: a.proposedValue,
      rationale: a.rationale,
      evidence: a.evidence,
      expectedEffect: a.expectedEffect,
      riskOfChange: a.riskOfChange,
      evaluationPlan: a.evaluationPlan,
      status,
      violations: validation.ok ? undefined : validation.violations,
      decidedBy: validation.ok ? undefined : `${userId}`,
    });

    if (!validation.ok) {
      await note(
        ctx,
        "WARN",
        "LEARNING_PROPOSAL_REJECTED",
        `proposal ${a.proposalId} on "${a.target}" refused: ${codesOf(validation.violations).join(", ")}`,
      );
    }

    return {
      ok: validation.ok,
      proposalId: a.proposalId,
      status,
      violations: codesOf(validation.violations),
    };
  },
});

export const advance = mutation({
  args: {
    proposalId: v.string(),
    next: statusValidator,
    evaluation: v.optional(evaluationValidator),
  },
  handler: async (
    ctx,
    a,
  ): Promise<{ ok: boolean; status: string; violations: string[] }> => {
    const { userId, email } = await requireOperator(ctx);
    const row = await findByProposalId(ctx, a.proposalId);
    if (!row) throw new Error("PROPOSAL_NOT_FOUND");

    // The confirmation timestamp is stamped HERE, from server time. A client cannot
    // backdate — or invent — the moment an evaluation was confirmed, and it is only
    // stamped when the caller both attests a pass and names a reference, so
    // `completedAt` keeps meaning "a named evaluation exists", not "someone clicked".
    const evaluation = a.evaluation
      ? {
          ...a.evaluation,
          completedAt:
            a.evaluation.completedAt ??
            (a.evaluation.passed === true && (a.evaluation.reference ?? "").trim().length > 0
              ? Date.now()
              : undefined),
        }
      : undefined;

    const result = advanceProposal(toProposal(row), a.next, {
      actor: { id: String(userId), privileged: true },
      at: Date.now(),
      evaluation,
    });

    if (!result.ok) {
      return { ok: false, status: row.status, violations: codesOf(result.violations) };
    }

    const p = result.proposal;
    await ctx.db.patch(
      row._id,
      compact({
        status: p.status,
        // The apply step swaps currentValue for proposedValue; persisting it here is
        // what makes the change real (and previousValue is what a rollback restores).
        currentValue: p.currentValue,
        previousValue: p.previousValue,
        decidedBy: p.decidedBy,
        appliedAt: p.appliedAt,
        rolledBackAt: p.rolledBackAt,
        evaluation: p.evaluation,
        violations: p.violations,
        at: Date.now(),
      }),
    );

    if (p.status === "APPLIED") {
      await note(
        ctx,
        "INFO",
        "LEARNING_PROPOSAL_APPLIED",
        `${a.proposalId} applied by ${email ?? userId}: ${p.target} ${JSON.stringify(
          p.previousValue,
        )} → ${JSON.stringify(p.currentValue)}`,
      );
    }
    return { ok: true, status: p.status, violations: [] };
  },
});

/** Deliberately allowed without a second approval step: a rollback restores the
 *  value already in force, so delaying it would leave a bad change live. */
export const rollback = mutation({
  args: { proposalId: v.string() },
  handler: async (
    ctx,
    a,
  ): Promise<{ ok: boolean; status: string; violations: string[] }> => {
    const { userId, email } = await requireOperator(ctx);
    const row = await findByProposalId(ctx, a.proposalId);
    if (!row) throw new Error("PROPOSAL_NOT_FOUND");

    const result = rollbackProposal(toProposal(row), {
      actor: { id: String(userId), privileged: true },
      at: Date.now(),
    });
    if (!result.ok) {
      return { ok: false, status: row.status, violations: codesOf(result.violations) };
    }

    const p = result.proposal;
    await ctx.db.patch(
      row._id,
      compact({
        status: p.status,
        currentValue: p.currentValue,
        rolledBackAt: p.rolledBackAt,
        decidedBy: p.decidedBy,
        at: Date.now(),
      }),
    );

    await note(
      ctx,
      "INFO",
      "LEARNING_PROPOSAL_ROLLED_BACK",
      `${a.proposalId} rolled back by ${email ?? userId}: ${p.target} restored to ${JSON.stringify(
        p.currentValue,
      )}`,
    );
    return { ok: true, status: p.status, violations: [] };
  },
});

// ---------------- read path ----------------

/** Latest-first listing with the deterministic audit summary computed by the pure
 *  policy, so the UI never re-implements the status counts. */
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, a) => {
    await requireOperator(ctx);
    const limit = Math.min(Math.max(a.limit ?? DEFAULT_LIST, 1), MAX_LIST);
    const rows = await ctx.db.query("learningProposals").withIndex("at", (q) => q.gte("at", 0)).collect();
    const ordered = rows.sort((x, y) => y.at - x.at).slice(0, limit);
    // Summary spans every stored proposal, not just the returned page.
    const summary = summarizeProposals(rows.map(toProposal));
    return {
      proposals: ordered.map((row) => ({
        proposalId: row.proposalId,
        createdAt: row.createdAt,
        at: row.at,
        trigger: row.trigger,
        target: row.target,
        currentValue: row.currentValue as ProposalValue,
        proposedValue: row.proposedValue as ProposalValue,
        previousValue: (row.previousValue ?? null) as ProposalValue | null,
        rationale: row.rationale,
        evidence: row.evidence,
        expectedEffect: row.expectedEffect,
        riskOfChange: row.riskOfChange,
        evaluationPlan: row.evaluationPlan,
        status: row.status,
        violations: readViolations(row.violations) ?? [],
        decidedBy: row.decidedBy ?? null,
        appliedAt: row.appliedAt ?? null,
        rolledBackAt: row.rolledBackAt ?? null,
        evaluation: row.evaluation ?? null,
      })),
      summary,
      total: rows.length,
    };
  },
});

/** Single proposal, for a detail view. */
export const byProposalId = query({
  args: { proposalId: v.string() },
  handler: async (ctx, a) => {
    await requireOperator(ctx);
    const row = await findByProposalId(ctx, a.proposalId);
    if (!row) return null;
    return { ...row, violations: readViolations(row.violations) ?? [] };
  },
});
