// ARISE V1 — PAPER EXECUTION + MONITOR COVERAGE regression tests (PRD Step 6).
// Runs the real Convex functions in an in-memory backend:
//   - duplicate/concurrent executions cannot open a second position or debit a
//     second fee (durable idempotency, not the broker's per-instance Set),
//   - a manual close must be priced from a real fresh 5m bar and can only be
//     applied once (no duplicate exits, no corrupted balance),
//   - the monitor reaches every OPEN position, not just the first 25.
// No network, no live prices, no real orders.

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import schema from "@/convex/schema";
import { api, internal } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const modules = import.meta.glob("../../convex/**/*.ts");
const MIN = 60_000;

// The close action prices exits from the server-side provider, so the provider
// is mocked here — no live exchange, no network. `fail` simulates an outage.
const mockProvider = vi.hoisted(() => ({
  klines: [] as unknown[][],
  fail: false,
  fail5m: false,
  deltaFallback: false,
}));

vi.mock("axios", () => ({
  default: {
    get: async (url: string, config?: { params?: { interval?: string } }) => {
      if (mockProvider.fail) throw new Error("provider unreachable");
      if (String(url).includes("/api/v3/klines")) {
        // Simulates a provider that cannot serve 5m and silently falls back to 15m.
        if (mockProvider.fail5m && config?.params?.interval === "5m") {
          throw new Error("5m series unavailable");
        }
        return { data: mockProvider.klines };
      }
      if (String(url).includes("bookTicker")) {
        return { data: { bidPrice: "109.9", askPrice: "110.1" } };
      }
      if (mockProvider.deltaFallback && String(url).includes("/v2/history/candles")) {
        const now = Date.now();
        const rows = [now - 7 * MIN, now - 2 * MIN].map((t) => ({
          time: Math.floor(t / 1000),
          open: "100",
          high: "112",
          low: "99",
          close: "110",
          volume: "1",
        }));
        return { data: { success: true, result: rows } };
      }
      if (mockProvider.deltaFallback && String(url).includes("/v2/tickers")) {
        return { data: { success: true, result: [{ symbol: "BTCUSD", bid: "109.9", ask: "110.1" }] } };
      }
      throw new Error(`unexpected provider url ${url}`);
    },
  },
}));

function kline(time: number, close: number): unknown[] {
  // High/low derived from the close so a synthetic "favourable" close is still a
  // structurally valid OHLC bar (invalid shapes are removed and would only prove
  // the structural check, not the rule under test).
  const high = Math.max(100, close) * 1.01;
  const low = Math.min(99, close) * 0.99;
  return [time, "100", String(high), String(low), String(close), "1", time + 5 * MIN, "0"];
}

/**
 * Realistic 5m feed: one completed bar at `completedClose`/`ageMs` and the
 * currently-forming bar, which must never be used to settle a trade.
 */
function setProviderBars(close: number, ageMs = 7 * MIN) {
  const completedAt = Date.now() - ageMs;
  mockProvider.fail = false;
  mockProvider.fail5m = false;
  mockProvider.deltaFallback = false;
  mockProvider.klines = [kline(completedAt, close), kline(completedAt + 5 * MIN, close)];
}

beforeEach(() => setProviderBars(110));

type TestConvex = ReturnType<typeof convexTest>;

function newBackend() {
  return convexTest(schema, modules);
}

/** Fresh completed 15m mark — what the paper ledger requires to mark equity. */
function mark(symbol: string, price: number) {
  return { symbol, price, time: Date.now() - MIN, interval: "15m", completed: true };
}

async function seedTrader(t: TestConvex, balance = 10_000) {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email: "trader@example.com" });
    await ctx.db.insert("paperAccounts", {
      userId: id,
      balance,
      equityHighWaterMark: balance,
      dayStartEquity: balance,
      dayKey: new Date().toISOString().slice(0, 10),
      emergencyStop: false,
      startingBalance: balance,
    });
    return id;
  });
  return userId;
}

