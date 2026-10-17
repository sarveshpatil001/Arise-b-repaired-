// ARISE V1 — ACCOUNT / ADMIN AUTHORIZATION regression tests (PRD Step 4).
// These run the REAL Convex functions against an in-memory backend, so they
// exercise server-side guards rather than UI routing:
//   - unauthenticated callers cannot read or write another user's data,
//   - cross-user access is denied by the handlers, not by hidden buttons,
//   - admin-only operations require the admin role on the server,
//   - the first-admin bootstrap can be claimed exactly once, even concurrently,
//   - the authenticated market-data action validates every input before it
//     reaches a provider.
// No live market data, no network, no real orders.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "@/convex/schema";
import { api, internal } from "@/convex/_generated/api";
import { MAX_CANDLES } from "@/convex/arise/charts";
import { NEWS_REQUESTS_PER_MINUTE } from "@/convex/arise/news";

// The glob must include src/convex/_generated — convex-test derives the module
// root from it. (Test files live outside src/convex so the Convex bundler never
// picks them up.)
const modules = import.meta.glob("../../convex/**/*.ts");

type TestConvex = ReturnType<typeof convexTest>;

function newBackend() {
  return convexTest(schema, modules);
}

async function seedUser(
  t: TestConvex,
  opts: { email: string; role?: "admin" | "user"; disabled?: boolean } = { email: "u@example.com" },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      email: opts.email,
      role: opts.role,
      disabled: opts.disabled,
    }),
  );
}

afterEach(() => {
  delete process.env.ARISE_ADMIN_CODE;
});

describe("unauthenticated access", () => {
  it("cannot create or mutate an account", async () => {
    const t = newBackend();
    await expect(t.mutation(api.arise.trading.createAccount, {})).rejects.toThrow(/Not authenticated/);
    await expect(t.mutation(api.arise.trading.setEmergencyStop, { active: true })).rejects.toThrow(
      /Not authenticated/,
    );
    await expect(t.mutation(api.arise.trading.resetAccount, {})).rejects.toThrow(/Not authenticated/);
  });

  it("cannot read the platform event log", async () => {
    const t = newBackend();
    await expect(t.query(api.arise.system.list, { limit: 5 })).rejects.toThrow(/Not authenticated/);
  });

  it("cannot read monitor status", async () => {
    const t = newBackend();
    await expect(t.query(api.arise.monitor.adminStatus, {})).rejects.toThrow(/Not authenticated/);
    await expect(t.query(api.arise.monitor.publicStatus, {})).rejects.toThrow(/Not authenticated/);
  });

  it("cannot call the market-data proxy", async () => {
    const t = newBackend();
    await expect(t.action(api.arise.charts.candles, { symbol: "BTCUSDT", interval: "1h" })).rejects.toThrow(
      /Not authenticated/,
    );
  });

  it("gets empty (not shared) user-scoped reads", async () => {
    const t = newBackend();
    const userId = await seedUser(t);
    const owner = t.withIdentity({ subject: userId });
    await owner.mutation(api.arise.trading.createAccount, {});

    // Same backend, no identity: must not observe the seeded account.
    await expect(t.query(api.arise.trading.myAccount, {})).resolves.toBeNull();
    await expect(t.query(api.arise.trading.openPositions, {})).resolves.toEqual([]);
    await expect(t.query(api.arise.decisions.list, { limit: 10 })).resolves.toEqual([]);
  });
});

