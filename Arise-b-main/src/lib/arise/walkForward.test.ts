// ARISE V1 — walk-forward engine tests.
//
// These pin the methodology, not the profitability: chronological folds, train-only
// candidate selection, no future or forming data, costs applied, fold-boundary
// positions closed, explicit refusals instead of empty verdicts, and synthetic data
// never producing a verdict. Every fixture is generated deterministically below —
// no network, no live prices, no Date.now() (the clock is always passed in).

import { describe, expect, it } from "vitest";
import {
  DEFAULT_BT_CONFIG,
  enumerateCandidates,
  runBacktest,
  type StrategyParams,
} from "./backtest";
import { defaultWFConfig, runWalkForward, type WFBar, type WFConfig } from "./walkForward";

const HOUR = 3_600_000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GenOpts {
  n: number;
  seed?: number;
  intervalMs?: number;
  /** Per-bar drift as a fraction of price. */
  drift?: number;
  /** Index at which the drift switches to `regimeDrift`. */
  regimeAt?: number;
  regimeDrift?: number;
  /** Noise amplitude as a fraction of price. */
  noise?: number;
  /** Insert a multi-bar gap every `skipEvery` bars. */
  skipEvery?: number;
  skipCount?: number;
}

/** Deterministic OHLC generator: strictly increasing timestamps, valid OHLC, all
 *  prices positive. Never imports market data. */
function makeBars(o: GenOpts): WFBar[] {
  const rnd = mulberry32(o.seed ?? 7);
  const intervalMs = o.intervalMs ?? HOUR;
  const bars: WFBar[] = [];
  let price = 100;
  let t = 1_700_000_000_000;
  for (let i = 0; i < o.n; i++) {
    if (o.skipEvery !== undefined && o.skipCount !== undefined && i > 0 && i % o.skipEvery === 0) {
      t += intervalMs * o.skipCount;
    }
    const driftPct = o.regimeAt !== undefined && i >= o.regimeAt ? (o.regimeDrift ?? 0) : (o.drift ?? 0);
    const noiseAmp = (o.noise ?? 0.002) * price;
    const open = price;
    const close = Math.max(1, price + driftPct * price + (rnd() - 0.5) * 2 * noiseAmp);
    const high = Math.max(open, close) + rnd() * noiseAmp;
    const low = Math.max(0.5, Math.min(open, close) - rnd() * noiseAmp);
    bars.push({ time: t, open, high, low, close, volume: 1000 + rnd() * 500 });
    price = close;
    t += intervalMs;
  }
  return bars;
}

/** Clock just after the last bar's window closes, so nothing is still forming. */
function clockAfter(bars: WFBar[], intervalMs = HOUR): number {
  return bars[bars.length - 1].time + intervalMs;
}

/** The same engine configuration `runWalkForward` builds for each window. */
function windowCfg(cfg: WFConfig, params: StrategyParams) {
  return {
    startingEquity: DEFAULT_BT_CONFIG.startingEquity,
    feeBps: cfg.feeBps,
    slippageBps: cfg.slippageBps,
    positionPct: cfg.positionPct,
    stopPct: cfg.stopPct,
    targetPct: cfg.targetPct,
    allowShort: DEFAULT_BT_CONFIG.allowShort,
    seed: cfg.seed,
    inSamplePct: 0,
    minBars: cfg.minBarsPerWindow,
    params,
  };
}

const WIDE = { stopPct: 90, targetPct: 500 } as const;