/** Decision as market.decide persists it before openPosition has run. */
function seedPendingDecision(t: TestConvex, userId: Id<"users">) {
  return t.run(async (ctx) =>
    ctx.db.insert("decisions", {
      userId,
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
      execution: { status: "PENDING_POSITION", fillPrice: 100, qty: 1, fee: 0.04 },
    }),
  );
}

function seedDecision(t: TestConvex, userId: Id<"users">) {
  return t.run(async (ctx) =>
    ctx.db.insert("decisions", {
      userId,
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
}

/** Opens a paper position through the real internal mutation. */
async function open(
  t: TestConvex,
  userId: Id<"users">,
  decisionId: Id<"decisions">,
  idemKey?: string,
) {
  return await t.mutation(internal.arise.trading.openPosition, {
    userId,
    decisionId,
    symbol: "BTCUSDT",
    side: "LONG",
    qty: 1,
    entryPrice: 100,
    stopLoss: 95,
    takeProfit: 110,
    entryFee: 0.04,
    maxLossQuote: 5,
    thesis: "test",
    riskDecision: "ALL_CHECKS_PASS",
    marks: [mark("BTCUSDT", 100)],
    idemKey,
  });
}

async function seedUserRow(t: TestConvex, email: string) {
  return await t.run(async (ctx) => ctx.db.insert("users", { email }));
}

async function openCount(t: TestConvex) {
  return await t.run(async (ctx) => (await ctx.db.query("positions").collect()).length);
}

async function balanceOf(t: TestConvex, userId: Id<"users">) {
  // `.filter` (not `.withIndex`) because convex-test types the raw ctx against
  // its own index map.
  const account = await t.run(async (ctx) =>
    ctx.db
      .query("paperAccounts")
      .filter((q) => q.eq(q.field("userId"), userId))
      .first(),
  );
  return account?.balance ?? null;
}

describe("durable execution idempotency", () => {
  it("opens one position for a repeated execution key", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);

    const first = await open(t, userId, decisionId, "p:u:BTCUSDT:1h:1000");
    const second = await open(t, userId, decisionId, "p:u:BTCUSDT:1h:1000");

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(await openCount(t)).toBe(1);
    // The entry fee was debited exactly once.
    expect(await balanceOf(t, userId)).toBeCloseTo(10_000 - 0.04, 6);
  });

  it("still opens a position for a different candle", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);

    await open(t, userId, decisionId, "p:u:BTCUSDT:1h:1000");
    await open(t, userId, decisionId, "p:u:BTCUSDT:1h:2000");

    expect(await openCount(t)).toBe(2);
  });

  it("does not open twice when duplicating the request", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);

    // A retry storm: five identical executions (one bar) must never stack up.
    for (let i = 0; i < 5; i++) {
      await open(t, userId, decisionId, "same-key");
    }
    expect(await openCount(t)).toBe(1);
    expect(await balanceOf(t, userId)).toBeCloseTo(10_000 - 0.04, 6);
  });

  it("rejects a duplicate even when the broker instance is new each time", async () => {
    // Regression guard for the original defect: the broker's in-memory key set is
    // rebuilt per request, so only the database can catch this.
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);
    await open(t, userId, decisionId, "durable-key");
    const before = await balanceOf(t, userId);
    await open(t, userId, decisionId, "durable-key");
    expect(await balanceOf(t, userId)).toBe(before);
  });
});

