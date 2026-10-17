// Analysis section — server-side authorization and immutability.
// Runs the real Convex functions against an in-memory backend; no provider calls.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "@/convex/schema";
import { api } from "@/convex/_generated/api";
import * as analysisModule from "@/convex/arise/analysis";

const modules = import.meta.glob("../../convex/**/*.ts");
type TestConvex = ReturnType<typeof convexTest>;

function newBackend() {
  return convexTest(schema, modules);
}

async function seedUser(
  t: TestConvex,
  opts: { email: string; disabled?: boolean } = { email: "u@example.com" },
) {
  return await t.run((ctx) =>
    ctx.db.insert("users", { email: opts.email, disabled: opts.disabled }),
  );
}

async function seedDecision(t: TestConvex, userId: Awaited<ReturnType<typeof seedUser>>) {
  return await t.run((ctx) =>
    ctx.db.insert("decisions", {
      userId,
      symbol: "BTCUSDT",
      interval: "1h",
      mode: "paper" as const,
      status: "TRADE",
      direction: "LONG",
      confidence: 0.7,
      regime: "TRENDING_UP",
      thesis: "Original thesis that must never be rewritten.",
      recommendedAction: "TRADE",
      dataQuality: "valid",
      dataAgeSec: 10,
      dataSource: "binance",
      dataTimestamp: 1_000_000,
      mind: { direction: "LONG" },
      agents: {},
      plan: { side: "LONG", entry: 100, stopLoss: 98, takeProfit: 104 },
      risk: { decision: "APPROVED", reasonCode: "ALL_CHECKS_PASS", checks: [] },
      evidence: { outcome: "TRADE", reasonCodes: [] },
      snapshotMeta: { lastClose: 100, lastBarTime: 1_000_000 },
    }),
  );
}

describe("Analysis authorization", () => {
  it("rejects every analysis read without an identity", async () => {
    const t = newBackend();
    await expect(t.query(api.arise.analysis.history, {})).rejects.toThrow(/Not authenticated/);
    await expect(t.query(api.arise.analysis.latest, {})).rejects.toThrow(/Not authenticated/);
    await expect(t.query(api.arise.analysis.monitoring, {})).rejects.toThrow(/Not authenticated/);
    await expect(t.query(api.arise.analysis.performance, {})).rejects.toThrow(/Not authenticated/);
    await expect(t.query(api.arise.analysis.health, {})).rejects.toThrow(/Not authenticated/);

    const userId = await seedUser(t);
    const decisionId = await seedDecision(t, userId);
    await expect(t.mutation(api.arise.analysis.save, { decisionId })).rejects.toThrow(/Not authenticated/);
  });

  it("rejects a disabled account even for its own saved analysis", async () => {
    const t = newBackend();
    const userId = await seedUser(t, { email: "disabled@example.com", disabled: true });
    const decisionId = await seedDecision(t, userId);
    await expect(
      t.withIdentity({ subject: userId }).mutation(api.arise.analysis.save, { decisionId }),
    ).rejects.toThrow(/ACCOUNT_DISABLED/);
    await expect(
      t.withIdentity({ subject: userId }).query(api.arise.analysis.history, {}),
    ).rejects.toThrow(/ACCOUNT_DISABLED/);
  });

  it("refuses to save another user's decision and keeps histories isolated", async () => {
    const t = newBackend();
    const userA = await seedUser(t, { email: "a@example.com" });
    const userB = await seedUser(t, { email: "b@example.com" });
    const decisionA = await seedDecision(t, userA);

    await expect(
      t.withIdentity({ subject: userB }).mutation(api.arise.analysis.save, { decisionId: decisionA }),
    ).rejects.toThrow(/Not found/);

    const saved = await t.withIdentity({ subject: userA }).mutation(api.arise.analysis.save, {
      decisionId: decisionA,
    });
    expect(saved.created).toBe(true);

    const historyA = await t.withIdentity({ subject: userA }).query(api.arise.analysis.history, {});
    const historyB = await t.withIdentity({ subject: userB }).query(api.arise.analysis.history, {});
    expect(historyA).toHaveLength(1);
    expect(historyB).toHaveLength(0);
  });

  it("is idempotent per decision and preserves the original prediction", async () => {
    const t = newBackend();
    const userId = await seedUser(t, { email: "owner@example.com" });
    const decisionId = await seedDecision(t, userId);
    const asOwner = t.withIdentity({ subject: userId });

    const first = await asOwner.mutation(api.arise.analysis.save, { decisionId });
    const second = await asOwner.mutation(api.arise.analysis.save, { decisionId });
    expect(second.created).toBe(false);
    expect(second.recordId).toBe(first.recordId);

    const count = await t.run((ctx) => ctx.db.query("analysisRecords").collect());
    expect(count).toHaveLength(1);

    // Mutating the decision afterwards cannot rewrite the saved record.
    await t.run((ctx) => ctx.db.patch(decisionId, { thesis: "changed later", direction: "SHORT" }));
    const history = await asOwner.query(api.arise.analysis.history, {});
    expect(history[0].thesis).toBe("Original thesis that must never be rewritten.");
    expect(history[0].direction).toBe("LONG");
  });

  it("exposes no update or delete endpoint for saved analyses", () => {
    const names = Object.keys(analysisModule);
    expect(names).toContain("save");
    expect(names).toContain("history");
    // Internal notifications and agent API endpoints carry the leading underscore /
    // suffix; a client-callable rewrite of a saved record must not exist at all.
    expect(names.filter((name) => /update|delete|remove|edit|patch/i.test(name))).toEqual([]);
  });
});