describe("fold layout", () => {
  it("keeps train and test windows strictly separated and chronologically ordered", () => {
    const bars = makeBars({ n: 600, drift: 0.001, noise: 0.004 });
    const res = runWalkForward(bars, "sma-cross", defaultWFConfig({ now: clockAfter(bars) }));

    expect(res.ok).toBe(true);
    expect(res.folds).toHaveLength(3);

    for (const fold of res.folds) {
      // The test window starts strictly after the training window ends.
      expect(fold.testStartTime).toBeGreaterThan(fold.trainEndTime);
      const trainTimes = new Set(
        bars.filter((b) => b.time >= fold.trainStartTime && b.time <= fold.trainEndTime).map((b) => b.time),
      );
      const testTimes = bars
        .filter((b) => b.time >= fold.testStartTime && b.time <= fold.testEndTime)
        .map((b) => b.time);
      expect(testTimes.length).toBeGreaterThan(0);
      // No bar is in both windows (no shared evidence, no leakage).
      for (const t of testTimes) expect(trainTimes.has(t)).toBe(false);
    }

    // Folds advance in time and the last test window ends on the newest completed bar.
    for (let i = 1; i < res.folds.length; i++) {
      expect(res.folds[i].trainStartTime).toBeGreaterThan(res.folds[i - 1].trainStartTime);
      expect(res.folds[i].testStartTime).toBeGreaterThan(res.folds[i - 1].testEndTime);
    }
    expect(res.folds[2].testEndTime).toBe(bars[bars.length - 1].time);
  });

  it("supports an expanding anchor without overlapping windows", () => {
    const bars = makeBars({ n: 600, drift: 0.001 });
    const res = runWalkForward(
      bars,
      "sma-cross",
      defaultWFConfig({ now: clockAfter(bars), anchor: "EXPANDING" }),
    );

    expect(res.ok).toBe(true);
    // The training window grows from bar 0, so every fold trains from the same start.
    expect(res.folds[0].trainStartTime).toBe(res.folds[2].trainStartTime);
    expect(res.folds[2].trainEndTime).toBeGreaterThan(res.folds[0].trainEndTime);
    for (const fold of res.folds) expect(fold.testStartTime).toBeGreaterThan(fold.trainEndTime);
  });
});

