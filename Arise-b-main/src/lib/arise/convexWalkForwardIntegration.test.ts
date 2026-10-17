import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "@/convex/schema";
import { api, internal } from "@/convex/_generated/api";

const modules = import.meta.glob("../../convex/**/*.ts");

describe("Convex runTest walk-forward integration", () => {
  it("persists synthetic-run refusal and cannot qualify a strategy", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "wf-integration@example.com", role: "user" }),
    );
    const botId = await t.run(async (ctx) =>
      ctx.db.insert("bots", {
        userId,
        name: "integration-bot",
        strategyId: "sma-cross",
        description: "deterministic integration fixture",
        createdAt: 1,
      }),
    );
    await t.mutation(internal.arise.billingFunctions.seedPlans, {});

    const result = await t.withIdentity({ subject: userId }).action(api.arise.backtest.runTest, {
      botId,
      symbol: "BTCUSDT",
      interval: "1h",
      useSynthetic: true,
      seed: 123,
    });

    expect(result.ok).toBe(true);
    expect(result.dataKind).toBe("SYNTHETIC");
    expect(result.walkForward).toMatchObject({ ok: false, reason: "SYNTHETIC_DATA" });
    const saved = await t.run(async (ctx) =>
      ctx.db.query("backtestRuns").withIndex("userId", (q) => q.eq("userId", userId)).first(),
    );
    expect(saved).not.toBeNull();
    expect(saved?.dataKind).toBe("SYNTHETIC");
    expect(saved?.walkForward).toMatchObject({ ok: false, reason: "SYNTHETIC_DATA" });
    expect(saved?.fitnessGates?.eligible).toBe(false);
    expect(saved?.fitnessGates?.blockers.length).toBeGreaterThan(0);
  });
});
