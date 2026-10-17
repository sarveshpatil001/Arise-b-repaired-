// ARISE — Strategy AI Arena (pure, deterministic, no LLM, no network).
//
// Ten RULE-BASED strategy candidates are evaluated on ONE validated OHLCV series with
// identical costs and identical execution assumptions. This is deliberately not ten
// independent "AI models": the label is rule-based, and the UI must say so.
//
// Integrity rules encoded here:
//   1. Signal at bar i uses closes/highs/lows/volumes[0..i] only. Fills happen at the
//      NEXT bar's open, so a signal can never trade on a price it has already seen.
//   2. A single chronological holdout (out-of-sample) is reported separately from the
//      in-sample period. The three OOS folds are sequential, not re-optimised, so
//      there is no parameter selection on the evaluation window.
//   3. Fees and slippage are charged on both sides of every trade; no zero-cost fill.
//   4. If a strategy lacks enough OOS trades, its metrics are NOT extrapolated. The
//      result says INSUFFICIENT_DATA and it cannot be selected.
//   5. If no strategy clears the admission gates the arena returns NO TRADE. A recent
//      large profit alone is never the selection criterion: the score weights
//      expectancy, profit factor, stability across folds and drawdown, after costs.

export type ArenaStrategyId =
  | "trend-following"
  | "breakout"
  | "pullback"
  | "support-resistance"
  | "mean-reversion"
  | "momentum"
  | "volatility-expansion"
  | "ma-crossover"
  | "rsi"
  | "volume-price-action";

export type MarketClass =
  | "TRENDING_UP"
  | "TRENDING_DOWN"
  | "RANGING"
  | "VOLATILE"
  | "TRANSITIONING"
  | "UNCLEAR";

export type ArenaStatus = "ELIGIBLE" | "REJECTED" | "INSUFFICIENT_DATA" | "NOT_SUITABLE";

export interface ArenaBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ArenaConfig {
  startingEquity: number;
  feeBps: number;
  slippageBps: number;
  inSamplePct: number;
  minBars: number;
  /** OOS trades required before a strategy may be selected. */
  minOosTrades: number;
  stopAtrMult: number;
  targetAtrMult: number;
}

export const DEFAULT_ARENA_CONFIG: ArenaConfig = {
  startingEquity: 10_000,
  feeBps: 4,
  slippageBps: 2,
  inSamplePct: 0.7,
  minBars: 150,
  minOosTrades: 8,
  stopAtrMult: 1.5,
  targetAtrMult: 3,
};

export interface ArenaMetrics {
  trades: number;
  winRatePct: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  totalReturnPct: number | null;
  maxDrawdownPct: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  feesPaid: number;
  stability: number | null;
}

export interface ArenaGates {
  sampleSize: boolean;
  profitFactor: boolean;
  expectancy: boolean;
  drawdown: boolean;
  stability: boolean;
  regimeFit: boolean;
  hasSignal: boolean;
}

export interface ArenaStrategyResult {
  id: ArenaStrategyId;
  label: string;
  kind: "RULE_BASED";
  status: ArenaStatus;
  regimeFit: boolean;
  regimeNote: string;
  signal: -1 | 0 | 1;
  signalReason: string;
  metrics: ArenaMetrics | null;
  gates: ArenaGates;
  score: number | null;
  reason: string;
  weaknesses: string[];
}

export interface ArenaResult {
  status: "OK" | "INSUFFICIENT_DATA";
  symbol: string;
  interval: string;
  dataSource: string;
  bars: number;
  marketClass: MarketClass;
  marketClassReason: string;
  splitIndex: number;
  dataStart: number | null;
  dataEnd: number | null;
  evaluatedAt: number;
  strategies: ArenaStrategyResult[];
  ranking: ArenaStrategyResult[];
  selectedId: ArenaStrategyId | null;
  selected: ArenaStrategyResult | null;
  selectedReason: string;
  noTradeReason: string;
  methodology: string[];
  limitations: string[];
  execution: "SIGNAL_ONLY";
}

