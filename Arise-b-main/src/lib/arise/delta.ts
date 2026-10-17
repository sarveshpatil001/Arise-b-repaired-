// ARISE V1 — Delta Exchange (demo/testnet) API layer.
// Pure request specs + response parsing. No network, no Convex — HTTP and HMAC
// signing live in src/convex/arise/delta.ts (Node action). Fail-closed everywhere.
//
// Reference (official docs, Authentication -> Signing a Message):
//   signature = hex(HMAC-SHA256(apiSecret, method + timestamp + requestPath + query + body))
//   timestamp is Unix seconds and is valid for 5 seconds; `query` includes the leading "?".

import type { RawBar } from "./validate";

export const DELTA_TESTNET_BASE_URL = "https://cdn-ind.testnet.deltaex.org"; // Demo account keys
export const DELTA_PRODUCTION_BASE_URL = "https://api.india.delta.exchange"; // never used by ARISE V1

export const DELTA_PATHS = {
  products: "/v2/products",
  tickers: "/v2/tickers",
  candles: "/v2/history/candles",
  orders: "/v2/orders",
  walletBalances: "/v2/wallet/balances",
  // Docs nav says "Positions -> Get margined positions"; the exact path string is
  // not printed in the docs body. Centralized here so a correction is one line.
  positions: "/v2/positions/margined",
} as const;

export interface DeltaEnv {
  DELTA_BASE_URL?: string;
  DELTA_TRADING_MODE?: string;
  DELTA_API_KEY?: string;
  DELTA_API_SECRET?: string;
}

/** Demo/testnet by default — an unset or empty base URL can never reach production. */
export function resolveDeltaBaseUrl(env: DeltaEnv): string {
  const raw = env.DELTA_BASE_URL?.trim();
  if (!raw) return DELTA_TESTNET_BASE_URL;
  // Normalize a trailing slash: every caller appends an absolute path (`/v2/...`),
  // and `https://host//v2/orders` would not match the signed request path.
  return raw.replace(/\/+$/, "");
}

/** Hard demo gate: every authenticated call must explicitly opt into demo trading. */
export function requireDemoTrading(env: DeltaEnv): void {
  if (env.DELTA_TRADING_MODE !== "demo") {
    throw new Error('DELTA_TRADING_MODE must be set to "demo" before any Delta order or account call');
  }
}

/**
 * ORDER/ACCOUNT ENDPOINT LOCK (V1 paper-only invariant).
 *
 * `resolveDeltaBaseUrl` intentionally honours a configured DELTA_BASE_URL so
 * market data can fall back to another source. That is safe for candles — data
 * carries no execution power — but it is NOT safe for authenticated calls: a
 * single env value (`DELTA_BASE_URL=https://api.india.delta.exchange`) plus a
 * `demo` mode string would have turned the paper mirror into a real-money order
 * path. Every authenticated call therefore resolves its base URL through this
 * function, which fails closed unless the host is a demo/testnet endpoint.
 */
/** Exact, verified demo hostnames. Never matched by substring. */
const DELTA_DEMO_HOSTS: ReadonlySet<string> = new Set([
  new URL(DELTA_TESTNET_BASE_URL).hostname.toLowerCase(),
]);

