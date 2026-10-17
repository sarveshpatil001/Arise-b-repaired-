// ARISE V1 — BACKGROUND POSITION MONITOR (server-side scheduler).
// Runs independently of user interaction via crons.ts (every 2 minutes).
//
// Design:
//   - Finds OPEN positions (bounded, indexed).
//   - Fetches REAL provider data per distinct symbol (never fabricates prices).
//   - Validates usability (fail-closed): stale/invalid data ⇒ skip, position stays open.
//   - Evaluates SL/TP with the existing execution math (checkExit/closePnl).
//   - Applies closes atomically + idempotently: re-reads the position inside the
//     same serialized mutation and only transitions OPEN → CLOSED once.
//   - Lease (`runningClaim`) prevents overlapping scheduler runs.
//   - Records every run to monitorState + systemEvents for observability.
//
// LIVE TRADING IS NEVER INVOLVED: this only patches the paper `positions` table.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "../_generated/server";
import { requireActiveAdmin, requireActiveUser } from "../lib/authz";
import { internal } from "../_generated/api";
import { fetchMarketData } from "../../lib/arise/providers";
import { validateBars } from "../../lib/arise/validate";
import {
  applyExitToPosition,
  monitorHealth,
  planEvaluations,
  type MonitorMark,
  type MonitorPosition,
} from "../../lib/arise/monitor";
import { DEFAULT_CONFIG } from "../../lib/arise/config";
import type { Mark } from "../../lib/arise/ledger";
import { settleClose } from "../../lib/arise/settlement";
import { intervalMs } from "../../lib/arise/quant";

const MAX_POSITIONS_PER_TICK = 25;
const BARS_FOR_MONITORING = 3; // last 3 bars: covers up to barStaleMultiplier × interval
const TICK_HISTORY = 10; // recent tick records kept for health display
const CLAIM_EXPIRY_MS = 5 * 60_000; // stale claim takeover safety net

interface TickResult {
  evaluated: number;
  closed: number;
  skipped: number;
}

interface PageResult {
  positions: MonitorPosition[];
  continueCursor: string;
  isDone: boolean;
}

// ---------------- internal helpers ----------------

/**
 * One bounded page of OPEN positions (the batch this tick evaluates).
 *
 * Pagination — not a fixed `.take(25)` — is what guarantees coverage: the cursor
 * is persisted in monitorState and advanced every tick, wrapping back to the
 * start once the scan completes. A flat take(25) re-read the SAME first 25 rows
 * forever, so positions 26+ could never be checked.
 */
export const openPositionsBatch = internalQuery({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }): Promise<PageResult> => {
    const page = await ctx.db
      .query("positions")
      .withIndex("status", (q) => q.eq("status", "OPEN"))
      .paginate({ numItems: MAX_POSITIONS_PER_TICK, cursor: cursor ?? null });
    return {
      positions: page.page.map<MonitorPosition>((p) => ({
        _id: p._id,
        userId: p.userId,
        openedAt: p.openedAt,
        symbol: p.symbol,
        side: p.side,
        qty: p.qty,
        entryPrice: p.entryPrice,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
        entryFee: p.entryFee,
        status: p.status,
      })),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** Persists the OPEN-position scan position so the next tick continues forward. */
export const saveOpenCursor = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }): Promise<boolean> => {
    const prev = await ctx.db
      .query("monitorState")
      .withIndex("key", (q) => q.eq("key", "monitor"))
      .first();
    if (!prev) return false;
    await ctx.db.patch(prev._id, { openCursor: cursor });
    return true;
  },
});

/** Fetch + validate real market data for monitoring (fail-closed). */
async function fetchMonitorMark(symbol: string, now: number): Promise<MonitorMark | null> {
  try {
    const fetched = await fetchMarketData(symbol, "15m", 60);
    // A fallback provider is not the instrument the position was opened on (Delta
    // demo perpetual vs Binance spot), and a fallback interval is not the series the
    // monitor contract expects. Refuse both instead of settling on a different basis.
    if (fetched.fellBack || fetched.interval !== "15m") return null;
    const validation = validateBars(fetched.data.bars, {
      symbol,
      assetClass: symbol.endsWith("USDT") ? "crypto" : "forex",
      interval: fetched.interval,
      now,
      config: DEFAULT_CONFIG,
      source: fetched.data.provider,
    });
    if (validation.quality !== "valid") return null;
    const completed = validation.bars.filter(
      (bar) => bar.time + intervalMs(fetched.interval) <= now,
    );
    if (completed.length === 0) return null;
    const recent = completed.slice(-BARS_FOR_MONITORING);
    return {
      symbol,
      interval: fetched.interval,
      requestedInterval: "15m",
      source: fetched.data.provider,
      quality: validation.quality,
      barsCount: completed.length,
      bars: recent.map((b) => ({ barTime: b.time, high: b.high, low: b.low, close: b.close })),
    };
  } catch {
    // Provider failure / circuit open ⇒ no data, never a fabricated price.
    return null;
  }
}

