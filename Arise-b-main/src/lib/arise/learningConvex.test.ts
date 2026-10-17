// ARISE V1 — CONTROLLED LEARNING regression tests (mandate §6.L, §7 step 14).
// These run the REAL Convex mutations against an in-memory backend, so they exercise
// the server boundary rather than the pure policy that `learning.test.ts` already
// covers:
//   - only an operator/admin can read or move a proposal,
//   - a forbidden target is recorded as REJECTED with its reason codes (a boundary
//     probe stays visible instead of being silently dropped),
//   - APPLIED is unreachable without a completed, passing evaluation, and the
//     refusal leaves the stored status untouched,
//   - rollback restores the value that was in force before the change.
// No network, no live data.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "@/convex/schema";
import { api } from "@/convex/_generated/api";

const modules = import.meta.glob("../../convex/**/*.ts");

type TestConvex = ReturnType<typeof convexTest>;

function newBackend() {
  return convexTest(schema, modules);
}

async function seedUser(
  t: TestConvex,
  opts: { email: string; role?: "admin" | "operator" | "analyst" | "user"; disabled?: boolean },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { email: opts.email, role: opts.role, disabled: opts.disabled }),
  );
}

const OPERATOR = { email: "ops@example.com", role: "operator" as const };

/** A deliberately valid, tightening proposal (minBars 120 → 200 requires more
 *  history before an analysis is trusted). */
function validProposal(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: "p-1",
    trigger: "PAPER_RESULT" as const,
    target: "evidence.thresholds.minBars",
    currentValue: 120,
    proposedValue: 200,
    rationale: "Forward paper runs on thin history produced uncalibrated signals.",
    evidence: ["paper run 2026-08-01..2026-09-01: expectancy -0.18R"],
    expectedEffect: "Fewer analyses on insufficient history; no change to risk limits.",
    riskOfChange: "More WAIT outcomes while history accumulates.",
    evaluationPlan: "Walk-forward over 24 months, then 4 weeks of paper trading.",
    ...overrides,
  };
}

/** `t.run` hands back a context typed against the generic data model (index names
 *  are not known there), so the row is located by scanning the small collection. */
async function rowOf(t: TestConvex, proposalId: string) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("learningProposals").collect();
    return rows.find((r) => r.proposalId === proposalId) ?? null;
  });
}

async function statusOf(t: TestConvex, proposalId: string): Promise<string | undefined> {
  return (await rowOf(t, proposalId))?.status;
}

describe("learning proposals — authorization", () => {
  it("refuses every entry point without a session", async () => {
    const t = newBackend();
    await expect(t.query(api.arise.learning.list, {})).rejects.toThrow(/Not authenticated/);
    await expect(t.mutation(api.arise.learning.propose, validProposal())).rejects.toThrow(
      /Not authenticated/,
    );
    await expect(
      t.mutation(api.arise.learning.advance, { proposalId: "p-1", next: "EVALUATING" }),
    ).rejects.toThrow(/Not authenticated/);
    await expect(t.mutation(api.arise.learning.rollback, { proposalId: "p-1" })).rejects.toThrow(
      /Not authenticated/,
    );
  });

  it("refuses ordinary users and analysts, who hold no control-plane authority", async () => {
    const t = newBackend();
    for (const role of ["user", "analyst"] as const) {
      const id = await seedUser(t, { email: `${role}@example.com`, role });
      const as = t.withIdentity({ subject: id });
      await expect(as.query(api.arise.learning.list, {})).rejects.toThrow(/FORBIDDEN/);
      await expect(as.mutation(api.arise.learning.propose, validProposal())).rejects.toThrow(
        /FORBIDDEN/,
      );
      await expect(
        as.mutation(api.arise.learning.advance, { proposalId: "p-1", next: "EVALUATING" }),
      ).rejects.toThrow(/FORBIDDEN/);
    }
  });

  it("refuses a disabled operator even though the role is privileged", async () => {
    const t = newBackend();
    const id = await seedUser(t, { email: "off@example.com", role: "operator", disabled: true });
    await expect(t.withIdentity({ subject: id }).query(api.arise.learning.list, {})).rejects.toThrow(
      /FORBIDDEN/,
    );
  });
});

