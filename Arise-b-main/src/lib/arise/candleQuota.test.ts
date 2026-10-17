import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "@/convex/schema";
import { internal } from "@/convex/_generated/api";
import { CANDLE_REQUESTS_PER_MINUTE } from "@/convex/arise/charts";

const modules = import.meta.glob("../../convex/**/*.ts");

describe("candle proxy quota", () => {
  it("limits a user to 30 requests per minute and resets at the next window", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { email: "charts@example.com" }));
    const now = 1_800_000_000_000;
    for (let i = 0; i < CANDLE_REQUESTS_PER_MINUTE; i++) {
      const result = await t.mutation(internal.arise.charts.consumeCandleQuota, { userId, now });
      expect(result.allowed).toBe(true);
    }
    await expect(
      t.mutation(internal.arise.charts.consumeCandleQuota, { userId, now }),
    ).resolves.toMatchObject({ allowed: false, remaining: 0 });
    await expect(
      t.mutation(internal.arise.charts.consumeCandleQuota, { userId, now: now + 60_000 }),
    ).resolves.toMatchObject({ allowed: true, remaining: CANDLE_REQUESTS_PER_MINUTE - 1 });
  });
});