describe("data acceptance", () => {
  it("refuses synthetic data without producing a single fold", () => {
    const bars = makeBars({ n: 600, drift: 0.001 });
    const res = runWalkForward(
      bars,
      "sma-cross",
      defaultWFConfig({ now: clockAfter(bars), dataKind: "SYNTHETIC" }),
    );

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("SYNTHETIC_DATA");
    expect(res.folds).toHaveLength(0);
    expect(res.variants).toHaveLength(0);
    expect(res.limitations.join(" ")).toMatch(/synthetic/i);
  });

  it("refuses bars stamped in the future", () => {
    const bars = makeBars({ n: 400, drift: 0.001 });
    const res = runWalkForward(
      bars,
      "sma-cross",
      defaultWFConfig({ now: bars[bars.length - 1].time - 10 * HOUR }),
    );

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("FUTURE_TIMESTAMP");
    expect(res.folds).toHaveLength(0);
  });

  it("drops a still-forming final candle and says so", () => {
    const bars = makeBars({ n: 450, drift: 0.001 });
    const now = bars[bars.length - 1].time + HOUR / 2; // last bar has not closed
    const res = runWalkForward(bars, "sma-cross", defaultWFConfig({ now }));

    expect(res.ok).toBe(true);
    expect(res.limitations.join(" ")).toMatch(/still-forming/);
    // The forming bar cannot be in any window.
    for (const fold of res.folds) expect(fold.testEndTime).toBeLessThan(bars[bars.length - 1].time);
  });

  it("refuses when every bar is still forming", () => {
    // Every bar exists (none is future-dated relative to the clock) yet no bar's
    // window has closed: pack the bars 1ms apart inside a single 1h window and set the
    // clock to the last of them. Uniformly-spaced bars cannot express this case — with
    // an interval between bars, an earlier bar has always closed by the time the latest
    // one exists.
    const raw = makeBars({ n: 400, drift: 0.001 });
    const bars = raw.map((b, i) => ({ ...b, time: raw[0].time + i }));
    const res = runWalkForward(
      bars,
      "sma-cross",
      defaultWFConfig({ now: bars[bars.length - 1].time }),
    );

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("NO_COMPLETED_BARS");
    expect(res.folds).toHaveLength(0);
  });

  it("refuses empty and malformed input with explicit reasons", () => {
    const good = makeBars({ n: 400, drift: 0.001 });
    const now = clockAfter(good);

    expect(runWalkForward([], "sma-cross", defaultWFConfig({ now })).reason).toBe("EMPTY_INPUT");
    expect(runWalkForward([good[0]], "sma-cross", defaultWFConfig({ now })).reason).toBe(
      "INSUFFICIENT_BARS",
    );

    const nanPrice = good.map((b, i) => (i === 5 ? { ...b, close: Number.NaN } : b));
    expect(runWalkForward(nanPrice, "sma-cross", defaultWFConfig({ now })).reason).toBe("INVALID_BAR");

    const inverted = good.map((b, i) => (i === 5 ? { ...b, high: b.low - 1 } : b));
    expect(runWalkForward(inverted, "sma-cross", defaultWFConfig({ now })).reason).toBe(
      "INVALID_OHLC",
    );

    const openAboveHigh = good.map((b, i) => (i === 5 ? { ...b, open: b.high + 5 } : b));
    expect(runWalkForward(openAboveHigh, "sma-cross", defaultWFConfig({ now })).reason).toBe(
      "INVALID_OHLC",
    );

    const duplicated = good.map((b, i) => (i === 5 ? { ...b, time: good[4].time } : b));
    expect(runWalkForward(duplicated, "sma-cross", defaultWFConfig({ now })).reason).toBe(
      "DUPLICATE_TIMESTAMP",
    );

    // Genuine inversion with NO duplicate: index 5 is moved back to index 3's time, so
    // the series reads …3,4,3,5… — going backwards without any equal pair. (Reusing the
    // NEXT bar's timestamp would create a duplicate and is already covered above.)
    const swapped = good.map((b, i) => (i === 5 ? { ...b, time: good[3].time } : b));
    expect(runWalkForward(swapped, "sma-cross", defaultWFConfig({ now })).reason).toBe(
      "NON_MONOTONIC_TIMESTAMPS",
    );
  });

  it("refuses to produce a verdict when there is not enough history", () => {
    const bars = makeBars({ n: 200, drift: 0.001 });
    const res = runWalkForward(bars, "sma-cross", defaultWFConfig({ now: clockAfter(bars) }));

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("INSUFFICIENT_BARS");
    expect(res.folds).toHaveLength(0);
    expect(res.limitations.join(" ")).toMatch(/fewer than/);
  });

  it("refuses an unusable configuration rather than guessing", () => {
    const bars = makeBars({ n: 600, drift: 0.001 });
    const res = runWalkForward(
      bars,
      "sma-cross",
      defaultWFConfig({ now: clockAfter(bars), trainBars: 20 }), // below minBarsPerWindow
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("INVALID_CONFIG");
  });

  it("lays windows out by bar index when the series has gaps", () => {
    const gapped = makeBars({ n: 600, drift: 0.001, skipEvery: 50, skipCount: 3 });
    const res = runWalkForward(gapped, "sma-cross", defaultWFConfig({ now: clockAfter(gapped) }));

    expect(res.ok).toBe(true);
    expect(res.folds).toHaveLength(3);
    // Index-based layout: fold 0 still starts at bar index 270 of the series.
    expect(res.folds[0].trainStartTime).toBe(gapped[270].time);
    for (const fold of res.folds) expect(fold.testStartTime).toBeGreaterThan(fold.trainEndTime);
    expect(res.limitations.join(" ")).toMatch(/gap/i);
  });
});

describe("costs and fold boundaries", () => {
  it("charges fees and slippage on every fold", () => {
    const bars = makeBars({ n: 600, drift: 0.002, noise: 0.001 });
    const opts = { ...WIDE, now: clockAfter(bars) };
    const cheap = runWalkForward(bars, "buy-hold", defaultWFConfig({ ...opts, feeBps: 4, slippageBps: 2 }));
    const dear = runWalkForward(bars, "buy-hold", defaultWFConfig({ ...opts, feeBps: 60, slippageBps: 40 }));

    expect(cheap.ok).toBe(true);
    expect(dear.ok).toBe(true);
    expect(cheap.foldReturnsPct).toHaveLength(dear.foldReturnsPct.length);
    // Strictly worse with higher costs — the cost model is actually applied.
    expect(dear.meanOosReturnPct).toBeLessThan(cheap.meanOosReturnPct);
    expect(cheap.limitations.join(" ")).toMatch(/modelled/i);
  });

  it("closes a position still open at a fold boundary at END_OF_DATA", () => {
    const bars = makeBars({ n: 600, drift: 0.002, noise: 0.001 });
    const cfg = defaultWFConfig({ ...WIDE, now: clockAfter(bars) });
    const res = runWalkForward(bars, "buy-hold", cfg);

    expect(res.ok).toBe(true);
    const last = res.folds[res.folds.length - 1];
    const window = bars.filter((b) => b.time >= last.testStartTime && b.time <= last.testEndTime);
    // buy-hold has an empty parameter space, so its selection is always `{}`.
    expect(last.selectedParams).toEqual({});
    const rerun = runBacktest(window, "buy-hold", windowCfg(cfg, {}), "none");

    expect(rerun.trades.length).toBe(1);
    expect(rerun.trades[0].exitReason).toBe("END_OF_DATA");
    expect(res.limitations.join(" ")).toMatch(/END_OF_DATA/);
  });
});

describe("candidate selection", () => {
  it("selects on training bars only, and does so deterministically", () => {
    const bars = makeBars({ n: 600, seed: 11, drift: 0.0005, regimeAt: 540, regimeDrift: -0.004, noise: 0.005 });
    const cfg = defaultWFConfig({ now: clockAfter(bars) });
    const res = runWalkForward(bars, "sma-cross", cfg);
    const again = runWalkForward(bars, "sma-cross", cfg);

    expect(res.ok).toBe(true);
    expect(JSON.stringify(again)).toBe(JSON.stringify(res));

    const candidates = enumerateCandidates("sma-cross");
    for (const fold of res.folds) {
      const train = bars.filter((b) => b.time >= fold.trainStartTime && b.time <= fold.trainEndTime);
      let best: { params: StrategyParams; ret: number; dd: number; trades: number } | null = null;
      for (const c of candidates) {
        const run = runBacktest(train, "sma-cross", windowCfg(cfg, c), "none");
        const ret = run.metrics.outSampleReturnPct;
        const dd = run.metrics.maxDrawdownPct;
        const trades = run.metrics.tradeCount;
        const better =
          best === null ||
          ret > best.ret ||
          (ret === best.ret && dd < best.dd) ||
          (ret === best.ret && dd === best.dd && trades < best.trades);
        if (better) best = { params: { ...c }, ret, dd, trades };
      }
      expect(best).not.toBeNull();
      expect(fold.selectedParams).toEqual(best?.params);
      expect(fold.trainReturnPct).toBeCloseTo(best?.ret ?? 0, 10);
    }
  });

  it("reports every candidate as a parameter variant, including the untuned ones", () => {
    const bars = makeBars({ n: 600, drift: 0.001 });
    const now = clockAfter(bars);
    const sma = runWalkForward(bars, "sma-cross", defaultWFConfig({ now }));
    const hold = runWalkForward(bars, "buy-hold", defaultWFConfig({ now }));

    expect(sma.variants).toHaveLength(enumerateCandidates("sma-cross").length);
    expect(sma.variants.every((v) => /fast=|slow=/.test(v.label))).toBe(true);
    expect(hold.variants).toHaveLength(1);
    expect(hold.variants[0].label).toBe("default");
    expect(sma.limitations.join(" ")).toMatch(/not independent strategies/i);
  });
});

describe("aggregate reporting", () => {
  it("keeps training results distinct from out-of-sample results", () => {
    const bars = makeBars({ n: 600, drift: 0.001, noise: 0.004 });
    const res = runWalkForward(bars, "arise-momentum", defaultWFConfig({ now: clockAfter(bars) }));

    expect(res.ok).toBe(true);
    const testMean = res.foldReturnsPct.reduce((a, r) => a + r, 0) / res.foldReturnsPct.length;
    expect(res.meanOosReturnPct).toBeCloseTo(testMean, 10);
    expect(res.foldsForFitness.map((f) => f.returnPct)).toEqual(res.folds.map((f) => f.testReturnPct));
    expect(res.foldsForFitness.map((f) => f.tradeCount)).toEqual(res.folds.map((f) => f.testTradeCount));
    expect(res.oosTradeCount).toBe(res.folds.reduce((a, f) => a + f.testTradeCount, 0));
    // Train and test are separately reported per fold, never collapsed into one number.
    for (const fold of res.folds) {
      expect(Number.isFinite(fold.trainReturnPct)).toBe(true);
      expect(Number.isFinite(fold.testReturnPct)).toBe(true);
    }
  });

  it("reports a profitable-fold fraction below one when folds disagree", () => {
    const bars = makeBars({
      n: 600,
      seed: 3,
      drift: 0.004,
      noise: 0.001,
      regimeAt: 540,
      regimeDrift: -0.02,
    });
    const res = runWalkForward(bars, "buy-hold", defaultWFConfig({ ...WIDE, now: clockAfter(bars) }));

    expect(res.ok).toBe(true);
    expect(res.foldReturnsPct).toHaveLength(3);
    expect(res.foldReturnsPct[0]).toBeGreaterThan(0);
    expect(res.foldReturnsPct[2]).toBeLessThan(0);
    expect(res.profitableFoldFraction).toBeGreaterThan(0);
    expect(res.profitableFoldFraction).toBeLessThan(1);
  });

  it("reports the loss instead of refusing when no candidate is profitable out-of-sample", () => {
    const bars = makeBars({ n: 600, seed: 5, drift: 0, noise: 0.01 });
    const res = runWalkForward(
      bars,
      "sma-cross",
      defaultWFConfig({ now: clockAfter(bars), feeBps: 200, slippageBps: 200 }),
    );

    // The engine reports what happened (including folds that the strategy simply did
    // not trade, which score 0 rather than a loss); only the fitness gates decide
    // whether that evidence is good enough to promote anything.
    expect(res.ok).toBe(true);
    expect(res.folds).toHaveLength(3);
    expect(res.variants.every((v) => v.returnPct <= 0)).toBe(true);
    // Non-positive, not strictly negative: a fold in which the strategy never traded
    // scores exactly 0, and 0 is a real measurement rather than a loss. The engine's job
    // is to report what happened; deciding that zero is not good enough is the gate's.
    expect(res.foldReturnsPct.every((r) => r <= 0)).toBe(true);
    expect(res.foldReturnsPct).toHaveLength(3);
    expect(res.meanOosReturnPct).toBeLessThanOrEqual(0);
    expect(res.profitableFoldFraction).toBe(0);
  });

  it("marks its own output as deterministic and documents the limitations", () => {
    const bars = makeBars({ n: 600, drift: 0.001 });
    const res = runWalkForward(bars, "rsi-mean", defaultWFConfig({ now: clockAfter(bars) }));

    expect(res.deterministic).toBe(true);
    const text = res.limitations.join(" ");
    expect(text).toMatch(/not a forecast/i);
    expect(text).toMatch(/overlap/i);
    expect(text).toMatch(/training bars only/i);
  });
});
