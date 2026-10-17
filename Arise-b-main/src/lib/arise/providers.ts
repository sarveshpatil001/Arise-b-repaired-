// ARISE V1 — market data providers (REAL data only).
// Binance public REST for crypto, Yahoo Finance chart API for FX pairs.
// Never fabricate prices. On provider failure → circuit breaker → fallback → else NO TRADE.

import axios from "axios";
import type { Bar } from "./types";
import type { RawBar } from "./validate";
import { intervalMs } from "./quant";
import {
  deltaQueryString,
  deltaResolution,
  DELTA_PATHS,
  parseCandles,
  parseTicker,
  resolveDeltaBaseUrl,
  toDeltaSymbol,
  type DeltaEnv,
} from "./delta";

const TIMEOUT = 10_000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ---------------- Circuit breaker (per provider) ----------------

interface BreakerState {
  failures: number;
  openedAt: number | null;
}

const breakers = new Map<string, BreakerState>();
const BREAKER_THRESHOLD = 4;
const BREAKER_COOLDOWN_MS = 60_000;

function breakerStatus(name: string): "CLOSED" | "OPEN" | "HALF_OPEN" {
  const b = breakers.get(name);
  if (!b || b.openedAt === null) return "CLOSED";
  if (Date.now() - b.openedAt > BREAKER_COOLDOWN_MS) return "HALF_OPEN";
  return "OPEN";
}

function recordSuccess(name: string) {
  breakers.set(name, { failures: 0, openedAt: null });
}

function recordFailure(name: string) {
  const b = breakers.get(name) ?? { failures: 0, openedAt: null };
  b.failures++;
  if (b.failures >= BREAKER_THRESHOLD) b.openedAt = Date.now();
  breakers.set(name, b);
}

async function guarded<T>(provider: string, fn: () => Promise<T>): Promise<T> {
  const st = breakerStatus(provider);
  if (st === "OPEN") throw new Error(`${provider} circuit open`);
  try {
    const out = await fn();
    recordSuccess(provider);
    return out;
  } catch (e) {
    recordFailure(provider);
    throw e;
  }
}

// ---------------- Symbol maps ----------------

const FX_MAP: Record<string, { yahoo: string; assetClass: "forex"; name: string }> = {
  EURUSD: { yahoo: "EURUSD=X", assetClass: "forex", name: "Euro / US Dollar" },
  GBPUSD: { yahoo: "GBPUSD=X", assetClass: "forex", name: "Pound / US Dollar" },
  USDJPY: { yahoo: "USDJPY=X", assetClass: "forex", name: "Dollar / Yen" },
  AUDUSD: { yahoo: "AUDUSD=X", assetClass: "forex", name: "Aussie / US Dollar" },
};

/** Intervals the provider layer can actually serve (both maps below cover these). */
export const SUPPORTED_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;

const BINANCE_INTERVAL: Record<string, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
};

const YAHOO_INTERVAL: Record<string, { interval: string; range: string }> = {
  "1m": { interval: "1m", range: "7d" },
  "5m": { interval: "5m", range: "1mo" },
  "15m": { interval: "15m", range: "1mo" },
  "1h": { interval: "1h", range: "3mo" },
  "4h": { interval: "1h", range: "6mo" }, // resampled from 1h
  "1d": { interval: "1d", "range": "2y" },
};

export interface SymbolMeta {
  symbol: string;
  name: string;
  assetClass: Bar["assetClass"];
}

export function listSymbols(): SymbolMeta[] {
  const crypto = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];
  const names: Record<string, string> = {
    BTCUSDT: "Bitcoin",
    ETHUSDT: "Ethereum",
    SOLUSDT: "Solana",
    BNBUSDT: "BNB",
    XRPUSDT: "XRP",
    EURUSD: "Euro / US Dollar",
    GBPUSD: "Pound / US Dollar",
    USDJPY: "Dollar / Yen",
    AUDUSD: "Aussie / US Dollar",
  };
  return [
    ...crypto.map((s) => ({ symbol: s, name: names[s] ?? s, assetClass: "crypto" as const })),
    ...Object.keys(FX_MAP).map((s) => ({
      symbol: s,
      name: names[s] ?? FX_MAP[s].name,
      assetClass: "forex" as const,
    })),
  ];
}

function resolveYahoo(symbol: string): string | null {
  if (symbol.endsWith("USDT")) {
    const base = symbol.slice(0, -4);
    return `${base}-USD`;
  }
  return FX_MAP[symbol]?.yahoo ?? null;
}

function resolveProvider(symbol: string): "binance" | "yahoo" | null {
  if (symbol.endsWith("USDT")) return "binance";
  return FX_MAP[symbol] ? "yahoo" : null;
}

// ---------------- Fetchers ----------------