export const ARENA_STRATEGIES: { id: ArenaStrategyId; label: string }[] = [
  { id: "trend-following", label: "Trend Following" },
  { id: "breakout", label: "Breakout" },
  { id: "pullback", label: "Pullback Entry" },
  { id: "support-resistance", label: "Support and Resistance" },
  { id: "mean-reversion", label: "Mean Reversion" },
  { id: "momentum", label: "Momentum" },
  { id: "volatility-expansion", label: "Volatility Expansion" },
  { id: "ma-crossover", label: "Moving Average Crossover" },
  { id: "rsi", label: "RSI-Based Strategy" },
  { id: "volume-price-action", label: "Volume-Confirmed Price Action" },
];

interface Trade {
  entryIdx: number;
  exitIdx: number;
  side: 1 | -1;
  entry: number;
  exit: number;
  pnl: number;
  fees: number;
  inSample: boolean;
}

interface SignalResult {
  signal: -1 | 0 | 1;
  reason: string;
}

// ---------------------------------------------------------------- indicators

function smaAt(values: number[], endIdx: number, period: number): number | null {
  if (endIdx + 1 < period) return null;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) sum += values[i];
  return sum / period;
}

function emaAt(values: number[], endIdx: number, period: number): number | null {
  if (endIdx + 1 < period) return null;
  const k = 2 / (period + 1);
  let value = 0;
  for (let i = 0; i < period; i++) value += values[i];
  value /= period;
  for (let i = period; i <= endIdx; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function stdAt(values: number[], endIdx: number, period: number): number | null {
  if (endIdx + 1 < period) return null;
  const slice = values.slice(endIdx - period + 1, endIdx + 1);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

function rsiAt(closes: number[], endIdx: number, period = 14): number | null {
  if (endIdx < period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

function atrAt(bars: ArenaBar[], endIdx: number, period = 14): number | null {
  if (endIdx < period) return null;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    const prevClose = bars[i - 1]?.close ?? bars[i].close;
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose),
    );
    sum += tr;
  }
  return sum / period;
}

function rocAt(closes: number[], endIdx: number, period: number): number {
  if (endIdx - period < 0) return 0;
  const base = closes[endIdx - period];
  return base > 0 ? ((closes[endIdx] - base) / base) * 100 : 0;
}

// ---------------------------------------------------------------- market classification

export function classifyMarket(bars: ArenaBar[]): { marketClass: MarketClass; reason: string } {
  if (bars.length < 60) {
    return { marketClass: "UNCLEAR", reason: "Fewer than 60 bars — market condition cannot be classified." };
  }
  const closes = bars.map((b) => b.close);
  const last = bars.length - 1;
  const ema20 = emaAt(closes, last, 20);
  const ema50 = emaAt(closes, last, 50);
  const roc20 = rocAt(closes, last, 20);
  const atr = atrAt(bars, last, 14);
  const atrPct = atr !== null && closes[last] > 0 ? (atr / closes[last]) * 100 : null;

  const atrHistory: number[] = [];
  for (let i = Math.max(14, last - 60); i <= last; i++) {
    const a = atrAt(bars, i, 14);
    if (a !== null && closes[i] > 0) atrHistory.push((a / closes[i]) * 100);
  }
  const medianAtr = median(atrHistory);
  const volExpanded = atrPct !== null && medianAtr !== null && medianAtr > 0 && atrPct > medianAtr * 1.6;
  const volCompressed = atrPct !== null && medianAtr !== null && medianAtr > 0 && atrPct < medianAtr * 0.7;

  if (ema20 === null || ema50 === null) {
    return { marketClass: "UNCLEAR", reason: "Not enough history for trend structure." };
  }

  const spreadPct = Math.abs((ema20 - ema50) / ema50) * 100;
  const crossedRecently = (() => {
    for (let i = Math.max(50, last - 10); i <= last; i++) {
      const a = emaAt(closes, i, 20);
      const b = emaAt(closes, i, 50);
      const p = emaAt(closes, i - 1, 20);
      const q = emaAt(closes, i - 1, 50);
      if (a === null || b === null || p === null || q === null) continue;
      if (Math.sign(a - b) !== Math.sign(p - q)) return true;
    }
    return false;
  })();

  if (volExpanded && spreadPct < 0.6) {
    return {
      marketClass: "VOLATILE",
      reason: `ATR ${atrPct?.toFixed(2)}% is above 1.6× its 60-bar median with no decisive EMA separation (${spreadPct.toFixed(2)}%).`,
    };
  }
  if (crossedRecently && spreadPct < 0.8) {
    return {
      marketClass: "TRANSITIONING",
      reason: "EMA20/EMA50 crossed within the last 10 bars; direction is not yet established.",
    };
  }
  if (spreadPct >= 0.35 && roc20 > 1) {
    return {
      marketClass: "TRENDING_UP",
      reason: `EMA20 is ${spreadPct.toFixed(2)}% above EMA50 and 20-bar ROC is +${roc20.toFixed(2)}%.`,
    };
  }
  if (spreadPct >= 0.35 && roc20 < -1) {
    return {
      marketClass: "TRENDING_DOWN",
      reason: `EMA20 is ${spreadPct.toFixed(2)}% below EMA50 and 20-bar ROC is ${roc20.toFixed(2)}%.`,
    };
  }
  if (spreadPct < 0.6 && volCompressed) {
    return {
      marketClass: "RANGING",
      reason: `Compressed volatility (ATR ${atrPct?.toFixed(2)}% vs median ${medianAtr?.toFixed(2)}%) and flat EMAs (${spreadPct.toFixed(2)}%).`,
    };
  }
  if (spreadPct < 0.8 && Math.abs(roc20) < 1.5) {
    return {
      marketClass: "RANGING",
      reason: `Price is rotating around a flat 20-bar mean with ${Math.abs(roc20).toFixed(2)}% 20-bar drift.`,
    };
  }
  return {
    marketClass: "UNCLEAR",
    reason: "Trend, momentum and volatility evidence disagree; the regime is not classified.",
  };
}

// ---------------------------------------------------------------- strategy signals

export function strategySignal(
  id: ArenaStrategyId,
  bars: ArenaBar[],
  i: number,
): SignalResult {
  if (i < 60) return { signal: 0, reason: "Insufficient history (need at least 60 bars)." };
  const closes = bars.map((b) => b.close);
  const bar = bars[i];
  const close = bar.close;
  const prev = bars[i - 1];
  const ema20 = emaAt(closes, i, 20);
  const ema50 = emaAt(closes, i, 50);
  const sma20 = smaAt(closes, i, 20);
  const atr = atrAt(bars, i, 14);
  if (ema20 === null || ema50 === null || sma20 === null || atr === null || atr <= 0) {
    return { signal: 0, reason: "Indicators are not available yet." };
  }
  const slope = closes[i] - closes[i - 20];
  const roc10 = rocAt(closes, i, 10);
  const rsi = rsiAt(closes, i, 14);

  switch (id) {
    case "trend-following": {
      if (ema20 > ema50 && slope > 0) {
        return { signal: 1, reason: "EMA20 above EMA50 with a positive 20-bar slope." };
      }
      if (ema20 < ema50 && slope < 0) {
        return { signal: -1, reason: "EMA20 below EMA50 with a negative 20-bar slope." };
      }
      return { signal: 0, reason: "Trend structure and slope do not agree." };
    }
    case "breakout": {
      const lookback = bars.slice(Math.max(0, i - 20), i);
      const high = Math.max(...lookback.map((b) => b.high));
      const low = Math.min(...lookback.map((b) => b.low));
      if (close > high) return { signal: 1, reason: `Close broke the prior 20-bar high (${high.toFixed(4)}).` };
      if (close < low) return { signal: -1, reason: `Close broke the prior 20-bar low (${low.toFixed(4)}).` };
      return { signal: 0, reason: "Price remains inside the prior 20-bar range." };
    }
    case "pullback": {
      if (ema20 > ema50 && bar.low <= ema20 + atr * 0.5 && close > ema20 && close > bar.open) {
        return { signal: 1, reason: "Uptrend pullback into EMA20 that closed back above it." };
      }
      if (ema20 < ema50 && bar.high >= ema20 - atr * 0.5 && close < ema20 && close < bar.open) {
        return { signal: -1, reason: "Downtrend pullback into EMA20 that closed back below it." };
      }
      return { signal: 0, reason: "No pullback entry aligned with the trend." };
    }
    case "support-resistance": {
      const window = bars.slice(Math.max(0, i - 20), i + 1);
      const high = Math.max(...window.map((b) => b.high));
      const low = Math.min(...window.map((b) => b.low));
      if (high <= low) return { signal: 0, reason: "Range is degenerate." };
      const position = (close - low) / (high - low);
      if (position <= 0.12 && close > prev.close) {
        return { signal: 1, reason: `Bounce from the lower 12% of the 20-bar range (${(position * 100).toFixed(0)}%).` };
      }
      if (position >= 0.88 && close < prev.close) {
        return { signal: -1, reason: `Rejection from the upper 12% of the 20-bar range (${(position * 100).toFixed(0)}%).` };
      }
      return { signal: 0, reason: "Price is not at a tested range boundary." };
    }
    case "mean-reversion": {
      const sd = stdAt(closes, i, 20);
      if (!sd || sd <= 0) return { signal: 0, reason: "No usable 20-bar dispersion." };
      const z = (close - sma20) / sd;
      if (z <= -2) return { signal: 1, reason: `Close is ${z.toFixed(2)}σ below its 20-bar mean.` };
      if (z >= 2) return { signal: -1, reason: `Close is ${z.toFixed(2)}σ above its 20-bar mean.` };
      return { signal: 0, reason: `Close is within ${Math.abs(z).toFixed(2)}σ of the mean.` };
    }
    case "momentum": {
      if (roc10 > 1 && close > ema20) return { signal: 1, reason: `10-bar ROC +${roc10.toFixed(2)}% above EMA20.` };
      if (roc10 < -1 && close < ema20) return { signal: -1, reason: `10-bar ROC ${roc10.toFixed(2)}% below EMA20.` };
      return { signal: 0, reason: "Momentum is below the 1% action threshold or against the mean." };
    }
    case "volatility-expansion": {
      const atrPct = (atr / close) * 100;
      const history: number[] = [];
      for (let j = Math.max(14, i - 50); j < i; j++) {
        const a = atrAt(bars, j, 14);
        if (a !== null && closes[j] > 0) history.push((a / closes[j]) * 100);
      }
      const med = median(history);
      const expanded = med !== null && med > 0 && atrPct > med * 1.5;
      if (!expanded) return { signal: 0, reason: "Volatility has not expanded versus its 50-bar median." };
      if (close > prev.high) return { signal: 1, reason: `Expanded volatility with a break of the prior high (ATR ${atrPct.toFixed(2)}%).` };
      if (close < prev.low) return { signal: -1, reason: `Expanded volatility with a break of the prior low (ATR ${atrPct.toFixed(2)}%).` };
      return { signal: 0, reason: "Volatility expanded but price did not break the prior bar." };
    }
    case "ma-crossover": {
      const fast = smaAt(closes, i, 10);
      const slow = smaAt(closes, i, 30);
      const prevFast = smaAt(closes, i - 1, 10);
      const prevSlow = smaAt(closes, i - 1, 30);
      if (fast === null || slow === null || prevFast === null || prevSlow === null) {
        return { signal: 0, reason: "Moving averages are not available yet." };
      }
      if (prevFast <= prevSlow && fast > slow) return { signal: 1, reason: "SMA10 crossed above SMA30 on this bar." };
      if (prevFast >= prevSlow && fast < slow) return { signal: -1, reason: "SMA10 crossed below SMA30 on this bar." };
      return { signal: 0, reason: "No new SMA10/SMA30 cross." };
    }
    case "rsi": {
      if (rsi === null) return { signal: 0, reason: "RSI is not available yet." };
      if (rsi <= 30) return { signal: 1, reason: `RSI14 is ${rsi.toFixed(1)} (oversold).` };
      if (rsi >= 70) return { signal: -1, reason: `RSI14 is ${rsi.toFixed(1)} (overbought).` };
      return { signal: 0, reason: `RSI14 is ${rsi.toFixed(1)} — no extreme.` };
    }
    case "volume-price-action": {
      const avgVol = smaAt(bars.map((b) => b.volume), i, 20);
      if (!avgVol || avgVol <= 0) return { signal: 0, reason: "No usable volume baseline." };
      const confirmed = bar.volume > avgVol * 1.5;
      if (!confirmed) return { signal: 0, reason: "Volume is not at least 1.5× its 20-bar average." };
      if (close > prev.close) return { signal: 1, reason: "Up close on ≥1.5× average volume." };
      if (close < prev.close) return { signal: -1, reason: "Down close on ≥1.5× average volume." };
      return { signal: 0, reason: "Volume expanded with no directional close." };
    }
    default:
      return { signal: 0, reason: "Unknown strategy." };
  }
}

// ---------------------------------------------------------------- suitability

export function regimeFitness(id: ArenaStrategyId, marketClass: MarketClass): { fit: boolean; note: string } {
  const trending = marketClass === "TRENDING_UP" || marketClass === "TRENDING_DOWN";
  const ranging = marketClass === "RANGING";
  const volatile = marketClass === "VOLATILE";
  switch (id) {
    case "trend-following":
    case "momentum":
      return { fit: trending, note: trending ? "Trend continuation fits the classified trend." : "Trend continuation needs a classified trend." };
    case "pullback":
      return { fit: trending, note: trending ? "Pullback entries fit an established trend." : "A pullback needs an established trend." };
    case "ma-crossover":
      return { fit: trending || marketClass === "TRANSITIONING", note: "Crossovers need a directional transition." };
    case "breakout":
      return { fit: trending || volatile, note: "Breakouts need expansion or trend, not a quiet range." };
    case "volatility-expansion":
      return { fit: volatile || marketClass === "TRANSITIONING", note: "Expansion needs above-normal volatility." };
    case "support-resistance":
    case "mean-reversion":
    case "rsi":
      return { fit: ranging, note: "Mean-reversion logic fits a classified range, not a strong trend." };
    case "volume-price-action":
      return { fit: marketClass !== "UNCLEAR", note: marketClass === "UNCLEAR" ? "Regime is unclear; no directional bias is assumed." : "Volume confirmation can be evaluated in any classified regime." };
    default:
      return { fit: false, note: "Unknown strategy." };
  }
}

// ---------------------------------------------------------------- backtest

function backtest(
  id: ArenaStrategyId,
  bars: ArenaBar[],
  splitIndex: number,
  config: ArenaConfig,
): { trades: Trade[]; metrics: ArenaMetrics; signal: SignalResult; allTrades: Trade[] } {
  const trades: Trade[] = [];
  let position: { side: 1 | -1; entry: number; qty: number; stop: number; target: number; entryIdx: number; entryFee: number } | null = null;
  const feeRate = config.feeBps / 10_000;

  const closePosition = (exitIdx: number, rawPrice: number) => {
    if (!position) return;
    const slip = config.slippageBps / 10_000;
    const exitRaw = position.side === 1 ? rawPrice * (1 - slip) : rawPrice * (1 + slip);
    const exitFee = exitRaw * position.qty * feeRate;
    const gross = (exitRaw - position.entry) * position.qty * position.side;
    const pnl = gross - exitFee - position.entryFee;
    trades.push({
      entryIdx: position.entryIdx,
      exitIdx,
      side: position.side,
      entry: position.entry,
      exit: exitRaw,
      pnl,
      fees: exitFee + position.entryFee,
      inSample: position.entryIdx < splitIndex,
    });
    position = null;
  };

  const last = bars.length - 1;
  for (let i = 60; i < last; i++) {
    const signal = strategySignal(id, bars, i).signal;

    if (position) {
      const bar = bars[i];
      const hitStop = position.side === 1 ? bar.low <= position.stop : bar.high >= position.stop;
      const hitTarget = position.side === 1 ? bar.high >= position.target : bar.low <= position.target;
      if (hitStop) {
        closePosition(i, position.stop);
      } else if (hitTarget) {
        closePosition(i, position.target);
      } else if (signal !== 0 && signal !== position.side) {
        closePosition(i + 1, bars[i + 1].open);
      }
      continue;
    }

    if (signal !== 0) {
      const atr = atrAt(bars, i, 14);
      if (atr === null || atr <= 0) continue;
      const next = bars[i + 1];
      if (!next) continue;
      const slip = config.slippageBps / 10_000;
      const entry = signal === 1 ? next.open * (1 + slip) : next.open * (1 - slip);
      const qty = config.startingEquity / entry;
      position = {
        side: signal,
        entry,
        qty,
        stop: signal === 1 ? entry - atr * config.stopAtrMult : entry + atr * config.stopAtrMult,
        target: signal === 1 ? entry + atr * config.targetAtrMult : entry - atr * config.targetAtrMult,
        entryIdx: i + 1,
        entryFee: entry * qty * feeRate,
      };
    }
  }
  if (position) closePosition(last, bars[last].close);

  const oos = trades.filter((t) => t.entryIdx >= splitIndex);
  const metrics = summarizeTrades(oos, config);
  const signal = strategySignal(id, bars, last);
  return { trades: oos, metrics, signal, allTrades: trades };
}

function summarizeTrades(trades: Trade[], config: ArenaConfig): ArenaMetrics {
  if (trades.length === 0) {
    return {
      trades: 0,
      winRatePct: null,
      profitFactor: null,
      expectancy: null,
      totalReturnPct: null,
      maxDrawdownPct: null,
      avgWin: null,
      avgLoss: null,
      feesPaid: 0,
      stability: null,
    };
  }
  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const net = pnls.reduce((a, b) => a + b, 0);

  let equity = config.startingEquity;
  let peak = equity;
  let maxDd = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - equity) / peak) * 100);
  }

  // Sequential OOS folds: stability is the share of folds with positive net P&L.
  // No parameter is chosen on these folds; they only measure consistency.
  const foldSize = Math.max(1, Math.ceil(trades.length / 3));
  let positiveFolds = 0;
  let foldCount = 0;
  for (let start = 0; start < trades.length; start += foldSize) {
    const fold = trades.slice(start, start + foldSize);
    if (fold.length === 0) continue;
    foldCount += 1;
    if (fold.reduce((a, t) => a + t.pnl, 0) > 0) positiveFolds += 1;
  }

  return {
    trades: trades.length,
    winRatePct: (wins.length / trades.length) * 100,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: net / trades.length,
    totalReturnPct: (net / config.startingEquity) * 100,
    maxDrawdownPct: maxDd,
    avgWin: wins.length > 0 ? grossWin / wins.length : null,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : null,
    feesPaid: trades.reduce((a, t) => a + t.fees, 0),
    stability: foldCount > 0 ? positiveFolds / foldCount : null,
  };
}

