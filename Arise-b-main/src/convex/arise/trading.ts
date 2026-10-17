import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { requireActiveUser } from "../lib/authz";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { checkExit } from "../../lib/arise/execution";
import { applyOpen, markedEquity, prepareLedgerAccount, type Mark } from "../../lib/arise/ledger";
import { settleClose } from "../../lib/arise/settlement";
import { DEFAULT_CONFIG } from "../../lib/arise/config";
import { CLOSE_MARK_INTERVAL, createFreshnessPolicy, validateClosePrice } from "../../lib/arise/freshness";
import { fetchMarketData, listSymbols } from "../../lib/arise/providers";
import { validateBars } from "../../lib/arise/validate";
import { intervalMs } from "../../lib/arise/quant";

function dayKeyUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

async function dbOpenPositions(db: MutationCtx["db"], userId: Id<"users">) {
  return db.query("positions").withIndex("userId_status", (q) => q.eq("userId", userId).eq("status", "OPEN")).collect();
}

function markRecord(marks: Mark[]) {
  return Object.fromEntries(marks.map((mark) => [mark.symbol, mark]));
}

async function markAccountLedger(
  db: MutationCtx["db"],
  userId: Id<"users">,
  marks: Mark[],
  now: number,
  barStaleMultiplier = DEFAULT_CONFIG.barStaleMultiplier,
  requiredSymbols: string[] = [],
) {
  const account = await db.query("paperAccounts").withIndex("userId", (q) => q.eq("userId", userId)).first();
  if (!account) return null;
  const positions = await db.query("positions").withIndex("userId_status", (q) => q.eq("userId", userId).eq("status", "OPEN")).collect();
  const marked = markedEquity(account.balance, positions, markRecord(marks), {
    now,
    policy: createFreshnessPolicy(barStaleMultiplier),
    requiredSymbols: [...new Set([...marks.map((mark) => mark.symbol), ...requiredSymbols])],
  });
  const prepared = prepareLedgerAccount(account, marked, now);
  if (marked.complete) {
    await db.patch(account._id, {
      dayKey: prepared.dayKey,
      dayStartEquity: prepared.dayStartEquity,
      equityHighWaterMark: prepared.equityHighWaterMark,
    });
  }
  return { account: { ...account, ...prepared }, positions, marked, deferred: !marked.complete };
}

// ---------------- internal (used by market action) ----------------

export const internalGetAccount = internalQuery({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    return await ctx.db
      .query("paperAccounts")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .first();
  },
});

export const markAccount = internalMutation({
  args: {
    userId: v.id("users"),
    marks: v.array(v.object({ symbol: v.string(), price: v.number(), time: v.number(), interval: v.string(), completed: v.boolean() })),
    barStaleMultiplier: v.optional(v.number()),
    requiredSymbols: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { userId, marks, barStaleMultiplier, requiredSymbols }) =>
    markAccountLedger(ctx.db, userId, marks, Date.now(), barStaleMultiplier, requiredSymbols),
});

export const listOpenPositions = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) =>
    ctx.db
      .query("positions")
      .withIndex("userId_status", (q) => q.eq("userId", userId).eq("status", "OPEN"))
      .collect(),
});