export function resolveDeltaOrderBaseUrl(env: DeltaEnv): string {
  const url = resolveDeltaBaseUrl(env);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("delta: DELTA_BASE_URL is not a valid URL");
  }

  // HTTPS and an ordinary port only: a demo host over plain HTTP would leak the
  // API key and signature, and a non-standard port is not part of the verified
  // demo surface.
  if (parsed.protocol !== "https:") {
    throw new Error(
      `delta: refusing a non-HTTPS authenticated URL (${parsed.protocol}) — ARISE V1 is paper-only`,
    );
  }
  if (parsed.port !== "" && parsed.port !== "443") {
    throw new Error(`delta: refusing an unexpected port "${parsed.port}" on an authenticated URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("delta: refusing credentials embedded in DELTA_BASE_URL");
  }
  // The signature is computed over the exact path (`/v2/orders`), so a base URL
  // carrying a path prefix, query or fragment would be signed differently from the
  // URL actually requested (and could smuggle parameters). Only an origin is valid.
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error(
      "delta: refusing an authenticated base URL with a path, query or fragment — only an origin is allowed",
    );
  }

  // Exact hostname allowlist. "contains testnet" is not evidence of a demo host.
  const hostname = parsed.hostname.toLowerCase();
  const productionHost = new URL(DELTA_PRODUCTION_BASE_URL).hostname.toLowerCase();
  // The hostname can appear at most once in a URL (WHATWG parsing rejects
  // duplicates), so an exact match of the parsed host cannot be spoofed, and the
  // canonical origin is returned rather than the raw string.
  if (hostname === productionHost || !DELTA_DEMO_HOSTS.has(hostname)) {
    throw new Error(
      `delta: refusing an authenticated call to non-demo host "${hostname}" — ARISE V1 is paper-only`,
    );
  }
  return parsed.origin;
}

/** Credentials by name only — the error text never contains a secret value. */
export function deltaCredentials(env: DeltaEnv): { apiKey: string; apiSecret: string } {
  const apiKey = env.DELTA_API_KEY;
  const apiSecret = env.DELTA_API_SECRET;
  if (!apiKey) throw new Error("DELTA_API_KEY is not configured");
  if (!apiSecret) throw new Error("DELTA_API_SECRET is not configured");
  return { apiKey, apiSecret };
}

/** Exact prehash string defined by Delta: method + timestamp + requestPath + query + body. */
export function deltaSignaturePayload(opts: {
  method: string;
  timestamp: string;
  path: string;
  queryString: string;
  body: string;
}): string {
  return opts.method + opts.timestamp + opts.path + opts.queryString + opts.body;
}

/** "" or "?a=1&b=2" — used verbatim in BOTH the request URL and the signature. */
export function deltaQueryString(params: Record<string, string | number>): string {
  const parts = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

/** Headers Delta requires; User-Agent is mandatory or the CDN rejects the request. */
export function deltaAuthHeaders(opts: { apiKey: string; timestamp: string; signature: string }): Record<string, string> {
  return {
    "api-key": opts.apiKey,
    signature: opts.signature,
    timestamp: opts.timestamp,
    "User-Agent": "arise-v1",
    "Content-Type": "application/json",
  };
}

// ---------------- Symbology / resolutions ----------------

const DELTA_SYMBOLS: Record<string, string> = {
  BTCUSDT: "BTCUSD",
  ETHUSDT: "ETHUSD",
  SOLUSDT: "SOLUSD",
  BNBUSDT: "BNBUSD",
  XRPUSDT: "XRPUSD",
};

/** ARISE symbol -> Delta contract symbol. Forex has no Delta product (fail closed). */
export function toDeltaSymbol(symbol: string): string | null {
  return DELTA_SYMBOLS[symbol] ?? null;
}

/** ARISE interval -> Delta `resolution`. Unknown intervals are refused. */
export function deltaResolution(interval: string): string {
  const supported = ["1m", "5m", "15m", "1h", "4h", "1d"];
  if (!supported.includes(interval)) {
    throw new Error(`delta: unsupported interval ${interval}`);
  }
  return interval;
}

// ---------------- Parsing helpers ----------------

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pick(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

/** Delta OHLC rows -> RawBar[]. Invalid rows are dropped; zero usable rows throw. */
export function parseCandles(result: unknown): RawBar[] {
  if (!Array.isArray(result)) throw new Error("delta: candles payload is not an array");
  const bars: RawBar[] = [];
  for (const row of result) {
    const r = asRecord(row);
    if (!r) continue;
    const timeRaw = toNumber(pick(r, ["time", "timestamp"]));
    const open = toNumber(r.open);
    const high = toNumber(r.high);
    const low = toNumber(r.low);
    const close = toNumber(r.close);
    const volume = toNumber(pick(r, ["volume"])) ?? 0;
    if (timeRaw === null || open === null || high === null || low === null || close === null) continue;
    // Delta timestamps may be seconds or microseconds/milliseconds — normalize to ms.
    const time = timeRaw < 1e12 ? timeRaw * 1000 : timeRaw;
    if (time <= 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) continue;
    bars.push({ time, open, high, low, close, volume });
  }
  if (bars.length === 0) throw new Error("delta: no usable candles");
  return bars.sort((a, b) => a.time - b.time);
}

export interface DeltaBook {
  bestBid: number | null;
  bestAsk: number | null;
}

/** Ticker row for a Delta product -> top of book. Crossed/invalid books yield null. */
export function parseTicker(result: unknown, deltaSymbol: string): DeltaBook | null {
  const rows = Array.isArray(result) ? result : [result];
  for (const row of rows) {
    const r = asRecord(row);
    if (!r) continue;
    const symbol = pick(r, ["symbol", "product_symbol"]);
    if (symbol !== deltaSymbol) continue;
    const bid = toNumber(pick(r, ["bid", "best_bid", "buy_price"]));
    const ask = toNumber(pick(r, ["ask", "best_ask", "sell_price"]));
    if (bid === null || ask === null || bid <= 0 || ask <= 0 || ask < bid) return null;
    return { bestBid: bid, bestAsk: ask };
  }
  return null;
}

// ---------------- Order construction ----------------

export function buildOrderBody(opts: {
  productId: number;
  sizeContracts: number;
  side: "buy" | "sell";
  orderType?: "market_order" | "limit_order";
  limitPrice?: string;
  clientOrderId?: string;
}): string {
  if (!Number.isInteger(opts.productId) || opts.productId <= 0) {
    throw new Error("delta: invalid product id");
  }
  if (!Number.isInteger(opts.sizeContracts) || opts.sizeContracts <= 0) {
    throw new Error("delta: invalid contract size");
  }
  const body: Record<string, string | number> = {
    order_type: opts.orderType ?? "market_order",
    size: opts.sizeContracts,
    side: opts.side,
    product_id: opts.productId,
  };
  if (opts.limitPrice !== undefined) body.limit_price = String(opts.limitPrice);
  if (opts.clientOrderId) body.client_order_id = opts.clientOrderId;
  return JSON.stringify(body);
}

export function findDeltaProduct(products: unknown, deltaSymbol: string): Record<string, unknown> | null {
  if (!Array.isArray(products)) return null;
  for (const row of products) {
    const r = asRecord(row);
    if (r && r.symbol === deltaSymbol) return r;
  }
  return null;
}

/** Coin quantity -> integer contracts using the product's contract_value. Fail closed. */
export function contractsFromQty(qty: number, product: Record<string, unknown>): number {
  const specs = asRecord(product.specifications);
  const contractValue =
    toNumber(pick(product, ["contract_value", "contract_size"])) ??
    (specs ? toNumber(pick(specs, ["contract_value", "contract_size"])) : null);
  if (contractValue === null || contractValue <= 0) {
    throw new Error("DELTA_CONTRACT_SIZE_UNKNOWN: product has no contract_value");
  }
  const contracts = Math.round(qty / contractValue);
  if (!Number.isFinite(contracts) || contracts < 1) {
    throw new Error("DELTA_ORDER_SIZE_TOO_SMALL: quantity rounds to zero contracts");
  }
  return contracts;
}

// ---------------- Account snapshot ----------------

export interface DeltaBalance {
  asset: string;
  balance: number;
  availableBalance: number | null;
}

export interface DeltaPositionRow {
  symbol: string;
  size: number;
  entryPrice: number | null;
  markPrice: number | null;
  unrealizedPnl: number | null;
}

export interface DeltaAccountSnapshot {
  balances: DeltaBalance[];
  positions: DeltaPositionRow[];
}

/** Wallet balances + margined positions -> dashboard shape. Unparseable rows are skipped. */
export function parseAccountSnapshot(balancesResult: unknown, positionsResult: unknown): DeltaAccountSnapshot {
  const balances: DeltaBalance[] = [];
  for (const row of Array.isArray(balancesResult) ? balancesResult : []) {
    const r = asRecord(row);
    if (!r) continue;
    const asset = pick(r, ["asset_symbol", "asset", "symbol"]);
    const balance = toNumber(pick(r, ["balance", "wallet_balance", "total_balance"]));
    if (typeof asset !== "string" || balance === null) continue;
    balances.push({
      asset,
      balance,
      availableBalance: toNumber(pick(r, ["available_balance", "available", "available_balance_for_margin"])),
    });
  }
  const positions: DeltaPositionRow[] = [];
  for (const row of Array.isArray(positionsResult) ? positionsResult : []) {
    const r = asRecord(row);
    if (!r) continue;
    const symbol = pick(r, ["product_symbol", "symbol"]);
    const size = toNumber(pick(r, ["size", "position_size", "qty"]));
    if (typeof symbol !== "string" || size === null) continue;
    positions.push({
      symbol,
      size,
      entryPrice: toNumber(pick(r, ["entry_price", "average_price", "buy_price"])),
      markPrice: toNumber(pick(r, ["mark_price", "markPrice"])),
      unrealizedPnl: toNumber(pick(r, ["unrealized_pnl", "pnl", "unrealized_pnl_ccy"])),
    });
  }
  return { balances, positions };
}

export function parseOrderResult(result: unknown): { orderId: string; status: string } {
  const r = asRecord(result);
  if (!r) throw new Error("delta: order response is not an object");
  const id = pick(r, ["id", "order_id", "uuid"]);
  const status = pick(r, ["state", "status"]);
  return {
    orderId: id === undefined ? "" : String(id),
    status: typeof status === "string" ? status : "",
  };
}
