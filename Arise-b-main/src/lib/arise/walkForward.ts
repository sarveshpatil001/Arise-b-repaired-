// ARISE V1 — walk-forward validation engine (pure, deterministic, no network).
//
// WHY this exists: `strategyFitness.ts` requires walk-forward folds and parameter
// perturbations before a strategy can be promoted, and a single backtest run cannot
// produce either. Without this engine every gate that needs out-of-sample evidence
// fails closed forever, which is safe but useless — no strategy can ever be promoted.
// This module produces that evidence honestly, or refuses to produce a verdict.
//
// The methodology is deliberately narrow:
//   * Folds are chronological. Candidates are selected on TRAINING bars only and the
//     selection is then evaluated on bars it never saw. Nothing here shuffles data.
//   * Each window is evaluated as an independent `runBacktest` call, so a position
//     open at a window boundary is closed by the engine's END_OF_DATA handling and
//     never carried across a fold.
//   * Test windows are run with `inSamplePct: 0`, which makes every trade in them
//     out-of-sample — the split lives at fold level, not inside a window.
//   * Synthetic data cannot produce a verdict at all: it refuses before it computes.
//
// What this engine does NOT do: it does not decide eligibility (that is
// `strategyFitness.ts`), and it does not authorise execution. Fold results are
// historical measurements under modelled costs, not a forecast.

import {
  DEFAULT_BT_CONFIG,
  enumerateCandidates,
  runBacktest,
  type BTMetrics,
  type StrategyId,
  type StrategyParams,
} from "./backtest";
import type { ParameterVariant, WalkForwardFold } from "./strategyFitness";

export interface WFBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface WFConfig {
  /** Number of chronological folds. Each fold owns one train window and one test window. */
  folds: number;
  /** Bars in a training window (ROLLING) or in the initial training window (EXPANDING). */
  trainBars: number;
  /** Bars in each out-of-sample test window. */
  testBars: number;
  /** ROLLING keeps the training window a fixed size; EXPANDING grows it from bar 0. */
  anchor: "ROLLING" | "EXPANDING";
  /** Minimum bars any single window must contain, and the engine's INSUFFICIENT_DATA bar. */
  minBarsPerWindow: number;
  feeBps: number;
  slippageBps: number;
  positionPct: number;
  stopPct: number;
  targetPct: number;
  seed: number;
  /** Wall clock used ONLY to reject future-dated and still-forming bars. */
  now: number;
  intervalMs: number;
  /** Provenance of the bars. SYNTHETIC refuses to produce a verdict. */
  dataKind: "REAL" | "SYNTHETIC";
}

export interface WFFold {
  index: number;
  trainStartTime: number;
  trainEndTime: number;
  testStartTime: number;
  testEndTime: number;
  selectedParams: Record<string, number>;
  trainReturnPct: number;
  trainTradeCount: number;
  testReturnPct: number;
  testTradeCount: number;
  testMaxDrawdownPct: number;
}

export interface WFResult {
  ok: boolean;
  /** Non-null only when `ok` is false: why the methodology refused to produce a verdict. */
  reason: string | null;
  folds: WFFold[];
  oosTradeCount: number;
  profitableFoldFraction: number;
  meanOosReturnPct: number;
  foldReturnsPct: number[];
  /** Parameter fragility: every candidate's own out-of-sample aggregate. */
  variants: ParameterVariant[];
  /** Shape the fitness gates consume directly. */
  foldsForFitness: WalkForwardFold[];
  limitations: string[];
  deterministic: true;
}

const HOUR_MS = 3_600_000;

/** Defaults are sized for the ~400-bar fetches the Convex layer performs:
 *  150 + 3 × 60 = 330 bars, leaving headroom for the still-forming bar and gaps. */
export function defaultWFConfig(over: Partial<WFConfig> = {}): WFConfig {
  return {
    folds: 3,
    trainBars: 150,
    testBars: 60,
    anchor: "ROLLING",
    minBarsPerWindow: 60,
    feeBps: DEFAULT_BT_CONFIG.feeBps,
    slippageBps: DEFAULT_BT_CONFIG.slippageBps,
    positionPct: DEFAULT_BT_CONFIG.positionPct,
    stopPct: DEFAULT_BT_CONFIG.stopPct,
    targetPct: DEFAULT_BT_CONFIG.targetPct,
    seed: DEFAULT_BT_CONFIG.seed,
    // Convenience default only. `runWalkForward` never reads the clock itself, so a
    // caller that passes `now` gets fully reproducible behaviour.
    now: Date.now(),
    intervalMs: HOUR_MS,
    dataKind: "REAL",
    ...over,
  };
}

