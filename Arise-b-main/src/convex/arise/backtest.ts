// ARISE Bot Training System — Convex backend.
// Bots + deterministic backtest runs. User-isolated, server-validated.
// Real data via providers (labeled REAL); seeded random-walk fallback labeled SYNTHETIC.

import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import { requireActiveAdmin, requireActiveUser } from "../lib/authz";
import { fetchMarketData, listSymbols } from "../../lib/arise/providers";
import {
  DEFAULT_BT_CONFIG,
  runBacktest,
  type BTBar,
  type StrategyId,
} from "../../lib/arise/backtest";
import { evaluateStrategyFitness } from "../../lib/arise/strategyFitness";
import { defaultWFConfig, runWalkForward } from "../../lib/arise/walkForward";
import { intervalMs } from "../../lib/arise/quant";

const STRATEGIES = [
  "sma-cross",
  "rsi-mean",
  "arise-momentum",
  "buy-hold",
] as const;
const STRESSES = [
  "none",
  "gap-down",
  "vol-spike",
  "low-liquidity",
  "high-cost",
] as const;

/**
 * Definition version of the allow-listed strategy an experiment ran against.
 * ARISE does not yet persist a per-strategy version history, so this is the
 * shipped definition of the current build, recorded so a gate report can be
 * traced back to the code that produced it. It must be bumped whenever the
 * strategy definitions in ../../lib/arise/backtest.ts change semantics.
 */
const STRATEGY_DEFINITION_VERSION = "v1";

export const recordRun = internalMutation({
  args: {
    userId: v.id("users"),
    botId: v.id("bots"),
    botName: v.string(),
    strategyId: v.string(),
    symbol: v.string(),
    interval: v.string(),
    requestedInterval: v.optional(v.string()),
    dataKind: v.string(),
    dataSource: v.string(),
    barCount: v.number(),
    seed: v.number(),
    feeBps: v.number(),
    slippageBps: v.number(),
    positionPct: v.number(),
    stopPct: v.number(),
    targetPct: v.number(),
    inSamplePct: v.number(),
    stress: v.string(),
    status: v.string(),
    metrics: v.any(),
    fitness: v.any(),
    fitnessGates: v.optional(v.any()),
    walkForward: v.optional(v.any()),
    equityCurve: v.any(),
    trades: v.any(),
    error: v.optional(v.string()),
    createdAt: v.number(),
  },
  handler: async (ctx, a) => {
    return await ctx.db.insert("backtestRuns", a);
  },
});

// ---------------- public API ----------------

export const create = mutation({
  args: {
    name: v.string(),
    strategyId: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, { name, strategyId, description }) => {
    const { userId } = await requireActiveUser(ctx);
    const clean = name.trim().slice(0, 60);
    if (clean.length < 2)
      throw new Error("Bot name must be at least 2 characters");
    if (!(STRATEGIES as readonly string[]).includes(strategyId))
      throw new Error(`unknown strategy ${strategyId}`);
    if (description && description.length > 500)
      throw new Error("Description too long (max 500)");
    const dup = await ctx.db
      .query("bots")
      .withIndex("userId_name", (q) => q.eq("userId", userId).eq("name", clean))
      .first();
    if (dup) throw new Error("A bot with this name already exists");
    return await ctx.db.insert("bots", {
      userId,
      name: clean,
      strategyId,
      description,
      createdAt: Date.now(),
    });
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    return await ctx.db
      .query("bots")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .collect();
  },
});

export const runs = query({
  args: { botId: v.optional(v.id("bots")), limit: v.optional(v.number()) },
  handler: async (ctx, { botId, limit }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const lim = Math.min(Math.max(limit ?? 30, 1), 100);
    if (botId) {
      const bot = await ctx.db.get(botId);
      if (!bot || bot.userId !== userId) return [];
      return await ctx.db
        .query("backtestRuns")
        .withIndex("userId_bot", (q) =>
          q.eq("userId", userId).eq("botId", botId),
        )
        .order("desc")
        .take(lim);
    }
    return await ctx.db
      .query("backtestRuns")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .order("desc")
      .take(lim);
  },
});

export const get = query({
  args: { runId: v.id("backtestRuns") },
  handler: async (ctx, { runId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const run = await ctx.db.get(runId);
    if (!run || run.userId !== userId) return null;
    return run;
  },
});

function syntheticBars(seed: number, n: number, start: number): BTBar[] {
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const out: BTBar[] = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const shock = (rnd() - 0.5) * 2;
    const drift = Math.sin(i / 12) * 0.6 + shock * 0.8;
    const open = px;
    const close = Math.max(1, px + drift);
    out.push({
      time: 1_700_000_000_000 + i * 3_600_000,
      open,
      high: Math.max(open, close) * (1 + rnd() * 0.004),
      low: Math.min(open, close) * (1 - rnd() * 0.004),
      close,
      volume: 800 + rnd() * 600,
    });
    px = close;
  }
  return out;
}

