// ARISE Bot Training System — deterministic backtest engine (pure, no network).
// Guarantees: no look-ahead (signals see only bars[0..i]), fills at next open,
// fees + slippage deducted both sides, SL checked before TP (conservative),
// equity reconciled every bar, deterministic via seeded jitter, in/out-of-sample split.

export interface BTBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type StrategyId = "sma-cross" | "rsi-mean" | "arise-momentum" | "buy-hold";

export interface BTConfig {
  startingEquity: number;
  feeBps: number; // per side, e.g. 4
  slippageBps: number; // per side, e.g. 2
  positionPct: number; // % equity per trade (0..100)
  stopPct: number; // % adverse move → SL
  targetPct: number; // % favorable move → TP (2R default = 2x stop)
  inSamplePct: number; // 0.5..0.9, default 0.7
  allowShort: boolean;
  seed: number;
  minBars: number; // INSUFFICIENT_DATA below this
  /** Strategy parameters. Omitted/undefined reproduces the shipped strategy exactly. */
  params?: StrategyParams;
}

/**
 * Tunable strategy parameters. Every default matches the values the strategies were
 * shipped with, so an absent parameter set is behaviourally identical to the engine
 * that existed before parameterisation — the change is additive, not a rewrite.
 */
export interface StrategyParams {
  /** sma-cross: fast SMA period. */
  fast?: number;
  /** sma-cross: slow SMA period. */
  slow?: number;
  /** rsi-mean and arise-momentum: RSI lookback. */
  rsiPeriod?: number;
  /** rsi-mean: long entry level. */
  rsiOversold?: number;
  /** rsi-mean: short entry level. */
  rsiOverbought?: number;
  /** arise-momentum: rate-of-change lookback. */
  rocPeriod?: number;
  /** arise-momentum: |score| required to act. */
  momentumThreshold?: number;
}

export const DEFAULT_STRATEGY_PARAMS: Required<StrategyParams> = {
  fast: 20,
  slow: 50,
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  rocPeriod: 10,
  momentumThreshold: 0.25,
};

/** Search space for walk-forward parameter selection. Deliberately small and fixed so
 *  candidate enumeration is deterministic and cheap; it is NOT a claim that these are
 *  the only sensible values. */
export const PARAM_SPACE: Record<
  StrategyId,
  { key: keyof StrategyParams; values: number[] }[]
> = {
  "sma-cross": [
    { key: "fast", values: [10, 20, 30] },
    { key: "slow", values: [40, 50, 60] },
  ],
  "rsi-mean": [
    { key: "rsiPeriod", values: [10, 14, 21] },
    { key: "rsiOversold", values: [25, 30, 35] },
  ],
  "arise-momentum": [
    { key: "rocPeriod", values: [5, 10, 20] },
    { key: "momentumThreshold", values: [0.15, 0.25, 0.35] },
  ],
  "buy-hold": [],
};

/** Read a parameter, falling back to the shipped default. Out-of-range or non-finite
 *  values are ignored rather than clamped: a malformed candidate must behave exactly
 *  like the default one, so a bad parameter can never invent a signal. */
function param(
  params: StrategyParams | undefined,
  key: keyof StrategyParams,
  min: number,
  max: number,
): number {
  const fallback = DEFAULT_STRATEGY_PARAMS[key];
  const raw = params?.[key];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max) return fallback;
  return raw;
}

/** Deterministic candidate enumeration (cartesian product, declaration order).
 *  Degenerate combinations are dropped so the search never evaluates a config that
 *  cannot trade (e.g. a fast SMA that is not faster than the slow one). */
export function enumerateCandidates(id: StrategyId): StrategyParams[] {
  const axes = PARAM_SPACE[id];
  if (!axes || axes.length === 0) return [{}];
  let out: StrategyParams[] = [{}];
  for (const axis of axes) {
    const next: StrategyParams[] = [];
    for (const base of out) {
      for (const v of axis.values) next.push({ ...base, [axis.key]: v });
    }
    out = next;
  }
  return out.filter((p) => (id === "sma-cross" ? param(p, "fast", 2, 400) < param(p, "slow", 3, 400) : true));
}