/** Record (or replace) the latest tick record for observability. */
export const recordTick = internalMutation({
  args: {
    at: v.number(),
    evaluated: v.number(),
    closed: v.number(),
    skipped: v.number(),
    ok: v.boolean(),
    details: v.optional(v.string()),
  },
  handler: async (ctx, rec): Promise<boolean> => {
    const prev = await ctx.db
      .query("monitorState")
      .withIndex("key", (q) => q.eq("key", "monitor"))
      .first();
    const tick = {
      at: rec.at,
      evaluated: rec.evaluated,
      closed: rec.closed,
      skipped: rec.skipped,
      ok: rec.ok,
    };
    const history = (prev?.recentTicks ?? []).slice(0, TICK_HISTORY - 1);
    if (prev) {
      await ctx.db.patch(prev._id, {
        lastTickAt: rec.at,
        lastRun: { ...tick, details: rec.details },
        recentTicks: [tick, ...history],
      });
    } else {
      await ctx.db.insert("monitorState", {
        key: "monitor",
        lastTickAt: rec.at,
        lastRun: { ...tick, details: rec.details },
        recentTicks: [tick],
      });
    }
    return true;
  },
});

/** One scheduled monitoring pass (fetches provider data — runs as an action). */
export const tick = internalAction({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }): Promise<TickResult & { wrapped: boolean }> => {
    const now = Date.now();

    const page: PageResult = await ctx.runQuery(internal.arise.monitor.openPositionsBatch, { cursor });
    const batch = page.positions;
    const evaluated = batch.length;

    // Advance coverage before doing any work: closes are idempotent (applyExit
    // re-reads the position) so re-processing a page is always safe, and a crash
    // later in the tick still moves the scan forward.
    await ctx.runMutation(internal.arise.monitor.saveOpenCursor, {
      cursor: page.isDone ? undefined : page.continueCursor,
    });

    if (batch.length === 0) {
      await ctx.runMutation(internal.arise.monitor.recordTick, {
        at: now, evaluated: 0, closed: 0, skipped: 0, ok: true,
        details: "no open positions — idle",
      });
      return { evaluated: 0, closed: 0, skipped: 0, wrapped: page.isDone };
    }

    // Real provider data per distinct symbol.
    const symbols = [...new Set(batch.map((p) => p.symbol))];
    const marks: Record<string, MonitorMark | null> = {};
    for (const sym of symbols) {
      marks[sym] = await fetchMonitorMark(sym, now);
    }

    const accountMarks: Mark[] = Object.values(marks)
      .filter((mark): mark is MonitorMark => mark !== null)
      .flatMap((mark) => {
        const completedBars = mark.bars.filter(
          (bar) => bar.barTime + intervalMs(mark.interval) <= now,
        );
        const completed = completedBars[completedBars.length - 1];
        return completed
          ? [{ symbol: mark.symbol, price: completed.close, time: completed.barTime, interval: mark.interval, completed: true }]
          : [];
      });
    const userPositions = new Map<string, MonitorPosition[]>();
    for (const position of batch) {
      if (!position.userId) continue;
      const owned = userPositions.get(position.userId) ?? [];
      owned.push(position);
      userPositions.set(position.userId, owned);
    }
    for (const userId of userPositions.keys()) {
      // The mutation reads every current OPEN position and defers anchors itself
      // unless all required portfolio marks are fresh and complete.
      await ctx.runMutation(internal.arise.trading.markAccount, {
        userId: userId as never,
        marks: accountMarks,
        barStaleMultiplier: DEFAULT_CONFIG.barStaleMultiplier,
      });
    }

    const plan = planEvaluations({
      positions: batch,
      marks,
      now,
      config: { barStaleMultiplier: DEFAULT_CONFIG.barStaleMultiplier },
    });

    const symbolOf = new Map<string, string>();
    for (const p of batch) symbolOf.set(p._id, p.symbol);

    let closed = 0;
    for (const exit of plan.exits) {
      const mark = marks[symbolOf.get(exit.positionId) ?? ""] ?? undefined;
      const res = await ctx.runMutation(internal.arise.monitor.applyExit, {
        positionId: exit.positionId as never,
        patch: exit.patch,
        mark: mark
          ? {
              barTime: mark.bars[mark.bars.length - 1].barTime,
              interval: mark.interval,
              source: mark.source,
            }
          : undefined,
        closes: accountMarks,
        barStaleMultiplier: DEFAULT_CONFIG.barStaleMultiplier,
      });
      if (res.applied) closed++;
    }

    await ctx.runMutation(internal.arise.monitor.recordTick, {
      at: now,
      evaluated,
      closed,
      skipped: plan.skipped.length,
      ok: true,
      details:
        plan.skipped.length > 0
          ? plan.skipped.map((s) => `${s.symbol}: ${s.reason}`).join(" | ").slice(0, 400)
          : undefined,
    });

    if (plan.skipped.length > 0) {
      await ctx.runMutation(internal.arise.system.record, {
        level: "WARN",
        area: "EXECUTION",
        code: "MONITOR_SKIPPED",
        message: plan.skipped.map((s) => `${s.symbol}: ${s.reason}`).join(" | ").slice(0, 400),
        at: now,
      }).catch(() => undefined);
    }

    return { evaluated, closed, skipped: plan.skipped.length, wrapped: page.isDone };
  },
});