// Regression for the audited audit-integrity defect: market.decide used to record
// the decision as FILLED before openPosition ran, so a failed position creation left
// a completed-looking trade that never existed. The decision is now persisted as
// PENDING_POSITION and finalized exactly once, only after the position row exists.
describe("decision execution lifecycle", () => {
  it("finalizes PENDING_POSITION to FILLED only after the position exists", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedPendingDecision(t, userId);

    const opened = await open(t, userId, decisionId, "lifecycle-key");
    expect(opened.duplicate).toBe(false);

    const execution = { status: "FILLED", positionId: opened.positionId, fillPrice: 100, qty: 1 };
    const applied = await t.mutation(internal.arise.decisions.setExecution, {
      id: decisionId,
      userId,
      execution,
    });
    expect(applied).toBe(true);

    const decision = await t.run(async (ctx) => ctx.db.get(decisionId));
    expect((decision?.execution as { status?: string }).status).toBe("FILLED");
    expect((decision?.execution as { positionId?: string }).positionId).toBe(opened.positionId);
  });

  it("records a truthful failure when position creation fails", async () => {
    const t = newBackend();
    // No paper account: this is the real failure mode openPosition rejects on.
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { email: "no-account@example.com" }));
    const decisionId = await seedPendingDecision(t, userId);

    await expect(open(t, userId, decisionId, "failed-key")).rejects.toThrow(/Paper account unavailable/);
    expect(await openCount(t)).toBe(0);

    const execution = { status: "FAILED", reason: "POSITION_OPEN_FAILED" };
    const applied = await t.mutation(internal.arise.decisions.setExecution, {
      id: decisionId,
      userId,
      execution,
      error: "Paper account unavailable",
      status: "ERROR",
    });
    expect(applied).toBe(true);

    const decision = await t.run(async (ctx) => ctx.db.get(decisionId));
    expect(decision?.status).toBe("ERROR");
    expect((decision?.execution as { status?: string }).status).toBe("FAILED");
    expect(decision?.error).toMatch(/Paper account unavailable/);
  });

  it("cannot finalize a decision that was never PENDING_POSITION", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    // An already-completed record must never be rewritten by a late retry.
    const decisionId = await seedDecision(t, userId);

    const applied = await t.mutation(internal.arise.decisions.setExecution, {
      id: decisionId,
      userId,
      execution: { status: "FILLED", positionId: "forged" },
    });
    expect(applied).toBe(false);

    const decision = await t.run(async (ctx) => ctx.db.get(decisionId));
    expect(decision?.execution).toBeUndefined();
  });

  it("applies the PENDING_POSITION → FILLED transition exactly once under a retry", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedPendingDecision(t, userId);
    const opened = await open(t, userId, decisionId, "once-key");

    const finalize = () =>
      t.mutation(internal.arise.decisions.setExecution, {
        id: decisionId,
        userId,
        execution: { status: "FILLED", positionId: opened.positionId },
      });
    const results = await Promise.all([finalize(), finalize()]);

    expect(results.sort()).toEqual([false, true]);
    const decision = await t.run(async (ctx) => ctx.db.get(decisionId));
    expect((decision?.execution as { status?: string }).status).toBe("FILLED");
  });

  it("suppresses a concurrent duplicate execution instead of opening twice", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedPendingDecision(t, userId);

    const results = await Promise.all([
      open(t, userId, decisionId, "concurrent-key"),
      open(t, userId, decisionId, "concurrent-key"),
    ]);

    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.positionId)).size).toBe(1);
    expect(await openCount(t)).toBe(1);
    expect(await balanceOf(t, userId)).toBeCloseTo(10_000 - 0.04, 6);
  });
});

