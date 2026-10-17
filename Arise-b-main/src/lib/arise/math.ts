// ARISE V1 — deterministic math primitives. No LLM involvement. Pure functions only.

export const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));

export const safe = (v: number): boolean =>
  Number.isFinite(v) && !Number.isNaN(v);

export const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export function stdev(xs: number[], sample = false): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance =
    xs.reduce((acc, x) => acc + (x - m) * (x - m), 0) /
    (sample ? xs.length - 1 : xs.length);
  return Math.sqrt(variance);
}

/** Percentile rank of x within xs, 0..100 */
export function percentileRank(xs: number[], x: number): number {
  if (xs.length === 0) return 50;
  const below = xs.filter((v) => v < x).length;
  const equal = xs.filter((v) => v === x).length;
  return ((below + equal / 2) / xs.length) * 100;
}

/** OLS slope of y over index 0..n-1, in y-units per step */
export function linregSlope(y: number[]): number {
  const n = y.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (y[i] - ym);
    den += (i - xm) * (i - xm);
  }
  return den === 0 ? 0 : num / den;
}

/** Pearson correlation of two equal-length series */
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const xm = mean(x);
  const ym = mean(y);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a1 = x[i] - xm;
    const b1 = y[i] - ym;
    num += a1 * b1;
    dx += a1 * a1;
    dy += b1 * b1;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : clamp(num / den, -1, 1);
}

/** Exponential moving average series (same length as input). */
export function emaSeries(xs: number[], period: number): number[] {
  const out: number[] = [];
  if (xs.length === 0) return out;
  const k = 2 / (period + 1);
  let prev = xs[0];
  for (let i = 0; i < xs.length; i++) {
    prev = i === 0 ? xs[0] : xs[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function ema(xs: number[], period: number): number {
  const s = emaSeries(xs, period);
  return s.length === 0 ? 0 : s[s.length - 1];
}

export function sma(xs: number[], period: number): number {
  if (xs.length === 0) return 0;
  const w = xs.slice(-period);
  return mean(w);
}

/** Wilder RSI */
export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

/** Average True Range (Wilder) */
export function atr(
  bars: { high: number; low: number; close: number }[],
  period = 14,
): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prevClose = bars[i - 1].close;
    trs.push(
      Math.max(
        b.high - b.low,
        Math.abs(b.high - prevClose),
        Math.abs(b.low - prevClose),
      ),
    );
  }
  return ema(trs, period);
}

export function macd(closes: number[], fast = 12, slow = 26, signal = 9) {
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const line = closes.map((_, i) => ef[i] - es[i]);
  const sig = emaSeries(line, signal);
  const last = line.length - 1;
  return {
    macd: line[last] ?? 0,
    signal: sig[last] ?? 0,
    hist: (line[last] ?? 0) - (sig[last] ?? 0),
  };
}

/** Rate of change over n bars, % */
export function roc(closes: number[], n: number): number {
  if (closes.length <= n) return 0;
  const prev = closes[closes.length - 1 - n];
  if (prev === 0) return 0;
  return ((closes[closes.length - 1] - prev) / prev) * 100;
}

/** Lag-1 autocorrelation of a series */
export function autocorr1(xs: number[]): number {
  if (xs.length < 3) return 0;
  return correlation(xs.slice(0, -1), xs.slice(1));
}

export function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) out.push(Math.log(closes[i] / closes[i - 1]));
  }
  return out;
}

export const fmtNum = (v: number, digits = 2): string =>
  safe(v) ? v.toLocaleString("en-US", { maximumFractionDigits: digits }) : "—";

export const fmtMoney = (v: number, digits = 2): string =>
  `${v < 0 ? "-" : ""}$${fmtNum(Math.abs(v), digits)}`;

export const fmtPct = (v: number, digits = 2): string =>
  `${v > 0 ? "+" : ""}${fmtNum(v, digits)}%`;