export const runTest = action({
  args: {
    botId: v.id("bots"),
    symbol: v.string(),
    interval: v.string(),
    stress: v.optional(v.string()),
    feeBps: v.optional(v.number()),
    slippageBps: v.optional(v.number()),
    positionPct: v.optional(v.number()),
    stopPct: v.optional(v.number()),
    targetPct: v.optional(v.number()),
    seed: v.optional(v.number()),
    useSynthetic: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    a,
  ): Promise<{
    ok: boolean;
    runId: string;
    status: string;
    dataKind: string;
    dataSource: string;
    barCount: number;
    metrics: unknown;
    fitness: unknown;
    fitnessGates: unknown;
    walkForward: unknown;
    tradeCount: number;
  }> => {
    // Active-user gate: a missing/deleted user row is rejected like a disabled one,
    // BEFORE entitlements are calculated or any provider data is fetched.
    const userId = await ctx.runQuery(internal.arise.trading.activeViewer, {});

    // Internal-only lookup: the bot record is read server-side and the ownership check
    // below is what authorizes it. This must NOT be a public query — a public lookup by
    // bot id would let any signed-in caller read another user's bot by guessing an id.
    const bot = await ctx.runQuery(internal.arise.backtest.getBotInternal, {
      botId: a.botId,
    });
    if (!bot) throw new Error("Bot not found");
    if (bot.userId !== userId) throw new Error("Bot not found");
    const strategyId = bot.strategyId as StrategyId;
    if (!(STRATEGIES as readonly string[]).includes(strategyId))
      throw new Error("Unknown strategy");

    const stress = a.stress ?? "none";
    if (!(STRESSES as readonly string[]).includes(stress))
      throw new Error(`unknown stress ${stress}`);
    const feeBps = Math.min(Math.max(a.feeBps ?? 4, 0), 100);
    const slippageBps = Math.min(Math.max(a.slippageBps ?? 2, 0), 100);
    const positionPct = Math.min(Math.max(a.positionPct ?? 15, 1), 100);
    const stopPct = Math.min(Math.max(a.stopPct ?? 1.5, 0.1), 20);
    const targetPct = Math.min(Math.max(a.targetPct ?? 3, 0.2), 40);
    const seed = Math.floor(a.seed ?? 42);

    const meta = listSymbols().find((s) => s.symbol === a.symbol);
    if (!meta) throw new Error(`unsupported symbol ${a.symbol}`);

    // plan gating (shared with analyses)
    const ents = await ctx.runQuery(
      internal.arise.billingFunctions.myEntitlementsInternal,
      {},
    );
    if (ents.remainingToday === 0) {
      throw new Error(
        `PLAN_LIMIT_REACHED: The ${ents.planName} plan allows ${ents.analysisLimitPerDay} analyses per day. Upgrade to continue.`,
      );
    }

    let bars: BTBar[];
    let dataKind = "REAL";
    let dataSource = "unknown";
    let fetchedInterval = a.interval;
    let requestedInterval: string | undefined = a.interval;
    if (a.useSynthetic) {
      bars = syntheticBars(seed, 400, 100);
      dataKind = "SYNTHETIC";
      dataSource = "synthetic-random-walk-v1";
    } else {
      let fetched;
      try {
        fetched = await fetchMarketData(a.symbol, a.interval, 400);
      } catch (e) {
        const msg = (e as Error).message;
        await ctx.runMutation(internal.arise.system.record, {
          level: "ERROR",
          area: "DATA",
          code: "BACKTEST_PROVIDER_FAILURE",
          message: `${a.symbol}: ${msg}`,
          at: Date.now(),
        });
        throw new Error(`MARKET_DATA_UNAVAILABLE: ${msg}`);
      }
      bars = fetched.data.bars.map((b) => ({ ...b }));
      dataSource = fetched.data.provider;
      fetchedInterval = fetched.interval;
      if (fetched.interval !== a.interval) requestedInterval = a.interval;
    }

    const result = runBacktest(
      bars,
      strategyId,
      {
        startingEquity: 10_000,
        feeBps,
        slippageBps,
        positionPct,
        stopPct,
        targetPct,
        seed,
      },
      stress,
    );

    // ---- deterministic strategy-fitness gates (src/lib/arise/strategyFitness.ts) ----
    // Only measurements THIS run actually produced are passed. A single historical
    // evaluation has no walk-forward folds and no parameter perturbations, so those
    // are `null` on purpose and their gates fail closed as blockers — inventing
    // stability evidence is exactly what the gate exists to prevent. The engine
    // applies a 5x slippage multiplier under the high-cost / low-liquidity stress
    // scenarios, so the effective figure is recorded rather than the requested one.
    // The leakage guard is a property of the engine that produced these metrics and
    // is readable from its source: `strategySignal` receives only `closes[0..i]`,
    // entries and signal exits fill at `data[i + 1].open`, and the fill jitter comes
    // from the seeded `mulberry32(c.seed)` generator.
    // ---- walk-forward evidence (src/lib/arise/walkForward.ts) ----
    // Chronological folds, parameters selected on training bars only, the selected
    // params then evaluated on the following test window. Candidates are enumerated
    // from the strategy's allow-listed parameter space. Synthetic runs are refused by
    // the engine itself (SYNTHETIC_DATA), so a simulated series can never qualify a
    // strategy for real-market consideration; a refusal leaves the walk-forward gates
    // unmeasured and therefore blocking.
    const wfConfig = defaultWFConfig({
      now: Date.now(),
      dataKind: dataKind === "SYNTHETIC" ? "SYNTHETIC" : "REAL",
      intervalMs: intervalMs(fetchedInterval),
      feeBps,
      slippageBps:
        stress === "high-cost" || stress === "low-liquidity"
          ? slippageBps * 5
          : slippageBps,
      positionPct,
      stopPct,
      targetPct,
      seed,
    });
    const walkForward = runWalkForward(bars, strategyId, wfConfig);

    // Out-of-sample trades come from the walk-forward test windows when the engine
    // produced them (genuinely unseen during selection); otherwise fall back to the
    // single in-sample split, which is a weaker measurement and is labelled as such.
    const splitOosTradeCount = result.trades.filter((t) => !t.inSample).length;
    const oosTradeCount = walkForward.ok
      ? walkForward.oosTradeCount
      : splitOosTradeCount;
    const effectiveSlippageBps =
      stress === "high-cost" || stress === "low-liquidity"
        ? slippageBps * 5
        : slippageBps;
    const fitnessGates = evaluateStrategyFitness({
      strategyId,
      strategyVersion: STRATEGY_DEFINITION_VERSION,
      metrics: result.metrics,
      insufficientData: result.insufficientData,
      barCount: bars.length,
      minBars: DEFAULT_BT_CONFIG.minBars,
      oosTradeCount,
      walkForwardFolds: walkForward.ok ? walkForward.foldsForFitness : null,
      parameterVariants: walkForward.ok ? walkForward.variants : null,
      costsApplied: { feeBps, slippageBps: effectiveSlippageBps },
      leakageGuard: {
        lookAheadChecked: true,
        usesNextBarOpenForFills: true,
        deterministicSeed: true,
      },
    });

    const status = result.insufficientData ? "INSUFFICIENT_DATA" : "COMPLETED";
    // cap stored arrays (400 points / 200 trades max for doc limits)
    const equityCurve = result.equityCurve.slice(0, 2000);
    const trades = result.trades.slice(0, 500);
    const runId: string = await ctx.runMutation(
      internal.arise.backtest.recordRun,
      {
        userId,
        botId: a.botId,
        botName: bot.name,
        strategyId,
        symbol: a.symbol,
        interval: fetchedInterval,
        requestedInterval,
        dataKind,
        dataSource,
        barCount: bars.length,
        seed,
        feeBps,
        slippageBps,
        positionPct,
        stopPct,
        targetPct,
        inSamplePct: 0.7,
        stress,
        status,
        metrics: result.metrics,
        fitness: result.fitness,
        fitnessGates,
        walkForward: {
          ok: walkForward.ok,
          reason: walkForward.reason,
          folds: walkForward.folds,
          oosTradeCount: walkForward.oosTradeCount,
          profitableFoldFraction: walkForward.profitableFoldFraction,
          meanOosReturnPct: walkForward.meanOosReturnPct,
          variants: walkForward.variants,
          limitations: walkForward.limitations,
          config: wfConfig,
        },
        equityCurve,
        trades,
        error: undefined,
        createdAt: Date.now(),
      },
    );

    await ctx.runMutation(
      internal.arise.billingFunctions.incrementUsageInternal,
      {
        userId,
        dayKey: new Date(Date.now()).toISOString().slice(0, 10),
      },
    );

    return {
      ok: true,
      runId,
      status,
      dataKind,
      dataSource,
      barCount: bars.length,
      metrics: result.metrics,
      fitness: result.fitness,
      fitnessGates,
      walkForward: {
        ok: walkForward.ok,
        reason: walkForward.reason,
        foldCount: walkForward.folds.length,
        oosTradeCount: walkForward.oosTradeCount,
        profitableFoldFraction: walkForward.profitableFoldFraction,
        meanOosReturnPct: walkForward.meanOosReturnPct,
      },
      tradeCount: result.trades.length,
    };
  },
});

export const adminRuns = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    // Admin console read: requires an ACTIVE administrator. The previous inline
    // role check ignored `disabled`, so a disabled admin kept platform-wide access
    // to every user's backtest runs.
    await requireActiveAdmin(ctx);
    const lim = Math.min(Math.max(limit ?? 50, 1), 200);
    return await ctx.db.query("backtestRuns").order("desc").take(lim);
  },
});

/**
 * Internal bot lookup for server-side callers only (the `runTest` action and any
 * future internal job). It is deliberately `internalQuery`: Convex exposes `internal*`
 * functions to other functions and the CLI but never to clients, so a guessed bot id
 * cannot be used to read someone else's bot. The payload is narrowed to the fields
 * callers need — the record is not a public object.
 */
export const getBotInternal = internalQuery({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    const bot = await ctx.db.get(botId);
    if (!bot) return null;
    return {
      _id: bot._id,
      userId: bot.userId,
      name: bot.name,
      strategyId: bot.strategyId,
    };
  },
});
