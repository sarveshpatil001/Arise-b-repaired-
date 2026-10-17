// ARISE V1 — object-level authorization boundary tests.
//
// These pin the P0/P1 audit repairs against regression:
//   - the internal bot lookup is not reachable from a client and never crosses users,
//   - plan seeding is an operator action, not a public mutation, and is idempotent,
//   - admin aggregates are admin-gated and honestly report a clipped scan,
//   - the backtest action authenticates and authorizes before doing any work.
// Real Convex functions against an in-memory backend, deterministic fixtures, no network.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "@/convex/schema";
import { api, internal } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import * as backtestModule from "@/convex/arise/backtest";
import * as billingFunctionsModule from "@/convex/arise/billingFunctions";
import { PLANS, PLAN_MAP } from "@/convex/arise/billing";

const modules = import.meta.glob("../../convex/**/*.ts");

type TestConvex = ReturnType<typeof convexTest>;

function newBackend() {
  return convexTest(schema, modules);
}

async function seedUser(t: TestConvex, email: string, role?: "admin" | "user") {
  return await t.run(async (ctx) => ctx.db.insert("users", { email, role }));
}

async function seedBot(t: TestConvex, userId: Id<"users">, name = "alpha") {
  return await t.run(async (ctx) =>
    ctx.db.insert("bots", {
      userId,
      name,
      strategyId: "sma-cross",
      description: "test bot",
      createdAt: Date.now(),
    }),
  );
}

describe("bot lookup — no public surface, no cross-user access", () => {
  it("declares the bot lookup internal, not public", () => {
    // The whole point of the repair: the bot record was a public query readable by id
    // before, by anyone. Two separate facts have to hold, and they are not the same
    // fact — asserting on the shape of the generated `api` object would prove neither,
    // because that object references every module export (public AND internal).
    //   1. the declaration itself is internal (Convex's own flag on the exported
    //      function, the thing the server uses to build the public surface), and
    //   2. the deployment's function spec agrees (verified out of band with
    //      `bunx convex function-spec`: arise/backtest.js:getBotInternal -> internal).
    const getBotInternal = backtestModule.getBotInternal as unknown as {
      isInternal?: boolean;
      isPublic?: boolean;
    };
    expect(getBotInternal.isInternal).toBe(true);
    expect(getBotInternal.isPublic).toBeUndefined();
    // The internal reference still exists for server-side callers (the market action).
    expect(typeof internal.arise.backtest.getBotInternal).toBe("object");
  });

  it("returns a narrowed payload to internal callers and null for unknown ids", async () => {
    const t = newBackend();
    const owner = await seedUser(t, "owner@example.com");
    const botId = await seedBot(t, owner, "momentum-1");

    const bot = await t.query(internal.arise.backtest.getBotInternal, { botId });
    expect(bot).toMatchObject({ _id: botId, userId: owner, name: "momentum-1", strategyId: "sma-cross" });
    // Narrow projection: the internal caller gets what it needs, nothing more.
    expect(Object.keys(bot ?? {}).sort()).toEqual(["_id", "name", "strategyId", "userId"]);

    const ghost = await t.run(async (ctx) => {
      const id = await ctx.db.insert("bots", {
        userId: owner,
        name: "temp",
        strategyId: "buy-hold",
        createdAt: 1,
      });
      await ctx.db.delete(id);
      return id;
    });
    expect(await t.query(internal.arise.backtest.getBotInternal, { botId: ghost })).toBeNull();
  });

  it("keeps every public bot reader scoped to its owner", async () => {
    const t = newBackend();
    const owner = await seedUser(t, "owner@example.com");
    const stranger = await seedUser(t, "stranger@example.com");
    const botId = await seedBot(t, owner);

    const runId = await t.run(async (ctx) =>
      ctx.db.insert("backtestRuns", {
        userId: owner,
        botId,
        botName: "alpha",
        strategyId: "sma-cross",
        symbol: "BTCUSDT",
        interval: "1h",
        dataKind: "REAL",
        dataSource: "test",
        barCount: 400,
        seed: 1,
        feeBps: 4,
        slippageBps: 2,
        positionPct: 15,
        stopPct: 1.5,
        targetPct: 3,
        inSamplePct: 0.7,
        stress: "none",
        status: "COMPLETED",
        metrics: {},
        fitness: {},
        equityCurve: [],
        trades: [],
        createdAt: Date.now(),
      }),
    );

    // Unauthenticated: nothing at all.
    expect(await t.query(api.arise.backtest.list, {})).toEqual([]);
    expect(await t.query(api.arise.backtest.runs, {})).toEqual([]);
    expect(await t.query(api.arise.backtest.get, { runId })).toBeNull();

    // Stranger: cannot enumerate the owner's bots, cannot read the run by id, and asking
    // for runs of the owner's bot returns nothing rather than the rows.
    const asStranger = t.withIdentity({ subject: stranger });
    expect(await asStranger.query(api.arise.backtest.list, {})).toEqual([]);
    expect(await asStranger.query(api.arise.backtest.get, { runId })).toBeNull();
    expect(await asStranger.query(api.arise.backtest.runs, { botId })).toEqual([]);

    // Owner: sees exactly their own records.
    const asOwner = t.withIdentity({ subject: owner });
    expect(await asOwner.query(api.arise.backtest.list, {})).toHaveLength(1);
    expect(await asOwner.query(api.arise.backtest.runs, { botId })).toHaveLength(1);
    expect(await asOwner.query(api.arise.backtest.get, { runId })).not.toBeNull();
  });

  it("authenticates and authorizes the backtest action before touching a provider", async () => {
    const t = newBackend();
    const owner = await seedUser(t, "owner@example.com");
    const stranger = await seedUser(t, "stranger@example.com");
    const botId = await seedBot(t, owner);

    // No session: refused before any market-data work.
    await expect(
      t.action(api.arise.backtest.runTest, { botId, symbol: "BTCUSDT", interval: "1h" }),
    ).rejects.toThrow(/Not authenticated/);

    // Wrong owner: reported as "not found" (no existence oracle for other users' bots).
    await expect(
      t
        .withIdentity({ subject: stranger })
        .action(api.arise.backtest.runTest, { botId, symbol: "BTCUSDT", interval: "1h" }),
    ).rejects.toThrow(/Bot not found/);
  });
});