// ---------------------------------------------------------------- arena

export function runArena(
  inputBars: ArenaBar[],
  opts: {
    symbol: string;
    interval: string;
    dataSource: string;
    now: number;
    config?: Partial<ArenaConfig>;
  },
): ArenaResult {
  const config: ArenaConfig = { ...DEFAULT_ARENA_CONFIG, ...(opts.config ?? {}) };
  const bars = sanitizeBars(inputBars);
  const dataStart = bars.length > 0 ? bars[0].time : null;
  const dataEnd = bars.length > 0 ? bars[bars.length - 1].time : null;

  if (bars.length < config.minBars) {
    return {
      status: "INSUFFICIENT_DATA",
      symbol: opts.symbol,
      interval: opts.interval,
      dataSource: opts.dataSource,
      bars: bars.length,
      marketClass: "UNCLEAR",
      marketClassReason: `Only ${bars.length} valid bars — ${config.minBars} required for a comparable evaluation.`,
      splitIndex: 0,
      dataStart,
      dataEnd,
      evaluatedAt: opts.now,
      strategies: ARENA_STRATEGIES.map((s) => ({
        id: s.id,
        label: s.label,
        kind: "RULE_BASED",
        status: "INSUFFICIENT_DATA",
        regimeFit: false,
        regimeNote: "Not evaluated.",
        signal: 0,
        signalReason: "Not evaluated.",
        metrics: null,
        gates: { sampleSize: false, profitFactor: false, expectancy: false, drawdown: false, stability: false, regimeFit: false, hasSignal: false },
        score: null,
        reason: `Insufficient valid bars (${bars.length} < ${config.minBars}).`,
        weaknesses: ["No evaluation was performed; no historical metric is invented."],
      })),
      ranking: [],
      selectedId: null,
      selected: null,
      selectedReason: "",
      noTradeReason: "NO TRADE — insufficient validated data for the arena.",
      methodology: arenaMethodology(),
      limitations: arenaLimitations(),
      execution: "SIGNAL_ONLY",
    };
  }

  const { marketClass, reason: marketClassReason } = classifyMarket(bars);
  const splitIndex = Math.max(
    60,
    Math.min(bars.length - 30, Math.floor(bars.length * clampConfig(config.inSamplePct))),
  );

  const strategies = ARENA_STRATEGIES.map<ArenaStrategyResult>(({ id, label }) => {
    const { metrics, signal } = backtest(id, bars, splitIndex, config);
    const fitness = regimeFitness(id, marketClass);
    const gates: ArenaGates = {
      sampleSize: metrics.trades >= config.minOosTrades,
      profitFactor: metrics.profitFactor !== null && metrics.profitFactor >= 1.05,
      expectancy: metrics.expectancy !== null && metrics.expectancy > 0,
      drawdown: metrics.maxDrawdownPct !== null && metrics.maxDrawdownPct <= 25,
      stability: metrics.stability !== null && metrics.stability >= 0.34,
      regimeFit: fitness.fit,
      hasSignal: signal.signal !== 0,
    };
    const passEvidence = gates.sampleSize && gates.profitFactor && gates.expectancy && gates.drawdown && gates.stability;
    const status: ArenaStatus =
      metrics.trades < 3
        ? "INSUFFICIENT_DATA"
        : !fitness.fit
          ? "NOT_SUITABLE"
          : passEvidence && gates.hasSignal
            ? "ELIGIBLE"
            : "REJECTED";

    const failed = Object.entries(gates).filter(([, ok]) => !ok).map(([key]) => key);
    const score = passEvidence && fitness.fit ? scoreOf(metrics) : null;
    return {
      id,
      label,
      kind: "RULE_BASED",
      status,
      regimeFit: fitness.fit,
      regimeNote: fitness.note,
      signal: signal.signal,
      signalReason: signal.reason,
      metrics,
      gates,
      score,
      reason:
        status === "ELIGIBLE"
          ? "Cleared every admission gate and has a current eligible signal."
          : status === "NOT_SUITABLE"
            ? `Strategy is not suitable for the classified market (${marketClass}).`
            : status === "INSUFFICIENT_DATA"
              ? `Only ${metrics.trades} out-of-sample trade(s); at least 3 are required to measure anything.`
              : `Rejected by admission gate(s): ${failed.join(", ")}.`,
      weaknesses: weaknessesOf(id, metrics, gates),
    };
  });

  const ranking = [...strategies]
    .filter((s) => s.score !== null)
    .sort((a, b) => (b.score as number) - (a.score as number));
  for (const strategy of strategies) {
    if (strategy.score !== null) {
      strategy.reason += ` Rank score ${strategy.score.toFixed(2)} (evidence-weighted, not recent profit).`;
    }
  }
  const selected = ranking[0] ?? null;

  let noTradeReason = "";
  if (!selected) {
    const anySignal = strategies.some((s) => s.signal !== 0);
    noTradeReason = anySignal
      ? "NO TRADE — no strategy cleared the sample, profitability, drawdown and stability gates. A candidate signal alone is not enough."
      : "NO TRADE — no strategy produced an eligible signal on the latest completed bar.";
  }

  return {
    status: "OK",
    symbol: opts.symbol,
    interval: opts.interval,
    dataSource: opts.dataSource,
    bars: bars.length,
    marketClass,
    marketClassReason,
    splitIndex,
    dataStart,
    dataEnd,
    evaluatedAt: opts.now,
    strategies,
    ranking,
    selectedId: selected?.id ?? null,
    selected,
    selectedReason: selected
      ? `Selected ${selected.label}: score ${(selected.score as number).toFixed(2)}, OOS expectancy ${formatMoney(selected.metrics?.expectancy)}, profit factor ${selected.metrics?.profitFactor?.toFixed(2) ?? "n/a"}, ${selected.metrics?.trades ?? 0} OOS trades, stability ${Math.round((selected.metrics?.stability ?? 0) * 100)}%.`
      : "",
    noTradeReason,
    methodology: arenaMethodology(),
    limitations: arenaLimitations(),
    execution: "SIGNAL_ONLY",
  };
}

