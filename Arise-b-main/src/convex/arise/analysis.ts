// ARISE — Analysis section backend.
//
// Every public endpoint here resolves the caller from the verified identity and
// checks ownership. `analysisRecords` is deliberately append-only: there is no
// update or delete function, so a later analysis, a monitoring event or a paper
// outcome can never rewrite what was originally predicted.
//
// The arena and catalysts actions are the only places that touch the network. Both
// reserve work before the provider call (the existing atomic analysis quota), and a
// failure is reported honestly rather than replaced with synthetic data.

import { v } from "convex/values";
import { action, mutation, query } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireActiveUser } from "../lib/authz";
import { fetchMarketData, listSymbols } from "../../lib/arise/providers";
import { validateBars } from "../../lib/arise/validate";
import { DEFAULT_CONFIG } from "../../lib/arise/config";
import { runArena, type ArenaBar, type ArenaResult } from "../../lib/arise/arena";
import {
  ANALYSIS_MODEL_VERSION,
  arenaRiskVeto,
  assessMonitoring,
  buildCatalystView,
  buildTradePlanCard,
  computePerformance,
  computeRiskPreview,
  type CatalystView,
  type DecisionLike,
} from "../../lib/arise/analysis";
import { monitorHealth } from "../../lib/arise/monitor";
import { markedEquity } from "../../lib/arise/ledger";
import { createFreshnessPolicy } from "../../lib/arise/freshness";
import { intervalMs } from "../../lib/arise/quant";

const HISTORY_LIMIT = 200;
const MONITORING_LIMIT = 40;

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

// ---------------------------------------------------------------- records

/**
 * Save one analysis as an immutable snapshot. Idempotent by decision: re-saving the
 * same analysis returns the existing record rather than creating a second history
 * entry or rewriting the first.
 */
export const save = mutation({
  args: {
    decisionId: v.id("decisions"),
    strategy: v.optional(v.any()),
    news: v.optional(v.any()),
  },
  handler: async (ctx, { decisionId, strategy, news }) => {
    const { userId } = await requireActiveUser(ctx);
    const decision = await ctx.db.get(decisionId);
    if (!decision || decision.userId !== userId) throw new Error("Not found");

    const existing = await ctx.db
      .query("analysisRecords")
      .withIndex("decisionId", (q) => q.eq("decisionId", decisionId))
      .first();
    if (existing) {
      if (existing.userId !== userId) throw new Error("Not found");
      return { recordId: existing._id, created: false };
    }

    const card = buildTradePlanCard(decision as unknown as DecisionLike, Date.now());
    const strategySummary = strategy && typeof strategy === "object"
      ? {
          selectedId: typeof strategy.selectedId === "string" ? strategy.selectedId.slice(0, 80) : null,
          selectedLabel: typeof strategy.selectedLabel === "string" ? strategy.selectedLabel.slice(0, 120) : null,
          marketClass: typeof strategy.marketClass === "string" ? strategy.marketClass.slice(0, 40) : null,
          score: typeof strategy.score === "number" && Number.isFinite(strategy.score) ? strategy.score : null,
          ranking: Array.isArray(strategy.ranking)
            ? strategy.ranking.slice(0, 10).map((r: unknown) => {
                const row = r as { id?: unknown; label?: unknown; score?: unknown; status?: unknown };
                return {
                  id: typeof row.id === "string" ? row.id.slice(0, 80) : "unknown",
                  label: typeof row.label === "string" ? row.label.slice(0, 120) : "unknown",
                  score: typeof row.score === "number" && Number.isFinite(row.score) ? row.score : null,
                  status: typeof row.status === "string" ? row.status.slice(0, 40) : "UNKNOWN",
                };
              })
            : [],
        }
      : undefined;

    const recordId = await ctx.db.insert("analysisRecords", {
      userId,
      decisionId,
      createdAt: Date.now(),
      symbol: decision.symbol,
      interval: decision.interval,
      status: decision.status,
      direction: decision.direction,
      confidence: decision.confidence,
      thesis: decision.thesis,
      recommendedAction: decision.recommendedAction,
      dataQuality: decision.dataQuality,
      dataSource: decision.dataSource,
      dataTimestamp: decision.dataTimestamp,
      snapshotMeta: decision.snapshotMeta,
      plan: decision.plan,
      risk: decision.risk,
      evidence: decision.evidence,
      minds: decision.mind,
      agents: decision.agents,
      features: decision.features,
      tradeCard: card,
      strategy: strategySummary,
      news: news && typeof news === "object" ? news : undefined,
      modelVersion: ANALYSIS_MODEL_VERSION,
    });
    return { recordId, created: true };
  },
});