describe("manual close integrity", () => {
  // Regression for the audited vulnerability: the client used to send the exit
  // price (only a fresh-looking bar timestamp was checked), so it could invent a
  // profitable exit. The client can now name only the position; extra price
  // fields are not part of the API and cannot influence settlement.
  it("rejects the old attack payload: the client price is not part of the API", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);
    const opened = await open(t, userId, decisionId, "k1");

    // Exactly the previous exploit: a profitable price with a fresh timestamp.
    await expect(
      t.withIdentity({ subject: userId }).action(api.arise.trading.closePosition, {
        positionId: opened.positionId,
        price: 1_000_000,
        priceTime: Date.now(),
      } as never),
    ).rejects.toThrow(/Unexpected field `price`/);

    const stillOpen = await t.run(async (ctx) => ctx.db.get(opened.positionId));
    expect(stillOpen?.status).toBe("OPEN");
  });

  it("settles at the server bar close", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);
    const opened = await open(t, userId, decisionId, "k5");

    const result = await t
      .withIdentity({ subject: userId })
      .action(api.arise.trading.closePosition, { positionId: opened.positionId });
    expect(result.exitPrice).toBe(110);

    const closed = await t.run(async (ctx) => ctx.db.get(opened.positionId));
    expect(closed?.status).toBe("CLOSED");
    expect(closed?.exitPrice).toBe(110);
  });

  it("uses the newest completed bar, never the still-forming candle", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);
    const opened = await open(t, userId, decisionId, "forming");

    // The forming candle's close is wildly favourable; a completed bar is 105.
    const completedAt = Date.now() - 7 * MIN;
    mockProvider.klines = [kline(completedAt, 105), kline(completedAt + 5 * MIN, 999)];

    const result = await t
      .withIdentity({ subject: userId })
      .action(api.arise.trading.closePosition, { positionId: opened.positionId });
    expect(result.exitPrice).toBe(105);
    expect(result.barInterval).toBe("5m");
  });

  it("refuses a future-dated provider bar", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);
    const opened = await open(t, userId, decisionId, "future");

    const now = Date.now();
    mockProvider.klines = [kline(now - 2 * MIN, 110), kline(now + 3 * MIN, 1_000_000)];

    await expect(
      t
        .withIdentity({ subject: userId })
        .action(api.arise.trading.closePosition, { positionId: opened.positionId }),
    ).rejects.toThrow(/future-dated/);
    expect(await openCount(t)).toBe(1);
  });

  it("refuses an unexplained gap in the close series (degraded data)", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);
    const opened = await open(t, userId, decisionId, "gap");

    // A missing 5m candle inside an open crypto session cannot be explained by a
    // market closure, so the series is degraded and cannot price an exit.
    const now = Date.now();
    mockProvider.klines = [kline(now - 22 * MIN, 110), kline(now - 17 * MIN, 110), kline(now - 7 * MIN, 110)];

    await expect(
      t
        .withIdentity({ subject: userId })
        .action(api.arise.trading.closePosition, { positionId: opened.positionId }),
    ).rejects.toThrow(/degraded/);
    expect(await openCount(t)).toBe(1);
  });

  it("refuses a non-5m fallback series instead of relabelling it", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);
    const opened = await open(t, userId, decisionId, "fallback");

    mockProvider.fail5m = true;
    await expect(
      t
        .withIdentity({ subject: userId })
        .action(api.arise.trading.closePosition, { positionId: opened.positionId }),
    ).rejects.toThrow(/CLOSE_PRICE_UNAVAILABLE/);
    expect(await openCount(t)).toBe(1);
  });

  it("refuses to settle when only a forming candle exists", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);
    const opened = await open(t, userId, decisionId, "forming-only");

    // The single bar started two minutes ago and closes in three: not an exit price.
    mockProvider.klines = [kline(Date.now() - 2 * MIN, 110)];
    await expect(
      t
        .withIdentity({ subject: userId })
        .action(api.arise.trading.closePosition, { positionId: opened.positionId }),
    ).rejects.toThrow(/no completed 5m bar/);
    expect(await openCount(t)).toBe(1);
  });

  it("refuses to price a position whose instrument is not supported", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);
    const position = await t.run(async (ctx) =>
      ctx.db.insert("positions", {
        userId,
        decisionId,
        symbol: "DOGEUSDT", // not in the provider symbol allowlist
        side: "LONG",
        qty: 1,
        entryPrice: 100,
        stopLoss: 95,
        takeProfit: 110,
        entryFee: 0.04,
        status: "OPEN",
        openedAt: Date.now(),
      }),
    );

    await expect(
      t
        .withIdentity({ subject: userId })
        .action(api.arise.trading.closePosition, { positionId: position }),
    ).rejects.toThrow(/unsupported instrument/);

    const row = await t.run(async (ctx) => ctx.db.get(position));
    expect(row?.status).toBe("OPEN");
  });

  it("refuses a fallback provider whose instrument or price basis differs", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);
    const opened = await open(t, userId, decisionId, "delta-fallback");

    // Primary 5m series is down; Delta demo (BTCUSD perpetual) answers instead.
    mockProvider.fail5m = true;
    mockProvider.deltaFallback = true;
    await expect(
      t
        .withIdentity({ subject: userId })
        .action(api.arise.trading.closePosition, { positionId: opened.positionId }),
    ).rejects.toThrow(/primary provider unavailable/);
    expect(await openCount(t)).toBe(1);
  });

  it("cannot close another account's position", async () => {
    const t = newBackend();
    const owner = await seedTrader(t);
    const decisionId = await seedDecision(t, owner);
    const opened = await open(t, owner, decisionId, "owned");
    const intruder = await seedUserRow(t, "intruder@example.com");

    await expect(
      t
        .withIdentity({ subject: intruder })
        .action(api.arise.trading.closePosition, { positionId: opened.positionId }),
    ).rejects.toThrow(/Not found/);

    const row = await t.run(async (ctx) => ctx.db.get(opened.positionId));
    expect(row?.status).toBe("OPEN");
  });

  it("cannot be settled twice by concurrent close requests", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);
    const opened = await open(t, userId, decisionId, "race");
    const before = await balanceOf(t, userId);

    const results = await Promise.allSettled([
      t
        .withIdentity({ subject: userId })
        .action(api.arise.trading.closePosition, { positionId: opened.positionId }),
      t
        .withIdentity({ subject: userId })
        .action(api.arise.trading.closePosition, { positionId: opened.positionId }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    // LONG 100 -> 110, qty 1, exit fee 4 bps of 110 = 0.044; the entry fee (0.04)
    // was already debited when the position opened.
    expect(await balanceOf(t, userId)).toBeCloseTo((before ?? 0) + 10 - 0.044, 6);
  });

  it("re-validates the bar inside the settlement mutation (defence in depth)", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);
    const opened = await open(t, userId, decisionId, "internal-guard");
    const before = await balanceOf(t, userId);

    // Bypass the action entirely: the internal settlement must still refuse a
    // forming candle and a fabricated price.
    await expect(
      t.mutation(internal.arise.trading.settleCloseAt, {
        positionId: opened.positionId,
        userId,
        exitPrice: 1_000_000,
        priceTime: Date.now() - MIN,
        reason: "MANUAL_CLOSE",
      }),
    ).rejects.toThrow(/CLOSE_PRICE_INVALID/);

    const row = await t.run(async (ctx) => ctx.db.get(opened.positionId));
    expect(row?.status).toBe("OPEN");
    expect(await balanceOf(t, userId)).toBe(before);
  });

  it("keeps P&L, fees and balance consistent with the trade record", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);
    const opened = await open(t, userId, decisionId, "pnl");
    const before = await balanceOf(t, userId);

    await t
      .withIdentity({ subject: userId })
      .action(api.arise.trading.closePosition, { positionId: opened.positionId });

    const closed = await t.run(async (ctx) => ctx.db.get(opened.positionId));
    expect(closed?.exitFee).toBeCloseTo(0.044, 9);
    // Net P&L includes the entry fee charged at open and the exit fee charged here.
    expect(closed?.pnl).toBeCloseTo(10 - 0.04 - 0.044, 9);
    expect(await balanceOf(t, userId)).toBeCloseTo((before ?? 0) + 10 - 0.044, 6);
  });

  it("rejects a disabled account before fetching a price", async () => {
    const t = newBackend();
    const owner = await seedTrader(t);
    const decisionId = await seedDecision(t, owner);
    const opened = await open(t, owner, decisionId, "disabled");
    await t.run(async (ctx) => ctx.db.patch(owner, { disabled: true }));

    await expect(
      t
        .withIdentity({ subject: owner })
        .action(api.arise.trading.closePosition, { positionId: opened.positionId }),
    ).rejects.toThrow(/ACCOUNT_DISABLED/);
    expect(await openCount(t)).toBe(1);
  });

  it("refuses to settle when the provider is unavailable (position stays open)", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);
    const opened = await open(t, userId, decisionId, "k2");
    const before = await balanceOf(t, userId);

    mockProvider.fail = true;
    await expect(
      t
        .withIdentity({ subject: userId })
        .action(api.arise.trading.closePosition, { positionId: opened.positionId }),
    ).rejects.toThrow(/CLOSE_PRICE_UNAVAILABLE/);
    expect(await openCount(t)).toBe(1);
    expect(await balanceOf(t, userId)).toBe(before);
  });

  it("refuses to settle on a stale provider bar", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);
    const opened = await open(t, userId, decisionId, "k4");

    // Every bar is older than the 3 x 5m CLOSE_POLICY bound.
    setProviderBars(110, 30 * MIN);
    await expect(
      t
        .withIdentity({ subject: userId })
        .action(api.arise.trading.closePosition, { positionId: opened.positionId }),
    ).rejects.toThrow(/CLOSE_PRICE_UNAVAILABLE/);
    expect(await openCount(t)).toBe(1);
  });

  it("closes once at the server price and cannot be replayed", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);
    const opened = await open(t, userId, decisionId, "k3");
    const before = await balanceOf(t, userId);

    await t
      .withIdentity({ subject: userId })
      .action(api.arise.trading.closePosition, { positionId: opened.positionId });

    // LONG 100 -> 110 (server bar close), qty 1, entry fee 0.04 + exit fee 4 bps of 110 = 0.044
    const expected = (before ?? 0) + (110 - 100) - 0.044;
    expect(await balanceOf(t, userId)).toBeCloseTo(expected, 6);

    // Replaying the close must not credit the balance a second time.
    await expect(
      t
        .withIdentity({ subject: userId })
        .action(api.arise.trading.closePosition, { positionId: opened.positionId }),
    ).rejects.toThrow(/Position not open/);
    expect(await balanceOf(t, userId)).toBeCloseTo(expected, 6);
  });
});