export function scoreOf(metrics: ArenaMetrics): number {
  const expectancy = metrics.expectancy ?? 0;
  const pf = metrics.profitFactor ?? 0;
  const dd = metrics.maxDrawdownPct ?? 100;
  const stability = metrics.stability ?? 0;
  const expectancyScore = Math.max(0, Math.min(1, expectancy / 150));
  const pfScore = Math.max(0, Math.min(1, (pf - 1) / 1.5));
  const ddScore = Math.max(0, Math.min(1, (25 - dd) / 25));
  return Math.round((expectancyScore * 0.35 + pfScore * 0.25 + stability * 0.2 + ddScore * 0.2) * 1000) / 1000;
}

// ---------------------------------------------------------------- helpers

export function sanitizeBars(input: ArenaBar[]): ArenaBar[] {
  const byTime = new Map<number, ArenaBar>();
  for (const bar of input) {
    if (
      !bar ||
      ![bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume].every((v) => typeof v === "number" && Number.isFinite(v))
    ) {
      continue;
    }
    if (bar.time <= 0 || bar.open <= 0 || bar.high <= 0 || bar.low <= 0 || bar.close <= 0) continue;
    if (bar.high < bar.low || bar.close > bar.high || bar.close < bar.low) continue;
    byTime.set(bar.time, { ...bar, volume: Math.max(0, bar.volume) });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function clampConfig(value: number): number {
  return Math.max(0.5, Math.min(0.9, Number.isFinite(value) ? value : 0.7));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return `$${value.toFixed(2)}`;
}

function weaknessesOf(id: ArenaStrategyId, metrics: ArenaMetrics, gates: ArenaGates): string[] {
  const out: string[] = [];
  if (metrics.trades < 20) out.push(`Small OOS sample (${metrics.trades} trades): high variance, not proof of edge.`);
  if (gates.profitFactor === false) out.push("Profit factor is below 1.05 after costs.");
  if (gates.drawdown === false) out.push(`OOS drawdown ${metrics.maxDrawdownPct?.toFixed(1)}% exceeds the 25% review limit.`);
  if (gates.stability === false) out.push("Net P&L is not positive across a majority of OOS folds.");
  if (gates.expectancy === false) out.push("Expectancy after fees and slippage is not positive.");
  if (id === "rsi" || id === "mean-reversion") out.push("Mean-reversion can be run over by a sustained trend.");
  if (id === "breakout") out.push("Breakouts are prone to false breakouts in low liquidity or range conditions.");
  if (id === "volume-price-action") out.push("Volume spikes can be exchange-specific or wash-driven.");
  if (out.length === 0) out.push("Past performance on one sample does not establish future returns.");
  return out;
}

function arenaMethodology(): string[] {
  return [
    "Stage 1: classify the market as trending, ranging, volatile, transitioning or unclear from EMA structure, 20-bar drift and ATR expansion.",
    "Stage 2: run all ten rule-based strategies on the same validated bars, timeframe and cost model; signals use only data up to their bar and fill at the next open.",
    "Stage 3: measure out-of-sample trades only (last 30%), with 4 bps fees + 2 bps slippage per side, profit factor, expectancy, win rate, drawdown and three sequential OOS-fold stability.",
    "Stage 4: the selected candidate is sent through the deterministic risk preview; a veto returns NO TRADE.",
    "Stage 5: rank eligible strategies by evidence quality (expectancy 35%, profit factor 25%, stability 20%, drawdown 20%) — never by recent profit alone.",
  ];
}

function arenaLimitations(): string[] {
  return [
    "Ten rule-based strategies, not ten independent AI models. No language model participates in this arena.",
    "One instrument and one timeframe per run; cross-market robustness is not established.",
    "Historical bars come from the configured provider and are validated, but provider history can have gaps or revisions.",
    "No parameter optimisation is performed; that avoids selection leakage but also means the rules are not tuned per market.",
    "A passing arena is evidence for review, not a promise of profit or a recommendation to trade.",
  ];
}