export const openPosition = internalMutation({
  args: {
    userId: v.id("users"),
    decisionId: v.id("decisions"),
    symbol: v.string(),
    side: v.string(),
    qty: v.number(),
    entryPrice: v.number(),
    stopLoss: v.number(),
    takeProfit: v.number(),
    entryFee: v.number(),
    maxLossQuote: v.number(),
    thesis: v.string(),
    riskDecision: v.string(),
    marks: v.array(v.object({ symbol: v.string(), price: v.number(), time: v.number(), interval: v.string(), completed: v.boolean() })),
    barStaleMultiplier: v.optional(v.number()),
    idemKey: v.optional(v.string()),
  },
  handler: async (ctx, p): Promise<{ positionId: Id<"positions">; duplicate: boolean }> => {
    const now = Date.now();

    // ---- durable duplicate-execution guard ----------------
    // A new PaperBroker is built per request, so the broker's in-memory
    // idempotency set can never catch a retry or a concurrent request. The key is
    // persisted instead: mutations are serialized, so the second caller always
    // observes the first caller's row and is suppressed without touching balances.
    if (p.idemKey) {
      const existing = await ctx.db
        .query("positions")
        .withIndex("idemKey", (q) => q.eq("idemKey", p.idemKey))
        .first();
      if (existing) {
        return { positionId: existing._id, duplicate: true };
      }
    }

    const [acct, openPositions] = await Promise.all([
      ctx.db.query("paperAccounts").withIndex("userId", (q) => q.eq("userId", p.userId)).first(),
      ctx.db.query("positions").withIndex("userId_status", (q) => q.eq("userId", p.userId).eq("status", "OPEN")).collect(),
    ]);
    if (!acct) throw new Error("Paper account unavailable");
    const marks = markRecord(p.marks);
    const requiredSymbols = [...new Set([...openPositions.map((position) => position.symbol), p.symbol])];
    const marked = markedEquity(acct.balance, openPositions, marks, {
      now,
      policy: createFreshnessPolicy(p.barStaleMultiplier ?? DEFAULT_CONFIG.barStaleMultiplier),
      requiredSymbols,
    });
    if (!marked.complete) {
      throw new Error(`MARKS_UNAVAILABLE: fresh completed marks required for ${marked.usedFallback.join(", ")}`);
    }
    const id = await ctx.db.insert("positions", {
      userId: p.userId,
      decisionId: p.decisionId,
      symbol: p.symbol,
      side: p.side,
      qty: p.qty,
      entryPrice: p.entryPrice,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      entryFee: p.entryFee,
      status: "OPEN",
      openedAt: now,
      thesis: p.thesis,
      riskDecision: p.riskDecision,
      maxLossQuote: p.maxLossQuote,
      idemKey: p.idemKey,
    });
    // debit entry fees once, then refresh account anchors from the complete mark set
    const balance = applyOpen(acct.balance, p.entryFee);
    await ctx.db.patch(acct._id, { balance });
    const positionsAfterOpen = await dbOpenPositions(ctx.db, p.userId);
    const equityAfterOpen = markedEquity(balance, positionsAfterOpen, marks, {
      now,
      policy: createFreshnessPolicy(p.barStaleMultiplier ?? DEFAULT_CONFIG.barStaleMultiplier),
      requiredSymbols: [...new Set(positionsAfterOpen.map((position) => position.symbol))],
    });
    if (equityAfterOpen.complete) {
      const prepared = prepareLedgerAccount({ ...acct, balance }, equityAfterOpen, now);
      await ctx.db.patch(acct._id, {
        dayKey: prepared.dayKey,
        dayStartEquity: prepared.dayStartEquity,
        equityHighWaterMark: prepared.equityHighWaterMark,
      });
    }
    return { positionId: id, duplicate: false };
  },
});

/** Bar-close maintenance: mark open positions against latest close, apply SL/TP, settle closed trades. */
export const recordEquityPoint = internalMutation({
  args: {
    userId: v.id("users"),
    t: v.number(),
    equity: v.number(),
    cash: v.number(),
    drawdownPct: v.number(),
  },
  handler: async (ctx, p) => {
    await ctx.db.insert("equityPoints", p);
    const rows = await ctx.db
      .query("equityPoints")
      .withIndex("userId_t", (q) => q.eq("userId", p.userId))
      .collect();
    if (rows.length > 500) {
      const sorted = rows.sort((a, b) => a.t - b.t);
      for (const r of sorted.slice(0, rows.length - 500)) await ctx.db.delete(r._id);
    }
    return true;
  },
});

