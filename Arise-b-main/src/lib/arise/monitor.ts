// ARISE V1 — PAPER POSITION MONITOR (pure logic, no Convex / no network imports).
// Decides, from validated recent bars, whether an open position's Stop Loss or
// Take Profit has been reached, and produces the atomic close patch for the
// positions table. The Convex wrapper (src/convex/arise/monitor.ts) supplies
// real provider data and persistence; this module contains no I/O.
//
// Safety rules encoded here:
//   - Fail-closed: missing / stale / structurally invalid data ⇒ evaluate nothing.
//   - No fabricated prices: exits fill at the SL/TP level only when a real bar
//     actually touched it (existing checkExit convention, SL priority preserved).
//   - P&L and exit fees reuse the existing execution math (closePnl + fee bps).
//   - OPEN → CLOSED may happen exactly once: applyExitToPosition guards the
//     transition so overlapping executions can never double-close or double-credit.

import { checkExit, closePnl } from "./execution";
import { createFreshnessPolicy, isFresh } from "./freshness";
import { intervalMs } from "./quant";

// ---------------- Exit fee (existing convention) ----------------
// Matches the exit fee used by trading.ts maintainPositions / closePosition:
// (exitPrice * qty * PAPER_TAKER_FEE_BPS) / 10_000 with PAPER_TAKER_FEE_BPS = 4.
export const MONITOR_EXIT_FEE_BPS = 4;

export function exitFeeFor(exitPrice: number, qty: number): number {
  return (exitPrice * qty * MONITOR_EXIT_FEE_BPS) / 10_000;
}

// ---------------- Data usability gate (fail-closed) ----------------

/** One validated recent bar, oldest-first within a series. */
export interface MonitorBar {
  barTime: number; // ms epoch of bar open
  high: number;
  low: number;
  close: number;
}

export interface MonitorMark {
  symbol: string;
  interval: string; // resolved interval of the fetched series
  requestedInterval: string;
  source: string;
  barsCount: number;
  bars: MonitorBar[]; // oldest → newest
}

/** Classifies a fetched series as usable, stale, or invalid. Never throws. */
export function assessMark(
  mark: MonitorMark | null | undefined,
  now: number,
  config: { barStaleMultiplier: number },
): { usable: boolean; state: "USABLE" | "STALE" | "INVALID"; detail: string } {
  if (!mark) return { usable: false, state: "INVALID", detail: "no market data returned" };
  if (!Array.isArray(mark.bars) || mark.bars.length === 0) {
    return { usable: false, state: "INVALID", detail: "no usable bars in series" };
  }

  const last = mark.bars[mark.bars.length - 1];
  const fields = [last.barTime, last.high, last.low, last.close] as unknown[];
  if (fields.some((f) => typeof f !== "number" || !Number.isFinite(f))) {
    return { usable: false, state: "INVALID", detail: "non-finite OHLC values" };
  }
  if (last.barTime <= 0) return { usable: false, state: "INVALID", detail: "non-positive bar time" };
  if (last.close <= 0 || last.high <= 0 || last.low <= 0) {
    return { usable: false, state: "INVALID", detail: "non-positive price" };
  }
  // Structural OHLC sanity (mirrors validate.ts): high ≥ low, close within [low, high].
  if (last.high < last.low || last.close > last.high * (1 + 1e-9) || last.close < last.low * (1 - 1e-9)) {
    return { usable: false, state: "INVALID", detail: "structurally invalid bar" };
  }

  const policy = createFreshnessPolicy(config.barStaleMultiplier);
  const freshness = isFresh(
    {
      time: last.barTime,
      price: last.close,
      interval: mark.interval,
      completed: last.barTime + intervalMs(mark.interval) <= now,
    },
    now,
    policy,
  );
  if (freshness.status === "INVALID") {
    return { usable: false, state: "INVALID", detail: "bar is incomplete, invalid, or future-dated" };
  }
  if (freshness.status === "STALE") {
    return {
      usable: false,
      state: "STALE",
      detail: `latest bar is ${Math.round((freshness.ageMs ?? 0) / 60_000)}m old (> ${config.barStaleMultiplier}× ${policy.interval})`,
    };
  }

  return { usable: true, state: "USABLE", detail: "" };
}

// ---------------- Exit evaluation (reuses existing execution math) ----------------

export interface MonitorPosition {
  _id: string;
  userId?: string;
  symbol: string;
  side: string; // LONG | SHORT
  qty: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  entryFee: number;
  status: string; // OPEN | CLOSED
  closedAt?: number; // set when CLOSED
}

export interface ExitPatch {
  positionId: string;
  patch: {
    status: "CLOSED";
    closedAt: number;
    exitPrice: number;
    exitReason: string; // STOP_LOSS | TAKE_PROFIT
    pnl: number;
    exitFee: number;
  };
}

/**
 * Evaluates one open position against ONE bar.
 * Returns null when no exit condition is reached on that bar.
 * SL has priority over TP (same bar) — consistent with existing checkExit order.
 */