export const latest = query({
  args: { symbol: v.optional(v.string()) },
  handler: async (ctx, { symbol }) => {
    const { userId } = await requireActiveUser(ctx);
    const rows = await ctx.db
      .query("analysisRecords")
      .withIndex("userId_createdAt", (q) => q.eq("userId", userId))
      .order("desc")
      .take(60);
    return rows.find((r) => !symbol || r.symbol === symbol) ?? null;
  },
});

export const history = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const { userId } = await requireActiveUser(ctx);
    const take = clampLimit(limit, 60, HISTORY_LIMIT);
    const rows = await ctx.db
      .query("analysisRecords")
      .withIndex("userId_createdAt", (q) => q.eq("userId", userId))
      .order("desc")
      .take(take);
    // Projection only: the table is the audit record, the UI gets what it renders.
    return rows.map((r) => ({
      _id: r._id,
      decisionId: r.decisionId,
      createdAt: r.createdAt,
      symbol: r.symbol,
      interval: r.interval,
      status: r.status,
      direction: r.direction,
      confidence: r.confidence,
      thesis: r.thesis,
      recommendedAction: r.recommendedAction,
      dataQuality: r.dataQuality,
      dataSource: r.dataSource,
      dataTimestamp: r.dataTimestamp,
      tradeCard: r.tradeCard,
      strategy: r.strategy,
      news: r.news,
      risk: r.risk,
      evidence: r.evidence,
      plan: r.plan,
      modelVersion: r.modelVersion,
    }));
  },
});

// ---------------------------------------------------------------- monitoring

/**
 * Saved predictions vs subsequent market observations. Marks are taken ONLY from
 * validated decision snapshots and are checked against the paper entry timestamp by
 * the pure assessor, so no pre-entry candle can be used to judge post-entry
 * performance. Unavailable data is returned as unavailable, not filled in.
 */
export const monitoring = query({
  args: { symbol: v.optional(v.string()) },
  handler: async (ctx, { symbol }) => {
    const { userId } = await requireActiveUser(ctx);
    const [records, positions, decisions] = await Promise.all([
      ctx.db
        .query("analysisRecords")
        .withIndex("userId_createdAt", (q) => q.eq("userId", userId))
        .order("desc")
        .take(MONITORING_LIMIT),
      ctx.db.query("positions").withIndex("userId", (q) => q.eq("userId", userId)).order("desc").take(MONITORING_LIMIT),
      ctx.db.query("decisions").withIndex("userId", (q) => q.eq("userId", userId)).order("desc").take(60),
    ]);

    const marks = new Map<string, { symbol: string; price: number; time: number; interval: string; completed: boolean }>();
    for (const d of decisions) {
      const meta = d.snapshotMeta as { lastClose?: number; lastBarTime?: number } | undefined;
      if (typeof meta?.lastClose === "number" && meta.lastClose > 0) {
        const time = typeof meta.lastBarTime === "number" ? meta.lastBarTime : d.dataTimestamp;
        const current = marks.get(d.symbol);
        if (!current || current.time < time) {
          marks.set(d.symbol, {
            symbol: d.symbol,
            price: meta.lastClose,
            time,
            interval: d.interval,
            // A bar is completed only once its full interval has elapsed. Treating a
            // forming candle as completed would let monitoring judge an unfinished price.
            completed: time + intervalMs(d.interval) <= Date.now(),
          });
        }
      }
    }

    const filtered = symbol ? records.filter((r) => r.symbol === symbol) : records;
    return filtered.map((record) => {
      const decision = decisions.find((d) => d._id === record.decisionId) ?? null;
      const position = positions.find((p) => p.decisionId === record.decisionId) ?? null;
      const assessment = assessMonitoring({
        decision: (decision ?? record) as unknown as DecisionLike,
        position,
        mark: marks.get(record.symbol) ?? null,
        now: Date.now(),
        barStaleMultiplier: DEFAULT_CONFIG.barStaleMultiplier,
      });
      return { record, position, decision, assessment };
    });
  },
});

// ---------------------------------------------------------------- performance

