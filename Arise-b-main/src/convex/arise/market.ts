import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  fetchMarketData,
  isPrimarySeries,
  listSymbols,
} from "../../lib/arise/providers";
import { buildSnapshot, runDecisionPipeline } from "../../lib/arise/pipeline";
import { DEFAULT_CONFIG } from "../../lib/arise/config";
import { validateExecution } from "../../lib/arise/risk";
import { PaperBroker, LIVE_TRADING_ENABLED } from "../../lib/arise/execution";
import { markedEquity, type Mark } from "../../lib/arise/ledger";
import type { RawNewsItem } from "../../lib/arise/news";
import { createFreshnessPolicy, isFresh } from "../../lib/arise/freshness";
import { intervalMs } from "../../lib/arise/quant";
import type { PipelineAccount } from "../../lib/arise/pipeline";

export const decide = action({
  args: { symbol: v.string(), interval: v.string(), execute: v.boolean() },
  handler: async (ctx, { symbol, interval, execute }) => {
    if (LIVE_TRADING_ENABLED) {
      throw new Error("LIVE_TRADING_ENABLED must be false in V1");
    }
    // -------- account-level access guard (disabled/deleted users are blocked) --------
    // Resolved from the verified identity through the shared helper, so a missing
    // user row and a disabled account are both rejected before any work happens.
    const userId = await ctx.runQuery(internal.arise.trading.activeViewer, {});

    // -------- platform-wide halt guard (admin control plane) --------
    const halt = await ctx.runQuery(internal.arise.admin.platformHaltState, {});
    if (halt.tradingHalted) {
      throw new Error(`PLATFORM_HALTED: ${halt.haltReason ?? "administrative halt"}`);
    }

    const now = Date.now();
    const cfg = { ...DEFAULT_CONFIG };

    const acct = await ctx.runQuery(internal.arise.trading.internalGetAccount, {});
    if (!acct) throw new Error("Initialize your paper account first");
    if (acct.emergencyStop) {
      throw new Error("EMERGENCY_STOP_ACTIVE: all new trades blocked");
    }

    const meta = listSymbols().find((s) => s.symbol === symbol);
    if (!meta) throw new Error(`unsupported symbol ${symbol}`);

    // -------- plan quota (atomic, before any provider work) --------
    // Check-and-increment in one serialized mutation. A separate read followed by a
    // later increment let concurrent requests all pass on the last remaining analysis.
    await ctx.runMutation(internal.arise.billingFunctions.reserveAnalysisInternal, {});

    // -------- market data (real providers only) --------
    const fetchStart = Date.now();
    let fetched;
    try {
      fetched = await fetchMarketData(symbol, interval, 400);
    } catch (e) {
      const msg = (e as Error).message;
      await ctx.runMutation(internal.arise.system.record, {
        level: "ERROR", area: "DATA", code: "PROVIDER_FAILURE",
        message: `${symbol}: ${msg}`, at: Date.now(),
      });
      throw new Error(`MARKET_DATA_UNAVAILABLE: ${msg}`);
    }
    const fetchMs = Date.now() - fetchStart;

    // A decision that can execute may only use the requested instrument and
    // interval from its primary provider. A Delta demo perpetual (BTCUSD) is not
    // Binance spot (BTCUSDT), and a 15m fallback is not the requested 1h series.
    // The 4h Yahoo resample is same-provider/same-interval and remains allowed.
    if (!isPrimarySeries(symbol, fetched)) {
      const detail = `primary ${meta.assetClass} series unavailable; got ${fetched.data.provider} ${fetched.interval}${fetched.fellBack ? ` (fallback: ${fetched.fallbackFrom ?? "unknown"})` : ""}`;
      await ctx.runMutation(internal.arise.system.record, {
        level: "ERROR", area: "DATA", code: "DATA_PROVENANCE_INVALID",
        message: `${symbol}: ${detail}`.slice(0, 400), at: Date.now(),
      });
      throw new Error(`DATA_INVALID: ${detail}`);
    }

    const { snapshot, errorCode } = buildSnapshot(fetched.data.bars, {
      symbol,
      assetClass: meta.assetClass,
      interval: fetched.interval,
      now,
      config: cfg,
      bestBid: fetched.data.bestBid,
      bestAsk: fetched.data.bestAsk,
      source: fetched.data.provider,
    });
    if (!snapshot || errorCode) {
      await ctx.runMutation(internal.arise.system.record, {
        level: "ERROR", area: "DATA", code: errorCode ?? "SNAPSHOT_FAILED",
        message: `${symbol}: snapshot failed`, at: Date.now(),
      });
      throw new Error(`DATA_INVALID: ${errorCode ?? "snapshot failed"}`);
    }

    // -------- mark open positions & account state --------
    const openPositions = await ctx.runQuery(internal.arise.trading.listOpenPositions, { userId });
    const markSymbols = [...new Set([...openPositions.map((position) => position.symbol), symbol])];
    const marks: Record<string, Mark> = {};
    const markErrors: string[] = [];
    let portfolioFetchMs = 0;
    for (const markSymbol of markSymbols) {
      const markMeta = listSymbols().find((item) => item.symbol === markSymbol);
      if (!markMeta) {
        markErrors.push(`${markSymbol}: unsupported symbol`);
        continue;
      }
      const markStart = Date.now();
      try {
        // Fetch a full validation window: buildSnapshot applies the same minBars
        // requirement as a decision, so a 10-bar mark series would always look
        // degraded and block every portfolio-bearing decision.
        const markFetch = markSymbol === symbol ? fetched : await fetchMarketData(markSymbol, interval, 400);
        portfolioFetchMs += Date.now() - markStart;
        if (!isPrimarySeries(markSymbol, markFetch)) {
          markErrors.push(`${markSymbol}: primary ${markMeta.assetClass} series unavailable (${markFetch.data.provider} ${markFetch.interval})`);
          continue;
        }
        const validated = buildSnapshot(markFetch.data.bars, {
          symbol: markSymbol,
          assetClass: markMeta.assetClass,
          interval: markFetch.interval,
          now,
          config: cfg,
          bestBid: markFetch.data.bestBid,
          bestAsk: markFetch.data.bestAsk,
          source: markFetch.data.provider,
        });
        if (!validated.snapshot || validated.snapshot.quality !== "valid") {
          markErrors.push(`${markSymbol}: market data ${validated.snapshot?.quality ?? "invalid"}`);
          continue;
        }
        const completedBars = validated.snapshot.bars.filter(
          (bar) => bar.time + intervalMs(markFetch.interval) <= now,
        );
        const completed = completedBars[completedBars.length - 1];
        if (!completed || !isFresh({ price: completed.close, time: completed.time, interval: markFetch.interval, completed: true }, now, createFreshnessPolicy(cfg.barStaleMultiplier)).fresh) {
          markErrors.push(`${markSymbol}: no fresh completed candle`);
          continue;
        }
        marks[markSymbol] = {
          symbol: markSymbol,
          price: completed.close,
          time: completed.time,
          interval: markFetch.interval,
          completed: true,
        };
      } catch (e) {
        portfolioFetchMs += Date.now() - markStart;
        markErrors.push(`${markSymbol}: ${(e as Error).message}`);
      }
    }
    const markedAt = Date.now();
    const prepared = await ctx.runMutation(internal.arise.trading.markAccount, {
      userId,
      marks: Object.values(marks),
      barStaleMultiplier: cfg.barStaleMultiplier,
      requiredSymbols: markSymbols,
    });
    if (!prepared) throw new Error("Paper account unavailable");
    const markedAcct = prepared;
    const openPositionsAtRisk = markedAcct.positions;
    const marked = markedEquity(markedAcct.account.balance, openPositionsAtRisk, marks, {
      now: markedAt,
      policy: createFreshnessPolicy(cfg.barStaleMultiplier),
      requiredSymbols: [...new Set([...openPositionsAtRisk.map((position) => position.symbol), symbol])],
    });
    const openNotional = openPositionsAtRisk.reduce(
      (acc: number, p: { qty: number; entryPrice: number }) => acc + p.qty * p.entryPrice,
      0,
    );

    const account: PipelineAccount = {
      equity: marked.complete ? marked.equity : markedAcct.account.balance,
      balance: markedAcct.account.balance,
      dayStartEquity: markedAcct.account.dayStartEquity,
      highWaterMark: markedAcct.account.equityHighWaterMark,
      openPositions: openPositionsAtRisk.length,
      openPositionNotional: openNotional,
      emergencyStop: markedAcct.account.emergencyStop,
    };

    // -------- news layer (real publisher feeds; a failure never blocks the trade) --------
    // Absent news is reported as UNAVAILABLE and contributes zero directional weight —
    // it is never a veto, and it is never replaced with invented sentiment.
    let newsItems: RawNewsItem[] = [];
    const newsStart = Date.now();
    try {
      const newsFeed = await ctx.runAction(internal.arise.news.fetchForAssetClass, {
        assetClass: meta.assetClass,
      });
      newsItems = newsFeed.items;
      if (newsFeed.failedFeeds.length > 0) {
        await ctx.runMutation(internal.arise.system.record, {
          level: "WARN",
          area: "DATA",
          code: "NEWS_FEED_DEGRADED",
          message: `${symbol}: feed(s) unavailable — ${newsFeed.failedFeeds.join(", ")}`.slice(0, 400),
          at: Date.now(),
        });
      }
    } catch (e) {
      await ctx.runMutation(internal.arise.system.record, {
        level: "WARN",
        area: "DATA",
        code: "NEWS_FETCH_FAILED",
        message: `${symbol}: ${(e as Error).message}`.slice(0, 400),
        at: Date.now(),
      }).catch(() => undefined);
    }
    const newsFetchMs = Date.now() - newsStart;

    // -------- decision pipeline --------
    const result = runDecisionPipeline(snapshot, account, cfg, now, newsItems, {
      // Required, not defaulted: the evidence gate must be told the real execution
      // mode, so a caller can never let it assume paper mode by omission.
      paperMode: !LIVE_TRADING_ENABLED,
    });
    if (!result.snapshot || !result.features || !result.agents || !result.mind || !result.riskDecision) {
      throw new Error(`PIPELINE_FAILED: ${result.errorCode ?? "unknown"}`);
    }

    const riskChecks = result.riskDecision.checks.map((c) => ({
      rule: c.rule, pass: c.pass, detail: c.detail,
    }));
    if (!marked.complete) {
      riskChecks.push({
        rule: "MARKS_UNAVAILABLE",
        pass: false,
        detail: `Fresh completed marks unavailable for: ${marked.usedFallback.join(", ")}${markErrors.length ? ` (${markErrors.join("; ")})` : ""}`,
      });
    }
    const riskDecision = marked.complete
      ? result.riskDecision
      : { ...result.riskDecision, decision: "VETOED" as const, reasonCode: "MARKS_UNAVAILABLE", message: `Fresh completed marks unavailable for: ${marked.usedFallback.join(", ")}`, approvedPositionSize: 0 };
    const plan = marked.complete ? result.plan : null;

    let execution: Record<string, unknown> | undefined;
    // The deterministic evidence gate is the authority on authorization. The
    // marks veto (account equity cannot be trusted) tightens it further and is
    // applied first so no downstream code can widen it again. `REJECT` is
    // persisted as "VETOED" to keep the operator vocabulary and audit schema
    // stable; the canonical TRADE/WAIT/REJECT verdict is stored in `evidence`.
    const evidenceOutcome = result.evidence ? result.evidence.outcome : "REJECT";
    const decisionStatus =
      !marked.complete || evidenceOutcome === "REJECT"
        ? "VETOED"
        : evidenceOutcome === "WAIT"
          ? "WAIT"
          : "TRADE";

    // -------- optional paper execution --------
    // Deterministic per-candle execution key: the same candle can never open a
    // second position, even across retries or concurrent requests.
    let executionIdemKey: string | undefined;
    if (
      execute &&
      riskDecision.decision !== "VETOED" &&
      plan &&
      decisionStatus === "TRADE"
    ) {
      const approvedQty = Math.min(riskDecision.approvedPositionSize, plan.positionSize);
      const ex = validateExecution(
        { symbol, side: plan.side, qty: approvedQty, type: "MARKET" },
        {
          bestBid: snapshot.bestBid,
          bestAsk: snapshot.bestAsk,
          lastClose: snapshot.latest.close,
          spreadPct: snapshot.spreadPct,
        },
        cfg,
      );
      if (!ex.ok) {
        execution = { status: "REJECTED", reason: ex.reasonCode };
      } else {
        const broker = new PaperBroker({
          lastClose: snapshot.latest.close,
          bestBid: snapshot.bestBid,
          bestAsk: snapshot.bestAsk,
        });
        const idemKey = `p:${userId}:${symbol}:${fetched.interval}:${snapshot.latest.time}`;
        executionIdemKey = idemKey;
        const fill = broker.submitOrder({
          idempotencyKey: idemKey,
          symbol,
          side: plan.side,
          qty: approvedQty,
          type: "MARKET",
          createdAt: now,
          status: "CREATED",
        });
        if (fill.status === "FILLED") {
          execution = {
            // NOT "FILLED" yet: the position row does not exist. The decision is
            // persisted with this intermediate status and finalized only after
            // openPosition succeeds (or marked FAILED if it does not).
            status: "PENDING_POSITION",
            fillPrice: fill.fillPrice,
            qty: fill.filledQty,
            fee: fill.fee,
            slippageBps: fill.slippageBps,
            broker: broker.name,
            stop: plan.stopLoss,
            target: plan.takeProfit,
          };
        } else {
          execution = { status: fill.status, reason: "BROKER_REJECT" };
        }
      }
    }

    // -------- record decision (audit trail) --------
    const decisionId: Id<"decisions"> = await ctx.runMutation(internal.arise.decisions.record, {
      userId,
      symbol,
      interval: fetched.interval,
      requestedInterval: interval,
      mode: "paper" as const,
      status: decisionStatus,
      direction: result.mind.direction,
      confidence: result.mind.confidence,
      regime: result.agents.regimeResolved,
      thesis: result.mind.thesis,
      recommendedAction: result.mind.recommendedAction,
      dataQuality: snapshot.quality,
      dataAgeSec: snapshot.quoteAgeSec,
      dataSource: snapshot.source,
      dataTimestamp: snapshot.latest.time,
      mind: { ...result.mind, plan: result.plan },
      agents: {
        quant: result.agents.quant,
        technical: result.agents.technical,
        regime: result.agents.regime,
        anomaly: result.agents.anomaly,
        portfolio: result.agents.portfolio,
        risk: result.agents.risk,
        news: result.agents.news,
      },
      features: result.features,
      snapshotMeta: {
        quality: snapshot.quality,
        notes: snapshot.qualityNotes,
        bars: snapshot.bars.length,
        lastClose: snapshot.latest.close,
        lastBarTime: snapshot.latest.time,
        spreadPct: snapshot.spreadPct,
        fetchMs: fetchMs + portfolioFetchMs,
        source: snapshot.source,
        fallback: fetched.fellBack ? fetched.fallbackFrom : null,
        newsFetchMs,
        newsStatus: result.news?.status ?? "UNAVAILABLE",
        newsScore: result.news?.score ?? null,
        newsFreshCount: result.news?.freshCount ?? 0,
      },
      risk: { ...riskDecision, checks: riskChecks },
      plan: plan ?? null,
      execution: execution ?? null,
      evidence: result.evidence
        ? {
            ...result.evidence.assessment,
            candidate: result.evidence.candidate,
            downgraded: result.evidence.downgraded,
          }
        : undefined,
      error: undefined,
    });

    // -------- link fill to position & open it --------
    if (execution && execution.status === "PENDING_POSITION") {
      // Response type is annotated explicitly: relying on inference here makes
      // `decide`'s return type circular through the generated API types.
      let opened: { positionId: Id<"positions">; duplicate: boolean };
      try {
        opened = await ctx.runMutation(internal.arise.trading.openPosition, {
          userId,
          decisionId,
          symbol,
          side: String(execution.side ?? (result.plan as { side: string }).side),
          qty: Number(execution.qty),
          entryPrice: Number(execution.fillPrice),
          stopLoss: Number(execution.stop),
          takeProfit: Number(execution.target),
          entryFee: Number(execution.fee),
          maxLossQuote: Number(execution.qty) * Math.abs(Number(execution.fillPrice) - Number(execution.stop)),
          thesis: result.mind.thesis,
          riskDecision: riskDecision.reasonCode,
          marks: Object.values(marks),
          barStaleMultiplier: cfg.barStaleMultiplier,
          idemKey: executionIdemKey,
        });
      } catch (e) {
        // The fill simulation succeeded but the position could not be opened. Record
        // that truthfully (never FILLED) and surface the failure to the caller.
        const message = (e as Error).message;
        execution = {
          ...execution,
          status: "FAILED",
          reason: "POSITION_OPEN_FAILED",
          message: message.slice(0, 300),
        };
        await ctx
          .runMutation(internal.arise.decisions.setExecution, {
            id: decisionId,
            userId,
            execution,
            error: message.slice(0, 500),
            status: "ERROR",
          })
          .catch(() => undefined);
        throw e;
      }

      execution = {
        ...execution,
        status: opened.duplicate ? "DUPLICATE_SUPPRESSED" : "FILLED",
        positionId: opened.positionId,
      };
      // Finalize the audit record. If this patch fails the decision stays
      // PENDING_POSITION (truthful: position exists, linkage unconfirmed) and an
      // operator event records the inconsistency rather than claiming a fill.
      try {
        await ctx.runMutation(internal.arise.decisions.setExecution, {
          id: decisionId,
          userId,
          execution,
        });
      } catch (e) {
        await ctx
          .runMutation(internal.arise.system.record, {
            level: "ERROR",
            area: "EXECUTION",
            code: "DECISION_FINALIZE_FAILED",
            message: `decision ${decisionId}: position ${opened.positionId} created but execution status could not be finalized: ${(e as Error).message}`.slice(0, 400),
            at: Date.now(),
          })
          .catch(() => undefined);
      }

      // -------- Delta demo mirror (best-effort; never blocks the paper trade) --------
      // Suppressed duplicates never mirror: a repeated request must not place a
      // second demo order for the same candle.
      if (!opened.duplicate) {
        try {
          const mirror = await ctx.runAction(internal.arise.delta.mirrorOrder, {
            symbol,
            side: result.mind.direction === "SHORT" ? ("sell" as const) : ("buy" as const),
            qty: Number(execution.qty),
            refId: String(decisionId),
          });
          await ctx.runMutation(internal.arise.system.record, {
            level: mirror.ok ? "INFO" : "WARN",
            area: "EXECUTION",
            code: mirror.ok ? "DELTA_MIRROR_OK" : mirror.skipped ? "DELTA_MIRROR_SKIPPED" : "DELTA_MIRROR_FAILED",
            message: `${symbol}: ${mirror.detail ?? `order ${mirror.orderId} ${mirror.status}`}`.slice(0, 400),
            at: Date.now(),
          });
        } catch (e) {
          await ctx.runMutation(internal.arise.system.record, {
            level: "WARN",
            area: "EXECUTION",
            code: "DELTA_MIRROR_FAILED",
            message: `${symbol}: ${(e as Error).message}`.slice(0, 400),
            at: Date.now(),
          }).catch(() => undefined);
        }
      }
    }

    // -------- position maintenance (SL/TP against the new bars) --------
    const lastBar = snapshot.bars[snapshot.bars.length - 1];
    await ctx.runMutation(internal.arise.trading.maintainPositions, {
      userId,
      marks: [{ symbol, close: lastBar.close, time: lastBar.time, high: lastBar.high, low: lastBar.low, interval: snapshot.interval }],
      portfolioMarks: Object.values(marks),
      barStaleMultiplier: cfg.barStaleMultiplier,
    });

    // -------- equity point (monitoring) --------
    const updatedAcct = await ctx.runQuery(internal.arise.trading.internalGetAccount, {});
    const remainingOpen = await ctx.runQuery(internal.arise.trading.listOpenPositions, { userId });
    if (updatedAcct) {
      const pointAt = Date.now();
      const equityResult = markedEquity(updatedAcct.balance, remainingOpen, marks, {
        now: pointAt,
        policy: createFreshnessPolicy(cfg.barStaleMultiplier),
        requiredSymbols: [...new Set(remainingOpen.map((position) => position.symbol))],
      });
      if (equityResult.complete) {
        const dd =
          updatedAcct.equityHighWaterMark > 0
            ? Math.max(0, ((updatedAcct.equityHighWaterMark - equityResult.equity) / updatedAcct.equityHighWaterMark) * 100)
            : 0;
        await ctx.runMutation(internal.arise.trading.recordEquityPoint, {
          userId, t: pointAt, equity: equityResult.equity, cash: updatedAcct.balance, drawdownPct: dd,
        });
      }
    }

    return {
      ok: true,
      decisionId,
      status: decisionStatus,
      direction: result.mind.direction,
      confidence: result.mind.confidence,
      regime: result.agents.regimeResolved,
      thesis: result.mind.thesis,
      recommendedAction: result.mind.recommendedAction,
      dataQuality: snapshot.quality,
      dataAgeSec: snapshot.quoteAgeSec,
      execution: execution ?? null,
      riskChecks,
      news: result.news
        ? {
            status: result.news.status,
            signal: result.news.signal,
            score: result.news.score,
            confidence: result.news.confidence,
            freshCount: result.news.freshCount,
            drivers: result.news.drivers,
          }
        : null,
      fetchMs: fetchMs + portfolioFetchMs,
    };
  },
});