describe("cross-user isolation", () => {
  it("does not expose another user's paper account", async () => {
    const t = newBackend();
    const userA = await seedUser(t, { email: "a@example.com" });
    const userB = await seedUser(t, { email: "b@example.com" });
    await t.withIdentity({ subject: userA }).mutation(api.arise.trading.createAccount, {});

    const asA = await t.withIdentity({ subject: userA }).query(api.arise.trading.myAccount, {});
    const asB = await t.withIdentity({ subject: userB }).query(api.arise.trading.myAccount, {});
    expect(asA).not.toBeNull();
    expect(asB).toBeNull();
  });

  it("refuses a close request for another user's position", async () => {
    const t = newBackend();
    const userA = await seedUser(t, { email: "a@example.com" });
    const userB = await seedUser(t, { email: "b@example.com" });
    await t.withIdentity({ subject: userA }).mutation(api.arise.trading.createAccount, {});

    const positionId = await t.run(async (ctx) => {
      const decisionId = await ctx.db.insert("decisions", {
        userId: userA,
        symbol: "BTCUSDT",
        interval: "1h",
        mode: "paper" as const,
        status: "TRADE",
        direction: "LONG",
        confidence: 60,
        regime: "TREND",
        thesis: "seed",
        recommendedAction: "ENTER_LONG",
        dataQuality: "valid",
        dataAgeSec: 1,
        dataSource: "test",
        dataTimestamp: Date.now(),
        mind: {},
        agents: {},
      });
      return await ctx.db.insert("positions", {
        userId: userA,
        decisionId,
        symbol: "BTCUSDT",
        side: "LONG",
        qty: 1,
        entryPrice: 100,
        stopLoss: 95,
        takeProfit: 110,
        entryFee: 0.04,
        status: "OPEN",
        openedAt: Date.now(),
      });
    });

    await expect(
      t
        .withIdentity({ subject: userB })
        .action(api.arise.trading.closePosition, { positionId }),
    ).rejects.toThrow(/Not found/);

    // A's position is untouched and B owns nothing.
    const stillOpen = await t.withIdentity({ subject: userA }).query(api.arise.trading.openPositions, {});
    expect(stillOpen).toHaveLength(1);
  });

  it("does not reveal another user's decision by id", async () => {
    const t = newBackend();
    const userA = await seedUser(t, { email: "a@example.com" });
    const userB = await seedUser(t, { email: "b@example.com" });
    const decisionId = await t.run(async (ctx) =>
      ctx.db.insert("decisions", {
        userId: userA,
        symbol: "BTCUSDT",
        interval: "1h",
        mode: "paper" as const,
        status: "TRADE",
        direction: "LONG",
        confidence: 60,
        regime: "TREND",
        thesis: "seed",
        recommendedAction: "ENTER_LONG",
        dataQuality: "valid",
        dataAgeSec: 1,
        dataSource: "test",
        dataTimestamp: Date.now(),
        mind: {},
        agents: {},
      }),
    );

    await expect(
      t.withIdentity({ subject: userB }).query(api.arise.decisions.byId, { id: decisionId }),
    ).resolves.toBeNull();
    await expect(
      t.withIdentity({ subject: userA }).query(api.arise.decisions.byId, { id: decisionId }),
    ).resolves.not.toBeNull();
  });

  it("hides execution + billing detail from non-admins but keeps the audit trail", async () => {
    const t = newBackend();
    const user = await seedUser(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("systemEvents", {
        level: "INFO", area: "EXECUTION", code: "MONITOR_EXIT_STOP_LOSS",
        message: "position=secret symbol=BTCUSDT qty=3 pnl=-12.5", at: Date.now(),
      });
      await ctx.db.insert("systemEvents", {
        level: "WARN", area: "DATA", code: "PROVIDER_FAILURE",
        message: "BTCUSDT: provider timeout", at: Date.now(),
      });
    });

    const asUser = await t.withIdentity({ subject: user }).query(api.arise.system.list, { limit: 10 });
    const exec = asUser.find((e) => e.area === "EXECUTION");
    const data = asUser.find((e) => e.area === "DATA");
    expect(exec?.message).not.toContain("pnl=-12.5");
    expect(data?.message).toContain("provider timeout");
  });
});