export const performance = query({
  args: {},
  handler: async (ctx) => {
    const { userId } = await requireActiveUser(ctx);
    const [records, positions, equity] = await Promise.all([
      ctx.db
        .query("analysisRecords")
        .withIndex("userId_createdAt", (q) => q.eq("userId", userId))
        .order("desc")
        .take(HISTORY_LIMIT),
      ctx.db.query("positions").withIndex("userId", (q) => q.eq("userId", userId)).order("desc").take(HISTORY_LIMIT),
      ctx.db.query("equityPoints").withIndex("userId_t", (q) => q.eq("userId", userId)).take(500),
    ]);
    return computePerformance(
      records.map((r) => ({
        decisionId: r.decisionId,
        symbol: r.symbol,
        interval: r.interval,
        direction: r.direction,
        status: r.status,
        confidence: r.confidence,
        dataTimestamp: r.dataTimestamp,
        snapshotMeta: r.snapshotMeta as { lastClose?: number } | undefined,
        strategy: r.strategy as { selectedId?: string } | undefined,
      })),
      positions.map((p) => ({
        _id: p._id,
        decisionId: p.decisionId,
        symbol: p.symbol,
        side: p.side,
        status: p.status,
        pnl: p.pnl,
        entryFee: p.entryFee,
        exitFee: p.exitFee,
        openedAt: p.openedAt,
        closedAt: p.closedAt,
        exitReason: p.exitReason,
      })),
      equity.map((e) => ({ t: e.t, equity: e.equity })),
    );
  },
});

// ---------------------------------------------------------------- module health

export const health = query({
  args: {},
  handler: async (ctx) => {
    const { userId } = await requireActiveUser(ctx);
    const [account, decisions, records, monitorRow, events] = await Promise.all([
      ctx.db.query("paperAccounts").withIndex("userId", (q) => q.eq("userId", userId)).first(),
      ctx.db.query("decisions").withIndex("userId", (q) => q.eq("userId", userId)).order("desc").take(1),
      ctx.db.query("analysisRecords").withIndex("userId_createdAt", (q) => q.eq("userId", userId)).order("desc").take(1),
      ctx.db.query("monitorState").withIndex("key", (q) => q.eq("key", "monitor")).first(),
      ctx.db.query("systemEvents").withIndex("at", (q) => q.gte("at", 0)).order("desc").take(200),
    ]);
    const mh = monitorHealth(monitorRow?.recentTicks ?? [], Date.now());
    const arenaEvent = events.find((e) => e.code === "STRATEGY_ARENA_RUN");
    const dataFailures = events.filter(
      (e) => e.area === "DATA" && e.level === "ERROR" && Date.now() - e.at < 7 * 86_400_000,
    );
    return {
      latestDecision: decisions[0] ?? null,
      latestRecord: records[0] ?? null,
      monitor: { state: mh.state, lastTickAt: mh.lastTickAt, detail: mh.detail },
      account: account ? { emergencyStop: account.emergencyStop } : null,
      arenaRanAt: arenaEvent?.at ?? null,
      providerFailureCount: dataFailures.length,
      providerEventAt: dataFailures[0]?.at ?? decisions[0]?.dataTimestamp ?? null,
    };
  },
});

// ---------------------------------------------------------------- strategy arena

const INTERVAL_ARG = v.union(
  v.literal("5m"),
  v.literal("15m"),
  v.literal("1h"),
  v.literal("4h"),
  v.literal("1d"),
);