describe("plan seeding is an operator action", () => {
  it("declares plan seeding internal, not public", () => {
    // Same distinction as the bot lookup above: the flag on the declaration is the
    // evidence, not the shape of the generated `api` object. Confirmed against the
    // deployment spec with `bunx convex function-spec`
    // (arise/billingFunctions.js:seedPlans -> internal).
    const seedPlans = billingFunctionsModule.seedPlans as unknown as {
      isInternal?: boolean;
      isPublic?: boolean;
    };
    expect(seedPlans.isInternal).toBe(true);
    expect(seedPlans.isPublic).toBeUndefined();
    expect(typeof internal.arise.billingFunctions.seedPlans).toBe("object");
  });

  it("is idempotent when run repeatedly", async () => {
    const t = newBackend();
    await t.mutation(internal.arise.billingFunctions.seedPlans, {});
    await t.mutation(internal.arise.billingFunctions.seedPlans, {});

    const rows = await t.run(async (ctx) => ctx.db.query("plans").collect());
    expect(rows).toHaveLength(PLANS.length);
    expect(new Set(rows.map((r) => r.key)).size).toBe(PLANS.length);
    expect(rows.map((r) => r.key).sort()).toEqual([...PLAN_MAP.keys()].sort());
  });
});

describe("admin aggregates are gated and honest about their bounds", () => {
  it("refuses non-admins and reports an untruncated scan for small data", async () => {
    const t = newBackend();
    const user = await seedUser(t, "user@example.com", "user");
    const admin = await seedUser(t, "admin@example.com", "admin");

    await expect(t.query(api.arise.billingFunctions.adminStats, {})).rejects.toThrow(
      /Not authenticated/,
    );
    await expect(
      t.withIdentity({ subject: user }).query(api.arise.billingFunctions.adminStats, {}),
    ).rejects.toThrow(/admin only/);

    const stats = await t.withIdentity({ subject: admin }).query(api.arise.billingFunctions.adminStats, {});
    expect(stats.totalUsers).toBe(2);
    // Bounded scan that did not hit its cap must say so rather than imply completeness.
    expect(stats.truncated).toBe(false);
  });
});

describe("stripe events are never silently lost", () => {
  it("keeps failed events visible to an operator with their state", async () => {
    const t = newBackend();
    await t.mutation(internal.arise.billingFunctions.internalClaimEvent, {
      stripeEventId: "evt_visible",
      type: "customer.subscription.updated",
      receivedAt: 1,
    });
    await t.mutation(internal.arise.billingFunctions.internalMarkEventFailed, {
      stripeEventId: "evt_visible",
      error: "boom",
      at: 2,
    });

    const row = await t.query(internal.arise.billingFunctions.internalGetEvent, {
      stripeEventId: "evt_visible",
    });
    expect(row).toMatchObject({ status: "FAILED", processed: false, error: "boom" });
  });
});