export const maintainPositions = internalMutation({
  args: {
    userId: v.id("users"),
    marks: v.array(v.object({ symbol: v.string(), close: v.number(), time: v.number(), high: v.number(), low: v.number(), interval: v.string() })),
    portfolioMarks: v.optional(v.array(v.object({ symbol: v.string(), price: v.number(), time: v.number(), interval: v.string(), completed: v.boolean() }))),
    barStaleMultiplier: v.optional(v.number()),
  },
  handler: async (ctx, { userId, marks, portfolioMarks, barStaleMultiplier }) => {
    const now = Date.now();
    const acct = await ctx.db
      .query("paperAccounts")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .first();
    if (!acct) return { settled: 0 };
    const open = await ctx.db
      .query("positions")
      .withIndex("userId_status", (q) => q.eq("userId", userId).eq("status", "OPEN"))
      .collect();

    let settled = 0;
    const equityMarks = portfolioMarks ?? [];
    for (const pos of open) {
      const mark = marks.find((m) => m.symbol === pos.symbol);
      if (!mark) continue;
      const exit = checkExit(
        {
          side: pos.side as "LONG" | "SHORT",
          entry: pos.entryPrice,
          stop: pos.stopLoss,
          target: pos.takeProfit,
        },
        { high: mark.high, low: mark.low },
      );
      if (!exit.closed) continue;
      const result = await settleClose(ctx.db, {
        positionId: pos._id,
        exitPrice: exit.exitPrice,
        reason: exit.reason,
        now,
        marks: markRecord(equityMarks),
        barStaleMultiplier: barStaleMultiplier ?? DEFAULT_CONFIG.barStaleMultiplier,
      });
      if (result.applied) settled++;
    }
    const [currentAccount, remaining] = await Promise.all([
      ctx.db.query("paperAccounts").withIndex("userId", (q) => q.eq("userId", userId)).first(),
      ctx.db.query("positions").withIndex("userId_status", (q) => q.eq("userId", userId).eq("status", "OPEN")).collect(),
    ]);
    if (!currentAccount) return { settled };
    const markMap = markRecord(equityMarks);
    const marked = markedEquity(currentAccount.balance, remaining, markMap, {
      now,
      policy: createFreshnessPolicy(barStaleMultiplier ?? DEFAULT_CONFIG.barStaleMultiplier),
      requiredSymbols: [...new Set(remaining.map((position) => position.symbol))],
    });
    const prepared = prepareLedgerAccount(currentAccount, marked, now);
    if (marked.complete) {
      await ctx.db.patch(currentAccount._id, {
        dayKey: prepared.dayKey,
        dayStartEquity: prepared.dayStartEquity,
        equityHighWaterMark: prepared.equityHighWaterMark,
      });
    }
    return { settled };
  },
});

// ---------------- public ----------------

export const myAccount = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    return await ctx.db
      .query("paperAccounts")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .first();
  },
});

export const createAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const { userId } = await requireActiveUser(ctx);
    const existing = await ctx.db
      .query("paperAccounts")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .first();
    if (existing) return existing._id;
    const now = Date.now();
    const starting = 10_000;
    return ctx.db.insert("paperAccounts", {
      userId,
      balance: starting,
      equityHighWaterMark: starting,
      dayStartEquity: starting,
      dayKey: dayKeyUtc(now),
      emergencyStop: false,
      startingBalance: starting,
    });
  },
});

export const resetAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const { userId } = await requireActiveUser(ctx);
    const open = await ctx.db
      .query("positions")
      .withIndex("userId_status", (q) => q.eq("userId", userId).eq("status", "OPEN"))
      .collect();
    if (open.length > 0) throw new Error("Close open positions before reset");
    const acct = await ctx.db
      .query("paperAccounts")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .first();
    if (!acct) throw new Error("No account");
    const now = Date.now();
    await ctx.db.patch(acct._id, {
      balance: acct.startingBalance,
      equityHighWaterMark: acct.startingBalance,
      dayStartEquity: acct.startingBalance,
      dayKey: dayKeyUtc(now),
      emergencyStop: false,
    });
    return true;
  },
});

export const setEmergencyStop = mutation({
  args: { active: v.boolean() },
  handler: async (ctx, { active }) => {
    const { userId } = await requireActiveUser(ctx);
    const acct = await ctx.db
      .query("paperAccounts")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .first();
    if (!acct) throw new Error("No account");
    await ctx.db.patch(acct._id, { emergencyStop: active });
    return true;
  },
});

/** Action-safe identity check: disabled accounts cannot close positions either. */
export const activeViewer = internalQuery({
  args: {},
  handler: async (ctx) => (await requireActiveUser(ctx)).userId,
});