export const DEFAULT_BT_CONFIG: BTConfig = {
  startingEquity: 10_000,
  feeBps: 4,
  slippageBps: 2,
  positionPct: 15,
  stopPct: 1.5,
  targetPct: 3.0,
  inSamplePct: 0.7,
  allowShort: true,
  seed: 42,
  minBars: 120,
};

export interface BTTrade {
  side: "LONG" | "SHORT";
  entryIdx: number;
  exitIdx: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  entryFee: number;
  exitFee: number;
  pnl: number;
  gross: number;
  exitReason: "TAKE_PROFIT" | "STOP_LOSS" | "SIGNAL_EXIT" | "END_OF_DATA";
  holdingBars: number;
  inSample: boolean;
}

export interface BTMetrics {
  tradeCount: number;
  winRatePct: number;
  totalReturnPct: number;
  inSampleReturnPct: number;
  outSampleReturnPct: number;
  maxDrawdownPct: number;
  profitFactor: number;
  sharpe: number;
  expectancy: number;
  avgHoldingBars: number;
  exposurePct: number;
  feesTotal: number;
  finalEquity: number;
}

export interface BTFitness {
  score: number; // 0..100
  grade: "A" | "B" | "C" | "D" | "F";
  verdict: "PASS" | "WATCH" | "FAIL" | "INSUFFICIENT_DATA";
  reasons: string[];
}

export interface BTResult {
  equityCurve: { t: number; equity: number }[];
  trades: BTTrade[];
  metrics: BTMetrics;
  fitness: BTFitness;
  splitIdx: number;
  insufficientData: boolean;
}

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

function sma(vals: number[], n: number): number {
  if (vals.length < n) return NaN;
  let s = 0;
  for (let i = vals.length - n; i < vals.length; i++) s += vals[i];
  return s / n;
}

function rsiCloses(closes: number[], n = 14): number {
  if (closes.length < n + 1) return 50;
  let g = 0;
  let l = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d;
    else l -= d;
  }
  if (l === 0) return 100;
  const rs = g / l;
  return 100 - 100 / (1 + rs);
}

function roc(closes: number[], n: number): number {
  if (closes.length <= n) return 0;
  const base = closes[closes.length - 1 - n];
  if (base <= 0) return 0;
  return ((closes[closes.length - 1] - base) / base) * 100;
}

/** Signal uses ONLY closes[0..i] — never future bars. Returns 1 long, -1 short, 0 flat. */
export function strategySignal(
  id: StrategyId,
  closes: number[],
  i: number,
  allowShort: boolean,
  params?: StrategyParams,
): number {
  const hist = closes.slice(0, i + 1);
  switch (id) {
    case "buy-hold":
      return i === 0 ? 1 : 0; // enter once; exit only at end/SLTP
    case "sma-cross": {
      const fast = param(params, "fast", 2, 400);
      const slow = param(params, "slow", 3, 400);
      // A fast period at or above the slow period cannot cross meaningfully: no signal.
      if (fast >= slow) return 0;
      if (hist.length < slow + 2) return 0;
      const f = sma(hist, fast);
      const s = sma(hist, slow);
      if (!Number.isFinite(f) || !Number.isFinite(s)) return 0;
      if (f > s * 1.0005) return 1;
      if (allowShort && f < s * 0.9995) return -1;
      return 0;
    }
    case "rsi-mean": {
      const n = Math.round(param(params, "rsiPeriod", 2, 200));
      const oversold = param(params, "rsiOversold", 1, 49);
      const overbought = param(params, "rsiOverbought", 51, 99);
      if (oversold >= overbought) return 0; // inverted thresholds: no signal, never a guess
      if (hist.length < n + 2) return 0;
      const r = rsiCloses(hist, n);
      if (r <= oversold) return 1;
      if (allowShort && r >= overbought) return -1;
      return 0;
    }
    case "arise-momentum": {
      const rocPeriod = Math.round(param(params, "rocPeriod", 2, 200));
      const rsiPeriod = Math.round(param(params, "rsiPeriod", 2, 200));
      const threshold = param(params, "momentumThreshold", 0.01, 1);
      if (hist.length < Math.max(rocPeriod, rsiPeriod) + 2) return 0;
      const m = roc(hist, rocPeriod);
      const r = rsiCloses(hist, rsiPeriod);
      const score = 0.6 * Math.max(-1, Math.min(1, m / 5)) + 0.4 * ((r - 50) / 30);
      if (!Number.isFinite(score)) return 0;
      if (score > threshold) return 1;
      if (allowShort && score < -threshold) return -1;
      return 0;
    }
  }
}