export const strategyArena = action({
  args: { symbol: v.string(), interval: INTERVAL_ARG },
  handler: async (ctx, { symbol, interval }) => {
    const userId = await ctx.runQuery(internal.arise.trading.activeViewer, {});
    const halt = await ctx.runQuery(internal.arise.admin.platformHaltState, {});
    if (halt.tradingHalted) throw new Error(`PLATFORM_HALTED: ${halt.haltReason ?? "administrative halt"}`);

    const meta = listSymbols().find((s) => s.symbol === symbol);
    if (!meta) throw new Error(`UNSUPPORTED_SYMBOL: ${symbol}`);

    // Atomic reservation BEFORE the provider call. A failed fetch consumes the
    // reservation, exactly like the decision action: quota protects provider work,
    // not only successful analyses.
    await ctx.runMutation(internal.arise.billingFunctions.reserveAnalysisInternal, {});

    let fetched;
    try {
      fetched = await fetchMarketData(symbol, interval, 500);
    } catch (e) {
      await ctx.runMutation(internal.arise.system.record, {
        level: "ERROR",
        area: "DATA",
        code: "ARENA_PROVIDER_FAILURE",
        message: `${symbol}/${interval}: ${(e as Error).message}`.slice(0, 400),
        at: Date.now(),
      });
      throw new Error(`MARKET_DATA_UNAVAILABLE: ${(e as Error).message}`);
    }

    // Fallback changes the instrument/timeframe; an arena built on it would compare
    // strategies on data the caller did not ask for. Reject instead of relabelling.
    if (fetched.fellBack) {
      throw new Error(`ARENA_DATA_PROVENANCE: provider fell back to ${fetched.fallbackFrom ?? "another source"}`);
    }
    if (fetched.interval !== interval) {
      throw new Error(`ARENA_DATA_PROVENANCE: provider served ${fetched.interval} instead of ${interval}`);
    }

    const now = Date.now();
    const validation = validateBars(fetched.data.bars, {
      symbol,
      assetClass: meta.assetClass,
      interval: fetched.interval,
      now,
      config: DEFAULT_CONFIG,
      source: fetched.data.provider,
    });
    if (validation.quality === "invalid" || validation.bars.length < DEFAULT_CONFIG.minBars) {
      throw new Error(`DATA_INVALID: ${validation.quality} series with ${validation.bars.length} bars`);
    }

    const bars: ArenaBar[] = validation.bars.map((b) => ({
      time: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));
    const last = bars[bars.length - 1];
    const arena = runArena(bars, {
      symbol,
      interval: fetched.interval,
      dataSource: fetched.data.provider,
      now,
    });

    // Stage 4 — deterministic risk review of the selected candidate. The risk engine
    // has veto authority; a failed review is reported as NO TRADE, not overridden.
    const [account, open] = await Promise.all([
      ctx.runQuery(internal.arise.trading.internalGetAccount, {}),
      ctx.runQuery(internal.arise.trading.listOpenPositions, { userId }),
    ]);
    let riskReview = null;
    if (arena.selected && arena.selected.signal !== 0) {
      const atrWindow = bars.slice(-15);
      const atr = (() => {
        let sum = 0;
        for (let i = 1; i < atrWindow.length; i++) {
          const prev = atrWindow[i - 1].close;
          sum += Math.max(
            atrWindow[i].high - atrWindow[i].low,
            Math.abs(atrWindow[i].high - prev),
            Math.abs(atrWindow[i].low - prev),
          );
        }
        return sum / Math.max(1, atrWindow.length - 1);
      })();
      const openNotional = open.reduce((acc, p) => acc + p.qty * p.entryPrice, 0);
      const equityMark = account
        ? markedEquity(account.balance, open, {}, {
            now,
            policy: createFreshnessPolicy(DEFAULT_CONFIG.barStaleMultiplier),
          }).equity
        : DEFAULT_CONFIG.startingBalance;
      riskReview = computeRiskPreview({
        side: arena.selected.signal === 1 ? "LONG" : "SHORT",
        entry: last.close,
        atr,
        equity: account ? Math.max(account.balance, equityMark) : DEFAULT_CONFIG.startingBalance,
        balance: account?.balance ?? 0,
        dayStartEquity: account?.dayStartEquity ?? 0,
        highWaterMark: account?.equityHighWaterMark ?? 0,
        openNotional,
        openPositions: open.length,
        emergencyStop: account?.emergencyStop ?? true,
        config: DEFAULT_CONFIG,
      });
    }

    // Stage 4 must gate Stage 5. A risk veto clears the winner: an arena result may
    // never present a risk-blocked strategy as the selection, and saving it must be
    // impossible because there is no selected strategy left to attach.
    const riskVeto = arenaRiskVeto(arena.selected, riskReview);
    const effectiveArena: ArenaResult = riskVeto
      ? {
          ...arena,
          selected: null,
          selectedId: null,
          selectedReason: "",
          noTradeReason: `RISK_VETO: ${riskVeto.label} was the strongest eligible strategy, but the deterministic risk review returned NO_TRADE (${riskVeto.reasonCode}: ${riskVeto.message}).`,
        }
      : arena;

    await ctx.runMutation(internal.arise.system.record, {
      level: riskVeto ? "WARN" : "INFO",
      area: "AI",
      code: "STRATEGY_ARENA_RUN",
      message: `${symbol}/${fetched.interval}: ${effectiveArena.selected?.label ?? "NO TRADE"} · ${arena.marketClass} · ${bars.length} bars${riskVeto ? ` · RISK_VETO ${riskVeto.reasonCode}` : ""}`,
      at: now,
    });

    return {
      arena: effectiveArena,
      riskReview,
      riskVeto,
      provenance: {
        provider: fetched.data.provider,
        interval: fetched.interval,
        requestedInterval: interval,
        fellBack: fetched.fellBack,
        quality: validation.quality,
        notes: validation.notes,
        bars: validation.bars.length,
        lastBarTime: last.time,
      },
      execution: "SIGNAL_ONLY" as const,
    };
  },
});

// ---------------------------------------------------------------- catalysts

const CATALYST_TIMEOUT_MS = 8_000;

export const catalysts = action({
  args: { symbol: v.optional(v.string()) },
  handler: async (ctx, { symbol }): Promise<CatalystView> => {
    const userId = await ctx.runQuery(internal.arise.trading.activeViewer, {});
    const configuredUrl = process.env.ECONOMIC_CALENDAR_URL;
    const now = Date.now();
    if (!configuredUrl) {
      return buildCatalystView({ configured: false, now, provider: null });
    }

    // Reuse the per-user news quota so a client cannot turn this proxy into an
    // unbounded provider fetch loop. It is checked before any network call.
    const quota = await ctx.runMutation(internal.arise.news.consumeNewsQuota, { userId, now });
    if (!quota.allowed) {
      return {
        ...buildCatalystView({ configured: true, now, provider: "configured calendar" }),
        status: "INVALID",
        notes: ["Rate limit reached for catalyst requests. No provider call was made."],
      };
    }

    let url: URL;
    try {
      url = new URL(configuredUrl);
    } catch {
      return {
        ...buildCatalystView({ configured: true, now, provider: null }),
        status: "INVALID",
        notes: ["ECONOMIC_CALENDAR_URL is not a valid URL. No request was sent."],
      };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return {
        ...buildCatalystView({ configured: true, now, provider: null }),
        status: "INVALID",
        notes: ["ECONOMIC_CALENDAR_URL must be http(s)."],
      };
    }
    if (url.username || url.password) {
      return {
        ...buildCatalystView({ configured: true, now, provider: url.hostname }),
        status: "INVALID",
        notes: ["ECONOMIC_CALENDAR_URL must not embed credentials; use ECONOMIC_CALENDAR_API_KEY."],
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CATALYST_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        "user-agent": "ARISE-Analysis/1.0",
        accept: "application/json",
      };
      if (process.env.ECONOMIC_CALENDAR_API_KEY) {
        headers["x-api-key"] = process.env.ECONOMIC_CALENDAR_API_KEY;
      }
      // Redirects are refused: a cross-origin redirect could carry the API key to a
      // host the owner did not configure.
      const response = await fetch(url.toString(), { headers, signal: controller.signal, redirect: "error" });
      if (!response.ok) {
        return {
          ...buildCatalystView({ configured: true, now, provider: url.hostname }),
          status: "INVALID",
          notes: [`Catalyst provider returned HTTP ${response.status}; no events are shown.`],
        };
      }
      const body = await response.text();
      if (body.length > 512_000) {
        return {
          ...buildCatalystView({ configured: true, now, provider: url.hostname }),
          status: "INVALID",
          notes: ["Catalyst provider payload exceeded the 512 KB limit and was refused."],
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return {
          ...buildCatalystView({ configured: true, now, provider: url.hostname }),
          status: "INVALID",
          notes: ["Catalyst provider did not return JSON; no events are shown."],
        };
      }
      const view = buildCatalystView({
        configured: true,
        provider: url.hostname,
        raw: parsed,
        now,
        fetchedAt: now,
      });
      if (symbol && view.events.length > 0) {
        const base = symbol.replace(/(USDT|USDC|USD|PERP)$/i, "").toUpperCase();
        const relevant = view.events.filter(
          (e) =>
            e.affectedAssets.length === 0 ||
            e.affectedAssets.some((a) => {
              const asset = a.toUpperCase();
              return asset.includes(base) || base.includes(asset.replace(/(USDT|USDC|USD|PERP)$/i, ""));
            }),
        );
        return { ...view, events: relevant };
      }
      return view;
    } catch (e) {
      const message = (e as Error).name === "AbortError" ? "timeout" : (e as Error).message;
      await ctx.runMutation(internal.arise.system.record, {
        level: "WARN",
        area: "DATA",
        code: "CATALYST_FETCH_FAILED",
        message: message.slice(0, 300),
        at: Date.now(),
      });
      return {
        ...buildCatalystView({ configured: true, now, provider: url.hostname }),
        status: "INVALID",
        notes: [`Catalyst provider request failed: ${message}. No events are invented.`],
      };
    } finally {
      clearTimeout(timer);
    }
  },
});