export function evaluateExit(
  position: MonitorPosition,
  bar: MonitorBar,
  now: number,
): ExitPatch | null {
  if (position.status !== "OPEN") return null; // never process closed positions

  const exit = checkExit(
    {
      side: position.side as "LONG" | "SHORT",
      entry: position.entryPrice,
      stop: position.stopLoss,
      target: position.takeProfit,
    },
    { high: bar.high, low: bar.low },
  );
  if (!exit.closed) return null;

  const fee = exitFeeFor(exit.exitPrice, position.qty);
  const { pnl } = closePnl(
    position.side as "LONG" | "SHORT",
    position.entryPrice,
    exit.exitPrice,
    position.qty,
    position.entryFee,
    fee,
  );

  return {
    positionId: position._id,
    patch: {
      status: "CLOSED",
      closedAt: now,
      exitPrice: exit.exitPrice,
      exitReason: exit.reason,
      pnl,
      exitFee: fee,
    },
  };
}

// ---------------- Batch planning (bounded work) ----------------

export interface PlanInput {
  positions: MonitorPosition[]; // open positions only, pre-filtered by caller
  marks: Record<string, MonitorMark | null>; // by symbol; null/empty = fetch failed
  now: number;
  config: { barStaleMultiplier: number };
}

export interface PlanOutput {
  exits: ExitPatch[];
  skipped: { positionId: string; symbol: string; reason: string }[];
}

/**
 * Plans exits for a batch. Bars are evaluated OLDEST → NEWEST so the first
 * touch (which determines the true exit price) wins. Unusable data produces
 * explicit skips, never exits and never fabricated prices.
 */
export function planEvaluations(input: PlanInput): PlanOutput {
  const exits: ExitPatch[] = [];
  const skipped: PlanOutput["skipped"] = [];

  for (const pos of input.positions) {
    if (pos.status !== "OPEN") continue; // closed positions are never processed again
    const mark = input.marks[pos.symbol];
    if (!mark || mark.bars.length === 0) {
      skipped.push({ positionId: pos._id, symbol: pos.symbol, reason: "MARKET_DATA_UNAVAILABLE" });
      continue;
    }
    const gate = assessMark(mark, input.now, input.config);
    if (!gate.usable) {
      skipped.push({ positionId: pos._id, symbol: pos.symbol, reason: `${gate.state}: ${gate.detail}` });
      continue;
    }
    let exit: ExitPatch | null = null;
    for (const bar of mark.bars) {
      exit = evaluateExit(pos, bar, input.now);
      if (exit) break; // first touch wins — oldest bar first
    }
    if (exit) exits.push(exit);
    // No exit condition ⇒ no record needed; position simply stays open.
  }

  return { exits, skipped };
}

// ---------------- Atomic close application (idempotent) ----------------

export interface CloseLikeDoc {
  status: string;
  closedAt?: number;
}

/**
 * Applies an exit patch only if the position is still OPEN.
 * Returns true exactly when this call performed the OPEN → CLOSED transition,
 * so P&L is credited at most once even under overlapping executions.
 * The Convex wrapper must re-read the position inside the same mutation
 * (single serialized transaction) and call this before patching.
 */
export function applyExitToPosition(
  current: CloseLikeDoc | null,
  exit: ExitPatch,
): { applied: boolean; patch?: ExitPatch["patch"] } {
  // Re-read guard: if any other execution closed it first, do nothing.
  if (!current || current.status !== "OPEN") return { applied: false };
  return { applied: true, patch: exit.patch };
}

// ---------------- Health classification ----------------

export type MonitorHealth = "HEALTHY" | "DEGRADED" | "OFFLINE";

export interface MonitorTickRecord {
  at: number;
  evaluated: number;
  closed: number;
  skipped: number;
  ok: boolean;
}

const FRESH_TICK_MS = 15 * 60_000; // evaluation ticks must be recent while positions are open
const IDLE_FRESH_MS = 24 * 3_600_000; // idle monitor must still have run within a day

/** Monitor health from recent tick history (existing status vocabulary). */
export function monitorHealth(
  recent: MonitorTickRecord[],
  now: number,
): { state: MonitorHealth; lastTickAt: number | null; detail: string } {
  const last = recent[0]; // caller passes newest-first
  if (!last) return { state: "OFFLINE", lastTickAt: null, detail: "monitor has never run" };

  if (!last.ok) {
    return { state: "DEGRADED", lastTickAt: last.at, detail: "last monitoring run failed" };
  }

  const idle = last.evaluated === 0 && last.skipped === 0;
  if (idle) {
    if (now - last.at > IDLE_FRESH_MS) {
      return { state: "DEGRADED", lastTickAt: last.at, detail: "no recent checks — scheduler may be stalled" };
    }
    return { state: "HEALTHY", lastTickAt: last.at, detail: "no open positions — monitor idle" };
  }

  if (last.skipped > 0) {
    return {
      state: "DEGRADED",
      lastTickAt: last.at,
      detail: `${last.skipped} position(s) skipped — unusable or unavailable market data`,
    };
  }

  if (now - last.at > FRESH_TICK_MS) {
    return { state: "DEGRADED", lastTickAt: last.at, detail: `last check ${Math.round((now - last.at) / 60_000)}m ago` };
  }
  return { state: "HEALTHY", lastTickAt: last.at, detail: "all open positions evaluated" };
}