describe("monitor coverage beyond one batch", () => {
  async function seedMany(t: TestConvex, count: number) {
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i++) {
        await ctx.db.insert("positions", {
          userId,
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
      }
    });
    return userId;
  }

  it("reaches every open position across pages (not just the first 25)", async () => {
    const t = newBackend();
    await seedMany(t, 30);

    const page1 = await t.query(internal.arise.monitor.openPositionsBatch, {});
    expect(page1.positions).toHaveLength(25);
    expect(page1.isDone).toBe(false);

    const page2 = await t.query(internal.arise.monitor.openPositionsBatch, {
      cursor: page1.continueCursor,
    });
    const seen = new Set([...page1.positions, ...page2.positions].map((p) => p._id));
    expect(seen.size).toBe(30);
    expect(page2.isDone).toBe(true);
  });

  it("handles a single page without wrapping", async () => {
    const t = newBackend();
    await seedMany(t, 4);
    const page = await t.query(internal.arise.monitor.openPositionsBatch, {});
    expect(page.positions).toHaveLength(4);
    expect(page.isDone).toBe(true);
  });

  it("persists the scan cursor so the next tick continues forward", async () => {
    const t = newBackend();
    await seedMany(t, 30);
    const page1 = await t.query(internal.arise.monitor.openPositionsBatch, {});

    // First run claims the monitor (creates the state row).
    const first = await t.mutation(internal.arise.monitor.claimRun, { at: Date.now() });
    expect(first.decision).toBe("go");
    expect(first.cursor).toBeUndefined();

    await t.mutation(internal.arise.monitor.saveOpenCursor, { cursor: page1.continueCursor });

    // A later run (past the 5 minute lease) resumes where the scan stopped.
    const later = await t.mutation(internal.arise.monitor.claimRun, {
      at: Date.now() + 6 * MIN,
    });
    expect(later.decision).toBe("go");
    expect(later.cursor).toBe(page1.continueCursor);
  });

  it("never processes a closed position twice", async () => {
    const t = newBackend();
    const userId = await seedTrader(t);
    const decisionId = await seedDecision(t, userId);
    const opened = await open(t, userId, decisionId, "closed-once");

    await t
      .withIdentity({ subject: userId })
      .action(api.arise.trading.closePosition, { positionId: opened.positionId });

    const batch = await t.query(internal.arise.monitor.openPositionsBatch, {});
    expect(batch.positions).toHaveLength(0);
  });
});
