"use node";

// ARISE V1 — Delta Exchange DEMO mirror (testnet only).
// HMAC-SHA256 signing per official docs: method + timestamp + requestPath + query + body.
// Every authenticated call is hard-gated on DELTA_TRADING_MODE === "demo"; the V1
// live-trading lock (execution.ts) is untouched. Failures never block paper trading.

import crypto from "node:crypto";
import { v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  buildOrderBody,
  contractsFromQty,
  deltaAuthHeaders,
  deltaCredentials,
  deltaQueryString,
  deltaSignaturePayload,
  DELTA_PATHS,
  findDeltaProduct,
  parseAccountSnapshot,
  parseOrderResult,
  requireDemoTrading,
  resolveDeltaBaseUrl,
  resolveDeltaOrderBaseUrl,
  toDeltaSymbol,
  type DeltaAccountSnapshot,
  type DeltaEnv,
} from "../../lib/arise/delta";

interface DeltaSpec {
  method: "GET" | "POST";
  path: string;
  params: Record<string, string | number>;
  body: string;
}

interface MirrorResult {
  ok: boolean;
  skipped: boolean;
  detail: string | null;
  orderId: string;
  status: string;
}

async function deltaFetch(spec: DeltaSpec, opts: { auth: boolean }): Promise<unknown> {
  const env = process.env as DeltaEnv;
  // Authenticated calls are hard-locked to demo endpoints (resolveDeltaOrderBaseUrl);
  // only the public product lookup may use a configured market-data base URL.
  const base = opts.auth ? resolveDeltaOrderBaseUrl(env) : resolveDeltaBaseUrl(env);
  const queryString = deltaQueryString(spec.params);
  const url = `${base}${spec.path}${queryString}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "User-Agent": "arise-v1", // Delta's CDN rejects requests without a User-Agent
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (opts.auth) {
    const { apiKey, apiSecret } = deltaCredentials(env);
    const payload = deltaSignaturePayload({
      method: spec.method,
      timestamp,
      path: spec.path,
      queryString,
      body: spec.body,
    });
    const signature = crypto.createHmac("sha256", apiSecret).update(payload).digest("hex");
    Object.assign(headers, deltaAuthHeaders({ apiKey, timestamp, signature }));
  }
  const res = await fetch(url, {
    method: spec.method,
    headers,
    body: spec.method === "POST" ? spec.body : undefined,
    // Authenticated calls must not follow redirects: fetch would replay the
    // api-key/signature headers to whatever origin the redirect names, defeating
    // the exact host allowlist above. Any redirect therefore fails the call
    // instead of forwarding credentials to an unapproved destination.
    redirect: opts.auth ? "error" : "follow",
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`delta: non-JSON response from ${spec.path} (HTTP ${res.status})`);
  }
  const envelope = parsed as { success?: boolean; result?: unknown; error?: { code?: string } };
  if (!res.ok || envelope.success !== true) {
    const code = envelope.error?.code ?? `http_${res.status}`;
    throw new Error(`delta: ${spec.method} ${spec.path} failed: ${code}`);
  }
  return envelope.result;
}

/** Delta demo balances + positions for the ARISE dashboard (read-only, signed-in users). */
export const accountSnapshot = action({
  args: {},
  handler: async (ctx): Promise<DeltaAccountSnapshot> => {
    // The demo account is a single deployment-wide account, not a user resource, so
    // it is administrator-only. No Delta request (host validation or credentials)
    // happens before authorization succeeds.
    await ctx.runQuery(internal.arise.admin.activeAdminViewer, {});
    requireDemoTrading(process.env as DeltaEnv);
    const [balances, positions] = await Promise.all([
      deltaFetch({ method: "GET", path: DELTA_PATHS.walletBalances, params: {}, body: "" }, { auth: true }),
      deltaFetch({ method: "GET", path: DELTA_PATHS.positions, params: {}, body: "" }, { auth: true }),
    ]);
    return parseAccountSnapshot(balances, positions);
  },
});

/**
 * Mirror an ARISE paper fill as a demo market order on Delta.
 * Internal only — never exposed to clients. Best-effort: callers treat non-ok
 * results as observability only.
 *
 * Safety: this is the ONLY order-submitting path in ARISE. It is demo-only twice
 * over — `requireDemoTrading` (mode string) and `resolveDeltaOrderBaseUrl`
 * (endpoint host allowlist). There is no code path from here to real money in V1.
 */
export const mirrorOrder = internalAction({
  args: {
    symbol: v.string(),
    side: v.union(v.literal("buy"), v.literal("sell")),
    qty: v.number(),
    refId: v.string(),
  },
  handler: async (_ctx, { symbol, side, qty, refId }): Promise<MirrorResult> => {
    requireDemoTrading(process.env as DeltaEnv);
    const deltaSymbol = toDeltaSymbol(symbol);
    if (!deltaSymbol) {
      return { ok: false, skipped: true, detail: `no Delta product for ${symbol}`, orderId: "", status: "" };
    }
    const products = await deltaFetch(
      { method: "GET", path: DELTA_PATHS.products, params: { page_size: 500 }, body: "" },
      { auth: false },
    );
    const product = findDeltaProduct(products, deltaSymbol);
    if (!product) {
      return { ok: false, skipped: true, detail: `product ${deltaSymbol} not listed on Delta`, orderId: "", status: "" };
    }
    const productId = Number(product.product_id ?? product.id);
    const sizeContracts = contractsFromQty(qty, product);
    const body = buildOrderBody({
      productId,
      sizeContracts,
      side,
      orderType: "market_order",
      clientOrderId: `arise-${refId}`.slice(0, 32),
    });
    const result = await deltaFetch({ method: "POST", path: DELTA_PATHS.orders, params: {}, body }, { auth: true });
    const order = parseOrderResult(result);
    return { ok: true, skipped: false, detail: null, orderId: order.orderId, status: order.status };
  },
});