describe("learning proposals — validation at the boundary", () => {
  it("rejects a forbidden target, records the reason and keeps the probe visible", async () => {
    const t = newBackend();
    const id = await seedUser(t, OPERATOR);
    const as = t.withIdentity({ subject: id });

    const result = await as.mutation(
      api.arise.learning.propose,
      validProposal({
        proposalId: "p-risk",
        target: "risk.limits.riskPerTradePct",
        currentValue: 0.5,
        proposedValue: 5,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe("REJECTED");
    expect(result.violations).toContain("FORBIDDEN_TARGET");

    // Stored as REJECTED with codes, not dropped: an attempt to move a risk limit
    // is precisely the thing an operator needs to be able to see.
    const stored = await rowOf(t, "p-risk");
    expect(stored?.status).toBe("REJECTED");
    expect(JSON.stringify(stored?.violations)).toContain("FORBIDDEN_TARGET");

    const events = await as.query(api.arise.system.list, { limit: 20 });
    expect(events.some((e) => e.code === "LEARNING_PROPOSAL_REJECTED" && e.level === "WARN")).toBe(
      true,
    );
  });

  it("rejects an execution-mode change and an evidence-free proposal", async () => {
    const t = newBackend();
    const id = await seedUser(t, OPERATOR);
    const as = t.withIdentity({ subject: id });

    const mode = await as.mutation(
      api.arise.learning.propose,
      validProposal({
        proposalId: "p-mode",
        target: "execution.mode",
        currentValue: "paper",
        proposedValue: "live",
      }),
    );
    expect(mode.ok).toBe(false);
    expect(mode.violations).toContain("FORBIDDEN_TARGET");
    expect(mode.violations).toContain("EXECUTION_MODE_CHANGE");

    const noEvidence = await as.mutation(
      api.arise.learning.propose,
      validProposal({ proposalId: "p-noev", evidence: ["   "] }),
    );
    expect(noEvidence.ok).toBe(false);
    expect(noEvidence.violations).toContain("EMPTY_EVIDENCE");
  });

  it("accepts a valid tightening proposal and refuses a duplicate id", async () => {
    const t = newBackend();
    const id = await seedUser(t, OPERATOR);
    const as = t.withIdentity({ subject: id });

    const created = await as.mutation(api.arise.learning.propose, validProposal());
    expect(created.ok).toBe(true);
    expect(created.status).toBe("PROPOSED");

    await expect(as.mutation(api.arise.learning.propose, validProposal())).rejects.toThrow(
      /DUPLICATE_PROPOSAL/,
    );
  });

  it("rejects an unknown trigger before anything is stored", async () => {
    const t = newBackend();
    const id = await seedUser(t, OPERATOR);
    const bad = { ...validProposal(), trigger: "MADE_UP_TRIGGER" };
    await expect(
      t.withIdentity({ subject: id }).mutation(api.arise.learning.propose, bad as never),
    ).rejects.toThrow();
  });
});

describe("learning proposals — nothing is applied without a passing evaluation", () => {
  async function proposed(t: TestConvex) {
    const id = await seedUser(t, OPERATOR);
    const as = t.withIdentity({ subject: id });
    await as.mutation(api.arise.learning.propose, validProposal());
    return as;
  }

  it("cannot jump from PROPOSED straight to APPLIED", async () => {
    const t = newBackend();
    const as = await proposed(t);
    const result = await as.mutation(api.arise.learning.advance, {
      proposalId: "p-1",
      next: "APPLIED",
      evaluation: { completedAt: Date.now(), passed: true, reference: "wf-1" },
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toContain("ILLEGAL_TRANSITION");
    expect(await statusOf(t, "p-1")).toBe("PROPOSED");
  });

  it("refuses APPLIED when the evaluation is missing, unfinished or failed", async () => {
    const t = newBackend();
    const as = await proposed(t);
    await as.mutation(api.arise.learning.advance, { proposalId: "p-1", next: "EVALUATING" });
    await as.mutation(api.arise.learning.advance, { proposalId: "p-1", next: "APPROVED" });

    const missing = await as.mutation(api.arise.learning.advance, {
      proposalId: "p-1",
      next: "APPLIED",
    });
    expect(missing.violations).toContain("EVALUATION_NOT_COMPLETED");

    const unfinished = await as.mutation(api.arise.learning.advance, {
      proposalId: "p-1",
      next: "APPLIED",
      evaluation: { startedAt: Date.now(), passed: true },
    });
    expect(unfinished.violations).toContain("EVALUATION_NOT_COMPLETED");

    const failed = await as.mutation(api.arise.learning.advance, {
      proposalId: "p-1",
      next: "APPLIED",
      evaluation: { completedAt: Date.now(), passed: false },
    });
    expect(failed.violations).toContain("EVALUATION_FAILED");

    // Every refusal left the stored state at APPROVED — no partial apply.
    expect(await statusOf(t, "p-1")).toBe("APPROVED");
  });

  it("applies with a passing evaluation, captures the previous value, and rolls back", async () => {
    const t = newBackend();
    const as = await proposed(t);
    await as.mutation(api.arise.learning.advance, { proposalId: "p-1", next: "EVALUATING" });
    await as.mutation(api.arise.learning.advance, { proposalId: "p-1", next: "APPROVED" });

    const applied = await as.mutation(api.arise.learning.advance, {
      proposalId: "p-1",
      next: "APPLIED",
      evaluation: { completedAt: Date.now(), passed: true, reference: "wf-2026-09" },
    });
    expect(applied.ok).toBe(true);
    expect(applied.status).toBe("APPLIED");

    const after = await rowOf(t, "p-1");
    expect(after?.currentValue).toBe(200);
    expect(after?.previousValue).toBe(120);

    const rolled = await as.mutation(api.arise.learning.rollback, { proposalId: "p-1" });
    expect(rolled.ok).toBe(true);
    expect(rolled.status).toBe("ROLLED_BACK");
    expect(await statusOf(t, "p-1")).toBe("ROLLED_BACK");

    const restored = await rowOf(t, "p-1");
    expect(restored?.currentValue).toBe(120);
    expect(restored?.rolledBackAt).not.toBeNull();
  });

  it("requires a named evaluation reference and stamps the completion time itself", async () => {
    const t = newBackend();
    const as = await proposed(t);
    await as.mutation(api.arise.learning.advance, { proposalId: "p-1", next: "EVALUATING" });
    await as.mutation(api.arise.learning.advance, { proposalId: "p-1", next: "APPROVED" });

    // An attestation with no reference is not evidence that an evaluation happened,
    // so nothing is stamped and the gate keeps refusing.
    const unnamed = await as.mutation(api.arise.learning.advance, {
      proposalId: "p-1",
      next: "APPLIED",
      evaluation: { passed: true },
    });
    expect(unnamed.violations).toContain("EVALUATION_NOT_COMPLETED");
    expect(await statusOf(t, "p-1")).toBe("APPROVED");

    const applied = await as.mutation(api.arise.learning.advance, {
      proposalId: "p-1",
      next: "APPLIED",
      evaluation: { passed: true, reference: "wf-2026-09" },
    });
    expect(applied.ok).toBe(true);

    const row = await rowOf(t, "p-1");
    const evaluation = row?.evaluation as { completedAt?: number; reference?: string } | undefined;
    expect(evaluation?.reference).toBe("wf-2026-09");
    expect(typeof evaluation?.completedAt).toBe("number");
  });

  it("refuses to roll back a proposal that was never applied", async () => {
    const t = newBackend();
    const as = await proposed(t);
    const result = await as.mutation(api.arise.learning.rollback, { proposalId: "p-1" });
    expect(result.ok).toBe(false);
    expect(result.violations).toContain("NO_PREVIOUS_VALUE");
    expect(await statusOf(t, "p-1")).toBe("PROPOSED");
  });
});

describe("learning proposals — read path", () => {
  it("returns proposals plus the deterministic audit summary for an operator", async () => {
    const t = newBackend();
    const id = await seedUser(t, OPERATOR);
    const as = t.withIdentity({ subject: id });

    await as.mutation(api.arise.learning.propose, validProposal());
    await as.mutation(
      api.arise.learning.propose,
      validProposal({
        proposalId: "p-bad",
        target: "risk.limits.maxLeverage",
        currentValue: 1,
        proposedValue: 3,
      }),
    );

    const view = await as.query(api.arise.learning.list, { limit: 10 });
    expect(view.total).toBe(2);
    expect(view.summary.counts.PROPOSED).toBe(1);
    expect(view.summary.counts.REJECTED).toBe(1);
    // All three reasons are true for this row and all three must be reported: it is
    // a forbidden target, it loosens the live value, and it is still looser than the
    // shipped default (maxLeverage defaults to 1).
    expect(view.summary.rejected).toEqual([
      {
        id: "p-bad",
        target: "risk.limits.maxLeverage",
        violations: [
          "FORBIDDEN_TARGET",
          "RISK_LIMIT_RELAXATION",
          "WEAKER_THAN_SHIPPED_DEFAULT",
        ],
      },
    ]);
    expect(view.proposals.map((p) => p.proposalId).sort()).toEqual(["p-1", "p-bad"]);
  });
});
