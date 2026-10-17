// ARISE V1 — quantitative engine. Deterministic feature computation over validated bars.
// INPUT: MarketSnapshot (validated). OUTPUT: QuantFeatures. No LLM, no network.

import type { MarketSnapshot, QuantFeatures } from "./types";
import {
  atr,
  autocorr1,
  clamp,
  ema,
  logReturns,
  macd,
  mean,
  percentileRank,
  rsi,
  safe,
  sma,
  stdev,
  linregSlope,
  roc,
} from "./math";

export const barIntervalSec: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

export function intervalMs(interval: string): number {
  return (barIntervalSec[interval] ?? 3600) * 1000;
}

export function computeQuantFeatures(snap: MarketSnapshot): QuantFeatures {
  const closes = snap.bars.map((b) => b.close);
  const highs = snap.bars.map((b) => b.high);
  const lows = snap.bars.map((b) => b.low);
  const vols = snap.bars.map((b) => b.volume);

  const last = closes[closes.length - 1] ?? 0;
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const sma20 = sma(closes, 20);
  const rets = logReturns(closes);
  const retStd = stdev(rets, true);

  // Trend: OLS slope of last 50 closes, expressed as % of price per bar
  const seg = closes.slice(-50);
  const slopePerBar = linregSlope(seg);
  const slopePerBarPct = last > 0 ? (slopePerBar / last) * 100 : 0;
  const emaStructure: QuantFeatures["trend"]["emaStructure"] =
    ema20 > ema50 * 1.0005
      ? "BULLISH"
      : ema20 < ema50 * 0.9995
        ? "BEARISH"
        : "FLAT";

  // ADX-lite: directional movement strength 0..100 (Wilder-style on EMA smoothing)
  let adx = 0;
  if (snap.bars.length >= 20) {
    const plusDM: number[] = [];
    const minusDM: number[] = [];
    for (let i = 1; i < snap.bars.length; i++) {
      const up = highs[i] - highs[i - 1];
      const dn = lows[i - 1] - lows[i];
      plusDM.push(up > dn && up > 0 ? up : 0);
      minusDM.push(dn > up && dn > 0 ? dn : 0);
    }
    const atr14 = atr(snap.bars, 14) || 1;
    const pdi = (ema(plusDM, 14) / atr14) * 100;
    const mdi = (ema(minusDM, 14) / atr14) * 100;
    const dx = pdi + mdi === 0 ? 0 : (Math.abs(pdi - mdi) / (pdi + mdi)) * 100;
    adx = clamp(dx, 0, 100);
  }

  const distFromSma20Pct = sma20 > 0 ? ((last - sma20) / sma20) * 100 : 0;
  const distFromSma20Sigma = retStd > 0 ? (distFromSma20Pct / 100 / retStd) * Math.sqrt(1) : 0;

  // Momentum
  const roc10Pct = roc(closes, 10);
  const roc3Pct = roc(closes, 3);
  const rsi14 = rsi(closes, 14);
  const m = macd(closes);
  const momRaw =
    0.4 * clamp(roc10Pct / 5, -1, 1) +
    0.3 * clamp((rsi14 - 50) / 30, -1, 1) +
    0.3 * clamp((m.hist / (last || 1)) * 200, -1, 1);
  const momentumScore = clamp(momRaw, -1, 1);

  // Volatility
  const realizedVolPct = retStd * 100; // per-bar sigma, %
  const atr14 = atr(snap.bars, 14);
  const atrPct = last > 0 ? (atr14 / last) * 100 : 0;
  const rollingVols: number[] = [];
  for (let i = 20; i <= rets.length; i++) {
    rollingVols.push(stdev(rets.slice(i - 20, i), true));
  }
  const volPercentile = clamp(percentileRank(rollingVols, retStd), 0, 100);
  const volRegime: QuantFeatures["volatility"]["volRegime"] =
    volPercentile >= 90
      ? "EXTREME"
      : volPercentile >= 70
        ? "HIGH"
        : volPercentile <= 25
          ? "LOW"
          : "NORMAL";

  // Statistics
  const z20 =
    retStd > 0 && sma20 > 0
      ? (((last - sma20) / sma20) * 100) / (retStd * 100)
      : 0;
  const win = Math.min(60, closes.length);
  const wHigh = Math.max(...highs.slice(-win));
  const wLow = Math.min(...lows.slice(-win));
  const rangePositionPct =
    wHigh > wLow ? ((last - wLow) / (wHigh - wLow)) * 100 : 50;
  const autocorr = autocorr1(rets);

  // Liquidity
  const volMean = mean(vols);
  const volStd = stdev(vols);
  const volumeZ = volStd > 0 ? (vols[vols.length - 1] - volMean) / volStd : 0;
  const notionalPerBar = mean(
    snap.bars.slice(-20).map((b) => b.close * b.volume),
  );
  const spreadPct = snap.spreadPct;
  const liquidityState: QuantFeatures["liquidity"]["liquidityState"] =
    volumeZ > 0.5 && (spreadPct === null || spreadPct < 0.1)
      ? "HIGH"
      : spreadPct !== null && spreadPct > 0.3
        ? "LOW"
        : "MEDIUM";

  const trendStrength: QuantFeatures["trend"]["trendStrength"] =
    adx >= 25 ? "STRONG" : adx >= 18 ? "MODERATE" : "WEAK";

  const dataOk = snap.quality === "valid" || snap.quality === "degraded";
  const confidence = dataOk
    ? clamp(
        0.5 +
          (snap.quality === "valid" ? 0.15 : 0) +
          (snap.bars.length >= 150 ? 0.15 : 0.05) +
          (spreadPct !== null ? 0.1 : 0) -
          (volRegime === "EXTREME" ? 0.15 : 0),
        0.2,
        0.95,
      )
    : 0.2;

  return {
    symbol: snap.symbol,
    interval: snap.interval,
    dataQuality: snap.quality,
    barCount: snap.bars.length,
    trend: {
      slopePerBarPct: safe(slopePerBarPct) ? slopePerBarPct : 0,
      ema20,
      ema50,
      emaStructure,
      sma20,
      distFromSma20Pct,
      distFromSma20Sigma,
      adx,
      trendStrength,
    },
    momentum: {
      roc10Pct,
      roc3Pct,
      rsi14,
      rsiState:
        rsi14 >= 70 ? "OVERBOUGHT" : rsi14 <= 30 ? "OVERSOLD" : "NEUTRAL",
      macd: m.macd,
      macdSignal: m.signal,
      macdHist: m.hist,
      momentumScore,
    },
    volatility: { realizedVolPct, atr14, atrPct, volPercentile, volRegime },
    statistics: {
      zScore20: z20,
      rollingMean20: sma20,
      rollingStd20: retStd * (sma20 || 1),
      rangePositionPct,
      autocorr1: autocorr,
      retStd,
    },
    liquidity: { volumeZ, spreadPct, notionalPerBar, liquidityState },
    confidence,
  };
}