function refuse(reason: string, limitations: string[]): WFResult {
  return {
    ok: false,
    reason,
    folds: [],
    oosTradeCount: 0,
    profitableFoldFraction: 0,
    meanOosReturnPct: 0,
    foldReturnsPct: [],
    variants: [],
    foldsForFitness: [],
    limitations,
    deterministic: true,
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Explicit copy into a plain record: a spread of `StrategyParams` keeps its
 *  optional properties (`number | undefined`), which is not a `Record<string, number>`. */
function toParamRecord(params: StrategyParams): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function paramLabel(params: StrategyParams): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return "default";
  return entries.map(([k, v]) => `${k}=${v}`).join(",");
}

/** OHLC sanity with a relative epsilon, so ordinary float noise in real data is not
 *  rejected while a genuinely impossible bar still is. */
function ohlcWithinTolerance(b: WFBar): boolean {
  if (b.high < b.low) return false;
  const eps = Math.max(1e-9, Math.abs(b.high) * 1e-9);
  return (
    b.open <= b.high + eps &&
    b.open >= b.low - eps &&
    b.close <= b.high + eps &&
    b.close >= b.low - eps
  );
}

interface Precheck {
  ok: boolean;
  reason: string | null;
  usable: WFBar[];
  limitations: string[];
}

/** Everything that must be true before a single fold is computed. Refusals are
 *  explicit reason codes — never a silent empty result. */
function precheck(bars: WFBar[], cfg: WFConfig): Precheck {
  const limitations: string[] = [];

  if (cfg.dataKind === "SYNTHETIC") {
    return {
      ok: false,
      reason: "SYNTHETIC_DATA",
      usable: [],
      limitations: [
        "synthetic bars cannot qualify a strategy: research eligibility requires real, provenance-tracked market data",
      ],
    };
  }

  if (
    !Number.isInteger(cfg.folds) ||
    cfg.folds < 1 ||
    !Number.isInteger(cfg.trainBars) ||
    !Number.isInteger(cfg.testBars) ||
    !Number.isInteger(cfg.minBarsPerWindow) ||
    cfg.trainBars < 3 ||
    cfg.testBars < 1 ||
    cfg.minBarsPerWindow < 3 ||
    cfg.trainBars < cfg.minBarsPerWindow ||
    cfg.testBars < cfg.minBarsPerWindow ||
    !isFiniteNumber(cfg.intervalMs) ||
    cfg.intervalMs <= 0 ||
    !isFiniteNumber(cfg.now) ||
    !isFiniteNumber(cfg.feeBps) ||
    !isFiniteNumber(cfg.slippageBps)
  ) {
    return {
      ok: false,
      reason: "INVALID_CONFIG",
      usable: [],
      limitations: ["walk-forward configuration is not usable; no verdict is possible"],
    };
  }

  if (!Array.isArray(bars) || bars.length === 0) {
    return { ok: false, reason: "EMPTY_INPUT", usable: [], limitations: ["no bars supplied"] };
  }

  let prevTime: number | null = null;
  for (const b of bars) {
    if (
      !isFiniteNumber(b.time) ||
      b.time <= 0 ||
      !isFiniteNumber(b.open) ||
      !isFiniteNumber(b.high) ||
      !isFiniteNumber(b.low) ||
      !isFiniteNumber(b.close) ||
      !isFiniteNumber(b.volume) ||
      b.open <= 0 ||
      b.high <= 0 ||
      b.low <= 0 ||
      b.close <= 0
    ) {
      return {
        ok: false,
        reason: "INVALID_BAR",
        usable: [],
        limitations: ["a bar carries a non-finite or non-positive value"],
      };
    }
    if (!ohlcWithinTolerance(b)) {
      return {
        ok: false,
        reason: "INVALID_OHLC",
        usable: [],
        limitations: ["a bar violates OHLC ordering (high/low or open/close placement)"],
      };
    }
    if (b.time > cfg.now) {
      return {
        ok: false,
        reason: "FUTURE_TIMESTAMP",
        usable: [],
        limitations: ["a bar is stamped in the future relative to the supplied clock"],
      };
    }
    if (prevTime !== null && b.time <= prevTime) {
      return {
        ok: false,
        reason: b.time === prevTime ? "DUPLICATE_TIMESTAMP" : "NON_MONOTONIC_TIMESTAMPS",
        usable: [],
        limitations: ["bars are not strictly time-ordered; windows would be ambiguous"],
      };
    }
    prevTime = b.time;
  }

  // A bar whose window has not closed yet is still forming: its close is not final.
  const usable = bars.filter((b) => b.time + cfg.intervalMs <= cfg.now);
  const dropped = bars.length - usable.length;
  if (dropped > 0) {
    limitations.push(
      `${dropped} still-forming bar(s) dropped: their ${cfg.intervalMs}ms window had not closed at the supplied clock, so their close is not a final price`,
    );
  }
  if (usable.length === 0) {
    return {
      ok: false,
      reason: "NO_COMPLETED_BARS",
      usable: [],
      limitations: [...limitations, "every supplied bar was still forming"],
    };
  }

  const needed = cfg.trainBars + cfg.folds * cfg.testBars;
  if (usable.length < needed) {
    return {
      ok: false,
      reason: "INSUFFICIENT_BARS",
      usable,
      limitations: [
        ...limitations,
        `${usable.length} completed bars is fewer than the ${needed} the fold layout requires — no verdict is possible rather than an empty one`,
      ],
    };
  }

  let gaps = 0;
  for (let i = 1; i < usable.length; i++) {
    if (usable[i].time - usable[i - 1].time > cfg.intervalMs * 1.5) gaps++;
  }
  if (gaps > 0) {
    limitations.push(
      `${gaps} interval gap(s) larger than the nominal spacing: windows are laid out by bar index, so a gap widens the calendar span without moving the train/test boundary`,
    );
  }

  return { ok: true, reason: null, usable, limitations };
}

interface Window {
  trainFrom: number;
  trainTo: number;
  testFrom: number;
  testTo: number;
}

/**
 * Fold layout, anchored to the most recent bars so the newest evidence is always
 * evaluated. Windows are index ranges over the completed bars.
 *
 * ROLLING  : train [base+i·test, base+i·test+train), test [train.to, train.to+test)
 * EXPANDING: train [base, base+train+i·test),          test [train.to, train.to+test)
 * In both the gap between train and test is empty (test starts strictly after train
 * ends) and the final test window ends exactly at the last completed bar.
 */
function layoutFoldLayout(n: number, cfg: WFConfig): Window[] {
  const base = n - (cfg.folds * cfg.testBars + cfg.trainBars);
  const out: Window[] = [];
  for (let i = 0; i < cfg.folds; i++) {
    const rollingFrom = base + i * cfg.testBars;
    const trainFrom = cfg.anchor === "EXPANDING" ? base : rollingFrom;
    const trainTo = rollingFrom + cfg.trainBars;
    out.push({ trainFrom, trainTo, testFrom: trainTo, testTo: trainTo + cfg.testBars });
  }
  return out;
}

function windowConfig(cfg: WFConfig, params: StrategyParams): Partial<typeof DEFAULT_BT_CONFIG> {
  return {
    startingEquity: DEFAULT_BT_CONFIG.startingEquity,
    feeBps: cfg.feeBps,
    slippageBps: cfg.slippageBps,
    positionPct: cfg.positionPct,
    stopPct: cfg.stopPct,
    targetPct: cfg.targetPct,
    allowShort: DEFAULT_BT_CONFIG.allowShort,
    seed: cfg.seed,
    // The window itself is the unit of measurement, so everything inside it counts as
    // out-of-sample relative to the split that happens at fold level.
    inSamplePct: 0,
    minBars: cfg.minBarsPerWindow,
    params,
  };
}

/** Window return, net of fees and slippage, from the trades the engine actually made. */
function windowReturn(m: BTMetrics): number {
  return Number.isFinite(m.outSampleReturnPct) ? m.outSampleReturnPct : Number.NEGATIVE_INFINITY;
}

export function runWalkForward(bars: WFBar[], strategy: StrategyId, cfg: WFConfig): WFResult {
  const pre = precheck(bars, cfg);
  if (!pre.ok || pre.reason !== null) {
    return refuse(pre.reason ?? "INVALID_CONFIG", pre.limitations);
  }
  const data = pre.usable;
  const windows = layoutFoldLayout(data.length, cfg);
  const candidates = enumerateCandidates(strategy);

  const folds: WFFold[] = [];
  // Per-candidate out-of-sample returns, one entry per fold, for parameter fragility.
  const variantReturns = new Map<number, number[]>();

  for (let f = 0; f < windows.length; f++) {
    const w = windows[f];
    const trainBars = data.slice(w.trainFrom, w.trainTo);
    const testBars = data.slice(w.testFrom, w.testTo);

    let bestIdx = -1;
    let bestReturn = Number.NEGATIVE_INFINITY;
    let bestDrawdown = Number.POSITIVE_INFINITY;
    let bestTrades = Number.POSITIVE_INFINITY;

    for (let c = 0; c < candidates.length; c++) {
      const train = runBacktest(trainBars, strategy, windowConfig(cfg, candidates[c]), "none");
      if (train.insufficientData) continue;
      const ret = windowReturn(train.metrics);
      const dd = Number.isFinite(train.metrics.maxDrawdownPct)
        ? train.metrics.maxDrawdownPct
        : Number.POSITIVE_INFINITY;
      const trades = train.metrics.tradeCount;
      // Deterministic ordering: return, then shallower drawdown, then fewer trades,
      // then declaration order. Equal inputs always select the same candidate.
      const better =
        ret > bestReturn ||
        (ret === bestReturn && dd < bestDrawdown) ||
        (ret === bestReturn && dd === bestDrawdown && trades < bestTrades);
      if (better) {
        bestIdx = c;
        bestReturn = ret;
        bestDrawdown = dd;
        bestTrades = trades;
      }

      // Every candidate is also measured out-of-sample on this fold's test window, so
      // `variants` reflects parameter fragility rather than the selection result.
      const probe = runBacktest(testBars, strategy, windowConfig(cfg, candidates[c]), "none");
      const probeRet = probe.insufficientData ? Number.NEGATIVE_INFINITY : windowReturn(probe.metrics);
      const list = variantReturns.get(c) ?? [];
      list.push(probeRet);
      variantReturns.set(c, list);
    }

    if (bestIdx < 0) {
      return refuse("NO_EVALUABLE_CANDIDATE", [
        ...pre.limitations,
        `fold ${f} produced no evaluable candidate on its training window`,
      ]);
    }

    const selected = candidates[bestIdx];
    const test = runBacktest(testBars, strategy, windowConfig(cfg, selected), "none");
    const testReturn = test.insufficientData ? Number.NEGATIVE_INFINITY : windowReturn(test.metrics);

    folds.push({
      index: f,
      trainStartTime: trainBars[0].time,
      trainEndTime: trainBars[trainBars.length - 1].time,
      testStartTime: testBars[0].time,
      testEndTime: testBars[testBars.length - 1].time,
      selectedParams: toParamRecord(selected),
      trainReturnPct: bestReturn,
      trainTradeCount: bestTrades,
      testReturnPct: testReturn,
      testTradeCount: test.metrics.tradeCount,
      testMaxDrawdownPct: test.metrics.maxDrawdownPct,
    });
  }

  const foldReturnsPct = folds.map((f) => f.testReturnPct);
  const oosTradeCount = folds.reduce((a, f) => a + f.testTradeCount, 0);
  const positive = foldReturnsPct.filter((r) => r > 0).length;
  const meanOosReturnPct =
    foldReturnsPct.length > 0
      ? foldReturnsPct.reduce((a, r) => a + r, 0) / foldReturnsPct.length
      : 0;

  const variants: ParameterVariant[] = candidates.map((c, idx) => {
    const list = variantReturns.get(idx) ?? [];
    const mean = list.length > 0 ? list.reduce((a, r) => a + r, 0) / list.length : 0;
    return { label: paramLabel(c), returnPct: mean };
  });

  const limitations: string[] = [
    ...pre.limitations,
    "fold boundaries are hard: each window is an independent run, so a position still open at the end of a window is closed by the engine at END_OF_DATA and never carried across a fold",
    "fills are modelled (fees plus adverse slippage), not matched against an order book, so fold returns are optimistic relative to a real venue",
    "fold returns are historical measurements, not a forecast, and a positive out-of-sample fold is not evidence of future profitability",
    "folds share overlapping history, so the fold count overstates the number of independent observations",
    "parameter variants are perturbations of one strategy definition, not independent strategies",
    `candidate selection used training bars only (${cfg.trainBars} bars per fold, ${cfg.anchor} anchor); the reported out-of-sample returns come from ${cfg.testBars}-bar test windows`,
  ];

  return {
    ok: true,
    reason: null,
    folds,
    oosTradeCount,
    profitableFoldFraction: foldReturnsPct.length > 0 ? positive / foldReturnsPct.length : 0,
    meanOosReturnPct,
    foldReturnsPct,
    variants,
    foldsForFitness: folds.map((f) => ({
      index: f.index,
      returnPct: f.testReturnPct,
      tradeCount: f.testTradeCount,
    })),
    limitations,
    deterministic: true,
  };
}