/** Ownership + status lookup used by the close action before it prices the exit. */
export const positionForClose = internalQuery({
  args: { positionId: v.id("positions"), userId: v.id("users") },
  handler: async (ctx, { positionId, userId }) => {
    const pos = await ctx.db.get(positionId);
    if (!pos || pos.userId !== userId) return null;
    return { _id: pos._id, symbol: pos.symbol, status: pos.status };
  },
});

/** Settles an already-priced close. Internal: no client price can reach it. */
export const settleCloseAt = internalMutation({
  args: {
    positionId: v.id("positions"),
    userId: v.id("users"),
    exitPrice: v.number(),
    priceTime: v.number(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const pos = await ctx.db.get(args.positionId);
    if (!pos || pos.userId !== args.userId) throw new Error("Not found");
    if (pos.status !== "OPEN") return { applied: false, reason: "ALREADY_CLOSED" };
    // Defence in depth: the action validated the bar before calling this mutation,
    // but the settlement mutation re-checks that the price really is a completed,
    // fresh 5m bar close. A future caller cannot skip that proof.
    const verdict = validateClosePrice({ price: args.exitPrice, priceTime: args.priceTime, now: Date.now() });
    if (!verdict.ok) throw new Error(`CLOSE_PRICE_INVALID: ${verdict.reason}`);
    return settleClose(ctx.db, {
      positionId: args.positionId,
      exitPrice: args.exitPrice,
      reason: args.reason,
      now: Date.now(),
    });
  },
});

/**
 * Manual close. The exit price is fetched HERE, from the server-side market-data
 * providers — the client only names the position. Before this change the caller
 * supplied the price (with a bar timestamp) and a fresh-looking timestamp was the
 * only proof required, so a client could invent a favourable exit price.
 *
 * Failure is explicit (CLOSE_PRICE_UNAVAILABLE) and leaves the position open: no
 * fallback price, no settlement on unverifiable data.
 */
export const closePosition = action({
  args: { positionId: v.id("positions") },
  handler: async (ctx, { positionId }) => {
    const owner = await ctx.runQuery(internal.arise.trading.activeViewer, {});
    const pos = await ctx.runQuery(internal.arise.trading.positionForClose, {
      positionId,
      userId: owner,
    });
    if (!pos) throw new Error("Not found");
    if (pos.status !== "OPEN") throw new Error("Position not open");

    const now = Date.now();
    // The position names the instrument; nothing about the instrument comes from
    // the caller. An unknown symbol fails before any provider request.
    const meta = listSymbols().find((s) => s.symbol === pos.symbol);
    if (!meta) {
      throw new Error(`CLOSE_PRICE_UNAVAILABLE: unsupported instrument ${pos.symbol}`);
    }

    let fetched;
    try {
      fetched = await fetchMarketData(pos.symbol, CLOSE_MARK_INTERVAL, 24);
    } catch (e) {
      throw new Error(`CLOSE_PRICE_UNAVAILABLE: ${(e as Error).message}`);
    }

    // A fallback provider is not the instrument the position was opened on: for
    // crypto it is a Delta demo PERPETUAL (BTCUSD) standing in for Binance spot
    // (BTCUSDT), and for forex it is a coarser interval. Settling on it would mix
    // price bases, so the close fails closed instead and the position stays open.
    if (fetched.fellBack) {
      throw new Error(
        `CLOSE_PRICE_UNAVAILABLE: primary provider unavailable (fell back to ${fetched.fallbackFrom ?? "a fallback source"})`,
      );
    }

    // The exit price must be a 5m bar close. Validating a 15m bar as if it were a
    // completed 5m bar would accept a still-forming candle as a close, so a
    // fallback interval is refused rather than relabelled.
    if (fetched.interval !== CLOSE_MARK_INTERVAL) {
      throw new Error(
        `CLOSE_PRICE_UNAVAILABLE: provider served ${fetched.interval} instead of ${CLOSE_MARK_INTERVAL} (${fetched.fallbackFrom ?? "fallback"})`,
      );
    }

    // Same candle-validation contract as every other consumer: duplicates, invalid
    // OHLC and unexplained gaps degrade the series, and a degraded series cannot
    // price an exit.
    const validation = validateBars(fetched.data.bars, {
      symbol: pos.symbol,
      assetClass: meta.assetClass,
      interval: fetched.interval,
      now,
      config: DEFAULT_CONFIG,
      source: fetched.data.provider,
    });
    if (validation.quality !== "valid") {
      throw new Error(
        `CLOSE_PRICE_UNAVAILABLE: ${fetched.interval} data is ${validation.quality}${
          validation.notes.length ? ` (${validation.notes.join("; ")})` : ""
        }`,
      );
    }
    if (validation.bars.some((b) => b.time > now)) {
      throw new Error("CLOSE_PRICE_UNAVAILABLE: provider returned a future-dated bar");
    }

    // Only a genuinely COMPLETED bar may settle a trade. A forming candle's close
    // moves until the bar closes, so it is not an exit price.
    const completed = validation.bars
      .filter((b) => b.time + intervalMs(CLOSE_MARK_INTERVAL) <= now)
      .sort((a, b) => a.time - b.time);
    const candidate = completed[completed.length - 1];
    if (!candidate) {
      throw new Error(`CLOSE_PRICE_UNAVAILABLE: provider returned no completed ${CLOSE_MARK_INTERVAL} bar`);
    }

    const verdict = validateClosePrice({ price: candidate.close, priceTime: candidate.time, now });
    if (!verdict.ok) throw new Error(`CLOSE_PRICE_UNAVAILABLE: ${verdict.reason}`);

    const result = await ctx.runMutation(internal.arise.trading.settleCloseAt, {
      positionId,
      userId: owner,
      exitPrice: candidate.close,
      priceTime: candidate.time,
      reason: "MANUAL_CLOSE",
    });
    if (!result.applied) throw new Error("Position not open");

    return {
      exitPrice: candidate.close,
      priceTime: candidate.time,
      barInterval: fetched.interval,
      provider: fetched.data.provider ?? null,
      fellBack: fetched.fellBack,
    };
  },
});

export const openPositions = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    return await ctx.db
      .query("positions")
      .withIndex("userId_status", (q) => q.eq("userId", userId).eq("status", "OPEN"))
      .collect();
  },
});