/**
 * Atomic + idempotent exit application. Runs in ONE serialized mutation:
 * re-reads the position, applies only if still OPEN, credits the paper
 * account exactly once, then records the event.
 */
export const applyExit = internalMutation({
  args: {
    positionId: v.id("positions"),
    patch: v.object({
      status: v.literal("CLOSED"),
      closedAt: v.number(),
      exitPrice: v.number(),
      exitReason: v.string(),
      pnl: v.number(),
      exitFee: v.number(),
    }),
    mark: v.optional(
      v.object({
        barTime: v.number(),
        interval: v.string(),
        source: v.string(),
      }),
    ),
    closes: v.optional(v.array(v.object({ symbol: v.string(), price: v.number(), time: v.number(), interval: v.string(), completed: v.boolean() }))),
    barStaleMultiplier: v.optional(v.number()),
  },
  handler: async (ctx, { positionId, patch, mark, closes, barStaleMultiplier }): Promise<{ applied: boolean; reason?: string; exitReason?: string; pnl?: number }> => {
    const now = Date.now();

    // ---- idempotency: re-read inside the same transaction ----
    const pos = await ctx.db.get(positionId);
    if (!pos) return { applied: false, reason: "NOT_FOUND" };
    const gate = applyExitToPosition(
      { status: pos.status, closedAt: pos.closedAt },
      { positionId, patch },
    );
    if (!gate.applied || !gate.patch) {
      return { applied: false, reason: "ALREADY_CLOSED" };
    }

    const settlement = await settleClose(ctx.db, {
      positionId,
      exitPrice: gate.patch.exitPrice,
      reason: gate.patch.exitReason,
      now,
      marks: Object.fromEntries((closes ?? []).map((close) => [close.symbol, close])),
      barStaleMultiplier,
    });
    if (!settlement.applied) return { applied: false, reason: settlement.reason ?? "ALREADY_CLOSED" };

    // ---- observability: system event with full context ----
    await ctx.runMutation(internal.arise.system.record, {
      level: "INFO",
      area: "EXECUTION",
      code: `MONITOR_EXIT_${gate.patch.exitReason}`,
      message: [
        `position=${positionId}`,
        `symbol=${pos.symbol}`,
        `side=${pos.side}`,
        `qty=${pos.qty}`,
        `exit=${gate.patch.exitPrice}`,
        `pnl=${settlement.pnl?.toFixed(2) ?? gate.patch.pnl.toFixed(2)}`,
        `anchorUpdate=${settlement.complete ? "complete" : "deferred"}`,
        `barTime=${mark?.barTime ?? "n/a"}`,
        `barInterval=${mark?.interval ?? "n/a"}`,
        `source=${mark?.source ?? "n/a"}`,
        `evaluatedAt=${now}`,
      ].join(" "),
      at: now,
    }).catch(() => undefined);

    return { applied: true, exitReason: gate.patch.exitReason, pnl: settlement.pnl ?? gate.patch.pnl };
  },
});

// ---------------- scheduler lease (overlapping-run protection) ----------------

/**
 * Claims the monitor for this run. Returns "go" only if no live claim exists.
 * The completion record is the lease release; expired claims are taken over.
 */
