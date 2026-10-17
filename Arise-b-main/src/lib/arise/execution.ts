// ARISE V1 — PAPER EXECUTION. Simulated broker behind the BrokerAdapter abstraction.
// Models fees, slippage, spread crossing, rejections. Never presents itself as real money.
// LIVE_TRADING_ENABLED is hardcoded false — there is no UI or config path to enable it.

import type { FillResult, OrderStatus } from "./types";

export const LIVE_TRADING_ENABLED = false; // HARD LOCK — do not change for V1

export const PAPER_TAKER_FEE_BPS = 4; // 0.04% per side (Binance-like)
export const PAPER_SLIPPAGE_BPS = 2; // 0.02% baseline
/**
 * Conservative spread applied when the provider returned no top-of-book.
 * Half is paid on each side of the mid, so a missing book never becomes a
 * zero-cost fill. Recorded as ESTIMATED, never as an observed spread.
 */
export const PAPER_ESTIMATED_SPREAD_BPS = 5;

export interface PaperOrder {
  idempotencyKey: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  type: "MARKET";
  createdAt: number;
  status: OrderStatus;
  fill?: {
    price: number;
    qty: number;
    fee: number;
    slippageBps: number;
    filledAt: number;
  };
  rejectReason?: string;
}

export interface BrokerAdapter {
  name: string;
  getBestPrice(side: "LONG" | "SHORT"): number;
  submitOrder(o: PaperOrder): FillResult;
}

export class PaperBroker implements BrokerAdapter {
  name = "paper-binance-v1";
  private lastClose: number;
  private bestBid: number | null;
  private bestAsk: number | null;
  private submittedKeys = new Set<string>();

  constructor(opts: {
    lastClose: number;
    bestBid: number | null;
    bestAsk: number | null;
  }) {
    this.lastClose = opts.lastClose;
    this.bestBid = opts.bestBid;
    this.bestAsk = opts.bestAsk;
    this.submittedKeys = new Set();
  }

  /**
   * Price for OPENING `side`, i.e. the side you must cross:
   *   LONG  → ask (you buy)   SHORT → bid (you sell).
   * Closing is the opposite side of the same book.
   *
   * This used to return the numerically favourable side (bid for LONG), which
   * would have recorded an entry better than anything the market offered. The
   * method had no callers, but it is part of BrokerAdapter and is now pinned by
   * tests so a future caller cannot reintroduce a favourable fill.
   */
  getBestPrice(side: "LONG" | "SHORT"): number {
    return this.entryQuote(side).price;
  }

  /** Entry price + whether the spread had to be estimated (no quote book). */
  entryQuote(side: "LONG" | "SHORT"): {
    price: number;
    spreadEstimated: boolean;
  } {
    const observed = side === "LONG" ? this.bestAsk : this.bestBid;
    if (observed !== null && Number.isFinite(observed) && observed > 0) {
      return { price: observed, spreadEstimated: false };
    }
    const halfSpread = PAPER_ESTIMATED_SPREAD_BPS / 10_000 / 2;
    const factor = side === "LONG" ? 1 + halfSpread : 1 - halfSpread;
    return { price: this.lastClose * factor, spreadEstimated: true };
  }

  /** Idempotent: same idempotency key never fills twice. */
  submitOrder(o: PaperOrder): FillResult {
    if (this.submittedKeys.has(o.idempotencyKey)) {
      return {
        filledQty: 0,
        fillPrice: 0,
        fee: 0,
        slippageBps: 0,
        status: "REJECTED",
      };
    }
    this.submittedKeys.add(o.idempotencyKey);

    // Fail closed on non-finite sizes too: `NaN <= 0` is false, so an ordering
    // guard alone would fill a NaN quantity and corrupt the paper ledger.
    if (!Number.isFinite(o.qty) || !(o.qty > 0)) {
      return {
        filledQty: 0,
        fillPrice: 0,
        fee: 0,
        slippageBps: 0,
        status: "REJECTED",
      };
    }
    if (LIVE_TRADING_ENABLED) {
      // unreachable in V1 — fail closed if ever reached
      return {
        filledQty: 0,
        fillPrice: 0,
        fee: 0,
        slippageBps: 0,
        status: "FAILED",
      };
    }

    // Fill model: cross the spread in the adverse direction + slippage. A missing
    // book is priced with the documented estimate, not as a zero-spread fill.
    const basePrice = this.entryQuote(o.side).price;
    const slipMult =
      1 + (o.side === "LONG" ? 1 : -1) * (PAPER_SLIPPAGE_BPS / 10_000);
    const fillPrice = basePrice * slipMult;
    const fee = (fillPrice * o.qty * PAPER_TAKER_FEE_BPS) / 10_000;
    return {
      filledQty: o.qty,
      fillPrice,
      fee,
      slippageBps: PAPER_SLIPPAGE_BPS,
      status: "FILLED",
    };
  }
}

/** Applies bar close-out to open position: SL/TP/target checks on bar extremes. */
export function checkExit(
  pos: { side: "LONG" | "SHORT"; entry: number; stop: number; target: number },
  bar: { high: number; low: number },
): { closed: boolean; exitPrice: number; reason: string } {
  if (pos.side === "LONG") {
    if (bar.low <= pos.stop)
      return { closed: true, exitPrice: pos.stop, reason: "STOP_LOSS" };
    if (bar.high >= pos.target)
      return { closed: true, exitPrice: pos.target, reason: "TAKE_PROFIT" };
  } else {
    if (bar.high >= pos.stop)
      return { closed: true, exitPrice: pos.stop, reason: "STOP_LOSS" };
    if (bar.low <= pos.target)
      return { closed: true, exitPrice: pos.target, reason: "TAKE_PROFIT" };
  }
  return { closed: false, exitPrice: 0, reason: "" };
}

export function closePnl(
  side: "LONG" | "SHORT",
  entry: number,
  exit: number,
  qty: number,
  entryFee: number,
  exitFee: number,
): { pnl: number; gross: number } {
  const gross = side === "LONG" ? (exit - entry) * qty : (entry - exit) * qty;
  return { pnl: gross - entryFee - exitFee, gross };
}
