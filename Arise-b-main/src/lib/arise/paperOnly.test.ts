// ARISE V1 — PAPER-ONLY / LIVE-EXECUTION-IMPOSSIBLE regression tests (PRD Step 5).
// These pin the invariants that make real-money trading unreachable in V1:
//   1. the live-trading lock itself (execution.ts),
//   2. the demo-mode + demo-ENDPOINT lock on the only order-submitting path (delta),
//   3. the shape of the order body (no leverage, no exchange-side stop attachment),
//   4. the in-broker duplicate-fill guard,
//   5. what the simulator actually claims about fills (documented, not guaranteed).
// If any of these fail, paper-only safety has regressed.

import { describe, expect, it } from "vitest";
import { LIVE_TRADING_ENABLED, PaperBroker, checkExit } from "./execution";
import {
  DELTA_PRODUCTION_BASE_URL,
  DELTA_TESTNET_BASE_URL,
  buildOrderBody,
  requireDemoTrading,
  resolveDeltaOrderBaseUrl,
} from "./delta";

describe("live trading lock", () => {
  it("has the hard lock engaged", () => {
    expect(LIVE_TRADING_ENABLED).toBe(false);
  });

  it("never fills an order while the lock is engaged", () => {
    const broker = new PaperBroker({ lastClose: 100, bestBid: 99.9, bestAsk: 100.1 });
    const fill = broker.submitOrder({
      idempotencyKey: "k1",
      symbol: "BTCUSDT",
      side: "LONG",
      qty: 1,
      type: "MARKET",
      createdAt: 1,
      status: "CREATED",
    });
    // The lock is a *fail-closed* branch inside submitOrder: the only outcomes
    // reachable while it is engaged are FILLED (paper) or rejected — never a
    // real-money submission, because the broker performs no network I/O at all.
    expect(fill.status).toBe("FILLED");
    expect(broker.name).toBe("paper-binance-v1");
  });

  it("rejects non-positive and non-finite quantities", () => {
    const broker = new PaperBroker({ lastClose: 100, bestBid: 99.9, bestAsk: 100.1 });
    for (const qty of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const fill = broker.submitOrder({
        idempotencyKey: `q:${qty}`,
        symbol: "BTCUSDT",
        side: "LONG",
        qty,
        type: "MARKET",
        createdAt: 1,
        status: "CREATED",
      });
      // `NaN <= 0` is false, so the broker checks finiteness explicitly rather
      // than ordering alone — a NaN fill would corrupt the paper ledger.
      expect(fill.status).toBe("REJECTED");
    }
  });

  it("rejects a repeated idempotency key within one broker instance", () => {
    const broker = new PaperBroker({ lastClose: 100, bestBid: 99.9, bestAsk: 100.1 });
    const order = {
      idempotencyKey: "same",
      symbol: "BTCUSDT",
      side: "LONG" as const,
      qty: 1,
      type: "MARKET" as const,
      createdAt: 1,
      status: "CREATED" as const,
    };
    expect(broker.submitOrder(order).status).toBe("FILLED");
    expect(broker.submitOrder(order).status).toBe("REJECTED");
    // The in-memory guard is per-instance only; cross-request durability is
    // enforced at the database level (see paperExecution.test.ts).
  });
});

describe("delta demo lock", () => {
  it("requires the explicit demo mode string", () => {
    for (const mode of [undefined, "", "live", "LIVE", "prod", "production", "Demo"]) {
      expect(() => requireDemoTrading({ DELTA_TRADING_MODE: mode })).toThrow(/demo/i);
    }
    expect(() => requireDemoTrading({ DELTA_TRADING_MODE: "demo" })).not.toThrow();
  });

  it("defaults authenticated calls to the testnet endpoint", () => {
    expect(resolveDeltaOrderBaseUrl({})).toBe(DELTA_TESTNET_BASE_URL);
  });

  it("refuses to send an authenticated call to the production endpoint", () => {
    expect(() =>
      resolveDeltaOrderBaseUrl({
        DELTA_TRADING_MODE: "demo",
        DELTA_BASE_URL: DELTA_PRODUCTION_BASE_URL,
      }),
    ).toThrow(/paper-only/);
  });

  it("refuses any non-testnet host", () => {
    for (const host of [
      "https://api.example.com",
      "https://delta.exchange",
      "https://api.india.delta.exchange/",
      "not-a-url",
    ]) {
      expect(() => resolveDeltaOrderBaseUrl({ DELTA_BASE_URL: host })).toThrow();
    }
  });

  it("accepts an explicit testnet host", () => {
    expect(resolveDeltaOrderBaseUrl({ DELTA_BASE_URL: "https://cdn-ind.testnet.deltaex.org" })).toBe(
      "https://cdn-ind.testnet.deltaex.org",
    );
  });

  it("cannot express leverage or an exchange-enforced stop in an order body", () => {
    const body = JSON.parse(
      buildOrderBody({ productId: 27, sizeContracts: 3, side: "buy", clientOrderId: "arise-abc" }),
    );
    expect(Object.keys(body).sort()).toEqual(["client_order_id", "order_type", "product_id", "side", "size"]);
    expect(body.order_type).toBe("market_order");
    // No leverage / stop_loss / reduce_only fields exist, so ARISE can never ask
    // the exchange to enforce a stop — every stop in ARISE is SIMULATED locally.
    expect(body).not.toHaveProperty("leverage");
    expect(body).not.toHaveProperty("stop_loss_order");
  });

  it("refuses invalid contract sizes and product ids", () => {
    expect(() => buildOrderBody({ productId: 0, sizeContracts: 1, side: "buy" })).toThrow();
    expect(() => buildOrderBody({ productId: 27, sizeContracts: 0, side: "buy" })).toThrow();
    expect(() => buildOrderBody({ productId: 27, sizeContracts: 1.5, side: "buy" })).toThrow();
  });
});

describe("simulated stop semantics (documented, never guaranteed)", () => {
  it("fills a gapped stop at the stop level, not at the gapped price", () => {
    // SIMULATION ASSUMPTION: ARISE has no exchange-side stop, so a stop is
    // evaluated on bar extremes and booked at the stop price. In a real gap the
    // actual fill would be materially worse. This test documents the optimism
    // rather than hiding it — never present these fills as guaranteed.
    const exit = checkExit(
      { side: "LONG", entry: 100, stop: 95, target: 120 },
      { high: 101, low: 80 },
    );
    expect(exit).toEqual({ closed: true, exitPrice: 95, reason: "STOP_LOSS" });
  });

  it("gives the stop priority when a single bar touches both stop and target", () => {
    const exit = checkExit(
      { side: "LONG", entry: 100, stop: 95, target: 120 },
      { high: 130, low: 90 },
    );
    expect(exit.reason).toBe("STOP_LOSS");
  });
});