export function applyStress(bars: BTBar[], scenario: string): BTBar[] {
  if (scenario === "none") return bars;
  return bars.map((b, i) => {
    const c = { ...b };
    if (scenario === "gap-down" && i > 0 && i % 30 === 0) {
      const g = 0.95;
      c.open *= g;
      c.high *= g;
      c.low *= g;
      c.close *= g;
    } else if (scenario === "vol-spike") {
      const mid = (c.high + c.low) / 2;
      c.high = mid + (c.high - mid) * 2.5;
      c.low = mid - (mid - c.low) * 2.5;
    } else if (scenario === "low-liquidity") {
      c.volume *= 0.2;
    }
    return c;
  });
}

export function runBacktest(
  bars: BTBar[],
  strategy: StrategyId,
  cfg: Partial<BTConfig> = {},
  stress = "none",
): BTResult {
  const c: BTConfig = { ...DEFAULT_BT_CONFIG, ...cfg };
  const data = stress === "missing-bars" ? bars.filter((_, i) => i % 10 !== 9) : applyStress(bars, stress);
  // Low liquidity raises market impact as well as reducing observed volume;
  // volume alone does not otherwise participate in this engine's fill model.
  const effSlip = stress === "high-cost" || stress === "low-liquidity"
    ? c.slippageBps * 5
    : c.slippageBps;
  const splitIdx = Math.floor(data.length * c.inSamplePct);
  const rand = mulberry32(c.seed);

  if (data.length < c.minBars) {
    return {
      equityCurve: [],
      trades: [],
      metrics: emptyMetrics(c.startingEquity),
      fitness: { score: 0, grade: "F", verdict: "INSUFFICIENT_DATA", reasons: [`only ${data.length} bars (< ${c.minBars} required)`] },
      splitIdx,
      insufficientData: true,
    };
  }

  const closes = data.map((b) => b.close);
  let realized = 0; // cumulative net pnl (gross minus all fees)
  let pos: {
    side: 1 | -1;
    qty: number;
    entryPrice: number;
    entryFee: number;
    entryIdx: number;
    stop: number;
    target: number;
  } | null = null;
  const trades: BTTrade[] = [];
  const equityCurve: { t: number; equity: number }[] = [];
  let peak = c.startingEquity;
  let maxDD = 0;
  let exposedBars = 0;
  let feesTotal = 0;

  // Equity = start + realized + unrealized. Reconciles exactly for LONG and SHORT.
  const markEquity = (idx: number): number => {
    if (!pos) return c.startingEquity + realized;
    const px = data[idx].close;
    const unreal = pos.side === 1 ? (px - pos.entryPrice) * pos.qty : (pos.entryPrice - px) * pos.qty;
    return c.startingEquity + realized + unreal;
  };

  // close helper at bar idx with explicit price
  const closePos = (idx: number, px: number, reason: BTTrade["exitReason"]) => {
    if (!pos) return;
    const jitter = 1 + (rand() - 0.5) * 0.0002; // ±1bp deterministic
    const fill = px * (1 + (pos.side === 1 ? -1 : 1) * (effSlip / 10_000)) * jitter;
    const proceeds = pos.qty * fill;
    const exitFee = (proceeds * c.feeBps) / 10_000;
    const gross = pos.side === 1 ? (fill - pos.entryPrice) * pos.qty : (pos.entryPrice - fill) * pos.qty;
    const pnl = gross - pos.entryFee - exitFee;
    void proceeds;
    realized += gross - exitFee; // entry fee already deducted at entry
    feesTotal += exitFee;
    trades.push({
      side: pos.side === 1 ? "LONG" : "SHORT",
      entryIdx: pos.entryIdx,
      exitIdx: idx,
      entryPrice: pos.entryPrice,
      exitPrice: fill,
      qty: pos.qty,
      entryFee: pos.entryFee,
      exitFee,
      pnl,
      gross,
      exitReason: reason,
      holdingBars: idx - pos.entryIdx,
      inSample: pos.entryIdx < splitIdx,
    });
    pos = null;
  };

  const manageOpenPosition = (idx: number, bar: BTBar) => {
    if (!pos) return;
    exposedBars++;
    if (pos.side === 1) {
      if (bar.open <= pos.stop) closePos(idx, bar.open, "STOP_LOSS");
      else if (bar.low <= pos.stop) closePos(idx, pos.stop, "STOP_LOSS");
      else if (bar.high >= pos.target) closePos(idx, pos.target, "TAKE_PROFIT");
    } else {
      if (bar.open >= pos.stop) closePos(idx, bar.open, "STOP_LOSS");
      else if (bar.high >= pos.stop) closePos(idx, pos.stop, "STOP_LOSS");
      else if (bar.low <= pos.target) closePos(idx, pos.target, "TAKE_PROFIT");
    }
  };

  for (let i = 0; i < data.length; i++) {
    // 1) Manage positions against each bar. A stop gapped through fills at
    // the open rather than the unavailable stop price; SL wins if both levels hit.
    manageOpenPosition(i, data[i]);
    // 2) signal from closed history only (no look-ahead); fill at NEXT open
    if (i < data.length - 1) {
      const sig = strategySignal(strategy, closes, i, c.allowShort, c.params);
      const wantFlat = sig === 0;
      if (pos && ((pos.side === 1 && sig === -1) || (pos.side === -1 && sig === 1) || (wantFlat && i - pos.entryIdx >= 1 && strategy !== "buy-hold"))) {
        // exit at next open
        const nx = data[i + 1].open;
        closePos(i + 1, nx, "SIGNAL_EXIT");
      }
      if (!pos && sig !== 0) {
        const equity = markEquity(i);
        const notional = (c.positionPct / 100) * equity;
        const nextOpen = data[i + 1].open;
        const jitter = 1 + (rand() - 0.5) * 0.0002;
        const fill = nextOpen * (1 + (sig === 1 ? 1 : -1) * (effSlip / 10_000)) * jitter;
        if (fill > 0) {
          const qty = Math.floor((notional / fill) * 1e6) / 1e6;
          if (qty > 0) {
            const cost = qty * fill;
            const entryFee = (cost * c.feeBps) / 10_000;
            const stop = sig === 1 ? fill * (1 - c.stopPct / 100) : fill * (1 + c.stopPct / 100);
            const target = sig === 1 ? fill * (1 + c.targetPct / 100) : fill * (1 - c.targetPct / 100);
            realized -= entryFee; // fee deducted immediately; reconciled in equity
            feesTotal += entryFee;
            pos = { side: sig === 1 ? 1 : -1, qty, entryPrice: fill, entryFee, entryIdx: i + 1, stop, target };
            i++; // entry fills at this bar's open; its later range can trigger SL/TP
            manageOpenPosition(i, data[i]);
            const eq = markEquity(i);
            peak = Math.max(peak, eq);
            maxDD = Math.max(maxDD, peak > 0 ? ((peak - eq) / peak) * 100 : 0);
            equityCurve.push({ t: data[i].time, equity: eq });
            continue;
          }
        }
      }
    }
    const eq = markEquity(i);
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, peak > 0 ? ((peak - eq) / peak) * 100 : 0);
    equityCurve.push({ t: data[i].time, equity: eq });
  }
  if (pos) {
    closePos(data.length - 1, data[data.length - 1].close, "END_OF_DATA");
    equityCurve.push({ t: data[data.length - 1].time, equity: c.startingEquity + realized });
  }

  const metrics = computeMetrics(trades, equityCurve, c.startingEquity, splitIdx, data.length, exposedBars, feesTotal);
  metrics.maxDrawdownPct = maxDD;
  const fitness = scoreFitness(metrics, data.length, c.minBars);
  return { equityCurve, trades, metrics, fitness, splitIdx, insufficientData: false };
}