export interface FetchedData {
  bars: RawBar[];
  bestBid: number | null;
  bestAsk: number | null;
  provider: string;
  regular?: number;
}

/**
 * Public Binance market-data hosts, tried in order.
 *
 * `api.binance.com` answers HTTP 451 ("service unavailable from a restricted location")
 * for whole regions and some datacentre ranges. That used to make the primary crypto feed
 * fail on every request, silently pushing every crypto decision onto the Delta demo
 * fallback and losing top-of-book. The public data hosts below serve the same exchange
 * market data without a key and without the regional restriction.
 */
const BINANCE_HOSTS = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
  "https://api.binance.us",
] as const;

/** First host that answers, else re-throw the last error. */
async function binanceGet(path: string, params: Record<string, unknown>): Promise<unknown> {
  let lastError: Error | null = null;
  for (const base of BINANCE_HOSTS) {
    try {
      const res = await axios.get(`${base}${path}`, { params, timeout: TIMEOUT });
      return res.data;
    } catch (e) {
      lastError = e as Error;
    }
  }
  throw lastError ?? new Error("binance: no reachable data host");
}

async function fetchBinance(symbol: string, interval: string, limit: number): Promise<FetchedData> {
  return guarded("binance", async () => {
    const bi = BINANCE_INTERVAL[interval] ?? "1h";
    // Top-of-book is best-effort: a missing spread must never fail the bar fetch.
    const [klinesData, tickerData] = await Promise.all([
      binanceGet("/api/v3/klines", { symbol, interval: bi, limit }),
      binanceGet("/api/v3/ticker/bookTicker", { symbol }).catch(() => null),
    ]);
    if (!Array.isArray(klinesData) || klinesData.length === 0) {
      throw new Error(`binance returned no bars for ${symbol}`);
    }
    const raw: RawBar[] = (klinesData as unknown[][]).map((k) => ({
      time: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }));
    let bestBid: number | null = null;
    let bestAsk: number | null = null;
    const ticker = tickerData as { bidPrice?: string; askPrice?: string } | null;
    if (ticker) {
      const bid = Number(ticker.bidPrice);
      const ask = Number(ticker.askPrice);
      if (Number.isFinite(bid) && Number.isFinite(ask) && ask >= bid) {
        bestBid = bid;
        bestAsk = ask;
      }
    }
    return { bars: raw, bestBid, bestAsk, provider: "binance" };
  });
}