// Trade history is never pruned (it is the user's own record of what happened), so the
// page is read with a bounded, newest-first database read instead of loading every closed
// position the account has ever had and slicing in memory: the index is ordered
// (userId, status, _creationTime), so a descending take returns the most recently created
// rows without scanning the rest of the account's history.
const MAX_CLOSED_POSITIONS = 500;
const DEFAULT_CLOSED_POSITIONS = 100;

export const closedPositions = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const requested = limit ?? DEFAULT_CLOSED_POSITIONS;
    const bounded = Number.isFinite(requested)
      ? Math.min(Math.max(Math.floor(requested), 1), MAX_CLOSED_POSITIONS)
      : DEFAULT_CLOSED_POSITIONS;
    const rows = await ctx.db
      .query("positions")
      .withIndex("userId_status", (q) => q.eq("userId", userId).eq("status", "CLOSED"))
      .order("desc")
      .take(bounded);
    // closedAt is the authoritative close time; _creationTime ordering is not exactly the
    // same thing (a position can outlive several bars before it closes), so the returned
    // page is still sorted by the real value.
    return rows.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  },
});

// Marks are built from the most recent decisions only; the index is ordered
// (userId, _creationTime), so a descending take never walks the account's whole history.
const MARK_SCAN_LIMIT = 120;

/** Latest close per symbol from recent decisions — used to mark open positions client-side. */
export const latestMarks = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const decs = await ctx.db
      .query("decisions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MARK_SCAN_LIMIT);
    const bySymbol: Record<string, { symbol: string; close: number; time: number; interval: string; completed: boolean }> = {};
    for (const d of decs) {
      const meta = d.snapshotMeta as { lastClose?: number; lastBarTime?: number } | undefined;
      const close = meta?.lastClose;
      if (typeof close === "number" && close > 0) {
        const t = meta?.lastBarTime ?? d.dataTimestamp;
        if (!bySymbol[d.symbol] || bySymbol[d.symbol].time < t) {
          bySymbol[d.symbol] = {
            symbol: d.symbol,
            close,
            time: t,
            interval: d.interval,
            completed: t + intervalMs(d.interval) <= Date.now(),
          };
        }
      }
    }
    return Object.values(bySymbol);
  },
});