export const claimRun = internalMutation({
  args: { at: v.number() },
  handler: async (ctx, { at }): Promise<{ decision: "go" | "skip"; claimedBy?: number; cursor?: string }> => {
    const prev = await ctx.db
      .query("monitorState")
      .withIndex("key", (q) => q.eq("key", "monitor"))
      .first();
    if (prev?.runningClaim && at - prev.runningClaim.at < CLAIM_EXPIRY_MS) {
      return { decision: "skip", claimedBy: prev.runningClaim.at };
    }
    if (prev) {
      await ctx.db.patch(prev._id, { runningClaim: { at } });
    } else {
      await ctx.db.insert("monitorState", {
        key: "monitor",
        lastTickAt: at,
        recentTicks: [],
        runningClaim: { at },
      });
    }
    // Resume the OPEN-position scan where the previous tick stopped.
    return { decision: "go", cursor: prev?.openCursor };
  },
});

/** Releases the lease after a run (success or failure). */
export const completeRun = internalMutation({
  args: { at: v.number(), ok: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, { at, ok, error }): Promise<{ released: boolean }> => {
    const prev = await ctx.db
      .query("monitorState")
      .withIndex("key", (q) => q.eq("key", "monitor"))
      .first();
    if (!prev) return { released: false };
    await ctx.db.patch(prev._id, { runningClaim: undefined });
    if (!ok) {
      const history = (prev.recentTicks ?? []).slice(0, TICK_HISTORY - 1);
      await ctx.db.patch(prev._id, {
        lastRun: { at, evaluated: 0, closed: 0, skipped: 0, ok: false, details: error },
        recentTicks: [{ at, evaluated: 0, closed: 0, skipped: 0, ok: false }, ...history],
      });
      await ctx.runMutation(internal.arise.system.record, {
        level: "ERROR",
        area: "EXECUTION",
        code: "MONITOR_RUN_FAILED",
        message: (error ?? "monitor run failed").slice(0, 400),
        at,
      }).catch(() => undefined);
    }
    return { released: true };
  },
});

/** Wraps tick with the claim/release lease. This is what crons.ts schedules. */
export const guardedTick = internalAction({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    const at = Date.now();
    const claim = await ctx.runMutation(internal.arise.monitor.claimRun, { at });
    if (claim.decision === "skip") {
      return { skippedByLease: true, reason: "another monitoring run is active", evaluated: 0, closed: 0, skipped: 0 };
    }
    try {
      const result: TickResult & { wrapped: boolean } = await ctx.runAction(internal.arise.monitor.tick, {
        cursor: claim.cursor,
      });
      await ctx.runMutation(internal.arise.monitor.completeRun, { at, ok: true });
      return { ...result };
    } catch (e) {
      await ctx.runMutation(internal.arise.monitor.completeRun, {
        at, ok: false, error: (e as Error).message,
      });
      throw e;
    }
  },
});

// ---------------- status (admin console + Trades page) ----------------

/**
 * An active signed-in user's minimal monitor health. This is what the Trades page
 * reads: enough to explain whether exits are being evaluated, with no global
 * open-position counts, per-run skip details or operational history. Those stay on
 * the administrator endpoint below.
 */
export const publicStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireActiveUser(ctx);
    const row = await ctx.db
      .query("monitorState")
      .withIndex("key", (q) => q.eq("key", "monitor"))
      .first();
    const health = monitorHealth(row?.recentTicks ?? [], Date.now());
    return {
      state: health.state,
      detail: health.detail,
      lastTickAt: row?.lastTickAt ?? null,
      runningNow: row?.runningClaim != null,
      openPositions: null,
      schedule: "every 2 minutes",
    };
  },
});

/**
 * Full monitor health + last-run details. Administrator only: the payload exposes
 * platform-wide operational state (global open-position count, scan progress and
 * run history), which is not a customer resource.
 */
export const adminStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireActiveAdmin(ctx);
    const row = await ctx.db
      .query("monitorState")
      .withIndex("key", (q) => q.eq("key", "monitor"))
      .first();
    const openCount = await ctx.db
      .query("positions")
      .withIndex("status", (q) => q.eq("status", "OPEN"))
      .take(MAX_POSITIONS_PER_TICK + 1);
    const health = monitorHealth(row?.recentTicks ?? [], Date.now());
    return {
      state: health.state, // HEALTHY | DEGRADED | OFFLINE
      detail: health.detail,
      lastTickAt: row?.lastTickAt ?? null,
      lastRun: row?.lastRun ?? null,
      recentTicks: row?.recentTicks ?? [],
      runningNow: row?.runningClaim != null,
      openPositions: Math.min(openCount.length, MAX_POSITIONS_PER_TICK),
      openPositionsTruncated: openCount.length > MAX_POSITIONS_PER_TICK,
      /** True when the last tick finished a full scan of the OPEN positions. */
      scanComplete: row?.openCursor == null,
      positionsPerTick: MAX_POSITIONS_PER_TICK,
      schedule: "every 2 minutes",
    };
  },
});