async function fetchYahoo(symbol: string, interval: string): Promise<FetchedData> {
  return guarded("yahoo", async () => {
    const ysym = resolveYahoo(symbol);
    if (!ysym) throw new Error(`unsupported symbol ${symbol}`);
    const yint = YAHOO_INTERVAL[interval] ?? YAHOO_INTERVAL["1h"];
    const res = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}`,
      { params: { interval: yint.interval, range: yint.range }, timeout: TIMEOUT, headers: { "User-Agent": UA } },
    );
    const r = res.data?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const q = r?.meta?.regularMarketPrice;
    const o = r?.indicators?.quote?.[0] ?? {};
    const raw: RawBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const op = o.open?.[i];
      const hi = o.high?.[i];
      const lo = o.low?.[i];
      const cl = o.close?.[i];
      const vol = o.volume?.[i] ?? 0;
      if (
        Number.isFinite(op) && Number.isFinite(hi) && Number.isFinite(lo) && Number.isFinite(cl) &&
        op > 0 && hi > 0 && lo > 0 && cl > 0
      ) {
        raw.push({ time: ts[i] * 1000, open: op, high: hi, low: lo, close: cl, volume: vol });
      }
      // note: null slots (market closed) are skipped — quality notes reflect this via gaps
    }
    if (raw.length === 0) throw new Error("yahoo returned no usable bars");
    const regular: number | undefined = q;
    return { bars: raw, bestBid: null, bestAsk: null, provider: "yahoo", regular: regular ?? undefined };
  });
}

/** Delta Exchange demo/testnet public feed (crypto only) — fallback market-data source. */
async function fetchDelta(symbol: string, interval: string, limit: number): Promise<FetchedData> {
  return guarded("delta", async () => {
    const deltaSymbol = toDeltaSymbol(symbol);
    if (!deltaSymbol) throw new Error(`unsupported symbol ${symbol}`);
    const resolution = deltaResolution(interval);
    const env: DeltaEnv = typeof process !== "undefined" && process.env ? (process.env as DeltaEnv) : {};
    const base = resolveDeltaBaseUrl(env);
    const endSec = Math.floor(Date.now() / 1000);
    const spanSec = Math.ceil((intervalMs(interval) * Math.min(Math.max(limit, 1), 1000)) / 1000);
    const startSec = endSec - spanSec;
    const query = deltaQueryString({ symbol: deltaSymbol, resolution, start: startSec, end: endSec });
    const candlesRes = await axios.get(`${base}${DELTA_PATHS.candles}${query}`, {
      timeout: TIMEOUT,
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    const envelope = candlesRes.data as { success?: boolean; result?: unknown; error?: { code?: string } };
    if (envelope.success !== true) throw new Error(`delta error ${envelope.error?.code ?? "unknown"}`);
    const bars = parseCandles(envelope.result);
    const tickersRes = await axios
      .get(`${base}${DELTA_PATHS.tickers}`, { timeout: TIMEOUT, headers: { "User-Agent": UA, Accept: "application/json" } })
      .catch(() => null);
    const book = tickersRes ? parseTicker((tickersRes.data as { result?: unknown })?.result, deltaSymbol) : null;
    return { bars, bestBid: book?.bestBid ?? null, bestAsk: book?.bestAsk ?? null, provider: "delta" };
  });
}

/**
 * Resamples time-ordered bars into fixed buckets (epoch-aligned UTC boundaries).
 * OHLCV aggregation: open = first bar's open, high/low = extremes, close = last close,
 * volume = sum. Used for the 4h/1d fallback so a longer interval is genuinely built from
 * 1h bars instead of being relabelled (which would corrupt gap/staleness math downstream).
 */
export function resampleBars(bars: RawBar[], bucketMs: number): RawBar[] {
  const out: RawBar[] = [];
  for (const b of bars) {
    const t = Math.floor(b.time / bucketMs) * bucketMs;
    const prev = out[out.length - 1];
    if (prev && prev.time === t) {
      prev.high = Math.max(prev.high, b.high);
      prev.low = Math.min(prev.low, b.low);
      prev.close = b.close;
      prev.volume += b.volume;
    } else {
      out.push({ ...b, time: t });
    }
  }
  return out;
}

/** Bucket size for a longer interval that has to be rebuilt from 1h bars. */
const INTERVAL_BUCKET_MS: Record<string, number> = {
  "4h": 4 * 3_600_000,
  "1d": 86_400_000,
};

/** Aggregates 1h bars up to the requested longer interval (4h/1d fallback path). */
export function resampleForInterval(hourly: RawBar[], interval: string): RawBar[] {
  return resampleBars(hourly, INTERVAL_BUCKET_MS[interval] ?? 86_400_000);
}

export interface MarketFetch {
  data: FetchedData;
  interval: string;
  requestedInterval: "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
  fellBack: boolean;
  fallbackFrom?: string;
  errors: string[];
}

/** Fetch OHLCV with fallback: 4h/1d use resampling, 1m/5m/15m fall back to 15m on failure. */
export async function fetchMarketData(
  symbol: string,
  interval: string,
  limit = 400,
): Promise<MarketFetch> {
  const provider = resolveProvider(symbol);
  const errors: string[] = [];
  if (!provider) throw new Error(`unsupported symbol: ${symbol}`);

  async function tryInterval(iv: string): Promise<FetchedData> {
    return provider === "binance"
      ? fetchBinance(symbol, iv, limit)
      : fetchYahoo(symbol, iv);
  }

  let data: FetchedData;
  try {
    data = await tryInterval(interval);
    return { data, interval, requestedInterval: interval as MarketFetch["requestedInterval"], fellBack: false, errors };
  } catch (e) {
    errors.push(`${provider}:${interval} failed: ${(e as Error).message}`);
  }

  // Delta demo fallback (crypto, requested interval) — first fallback provider.
  if (symbol.endsWith("USDT")) {
    try {
      const deltaData = await fetchDelta(symbol, interval, limit);
      return {
        data: deltaData,
        interval,
        requestedInterval: interval as MarketFetch["requestedInterval"],
        fellBack: true,
        fallbackFrom: "delta",
        errors,
      };
    } catch (e) {
      errors.push(`delta:${interval} failed: ${(e as Error).message}`);
    }
  }

  // fallback chain — longer intervals are aggregated from 1h bars, never relabelled
  if (interval === "4h" || interval === "1d") {
    try {
      const hourly = await tryInterval("1h");
      const bars = resampleForInterval(hourly.bars, interval);
      return { data: { ...hourly, bars }, interval, requestedInterval: interval as MarketFetch["requestedInterval"], fellBack: true, fallbackFrom: `1h (resampled to ${interval})`, errors };
    } catch (e) {
      errors.push(`1h fallback failed: ${(e as Error).message}`);
    }
  }
  try {
    const f15 = await tryInterval("15m");
    return { data: f15, interval: "15m", requestedInterval: interval as MarketFetch["requestedInterval"], fellBack: true, fallbackFrom: "15m", errors };
  } catch (e) {
    errors.push(`15m fallback failed: ${(e as Error).message}`);
  }
  throw new Error(errors.join(" | ") || "all providers failed");
}
