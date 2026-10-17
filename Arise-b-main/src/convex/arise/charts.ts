import { v } from "convex/values";
import { action, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { fetchMarketData, listSymbols, SUPPORTED_INTERVALS } from "../../lib/arise/providers";
import { validateBars } from "../../lib/arise/validate";
import { DEFAULT_CONFIG } from "../../lib/arise/config";

// This action proxies quota-limited third-party market-data APIs, so it is
// authenticated (no anonymous callers can burn the deployment's rate limit) and
// every input is validated and bounded before a provider request is made.
const DEFAULT_CANDLES = 300;
export const MAX_CANDLES = 1000;
export const CANDLE_REQUESTS_PER_MINUTE = 30;
const CANDLE_WINDOW_MS = 60_000;

/** Fixed-window server-side quota; a single row per user prevents key flooding. */
export const consumeCandleQuota = internalMutation({
  args: { userId: v.id("users"), now: v.number() },
  handler: async (ctx, { userId, now }) => {
    const windowStart = Math.floor(now / CANDLE_WINDOW_MS) * CANDLE_WINDOW_MS;
    const existing = await ctx.db
      .query("candleRequestLimits")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .first();
    if (!existing) {
      await ctx.db.insert("candleRequestLimits", { userId, windowStart, count: 1 });
      return { allowed: true, remaining: CANDLE_REQUESTS_PER_MINUTE - 1 };
    }
    const count = existing.windowStart === windowStart ? existing.count : 0;
    if (count >= CANDLE_REQUESTS_PER_MINUTE) {
      return { allowed: false, remaining: 0 };
    }
    await ctx.db.patch(existing._id, { windowStart, count: count + 1 });
    return { allowed: true, remaining: CANDLE_REQUESTS_PER_MINUTE - count - 1 };
  },
});

export const candles = action({
  args: { symbol: v.string(), interval: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { symbol, interval, limit }) => {
    // Provider-proxying action: an active account is required, so a disabled
    // account can neither burn the deployment's provider quota nor read data.
    const userId = await ctx.runQuery(internal.arise.trading.activeViewer, {});
    const quota = await ctx.runMutation(internal.arise.charts.consumeCandleQuota, {
      userId,
      now: Date.now(),
    });
    if (!quota.allowed) throw new Error("RATE_LIMITED: candle requests are limited to 30 per minute");
    const meta = listSymbols().find((s) => s.symbol === symbol);
    if (!meta) throw new Error(`unsupported symbol ${symbol}`);
    if (!(SUPPORTED_INTERVALS as readonly string[]).includes(interval)) {
      throw new Error(`unsupported interval ${interval}`);
    }
    const requested = limit ?? DEFAULT_CANDLES;
    if (!Number.isSafeInteger(requested) || requested <= 0 || requested > MAX_CANDLES) {
      throw new Error(`limit must be a positive number (an integer between 1 and ${MAX_CANDLES})`);
    }
    const fetched = await fetchMarketData(symbol, interval, requested);
    const { bars } = validateBars(fetched.data.bars, {
      symbol,
      assetClass: meta.assetClass,
      interval: fetched.interval,
      now: Date.now(),
      config: DEFAULT_CONFIG,
      source: fetched.data.provider,
    });
    return {
      symbol,
      interval: fetched.interval,
      requestedInterval: interval,
      source: fetched.data.provider,
      fellBack: fetched.fellBack,
      fallbackFrom: fetched.fallbackFrom ?? null,
      bestBid: fetched.data.bestBid,
      bestAsk: fetched.data.bestAsk,
      bars: bars.map((b) => ({
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      })),
    };
  },
});
