// ARISE V1 — news acquisition (REAL publisher feeds only).
//
// This is the only place ARISE reaches the public web for headlines. Every feed is a
// keyless, public RSS/Atom endpoint from the registry in src/lib/arise/news.ts, and
// every failure is isolated per feed: one dead publisher degrades coverage, it never
// silently invents it. Nothing here interprets the news — parsing and scoring are the
// pure, tested functions in src/lib/arise/news.ts.
//
// If a feed stops serving items, the honest outcome is a smaller (or empty) item set,
// which the assessment layer reports as UNAVAILABLE. Never as fake sentiment.

import { v } from "convex/values";
import { action, internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { listSymbols } from "../../lib/arise/providers";
import {
  assessNews,
  parseFeedXml,
  sourcesFor,
  type NewsAssessment,
  type NewsFeedSource,
  type RawNewsItem,
} from "../../lib/arise/news";

/** Honest, self-identifying client string — no browser impersonation. */
const USER_AGENT = "ARISE-NewsReader/1.0";
const ACCEPT = "application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1";
const FEED_TIMEOUT_MS = 8_000;

/** Per-user proxy quota. Checked BEFORE any publisher feed is contacted. */
export const NEWS_REQUESTS_PER_MINUTE = 10;
const NEWS_WINDOW_MS = 60_000;

export const consumeNewsQuota = internalMutation({
  args: { userId: v.id("users"), now: v.number() },
  handler: async (ctx, { userId, now }) => {
    const windowStart = Math.floor(now / NEWS_WINDOW_MS) * NEWS_WINDOW_MS;
    const existing = await ctx.db
      .query("newsRequestLimits")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .first();
    if (!existing) {
      await ctx.db.insert("newsRequestLimits", { userId, windowStart, count: 1 });
      return { allowed: true, remaining: NEWS_REQUESTS_PER_MINUTE - 1 };
    }
    const count = existing.windowStart === windowStart ? existing.count : 0;
    if (count >= NEWS_REQUESTS_PER_MINUTE) return { allowed: false, remaining: 0 };
    await ctx.db.patch(existing._id, { windowStart, count: count + 1 });
    return { allowed: true, remaining: NEWS_REQUESTS_PER_MINUTE - count - 1 };
  },
});

export interface FeedStatus {
  id: string;
  name: string;
  url: string;
  ok: boolean;
  httpStatus: number | null;
  itemCount: number;
  error: string | null;
  notes: string[];
}

// Explicit result types: they keep Convex's inferred API types from becoming circular
// (an action that reads `internal.*` would otherwise depend on its own inferred type).
export interface NewsFeedResult {
  fetchedAt: number;
  items: RawNewsItem[];
  feeds: FeedStatus[];
  failedFeeds: string[];
}

export interface NewsAssessResult {
  assessment: NewsAssessment;
  feeds: FeedStatus[];
  fetchedAt: number;
}

async function fetchOne(source: NewsFeedSource): Promise<{ status: FeedStatus; items: RawNewsItem[] }> {
  const base = { id: source.id, name: source.name, url: source.url };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(source.url, {
      headers: { "user-agent": USER_AGENT, accept: ACCEPT },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      return {
        status: { ...base, ok: false, httpStatus: res.status, itemCount: 0, error: `HTTP ${res.status}`, notes: [] },
        items: [],
      };
    }
    const body = await res.text();
    const parsed = parseFeedXml(body, source);
    return {
      status: {
        ...base,
        ok: true,
        httpStatus: res.status,
        itemCount: parsed.items.length,
        error: null,
        notes: parsed.notes,
      },
      items: parsed.items,
    };
  } catch (e) {
    const message = (e as Error).name === "AbortError" ? `timeout after ${FEED_TIMEOUT_MS}ms` : (e as Error).message;
    return {
      status: { ...base, ok: false, httpStatus: null, itemCount: 0, error: message, notes: [] },
      items: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Strips punctuation/case so the same story syndicated by two desks collapses to one. */
function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function dedupe(items: RawNewsItem[]): RawNewsItem[] {
  const byKey = new Map<string, RawNewsItem>();
  for (const item of items) {
    const key = titleKey(item.title);
    if (key.length === 0) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    // Prefer the higher-tier source, then the more recent timestamp.
    const betterTier = item.tier < existing.tier;
    const newer = (item.publishedAt ?? 0) > (existing.publishedAt ?? 0);
    if (betterTier || (item.tier === existing.tier && newer)) byKey.set(key, item);
  }
  return [...byKey.values()];
}

/** Fetch + parse every registered feed for an asset class. Per-feed failures are
 *  reported in `feeds`, never hidden and never substituted with invented items. */
export const fetchForAssetClass = internalAction({
  args: { assetClass: v.union(v.literal("crypto"), v.literal("forex")) },
  handler: async (_ctx, { assetClass }): Promise<NewsFeedResult> => {
    const sources = sourcesFor(assetClass);
    const settled = await Promise.all(sources.map(fetchOne));
    const items = dedupe(settled.flatMap((s) => s.items));
    return {
      fetchedAt: Date.now(),
      items,
      feeds: settled.map((s) => s.status),
      failedFeeds: settled.filter((s) => !s.status.ok).map((s) => s.status.id),
    };
  },
});

/**
 * Public news read for one symbol: fetches the real feeds, then runs the deterministic
 * assessment. Requires authentication and meters nothing — it is a read, not a decision.
 */
export const assess = action({
  args: { symbol: v.string() },
  handler: async (ctx, { symbol }): Promise<NewsAssessResult> => {
    // This action reaches third-party feeds on the deployment's behalf; a disabled
    // account must not be able to use it as an open proxy.
    const userId = await ctx.runQuery(internal.arise.trading.activeViewer, {});

    const meta = listSymbols().find((s) => s.symbol === symbol);
    if (!meta) throw new Error(`unsupported symbol ${symbol}`);

    // Per-user quota BEFORE any publisher request. The mutation is serialized per
    // user, so concurrent calls cannot race past the limit.
    const quota = await ctx.runMutation(internal.arise.news.consumeNewsQuota, {
      userId,
      now: Date.now(),
    });
    if (!quota.allowed) {
      throw new Error(
        `RATE_LIMITED: news requests are limited to ${NEWS_REQUESTS_PER_MINUTE} per minute`,
      );
    }

    const feed = await ctx.runAction(internal.arise.news.fetchForAssetClass, {
      assetClass: meta.assetClass,
    });
    const assessment = assessNews(feed.items, {
      symbol,
      assetClass: meta.assetClass,
      now: Date.now(),
    });
    return {
      assessment,
      feeds: feed.feeds,
      fetchedAt: feed.fetchedAt,
    };
  },
});