describe("admin authorization + first-admin bootstrap", () => {
  it("refuses admin-only reads for non-admins", async () => {
    const t = newBackend();
    const user = await seedUser(t);
    await expect(
      t.withIdentity({ subject: user }).query(api.arise.billingFunctions.adminUsers, {}),
    ).rejects.toThrow(/Forbidden: admin only/);
  });

  it("allows admin-only reads for admins", async () => {
    const t = newBackend();
    const admin = await seedUser(t, { email: "root@example.com", role: "admin" });
    await expect(
      t.withIdentity({ subject: admin }).query(api.arise.billingFunctions.adminUsers, {}),
    ).resolves.toBeInstanceOf(Array);
  });

  it("fails closed when no bootstrap code is configured", async () => {
    const t = newBackend();
    const user = await seedUser(t);
    await expect(
      t.withIdentity({ subject: user }).mutation(api.arise.billingFunctions.bootstrapAdmin, { code: "x" }),
    ).rejects.toThrow(/ARISE_ADMIN_CODE/);
  });

  it("rejects a wrong bootstrap code", async () => {
    process.env.ARISE_ADMIN_CODE = "correct-code";
    const t = newBackend();
    const user = await seedUser(t);
    await expect(
      t.withIdentity({ subject: user }).mutation(api.arise.billingFunctions.bootstrapAdmin, { code: "nope" }),
    ).rejects.toThrow(/Invalid setup code/);
  });

  it("can be claimed exactly once, and not reused after initialization", async () => {
    process.env.ARISE_ADMIN_CODE = "correct-code";
    const t = newBackend();
    const first = await seedUser(t, { email: "first@example.com" });
    const second = await seedUser(t, { email: "second@example.com" });

    await t.withIdentity({ subject: first }).mutation(api.arise.billingFunctions.bootstrapAdmin, {
      code: "correct-code",
    });
    // A second claim is refused by the one-time closure marker. (The message is asserted
    // exactly because the refusal now comes from bootstrap being permanently closed
    // rather than merely from an admin existing — see the replay test below.)
    await expect(
      t.withIdentity({ subject: second }).mutation(api.arise.billingFunctions.bootstrapAdmin, {
        code: "correct-code",
      }),
    ).rejects.toThrow(/bootstrap is already closed/i);

    const admins = await t.run(async (ctx) => {
      const rows = await ctx.db.query("users").collect();
      return rows.filter((u) => u.role === "admin");
    });
    expect(admins).toHaveLength(1);
    expect(admins[0].email).toBe("first@example.com");

    // The closure is persisted, not inferred from the absence of a request.
    const marked = await t.run(async (ctx) => ctx.db.query("bootstrapState").collect());
    expect(marked).toHaveLength(1);
    expect(marked[0].completedBy).toBe(first);
  });

  it("cannot be re-opened by deleting every administrator and replaying the code", async () => {
    process.env.ARISE_ADMIN_CODE = "correct-code";
    const t = newBackend();
    const first = await seedUser(t, { email: "first@example.com" });
    const attacker = await seedUser(t, { email: "later@example.com" });

    await t
      .withIdentity({ subject: first })
      .mutation(api.arise.billingFunctions.bootstrapAdmin, { code: "correct-code" });

    // Remove every administrator: a naive "is there an admin?" check would re-open here.
    await t.run(async (ctx) => {
      for (const u of await ctx.db.query("users").collect()) {
        if (u.role === "admin") await ctx.db.patch(u._id, { role: undefined });
      }
    });

    await expect(
      t
        .withIdentity({ subject: attacker })
        .mutation(api.arise.billingFunctions.bootstrapAdmin, { code: "correct-code" }),
    ).rejects.toThrow(/bootstrap is already closed/i);

    const admins = await t.run(async (ctx) =>
      (await ctx.db.query("users").collect()).filter((u) => u.role === "admin"),
    );
    expect(admins).toHaveLength(0); // still nobody: the grant never happened
  });

  it("cannot be claimed by competing concurrent requests", async () => {
    process.env.ARISE_ADMIN_CODE = "correct-code";
    const t = newBackend();
    const a = await seedUser(t, { email: "a@example.com" });
    const b = await seedUser(t, { email: "b@example.com" });

    const results = await Promise.allSettled([
      t.withIdentity({ subject: a }).mutation(api.arise.billingFunctions.bootstrapAdmin, { code: "correct-code" }),
      t.withIdentity({ subject: b }).mutation(api.arise.billingFunctions.bootstrapAdmin, { code: "correct-code" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const admins = await t.run(async (ctx) => {
      const rows = await ctx.db.query("users").collect();
      return rows.filter((u) => u.role === "admin");
    });
    expect(admins).toHaveLength(1);
  });
});

describe("market-data proxy input validation", () => {
  it("rejects an unsupported interval before contacting a provider", async () => {
    const t = newBackend();
    const user = await seedUser(t);
    await expect(
      t.withIdentity({ subject: user }).action(api.arise.charts.candles, {
        symbol: "BTCUSDT",
        interval: "3s",
      }),
    ).rejects.toThrow(/unsupported interval/);
  });

  it("rejects an unsupported symbol", async () => {
    const t = newBackend();
    const user = await seedUser(t);
    await expect(
      t.withIdentity({ subject: user }).action(api.arise.charts.candles, {
        symbol: "DOGEUSDT",
        interval: "1h",
      }),
    ).rejects.toThrow(/unsupported symbol/);
  });

  it("rejects a non-positive or non-finite limit", async () => {
    const t = newBackend();
    const user = await seedUser(t);
    for (const limit of [0, -5, Number.NaN]) {
      await expect(
        t.withIdentity({ subject: user }).action(api.arise.charts.candles, {
          symbol: "BTCUSDT",
          interval: "1h",
          limit,
        }),
      ).rejects.toThrow(/limit must be a positive number/);
    }
  });

  it("rejects a fractional limit or a limit above the cap before contacting a provider", async () => {
    const t = newBackend();
    const user = await seedUser(t);
    for (const limit of [1.5, MAX_CANDLES + 1]) {
      await expect(
        t.withIdentity({ subject: user }).action(api.arise.charts.candles, {
          symbol: "BTCUSDT",
          interval: "1h",
          limit,
        }),
      ).rejects.toThrow(
        `limit must be a positive number (an integer between 1 and ${MAX_CANDLES})`,
      );
    }
  });
});

// Regression for the audited authorization gap: the legacy billing/admin
// endpoints checked `role === "admin"` but never `disabled`, so an administrator
// whose account had been disabled could still run platform-wide operations.
describe("disabled-account enforcement", () => {
  it("rejects a disabled administrator on every legacy admin endpoint", async () => {
    const t = newBackend();
    const admin = await seedUser(t, { email: "root@example.com", role: "admin", disabled: true });
    const target = await seedUser(t, { email: "target@example.com" });
    const as = t.withIdentity({ subject: admin });

    await expect(as.mutation(api.arise.billingFunctions.broadcast, { message: "hi" })).rejects.toThrow(
      /ACCOUNT_DISABLED/,
    );
    await expect(as.query(api.arise.billingFunctions.adminStats, {})).rejects.toThrow(/ACCOUNT_DISABLED/);
    await expect(as.query(api.arise.billingFunctions.adminUsers, {})).rejects.toThrow(/ACCOUNT_DISABLED/);
    await expect(
      as.mutation(api.arise.billingFunctions.setUserRole, { targetUserId: target, role: "admin" }),
    ).rejects.toThrow(/ACCOUNT_DISABLED/);
    await expect(
      as.mutation(api.arise.billingFunctions.grantPlan, { targetUserId: target, planKey: "pro" }),
    ).rejects.toThrow(/ACCOUNT_DISABLED/);
  });

  it("leaves the target untouched after a disabled admin's attempt", async () => {
    const t = newBackend();
    const admin = await seedUser(t, { email: "root@example.com", role: "admin", disabled: true });
    const target = await seedUser(t, { email: "target@example.com" });
    await expect(
      t
        .withIdentity({ subject: admin })
        .mutation(api.arise.billingFunctions.setUserRole, { targetUserId: target, role: "admin" }),
    ).rejects.toThrow(/ACCOUNT_DISABLED/);

    const row = await t.run(async (ctx) => ctx.db.get(target));
    expect(row?.role).not.toBe("admin");
  });

  it("rejects a disabled user's account mutations", async () => {
    const t = newBackend();
    const user = await seedUser(t, { email: "user@example.com", disabled: true });
    const as = t.withIdentity({ subject: user });

    await expect(as.mutation(api.arise.trading.createAccount, {})).rejects.toThrow(/ACCOUNT_DISABLED/);
    await expect(as.mutation(api.arise.trading.setEmergencyStop, { active: true })).rejects.toThrow(
      /ACCOUNT_DISABLED/,
    );
    await expect(as.mutation(api.arise.trading.resetAccount, {})).rejects.toThrow(/ACCOUNT_DISABLED/);
  });

  it("rejects a disabled user's manual close before any provider call", async () => {
    const t = newBackend();
    const user = await seedUser(t, { email: "user@example.com", disabled: true });
    const position = await t.run(async (ctx) => {
      const decisionId = await ctx.db.insert("decisions", {
        userId: user,
        symbol: "BTCUSDT",
        interval: "15m",
        status: "WAIT",
        dataTimestamp: Date.now(),
        snapshotMeta: {},
        createdAt: Date.now(),
      } as never);
      return await ctx.db.insert("positions", {
        userId: user,
        decisionId,
        symbol: "BTCUSDT",
        side: "LONG",
        qty: 1,
        entryPrice: 100,
        stopLoss: 95,
        takeProfit: 110,
        entryFee: 0.04,
        status: "OPEN",
        openedAt: Date.now(),
      });
    });

    await expect(
      t.withIdentity({ subject: user }).action(api.arise.trading.closePosition, { positionId: position }),
    ).rejects.toThrow(/ACCOUNT_DISABLED/);

    const stillOpen = await t.run(async (ctx) => ctx.db.get(position));
    expect(stillOpen?.status).toBe("OPEN");
  });

  it("rejects a disabled account on every user-scoped read", async () => {
    const t = newBackend();
    const user = await seedUser(t, { email: "disabled@example.com", disabled: true });
    const seeded = await t.run(async (ctx) => {
      await ctx.db.insert("paperAccounts", {
        userId: user,
        balance: 10_000,
        equityHighWaterMark: 10_000,
        dayStartEquity: 10_000,
        dayKey: "2026-10-17",
        emergencyStop: false,
        startingBalance: 10_000,
      });
      await ctx.db.insert("equityPoints", {
        userId: user,
        t: Date.now(),
        equity: 10_000,
        cash: 10_000,
        drawdownPct: 0,
      });
      const decisionId = await ctx.db.insert("decisions", {
        userId: user,
        symbol: "BTCUSDT",
        interval: "1h",
        mode: "paper" as const,
        status: "WAIT",
        direction: "FLAT",
        confidence: 0,
        regime: "RANGE",
        thesis: "seed",
        recommendedAction: "WAIT",
        dataQuality: "valid",
        dataAgeSec: 1,
        dataSource: "test",
        dataTimestamp: Date.now(),
        mind: {},
        agents: {},
        snapshotMeta: { lastClose: 100, lastBarTime: Date.now() },
      });
      await ctx.db.insert("positions", {
        userId: user,
        decisionId,
        symbol: "BTCUSDT",
        side: "LONG",
        qty: 1,
        entryPrice: 100,
        stopLoss: 95,
        takeProfit: 110,
        entryFee: 0.04,
        status: "OPEN",
        openedAt: Date.now(),
      });
      const botId = await ctx.db.insert("bots", {
        userId: user,
        name: "bot",
        strategyId: "buy-hold",
        createdAt: Date.now(),
      });
      const runId = await ctx.db.insert("backtestRuns", {
        userId: user,
        botId,
        botName: "bot",
        strategyId: "buy-hold",
        symbol: "BTCUSDT",
        interval: "1h",
        dataKind: "REAL",
        dataSource: "binance",
        barCount: 400,
        seed: 42,
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
      });
      await ctx.db.insert("subscriptions", {
        userId: user,
        stripeCustomerId: "cus_seed",
        planKey: "pro",
        status: "active",
        cancelAtPeriodEnd: false,
        updatedAt: Date.now(),
      });
      return { decisionId, botId, runId };
    });
    const as = t.withIdentity({ subject: user });

    for (const call of [
      () => as.query(api.arise.trading.myAccount, {}),
      () => as.query(api.arise.trading.openPositions, {}),
      () => as.query(api.arise.trading.closedPositions, {}),
      () => as.query(api.arise.trading.latestMarks, {}),
      () => as.query(api.arise.decisions.list, {}),
      () => as.query(api.arise.decisions.byId, { id: seeded.decisionId }),
      () => as.query(api.arise.decisions.latest, {}),
      () => as.query(api.arise.equity.list, {}),
      () => as.query(api.arise.backtest.list, {}),
      () => as.query(api.arise.backtest.runs, {}),
      () => as.query(api.arise.backtest.get, { runId: seeded.runId }),
      () => as.query(api.arise.billingFunctions.mySubscription, {}),
      () => as.query(api.arise.billingFunctions.myEntitlements, {}),
      () => as.query(api.arise.system.list, { limit: 5 }),
    ]) {
      await expect(call()).rejects.toThrow(/ACCOUNT_DISABLED/);
    }
  });

  it("still allows an active administrator", async () => {
    const t = newBackend();
    const admin = await seedUser(t, { email: "root@example.com", role: "admin" });
    await expect(
      t.withIdentity({ subject: admin }).mutation(api.arise.billingFunctions.broadcast, { message: "ok" }),
    ).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Full-surface authorization inventory (post-repair independent review).
//
// Each case pins an endpoint that was NOT covered by the five legacy admin
// checks: backtest admin reads, provider-proxying actions, the Delta demo
// account read, and the duplicate legacy role/plan mutations.
// ---------------------------------------------------------------------------
describe("expanded endpoint authorization", () => {
  it("refuses an unauthenticated caller on backtest admin reads", async () => {
    const t = newBackend();
    await expect(t.query(api.arise.backtest.adminRuns, { limit: 5 })).rejects.toThrow(/Not authenticated/);
  });

  it("refuses backtest admin reads to a non-admin and to a disabled admin", async () => {
    const t = newBackend();
    const user = await seedUser(t);
    const disabledAdmin = await seedUser(t, {
      email: "root@example.com",
      role: "admin",
      disabled: true,
    });

    await expect(
      t.withIdentity({ subject: user }).query(api.arise.backtest.adminRuns, { limit: 5 }),
    ).rejects.toThrow(/Forbidden: admin only/);
    await expect(
      t.withIdentity({ subject: disabledAdmin }).query(api.arise.backtest.adminRuns, { limit: 5 }),
    ).rejects.toThrow(/ACCOUNT_DISABLED/);
  });

  it("allows an active admin to read backtest runs", async () => {
    const t = newBackend();
    const admin = await seedUser(t, { email: "root@example.com", role: "admin" });
    await expect(
      t.withIdentity({ subject: admin }).query(api.arise.backtest.adminRuns, { limit: 5 }),
    ).resolves.toBeInstanceOf(Array);
  });

  it("refuses bot creation for a disabled account", async () => {
    const t = newBackend();
    const user = await seedUser(t, { email: "u@example.com", disabled: true });
    await expect(
      t.withIdentity({ subject: user }).mutation(api.arise.backtest.create, {
        name: "my bot",
        strategyId: "buy-hold",
      }),
    ).rejects.toThrow(/ACCOUNT_DISABLED/);
  });

  it("refuses provider-proxying actions for a disabled account", async () => {
    const t = newBackend();
    const user = await seedUser(t, { email: "u@example.com", disabled: true });
    const as = t.withIdentity({ subject: user });

    // These guards run before any provider/Delta request, so no network is touched.
    await expect(
      as.action(api.arise.charts.candles, { symbol: "BTCUSDT", interval: "1h" }),
    ).rejects.toThrow(/ACCOUNT_DISABLED/);
    await expect(as.action(api.arise.news.assess, { symbol: "BTCUSDT" })).rejects.toThrow(
      /ACCOUNT_DISABLED/,
    );
    await expect(as.action(api.arise.delta.accountSnapshot, {})).rejects.toThrow(/ACCOUNT_DISABLED/);
  });

  it("audits legacy role and plan changes instead of writing them invisibly", async () => {
    const t = newBackend();
    const admin = await seedUser(t, { email: "root@example.com", role: "admin" });
    const target = await seedUser(t, { email: "target@example.com" });

    await t
      .withIdentity({ subject: admin })
      .mutation(api.arise.billingFunctions.setUserRole, { targetUserId: target, role: "admin" });
    await t
      .withIdentity({ subject: admin })
      .mutation(api.arise.billingFunctions.grantPlan, { targetUserId: target, planKey: "pro" });

    const audit = await t.run(async (ctx) => ctx.db.query("adminAudit").collect());
    expect(audit.map((a) => a.action).join(" | ")).toMatch(/Role changed/);
    expect(audit.map((a) => a.action).join(" | ")).toMatch(/Plan pro granted/);
    expect(audit.every((a) => a.actorId === admin && a.result === "SUCCESS")).toBe(true);
  });

  it("refuses a legacy role/plan change for a target that does not exist", async () => {
    const t = newBackend();
    const admin = await seedUser(t, { email: "root@example.com", role: "admin" });
    const other = await seedUser(t, { email: "other@example.com" });
    await t.run(async (ctx) => ctx.db.delete(other));

    await expect(
      t
        .withIdentity({ subject: admin })
        .mutation(api.arise.billingFunctions.setUserRole, { targetUserId: other, role: "admin" }),
    ).rejects.toThrow(/User not found/);
    await expect(
      t
        .withIdentity({ subject: admin })
        .mutation(api.arise.billingFunctions.grantPlan, { targetUserId: other, planKey: "pro" }),
    ).rejects.toThrow(/User not found/);
  });
});

// Regressions for the remaining audit findings: the shared Delta demo account is
// not a per-user resource, the full monitor payload is operational data, news
// proxying is metered before any publisher request, and backtests require a live
// (not deleted, not disabled) account.
describe("remaining isolation and quota boundaries", () => {
  it("restricts the shared Delta demo snapshot to active administrators", async () => {
    const t = newBackend();
    const user = await seedUser(t);
    const disabledAdmin = await seedUser(t, { email: "root@example.com", role: "admin", disabled: true });

    await expect(
      t.withIdentity({ subject: user }).action(api.arise.delta.accountSnapshot, {}),
    ).rejects.toThrow(/Forbidden: admin only/);
    await expect(
      t.withIdentity({ subject: disabledAdmin }).action(api.arise.delta.accountSnapshot, {}),
    ).rejects.toThrow(/ACCOUNT_DISABLED/);

    // An active administrator passes the authorization gate. Demo mode is then
    // required and fails closed here, before any provider request is attempted.
    const admin = await seedUser(t, { email: "active-root@example.com", role: "admin" });
    const previous = process.env.DELTA_TRADING_MODE;
    delete process.env.DELTA_TRADING_MODE;
    try {
      await expect(
        t.withIdentity({ subject: admin }).action(api.arise.delta.accountSnapshot, {}),
      ).rejects.toThrow(/DELTA_TRADING_MODE/);
    } finally {
      if (previous !== undefined) process.env.DELTA_TRADING_MODE = previous;
    }
  });

  it("keeps the full monitor payload admin-only and gives users a minimal view", async () => {
    const t = newBackend();
    const user = await seedUser(t);
    const admin = await seedUser(t, { email: "root@example.com", role: "admin" });

    await expect(
      t.withIdentity({ subject: user }).query(api.arise.monitor.adminStatus, {}),
    ).rejects.toThrow(/Forbidden: admin only/);

    const publicView = await t.withIdentity({ subject: user }).query(api.arise.monitor.publicStatus, {});
    expect(publicView.state).toBeTypeOf("string");
    expect(publicView).not.toHaveProperty("recentTicks");
    expect(publicView.openPositions).toBeNull();

    const adminView = await t.withIdentity({ subject: admin }).query(api.arise.monitor.adminStatus, {});
    expect(adminView).toHaveProperty("recentTicks");
    expect(adminView.openPositions).toBeTypeOf("number");
  });

  it("consumes the news quota atomically and blocks the provider once exhausted", async () => {
    const t = newBackend();
    const user = await seedUser(t);
    const now = Date.now();

    const results = await Promise.all(
      Array.from({ length: NEWS_REQUESTS_PER_MINUTE + 2 }, () =>
        t.mutation(internal.arise.news.consumeNewsQuota, { userId: user, now }),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(NEWS_REQUESTS_PER_MINUTE);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await expect(
        t.withIdentity({ subject: user }).action(api.arise.news.assess, { symbol: "BTCUSDT" }),
      ).rejects.toThrow(/RATE_LIMITED/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("requires an existing, active account before a backtest can run", async () => {
    const t = newBackend();
    const disabled = await seedUser(t, { email: "disabled@example.com", disabled: true });
    const deleted = await seedUser(t, { email: "deleted@example.com" });
    const owner = await seedUser(t, { email: "owner@example.com" });
    const botId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("bots", {
        userId: owner,
        name: "owner bot",
        strategyId: "buy-hold",
        createdAt: Date.now(),
      });
      await ctx.db.delete(deleted);
      return id;
    });

    const run = (subject: string) =>
      t.withIdentity({ subject }).action(api.arise.backtest.runTest, {
        botId,
        symbol: "BTCUSDT",
        interval: "1h",
      });

    await expect(run("ghost")).rejects.toThrow(/Not authenticated/);
    await expect(run(deleted)).rejects.toThrow(/Not authenticated/);
    await expect(run(disabled)).rejects.toThrow(/ACCOUNT_DISABLED/);
  });
});

// Regression for the concurrent-quota bypass: the action used to read the remaining
// count, do its work, then increment. Concurrent requests all observed the same count
// and could exceed the daily plan limit. The reservation is now one serialized mutation.
describe("atomic analysis quota", () => {
  it("allows exactly the plan limit across concurrent reservations", async () => {
    const t = newBackend();
    const user = await seedUser(t);
    const as = t.withIdentity({ subject: user });

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        as.mutation(internal.arise.billingFunctions.reserveAnalysisInternal, {}),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toMatch(/PLAN_LIMIT_REACHED/);

    const usage = await t.run(async (ctx) =>
      (await ctx.db.query("analysisUsage").collect())[0],
    );
    expect(usage?.count).toBe(5);
  });

  it("refuses to reserve for a disabled account", async () => {
    const t = newBackend();
    const user = await seedUser(t, { email: "disabled@example.com", disabled: true });
    await expect(
      t
        .withIdentity({ subject: user })
        .mutation(internal.arise.billingFunctions.reserveAnalysisInternal, {}),
    ).rejects.toThrow(/ACCOUNT_DISABLED/);
  });
});

describe("role and plan administration hardening", () => {
  it("refuses to demote the last active administrator", async () => {
    const t = newBackend();
    const only = await seedUser(t, { email: "root@example.com", role: "admin" });

    await expect(
      t
        .withIdentity({ subject: only })
        .mutation(api.arise.admin.setUserRole, { targetUserId: only, role: "user" }),
    ).rejects.toThrow(/LAST_ADMIN/);
    // The legacy billing endpoint applies the same rule.
    await expect(
      t
        .withIdentity({ subject: only })
        .mutation(api.arise.billingFunctions.setUserRole, { targetUserId: only, role: "user" }),
    ).rejects.toThrow(/LAST_ADMIN/);

    const row = await t.run(async (ctx) => ctx.db.get(only));
    expect(row?.role).toBe("admin");
  });

  it("allows a demotion when another active administrator remains", async () => {
    const t = newBackend();
    const first = await seedUser(t, { email: "first@example.com", role: "admin" });
    const second = await seedUser(t, { email: "second@example.com", role: "admin" });

    await expect(
      t
        .withIdentity({ subject: first })
        .mutation(api.arise.admin.setUserRole, { targetUserId: second, role: "user" }),
    ).resolves.toBe(true);
  });

  it("refuses to grant a plan key outside the server-side plan list", async () => {
    const t = newBackend();
    const admin = await seedUser(t, { email: "root@example.com", role: "admin" });
    const target = await seedUser(t, { email: "target@example.com" });

    await expect(
      t
        .withIdentity({ subject: admin })
        .mutation(api.arise.admin.grantPlan, { targetUserId: target, planKey: "platinum" }),
    ).rejects.toThrow(/Unknown plan/);
    const subs = await t.run(async (ctx) => ctx.db.query("subscriptions").collect());
    expect(subs).toHaveLength(0);
  });
});

describe("decision action identity", () => {
  it("refuses a disabled account before fetching data or touching an account", async () => {
    const t = newBackend();
    const user = await seedUser(t, { email: "u@example.com", disabled: true });
    await expect(
      t
        .withIdentity({ subject: user })
        .action(api.arise.market.decide, { symbol: "BTCUSDT", interval: "1h", execute: false }),
    ).rejects.toThrow(/ACCOUNT_DISABLED/);
  });

  it("refuses an identity with no user row", async () => {
    const t = newBackend();
    await expect(
      t
        .withIdentity({ subject: "ghost" })
        .action(api.arise.market.decide, { symbol: "BTCUSDT", interval: "1h", execute: false }),
    ).rejects.toThrow(/Not authenticated/);
  });
});

describe("bootstrap privilege grant", () => {
  it("rejects a disabled account even with the correct deployment code", async () => {
    process.env.ARISE_ADMIN_CODE = "correct-code";
    const t = newBackend();
    const user = await seedUser(t, { email: "u@example.com", disabled: true });
    await expect(
      t
        .withIdentity({ subject: user })
        .mutation(api.arise.billingFunctions.bootstrapAdmin, { code: "correct-code" }),
    ).rejects.toThrow(/ACCOUNT_DISABLED/);

    const row = await t.run(async (ctx) => ctx.db.get(user));
    expect(row?.role).not.toBe("admin");
  });
});