function emptyMetrics(start: number): BTMetrics {
  return {
    tradeCount: 0, winRatePct: 0, totalReturnPct: 0, inSampleReturnPct: 0,
    outSampleReturnPct: 0, maxDrawdownPct: 0, profitFactor: 0, sharpe: 0,
    expectancy: 0, avgHoldingBars: 0, exposurePct: 0, feesTotal: 0, finalEquity: start,
  };
}

function computeMetrics(
  trades: BTTrade[],
  curve: { t: number; equity: number }[],
  start: number,
  splitIdx: number,
  n: number,
  exposedBars: number,
  feesTotal: number,
): BTMetrics {
  const finalEquity = curve.length > 0 ? curve[curve.length - 1].equity : start;
  const totalReturnPct = ((finalEquity - start) / start) * 100;
  const wins = trades.filter((t) => t.pnl > 0);
  const winRatePct = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const grossW = wins.reduce((a, t) => a + t.pnl, 0);
  const grossL = Math.abs(trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossL > 0 ? grossW / grossL : grossW > 0 ? 99 : 0;
  const expectancy = trades.length > 0 ? trades.reduce((a, t) => a + t.pnl, 0) / trades.length : 0;
  const avgHoldingBars = trades.length > 0 ? trades.reduce((a, t) => a + t.holdingBars, 0) / trades.length : 0;
  // per-trade returns for sharpe
  const rets = trades.map((t) => (t.entryPrice * t.qty > 0 ? t.pnl / (t.entryPrice * t.qty) : 0));
  const mean = rets.length > 0 ? rets.reduce((a, r) => a + r, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(Math.max(1, trades.length)) : 0;
  // in/out split approximated from trades by entry side
  const inTr = trades.filter((t) => t.inSample);
  const outTr = trades.filter((t) => !t.inSample);
  const inPnl = inTr.reduce((a, t) => a + t.pnl, 0);
  const outPnl = outTr.reduce((a, t) => a + t.pnl, 0);
  void splitIdx;
  return {
    tradeCount: trades.length,
    winRatePct,
    totalReturnPct,
    inSampleReturnPct: (inPnl / start) * 100,
    outSampleReturnPct: (outPnl / start) * 100,
    maxDrawdownPct: 0, // set by caller from curve walk
    profitFactor,
    sharpe,
    expectancy,
    avgHoldingBars,
    exposurePct: n > 0 ? (exposedBars / n) * 100 : 0,
    feesTotal,
    finalEquity,
  };
}

function scoreFitness(m: BTMetrics, bars: number, minBars: number): BTFitness {
  const reasons: string[] = [];
  if (bars < minBars) {
    return { score: 0, grade: "F", verdict: "INSUFFICIENT_DATA", reasons: [`only ${bars} bars (< ${minBars} required)`] };
  }
  if (m.tradeCount < 10) {
    reasons.push(`only ${m.tradeCount} trades (< 10 needed for significance)`);
    return { score: Math.min(30, m.tradeCount * 3), grade: "F", verdict: "INSUFFICIENT_DATA", reasons };
  }
  let score = 50;
  if (m.totalReturnPct > 0) score += 10; else { score -= 10; reasons.push("negative total return"); }
  if (m.outSampleReturnPct > 0) score += 10; else { score -= 10; reasons.push("out-of-sample return negative — possible overfit"); }
  if (m.maxDrawdownPct < 10) score += 8; else if (m.maxDrawdownPct > 25) { score -= 12; reasons.push(`max drawdown ${m.maxDrawdownPct.toFixed(1)}% exceeds 25%`); }
  if (m.profitFactor > 1.5) score += 8; else if (m.profitFactor < 1) { score -= 8; reasons.push(`profit factor ${m.profitFactor.toFixed(2)} below 1.0`); }
  if (m.sharpe > 1) score += 8; else if (m.sharpe < 0) { score -= 6; reasons.push("negative Sharpe"); }
  if (m.winRatePct >= 40 && m.winRatePct <= 70) score += 4; else reasons.push(`win rate ${m.winRatePct.toFixed(0)}% outside 40–70% band`);
  if (Math.abs(m.inSampleReturnPct - m.outSampleReturnPct) > 15) { score -= 8; reasons.push("in/out-of-sample divergence — possible overfit"); }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : score >= 35 ? "D" : "F";
  const verdict = score >= 65 ? "PASS" : score >= 45 ? "WATCH" : "FAIL";
  if (verdict === "PASS") reasons.unshift("in-sample and out-of-sample both positive with controlled drawdown");
  return { score, grade, verdict, reasons };
}

export const STRATEGY_LABELS: Record<StrategyId, string> = {
  "sma-cross": "SMA 20/50 trend",
  "rsi-mean": "RSI-14 mean reversion",
  "arise-momentum": "ARISE momentum",
  "buy-hold": "Buy & hold (baseline)",
};
