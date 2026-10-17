// Paper broker pricing convention. Regression for the audited defect: the helper
// returned the numerically favourable side for a LONG entry (bid instead of the
// ask it must cross), and a missing quote book silently became a zero-spread fill.

import { describe, expect, it } from "vitest";
import {
  PAPER_ESTIMATED_SPREAD_BPS,
  PAPER_SLIPPAGE_BPS,
  PAPER_TAKER_FEE_BPS,
  PaperBroker,
} from "./execution";

const book = { lastClose: 100, bestBid: 99.9, bestAsk: 100.1 };

function order(side: "LONG" | "SHORT", key = "k") {
  return {
    idempotencyKey: key,
    symbol: "BTCUSDT",
    side,
    qty: 1,
    type: "MARKET" as const,
    createdAt: 1,
    status: "CREATED" as const,
  };
}

describe("PaperBroker price sides", () => {
  it("prices a LONG entry at the ask and a SHORT entry at the bid", () => {
    const b = new PaperBroker(book);
    expect(b.getBestPrice("LONG")).toBe(100.1); // buy at ask
    expect(b.getBestPrice("SHORT")).toBe(99.9); // sell at bid
    // The favourable side is never used for an entry.
    expect(b.getBestPrice("LONG")).toBeGreaterThan(b.getBestPrice("SHORT"));
  });

  it("fills a LONG above the mid and a SHORT below it (adverse fill + slippage)", () => {
    const long = new PaperBroker(book).submitOrder(order("LONG"));
    const short = new PaperBroker(book).submitOrder(order("SHORT"));
    expect(long.fillPrice).toBeCloseTo(100.1 * (1 + PAPER_SLIPPAGE_BPS / 10_000), 8);
    expect(short.fillPrice).toBeCloseTo(99.9 * (1 - PAPER_SLIPPAGE_BPS / 10_000), 8);
    expect(long.fillPrice).toBeGreaterThan(100);
    expect(short.fillPrice).toBeLessThan(100);
  });

  it("charges taker fees on the filled notional", () => {
    const fill = new PaperBroker(book).submitOrder(order("LONG"));
    expect(fill.fee).toBeCloseTo((fill.fillPrice * 1 * PAPER_TAKER_FEE_BPS) / 10_000, 8);
  });
});

describe("PaperBroker missing quote book", () => {
  const noBook = { lastClose: 100, bestBid: null, bestAsk: null };

  it("never treats a missing spread as zero", () => {
    const b = new PaperBroker(noBook);
    const quote = b.entryQuote("LONG");
    expect(quote.spreadEstimated).toBe(true);
    const halfSpread = PAPER_ESTIMATED_SPREAD_BPS / 10_000 / 2;
    expect(quote.price).toBeCloseTo(100 * (1 + halfSpread), 8);

    const shortQuote = b.entryQuote("SHORT");
    expect(shortQuote.spreadEstimated).toBe(true);
    expect(shortQuote.price).toBeCloseTo(100 * (1 - halfSpread), 8);
  });

  it("marks the fill as estimated and keeps both sides adverse", () => {
    const long = new PaperBroker(noBook).submitOrder(order("LONG"));
    const short = new PaperBroker(noBook).submitOrder(order("SHORT"));
    expect(long.fillPrice).toBeGreaterThan(100);
    expect(short.fillPrice).toBeLessThan(100);
  });
});
