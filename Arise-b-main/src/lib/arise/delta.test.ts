// Tests for src/lib/arise/delta.ts — pure Delta Exchange (demo) request/parsing layer.
// Pure functions; no Convex, no network (HMAC check uses node:crypto locally).

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildOrderBody,
  contractsFromQty,
  deltaAuthHeaders,
  deltaCredentials,
  deltaQueryString,
  deltaResolution,
  deltaSignaturePayload,
  DELTA_PATHS,
  DELTA_TESTNET_BASE_URL,
  findDeltaProduct,
  parseAccountSnapshot,
  parseCandles,
  parseOrderResult,
  parseTicker,
  requireDemoTrading,
  resolveDeltaBaseUrl,
  resolveDeltaOrderBaseUrl,
  toDeltaSymbol,
} from "./delta";

describe("signature (official docs sample)", () => {
  it("reproduces the documented prehash string exactly", () => {
    const payload = deltaSignaturePayload({
      method: "GET",
      timestamp: "1542110948",
      path: "/v2/orders",
      queryString: "?product_id=1&state=open",
      body: "",
    });
    expect(payload).toBe("GET1542110948/v2/orders?product_id=1&state=open");
  });

  it("produces the HMAC-SHA256 hex digest cross-checked with openssl (docs recipe)", () => {
    // Known-answer vector: verified two independent ways (node:crypto here, and
    // `printf '%s' <prehash> | openssl dgst -sha256 -hmac <secret>` per the docs).
    // NOTE: the digest printed in the Delta docs sample (ad767f...) does NOT
    // reproduce from their own prehash + secret — it is a stale sample value.
    // The prehash string itself (asserted above) matches their docs exactly.
    const payload = deltaSignaturePayload({
      method: "GET",
      timestamp: "1542110948",
      path: "/v2/orders",
      queryString: "?product_id=1&state=open",
      body: "",
    });
    const signature = crypto
      .createHmac("sha256", "7b6f39dcf660ec1c7c664f612c60410a2bd0c258416b498bf0311f94228f")
      .update(payload)
      .digest("hex");
    expect(signature).toBe("4e38dda3e6477092f360ba70399266d8145630b22bcc34c0ec7f804d5746877a");
  });

  it("builds the query string with the leading '?' used by both URL and signature", () => {
    expect(deltaQueryString({})).toBe("");
    expect(deltaQueryString({ product_id: 1, state: "open" })).toBe("?product_id=1&state=open");
    expect(deltaQueryString({ symbol: "BTCUSD", resolution: "15m", start: 1, end: 2 })).toBe(
      "?symbol=BTCUSD&resolution=15m&start=1&end=2",
    );
  });

  it("sends the headers Delta requires, including User-Agent", () => {
    const headers = deltaAuthHeaders({ apiKey: "k", timestamp: "1542110948", signature: "s" });
    expect(headers["api-key"]).toBe("k");
    expect(headers.signature).toBe("s");
    expect(headers.timestamp).toBe("1542110948");
    expect(headers["User-Agent"]).toBe("arise-v1");
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

describe("demo safety", () => {
  it("defaults to the testnet base URL and honors an override", () => {
    expect(resolveDeltaBaseUrl({})).toBe(DELTA_TESTNET_BASE_URL);
    expect(resolveDeltaBaseUrl({ DELTA_BASE_URL: "  " })).toBe(DELTA_TESTNET_BASE_URL);
    expect(resolveDeltaBaseUrl({ DELTA_BASE_URL: "https://cdn-ind.testnet.deltaex.org" })).toBe(
      "https://cdn-ind.testnet.deltaex.org",
    );
    // A trailing slash is normalized: callers append "/v2/..." and the signed
    // path must match the requested path exactly.
    expect(resolveDeltaBaseUrl({ DELTA_BASE_URL: "https://cdn-ind.testnet.deltaex.org/" })).toBe(
      "https://cdn-ind.testnet.deltaex.org",
    );
  });

  it("refuses any authenticated call unless DELTA_TRADING_MODE is exactly demo", () => {
    expect(() => requireDemoTrading({})).toThrow(/DELTA_TRADING_MODE/);
    expect(() => requireDemoTrading({ DELTA_TRADING_MODE: "live" })).toThrow(/DELTA_TRADING_MODE/);
    expect(() => requireDemoTrading({ DELTA_TRADING_MODE: "demo" })).not.toThrow();
  });

  // Regression: the order-URL guard used to accept any host whose name merely
  // contained "testnet" and did not require HTTPS. Both checks are now exact.
  it("accepts only the verified demo hostname", () => {
    expect(resolveDeltaOrderBaseUrl({})).toBe(DELTA_TESTNET_BASE_URL);
    expect(
      resolveDeltaOrderBaseUrl({ DELTA_BASE_URL: "https://cdn-ind.testnet.deltaex.org" }),
    ).toBe("https://cdn-ind.testnet.deltaex.org");
    // Hostname matching is case-insensitive and the returned value is canonical:
    // a trailing slash must not produce "//v2/orders" in the signed URL.
    expect(
      resolveDeltaOrderBaseUrl({ DELTA_BASE_URL: "https://CDN-IND.TESTNET.DELTAEX.ORG/" }),
    ).toBe("https://cdn-ind.testnet.deltaex.org");
  });

  it("refuses the production host", () => {
    expect(() =>
      resolveDeltaOrderBaseUrl({ DELTA_BASE_URL: "https://api.india.delta.exchange" }),
    ).toThrow(/non-demo host/);
  });

  it("refuses hosts that merely contain the word testnet", () => {
    for (const host of [
      "https://testnet.deltaex.org",
      "https://evil-testnet.deltaex.org",
      "https://testnet.attacker.example",
      "https://cdn-ind.testnet.deltaex.org.attacker.example",
      // Trailing-dot FQDN must not resolve to the demo host.
      "https://cdn-ind.testnet.deltaex.org.",
    ]) {
      expect(() => resolveDeltaOrderBaseUrl({ DELTA_BASE_URL: host })).toThrow(/non-demo host/);
    }

    // A userinfo trick parses as a different host *and* embeds credentials; either
    // refusal is correct, and neither is allowed through.
    expect(() =>
      resolveDeltaOrderBaseUrl({ DELTA_BASE_URL: "https://cdn-ind.testnet.deltaex.org@evil.example" }),
    ).toThrow(/non-demo host|credentials embedded/);
  });

  it("requires HTTPS", () => {
    expect(() =>
      resolveDeltaOrderBaseUrl({ DELTA_BASE_URL: "http://cdn-ind.testnet.deltaex.org" }),
    ).toThrow(/non-HTTPS/);
  });

  it("refuses an authenticated base URL with a path, query or fragment", () => {
    for (const host of [
      "https://cdn-ind.testnet.deltaex.org/proxy",
      "https://cdn-ind.testnet.deltaex.org?target=elsewhere",
      "https://cdn-ind.testnet.deltaex.org#fragment",
    ]) {
      expect(() => resolveDeltaOrderBaseUrl({ DELTA_BASE_URL: host })).toThrow(
        /path, query or fragment/,
      );
    }
  });

  it("refuses malformed URLs, odd ports and embedded credentials", () => {
    expect(() => resolveDeltaOrderBaseUrl({ DELTA_BASE_URL: "not a url" })).toThrow(
      /not a valid URL/,
    );
    expect(() =>
      resolveDeltaOrderBaseUrl({ DELTA_BASE_URL: "https://cdn-ind.testnet.deltaex.org:8443" }),
    ).toThrow(/unexpected port/);
    expect(() =>
      resolveDeltaOrderBaseUrl({
        DELTA_BASE_URL: "https://user:pass@cdn-ind.testnet.deltaex.org",
      }),
    ).toThrow(/credentials embedded/);
  });

  it("never exposes credentials in a refusal", () => {
    try {
      resolveDeltaOrderBaseUrl({
        DELTA_BASE_URL: "https://api.india.delta.exchange",
        DELTA_API_KEY: "super-secret-key",
        DELTA_API_SECRET: "super-secret-value",
      });
      throw new Error("expected the guard to refuse");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).not.toContain("super-secret-key");
      expect(message).not.toContain("super-secret-value");
    }
  });

  it("names missing credential env vars without ever echoing values", () => {
    expect(() => deltaCredentials({})).toThrow("DELTA_API_KEY is not configured");
    expect(() => deltaCredentials({ DELTA_API_KEY: "public-key-id" })).toThrow("DELTA_API_SECRET is not configured");
    const creds = deltaCredentials({ DELTA_API_KEY: "k", DELTA_API_SECRET: "s" });
    expect(creds).toEqual({ apiKey: "k", apiSecret: "s" });
    expect(() => deltaCredentials({ DELTA_API_KEY: "" })).toThrow("DELTA_API_KEY is not configured");
  });
});

describe("symbology", () => {
  it("maps ARISE symbols to Delta contract symbols and refuses forex", () => {
    expect(toDeltaSymbol("BTCUSDT")).toBe("BTCUSD");
    expect(toDeltaSymbol("ETHUSDT")).toBe("ETHUSD");
    expect(toDeltaSymbol("XRPUSDT")).toBe("XRPUSD");
    expect(toDeltaSymbol("EURUSD")).toBeNull();
  });

  it("passes supported intervals and refuses unknown ones", () => {
    for (const interval of ["1m", "5m", "15m", "1h", "4h", "1d"]) {
      expect(deltaResolution(interval)).toBe(interval);
    }
    expect(() => deltaResolution("3h")).toThrow(/unsupported interval/);
  });
});

describe("parseCandles", () => {
  it("normalizes seconds to ms and string prices to numbers", () => {
    const bars = parseCandles([
      { time: 1_800_000_000, open: "100", high: "110", low: "90", close: "105", volume: "12.5" },
    ]);
    expect(bars).toEqual([{ time: 1_800_000_000_000, open: 100, high: 110, low: 90, close: 105, volume: 12.5 }]);
  });

  it("drops invalid rows and throws when nothing usable remains (fail closed)", () => {
    const bars = parseCandles([
      { time: 1_800_000_000, open: "0", high: "110", low: "90", close: "105", volume: "1" },
      { time: 1_800_000_060, open: "100", high: "110", low: "90", close: "105", volume: "1" },
    ]);
    expect(bars).toHaveLength(1);
    expect(() => parseCandles([])).toThrow(/no usable candles/);
    expect(() => parseCandles({})).toThrow(/not an array/);
  });
});

describe("parseTicker", () => {
  it("returns the top of book and rejects crossed books", () => {
    const rows = [
      { symbol: "ETHUSD", bid: "3000", ask: "3001" },
      { symbol: "BTCUSD", bid: "60000.5", ask: "60001.5" },
    ];
    expect(parseTicker(rows, "BTCUSD")).toEqual({ bestBid: 60000.5, bestAsk: 60001.5 });
    expect(parseTicker([{ symbol: "BTCUSD", bid: "60001", ask: "60000" }], "BTCUSD")).toBeNull();
    expect(parseTicker(rows, "SOLUSD")).toBeNull();
  });
});

describe("orders", () => {
  it("serializes the documented order body with big decimals as strings", () => {
    const body = buildOrderBody({
      productId: 16,
      sizeContracts: 3,
      side: "buy",
      orderType: "limit_order",
      limitPrice: "0.0005",
      clientOrderId: "arise-decision-1",
    });
    expect(JSON.parse(body)).toEqual({
      order_type: "limit_order",
      size: 3,
      side: "buy",
      product_id: 16,
      limit_price: "0.0005",
      client_order_id: "arise-decision-1",
    });
    expect(typeof JSON.parse(body).limit_price).toBe("string");
  });

  it("refuses invalid product ids and sizes", () => {
    expect(() => buildOrderBody({ productId: 0, sizeContracts: 1, side: "buy" })).toThrow(/invalid product id/);
    expect(() => buildOrderBody({ productId: 1, sizeContracts: 0, side: "buy" })).toThrow(/invalid contract size/);
  });

  it("converts coin quantity to contracts and fails closed on unknown contract size", () => {
    expect(contractsFromQty(0.5, { symbol: "BTCUSD", contract_value: "0.001" })).toBe(500);
    expect(contractsFromQty(0.5, { symbol: "BTCUSD", specifications: { contract_value: "0.05" } })).toBe(10);
    expect(() => contractsFromQty(1, { symbol: "BTCUSD" })).toThrow(/DELTA_CONTRACT_SIZE_UNKNOWN/);
    expect(() => contractsFromQty(0.0001, { symbol: "BTCUSD", contract_value: "1" })).toThrow(
      /DELTA_ORDER_SIZE_TOO_SMALL/,
    );
  });

  it("finds products by Delta symbol and parses order responses", () => {
    const products = [{ id: 27, symbol: "ETHUSD" }, { id: 28, symbol: "BTCUSD" }];
    expect(findDeltaProduct(products, "BTCUSD")).toEqual({ id: 28, symbol: "BTCUSD" });
    expect(findDeltaProduct(products, "SOLUSD")).toBeNull();
    expect(parseOrderResult({ id: 12345, state: "open" })).toEqual({ orderId: "12345", status: "open" });
    expect(() => parseOrderResult(null)).toThrow(/not an object/);
  });
});

describe("parseAccountSnapshot", () => {
  it("maps wallet balances and margined positions, skipping unparseable rows", () => {
    const snapshot = parseAccountSnapshot(
      [
        { asset_symbol: "USD", balance: "10000.50", available_balance: "9000.25" },
        { asset_symbol: "BTC" },
        "garbage",
      ],
      [
        { product_symbol: "BTCUSD", size: "2", entry_price: "60000", mark_price: "61000", unrealized_pnl: "2.5" },
        { symbol: "ETHUSD", position_size: "1" },
        null,
      ],
    );
    expect(snapshot.balances).toEqual([{ asset: "USD", balance: 10000.5, availableBalance: 9000.25 }]);
    expect(snapshot.positions).toEqual([
      { symbol: "BTCUSD", size: 2, entryPrice: 60000, markPrice: 61000, unrealizedPnl: 2.5 },
      { symbol: "ETHUSD", size: 1, entryPrice: null, markPrice: null, unrealizedPnl: null },
    ]);
  });
});

describe("paths", () => {
  it("keeps every endpoint centralized on the documented /v2 routes", () => {
    expect(DELTA_PATHS.candles).toBe("/v2/history/candles");
    expect(DELTA_PATHS.orders).toBe("/v2/orders");
    expect(DELTA_PATHS.products).toBe("/v2/products");
    expect(DELTA_PATHS.walletBalances).toBe("/v2/wallet/balances");
    expect(DELTA_PATHS.positions).toBe("/v2/positions/margined");
  });
});
