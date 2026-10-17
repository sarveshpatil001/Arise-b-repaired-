// Tests for src/lib/arise/monitor.ts — the 10 required monitoring scenarios.
// Pure functions; no Convex, no network.

import { describe, expect, it } from "vitest";
import {
  assessMark,
  applyExitToPosition,
  evaluateExit,
  exitFeeFor,
  monitorHealth,
  planEvaluations,
  type MonitorBar,
  type MonitorMark,
  type MonitorPosition,
} from "./monitor";
import { closePnl } from "./execution";
import { markedEquity, rollUtcDay, type Mark } from "./ledger";
import { applyOpen, closeAmounts } from "./ledger";
import { createFreshnessPolicy, isFresh } from "./freshness";
import { intervalMs } from "./quant";

const NOW = 1_800_000_000_000; // fixed "current time"

// Neutral 15m bar: inside SL 59_400 / TP 60_900 of the default position.
const BTC_BARS: MonitorBar[] = [
  { barTime: NOW - 35 * 60_000, high: 60_300, low: 59_800, close: 60_100 },
  { barTime: NOW - 20 * 60_000, high: 60_300, low: 59_800, close: 60_100 },
];
const BTC: MonitorMark = {
  symbol: "BTCUSDT",
  interval: "15m",
  requestedInterval: "15m",
  source: "binance",
  barsCount: 2,
  bars: BTC_BARS,
};

function pos(overrides: Partial<MonitorPosition> = {}): MonitorPosition {
  return {
    _id: "pos-1",
    symbol: "BTCUSDT",
    side: "LONG",
    qty: 0.1,
    entryPrice: 60_000,
    stopLoss: 59_400,
    takeProfit: 60_900,
    entryFee: 0.24,
    status: "OPEN",
    ...overrides,
  };
}

// 1. SL/TP not reached → remains open
describe("no exit condition reached", () => {
  it("keeps a LONG open when the bar never touches SL or TP", () => {
    expect(evaluateExit(pos(), BTC.bars[1], NOW)).toBeNull();
    const plan = planEvaluations({ positions: [pos()], marks: { BTCUSDT: BTC }, now: NOW, config: { barStaleMultiplier: 3 } });
    expect(plan.exits).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });

  it("keeps a SHORT open when the bar stays between SL and TP", () => {
    const short = pos({ side: "SHORT", entryPrice: 60_000, stopLoss: 60_600, takeProfit: 59_400 });
    expect(evaluateExit(short, BTC.bars[1], NOW)).toBeNull();
  });
});

// 2. Price reaches SL → closes
describe("stop loss reached", () => {
  it("closes a LONG when the bar low touches the stop", () => {
    const bar: MonitorBar = { barTime: NOW - 5 * 60_000, high: 60_800, low: 59_400, close: 59_500 };
    const out = evaluateExit(pos(), bar, NOW);
    expect(out?.patch.status).toBe("CLOSED");
    expect(out?.patch.exitReason).toBe("STOP_LOSS");
    expect(out?.patch.exitPrice).toBe(59_400);
  });

  it("closes a SHORT when the bar high touches the stop", () => {
    const short = pos({ side: "SHORT", entryPrice: 60_000, stopLoss: 60_600, takeProfit: 59_400 });
    const bar: MonitorBar = { barTime: NOW - 5 * 60_000, high: 60_600, low: 60_100, close: 60_300 };
    const out = evaluateExit(short, bar, NOW);
    expect(out?.patch.exitReason).toBe("STOP_LOSS");
    expect(out?.patch.exitPrice).toBe(60_600);
  });
});

// 3. Price reaches TP → closes
describe("take profit reached", () => {
  it("closes a LONG when the bar high touches the target", () => {
    const bar: MonitorBar = { barTime: NOW - 5 * 60_000, high: 60_900, low: 60_000, close: 60_800 };
    const out = evaluateExit(pos(), bar, NOW);
    expect(out?.patch.exitReason).toBe("TAKE_PROFIT");
    expect(out?.patch.exitPrice).toBe(60_900);
  });

  it("prioritizes SL over TP when one bar touches both", () => {
    const bar: MonitorBar = { barTime: NOW - 5 * 60_000, high: 61_000, low: 59_000, close: 60_000 };
    const out = evaluateExit(pos(), bar, NOW);
    expect(out?.patch.exitReason).toBe("STOP_LOSS");
  });
});

// 4. Provider failure → position remains open
describe("provider failure", () => {
  it("skips with MARKET_DATA_UNAVAILABLE and plans no exit", () => {
    const plan = planEvaluations({
      positions: [pos()],
      marks: { BTCUSDT: null }, // fetch threw / returned nothing
      now: NOW,
      config: { barStaleMultiplier: 3 },
    });
    expect(plan.exits).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].reason).toBe("MARKET_DATA_UNAVAILABLE");
  });
});

// 5. Stale / invalid data → position remains open
describe("stale or invalid data", () => {
  it("refuses a forming candle even when its age is within the stale limit", () => {
    const forming: MonitorMark = {
      ...BTC,
      bars: [{ barTime: NOW - 5 * 60_000, high: 60_300, low: 59_800, close: 60_100 }],
    };
    const gate = assessMark(forming, NOW, { barStaleMultiplier: 3 });
    expect(gate.usable).toBe(false);
    expect(gate.state).toBe("INVALID");
  });

  it("refuses a 1d series older than the fixed fine-interval freshness policy", () => {
    const daily: MonitorMark = {
      ...BTC,
      interval: "1d",
      bars: [{ barTime: NOW - 24 * 60 * 60_000 - 45 * 60_000, high: 60_300, low: 59_800, close: 60_100 }],
    };
    expect(NOW - daily.bars[0].barTime).toBeGreaterThan(45 * 60_000);
    expect(NOW - daily.bars[0].barTime).toBeLessThan(3 * intervalMs("1d"));
    const gate = assessMark(daily, NOW, { barStaleMultiplier: 3 });
    expect(gate.usable).toBe(false);
    expect(gate.state).toBe("STALE");
  });

  it("refuses a stale series (newest bar older than multiplier × interval)", () => {
    const stale: MonitorMark = {
      ...BTC,
      bars: [{ barTime: NOW - 5 * 3_600_000, high: 60_300, low: 59_800, close: 60_100 }], // 5h old vs 45m allowed
    };
    const gate = assessMark(stale, NOW, { barStaleMultiplier: 3 });
    expect(gate.state).toBe("STALE");
    expect(gate.usable).toBe(false);
    const plan = planEvaluations({
      positions: [pos()],
      marks: { BTCUSDT: stale },
      now: NOW,
      config: { barStaleMultiplier: 3 },
    });
    expect(plan.exits).toHaveLength(0);
    expect(plan.skipped[0].reason.startsWith("STALE")).toBe(true);
  });

  it("refuses structurally invalid bars (high < low)", () => {
    const bad: MonitorMark = { ...BTC, bars: [{ barTime: NOW - 5 * 60_000, high: 58_000, low: 59_000, close: 58_500 }] };
    expect(assessMark(bad, NOW, { barStaleMultiplier: 3 }).state).toBe("INVALID");
  });

  it("refuses future-dated bars (clock skew)", () => {
    const future: MonitorMark = { ...BTC, bars: [{ barTime: NOW + 3_600_000, high: 60_300, low: 59_800, close: 60_100 }] };
    expect(assessMark(future, NOW, { barStaleMultiplier: 3 }).state).toBe("INVALID");
  });

  it("refuses non-finite prices", () => {
    const nan: MonitorMark = { ...BTC, bars: [{ barTime: NOW - 5 * 60_000, high: 60_300, low: 59_800, close: Number.NaN }] };
    expect(assessMark(nan, NOW, { barStaleMultiplier: 3 }).state).toBe("INVALID");
  });

  it("refuses an empty series", () => {
    const empty: MonitorMark = { ...BTC, bars: [] };
    const plan = planEvaluations({ positions: [pos()], marks: { BTCUSDT: empty }, now: NOW, config: { barStaleMultiplier: 3 } });
    expect(plan.exits).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe("MARKET_DATA_UNAVAILABLE");
  });
});

// 6. Duplicate monitor execution → closes only once
// 7. P&L recorded exactly once
describe("idempotency", () => {
  it("applies the OPEN→CLOSED transition only once", () => {
    const bar: MonitorBar = { barTime: NOW - 5 * 60_000, high: 60_900, low: 60_000, close: 60_800 };
    const exit = evaluateExit(pos(), bar, NOW);
    expect(exit).not.toBeNull();

    // First execution sees OPEN → applies.
    const first = applyExitToPosition({ status: "OPEN" }, exit!);
    expect(first.applied).toBe(true);

    // Overlapping second execution already sees CLOSED → no-op.
    const second = applyExitToPosition({ status: "CLOSED", closedAt: NOW }, exit!);
    expect(second.applied).toBe(false);
  });

  it("computes deterministic P&L — same inputs, same result, once", () => {
    const bar: MonitorBar = { barTime: NOW - 5 * 60_000, high: 60_800, low: 59_400, close: 59_500 };
    const a = evaluateExit(pos(), bar, NOW);
    const b = evaluateExit(pos(), bar, NOW);
    expect(a?.patch.pnl).toBe(b?.patch.pnl);
    // LONG: gross = (59400 − 60000) × 0.1 = −60
    // exitFee = 59400 × 0.1 × 4/10000 = 2.376 ; pnl = −60 − 0.24(entry) − 2.376
    expect(a?.patch.exitFee).toBeCloseTo(2.376, 10);
    expect(a?.patch.pnl).toBeCloseTo(-60 - 0.24 - 2.376, 10);
  });
});

// 8. Fees/slippage use existing execution logic
describe("fee convention", () => {
  it("uses the existing 4 bps exit-fee convention", () => {
    expect(exitFeeFor(50_000, 2)).toBeCloseTo((50_000 * 2 * 4) / 10_000, 10);
  });
});

// 9. Multiple open positions can be monitored
describe("batch monitoring", () => {
  it("evaluates every open position and exits each independently", () => {
    const eth: MonitorMark = {
      symbol: "ETHUSDT", interval: "15m", requestedInterval: "15m", source: "binance", barsCount: 1,
      bars: [{ barTime: NOW - 20 * 60_000, high: 3_100, low: 3_000, close: 3_050 }],
    };
    const btcShort = pos({ _id: "pos-2", side: "SHORT", stopLoss: 60_600, takeProfit: 59_400 });
    // Explicit wide bar touching both the LONG SL (59_400) and the SHORT SL (60_600).
    const wide: MonitorMark = { ...BTC, bars: [{ barTime: NOW - 20 * 60_000, high: 61_000, low: 59_000, close: 60_000 }] };
    const plan = planEvaluations({
      positions: [pos(), btcShort],
      marks: { BTCUSDT: wide, ETHUSDT: eth },
      now: NOW,
      config: { barStaleMultiplier: 3 },
    });
    expect(plan.exits.map((e) => e.positionId).sort()).toEqual(["pos-1", "pos-2"]);
    expect(plan.exits.every((e) => e.patch.exitReason === "STOP_LOSS")).toBe(true);
  });

  it("skips only the symbols whose data failed, exits the rest", () => {
    // TP-touching BTC bar must produce an exit while EURUSD is skipped.
    const tpBar: MonitorMark = { ...BTC, bars: [{ barTime: NOW - 20 * 60_000, high: 60_900, low: 60_000, close: 60_800 }] };
    const plan = planEvaluations({
      positions: [pos(), pos({ _id: "pos-9", symbol: "EURUSD" })],
      marks: { BTCUSDT: tpBar, EURUSD: null },
      now: NOW,
      config: { barStaleMultiplier: 3 },
    });
    expect(plan.exits.map((e) => e.positionId)).toEqual(["pos-1"]);
    expect(plan.skipped.map((s) => s.symbol)).toEqual(["EURUSD"]);
  });

  it("uses the OLDEST touching bar for the exit price (first touch wins)", () => {
    const series: MonitorMark = {
      ...BTC,
      bars: [
        { barTime: NOW - 35 * 60_000, high: 60_900, low: 60_000, close: 60_700 }, // TP touched here first
        { barTime: NOW - 20 * 60_000, high: 61_200, low: 59_300, close: 59_500 },  // SL touched after
      ],
    };
    const plan = planEvaluations({ positions: [pos()], marks: { BTCUSDT: series }, now: NOW, config: { barStaleMultiplier: 3 } });
    expect(plan.exits).toHaveLength(1);
    expect(plan.exits[0].patch.exitReason).toBe("TAKE_PROFIT");
    expect(plan.exits[0].patch.exitPrice).toBe(60_900);
  });
});

// Batch 2 accounting regression coverage: entry fees are debited at entry,
// so every close path credits gross P&L less exit fee (not net P&L again).
describe("paper balance fee invariant", () => {
  const start = 10_000;
  const entry = 100;
  const qty = 2;
  const entryFee = 0.08;

  it("preserves the aggregate balance invariant across SL, TP, monitor, and manual exits", () => {
    const trades = [
      { side: "LONG", entry: 100, exit: 95, qty: 2, entryFee: 0.08 },
      { side: "SHORT", entry: 100, exit: 90, qty: 2, entryFee: 0.08 },
      { side: "LONG", entry: 100, exit: 105, qty: 2, entryFee: 0.08 },
      { side: "SHORT", entry: 100, exit: 110, qty: 2, entryFee: 0.08 },
    ] as const;
    let balance = start;
    let grossTotal = 0;
    let entryFees = 0;
    let exitFees = 0;
    for (const trade of trades) {
      const exitFee = exitFeeFor(trade.exit, trade.qty);
      const amount = closeAmounts({ ...trade, side: trade.side, exitFee });
      balance = applyOpen(balance, trade.entryFee);
      balance += amount.balanceDelta;
      grossTotal += amount.gross;
      entryFees += trade.entryFee;
      exitFees += exitFee;
    }
    expect(balance).toBeCloseTo(start + grossTotal - entryFees - exitFees, 10);
  });

  it.each([
    ["stop loss", "LONG", 95, "STOP_LOSS"],
    ["take profit", "SHORT", 90, "TAKE_PROFIT"],
    ["monitor close", "LONG", 105, "TAKE_PROFIT"],
    ["manual close", "SHORT", 110, "MANUAL_CLOSE"],
  ] as const)("charges entry and exit fees exactly once for %s", (path, side, intendedExit, reason) => {
    const position = pos({
      side,
      qty,
      entryPrice: entry,
      entryFee,
      stopLoss: side === "LONG" ? 95 : 105,
      takeProfit: side === "LONG" ? 105 : 90,
    });
    const bar = reason === "STOP_LOSS"
      ? { barTime: NOW - 60_000, high: 101, low: 95, close: 99 }
      : { barTime: NOW - 60_000, high: intendedExit, low: side === "SHORT" ? 90 : 100, close: 100 };
    const monitorExit = reason === "MANUAL_CLOSE" ? null : evaluateExit(position, bar, NOW);
    if (monitorExit) {
      expect(monitorExit.patch.exitReason).toBe(reason);
      expect(monitorExit.patch.exitPrice).toBe(intendedExit);
    }
    if (path === "monitor close") {
      expect(monitorExit).not.toBeNull();
      expect(applyExitToPosition({ status: "OPEN" }, monitorExit!).applied).toBe(true);
    }
    const exit = monitorExit?.patch.exitPrice ?? intendedExit;
    const exitFee = exitFeeFor(exit, qty);
    const { gross, pnl } = closePnl(side, entry, exit, qty, entryFee, exitFee);
    if (monitorExit) expect(monitorExit.patch.pnl).toBeCloseTo(pnl, 10);

    const balanceAfterEntry = applyOpen(start, entryFee);
    const amount = closeAmounts({ side, entry, exit, qty, entryFee, exitFee });
    const balanceEnd = balanceAfterEntry + amount.balanceDelta;
    expect(balanceEnd).toBeCloseTo(start + gross - entryFee - exitFee, 10);
    expect(balanceEnd - balanceAfterEntry).toBeCloseTo(gross - exitFee, 10);
    expect(pnl).toBeCloseTo(gross - entryFee - exitFee, 10);
    expect(path).toBeTruthy();
  });
});

describe("mark-to-market equity", () => {
  it("rejects a daily mark outside the explicit fixed fine-interval policy", () => {
    const dailyMark: Mark = {
      symbol: "TEST",
      price: 100,
      time: NOW - 2 * 86_400_000,
      interval: "1d",
      completed: true,
    };
    const fixedFinePolicy = { interval: "15m", barStaleMultiplier: 3 };

    expect(isFresh(dailyMark, NOW, fixedFinePolicy).fresh).toBe(false);
  });

  it.each([
    ["LONG", 110, 20],
    ["SHORT", 90, 20],
  ] as const)("marks %s unrealized P&L and equity from the current price", (side, mark, expectedPnl) => {
    const position = { symbol: "TEST", side, qty: 2, entryPrice: 100 };
    const ledgerMark: Mark = { symbol: "TEST", price: mark, time: NOW - 60_000, interval: "1h", completed: true };
    expect(markedEquity(999, [position], { TEST: ledgerMark }, {
      now: NOW,
      policy: createFreshnessPolicy(3),
    }).equity).toBe(999 + expectedPnl);
  });

  it("requires a fresh completed mark for a new candidate symbol", () => {
    const result = markedEquity(999, [], {}, {
      now: NOW,
      policy: createFreshnessPolicy(3),
      requiredSymbols: ["TEST"],
    });
    expect(result.equity).toBe(999);
    expect(result.complete).toBe(false);
    expect(result.usedFallback).toEqual(["TEST"]);
  });

  it("uses entry price when no mark is available", () => {
    const result = markedEquity(999, [{ symbol: "TEST", side: "LONG", qty: 2, entryPrice: 100 }], {}, {
      now: NOW,
      policy: createFreshnessPolicy(3),
    });
    expect(result.equity).toBe(999);
    expect(result.complete).toBe(false);
  });
});

describe("UTC day equity anchor", () => {
  it("rolls the anchor to marked equity at UTC midnight", () => {
    const beforeMidnight = Date.UTC(2025, 0, 1, 23, 59, 59);
    const afterMidnight = Date.UTC(2025, 0, 2, 0, 0, 1);
    expect(rollUtcDay({ dayKey: "2025-01-01", dayStartEquity: 1_000 }, 1_125, true, afterMidnight)).toEqual({
      dayKey: "2025-01-02",
      dayStartEquity: 1_125,
      deferred: false,
    });
    expect(rollUtcDay({ dayKey: "2025-01-01", dayStartEquity: 1_000 }, 1_125, true, beforeMidnight)).toEqual({
      dayKey: "2025-01-01",
      dayStartEquity: 1_000,
      deferred: false,
    });
  });
});

// 10. Closed positions are not processed again
describe("closed positions", () => {
  it("ignores CLOSED positions entirely", () => {
    const closed = pos({ status: "CLOSED", closedAt: NOW });
    expect(evaluateExit(closed, BTC.bars[1], NOW)).toBeNull();
    const plan = planEvaluations({
      positions: [closed],
      marks: { BTCUSDT: BTC },
      now: NOW,
      config: { barStaleMultiplier: 3 },
    });
    expect(plan.exits).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });
});

// Health classification
describe("monitorHealth", () => {
  it("OFFLINE before the first tick", () => {
    expect(monitorHealth([], NOW).state).toBe("OFFLINE");
  });

  it("HEALTHY after a recent successful tick", () => {
    const h = monitorHealth([{ at: NOW - 60_000, evaluated: 2, closed: 1, skipped: 0, ok: true }], NOW);
    expect(h.state).toBe("HEALTHY");
  });

  it("HEALTHY when idle with no open positions, within the idle window", () => {
    const h = monitorHealth([{ at: NOW - 3 * 3_600_000, evaluated: 0, closed: 0, skipped: 0, ok: true }], NOW);
    expect(h.state).toBe("HEALTHY");
  });

  it("DEGRADED when the monitor has been idle too long", () => {
    const h = monitorHealth([{ at: NOW - 30 * 3_600_000, evaluated: 0, closed: 0, skipped: 0, ok: true }], NOW);
    expect(h.state).toBe("DEGRADED");
  });

  it("DEGRADED when the last run failed or skipped positions", () => {
    expect(
      monitorHealth([{ at: NOW - 60_000, evaluated: 0, closed: 0, skipped: 2, ok: true }], NOW).state,
    ).toBe("DEGRADED");
    expect(
      monitorHealth([{ at: NOW - 60_000, evaluated: 0, closed: 0, skipped: 0, ok: false }], NOW).state,
    ).toBe("DEGRADED");
  });

  it("DEGRADED when evaluation ticks go quiet while positions are open", () => {
    const h = monitorHealth([{ at: NOW - 20 * 60_000, evaluated: 1, closed: 0, skipped: 0, ok: true }], NOW);
    expect(h.state).toBe("DEGRADED");
  });
});

// Regression for post-merge integrity findings: monitoring may only settle on
// primary-provider, valid, completed data for bars that began after entry.
describe("monitor settlement provenance and entry timing", () => {
  it("refuses a fallback provider's mark", () => {
    const delta: MonitorMark = { ...BTC, source: "delta" };
    const gate = assessMark(delta, NOW, { barStaleMultiplier: 3 });
    expect(gate.usable).toBe(false);
    expect(gate.state).toBe("INVALID");
    expect(gate.detail).toMatch(/non-primary provider/);
  });

  it("refuses a degraded series", () => {
    const degraded: MonitorMark = { ...BTC, quality: "degraded" };
    const gate = assessMark(degraded, NOW, { barStaleMultiplier: 3 });
    expect(gate.usable).toBe(false);
    expect(gate.state).toBe("INVALID");
    expect(gate.detail).toMatch(/degraded/);
  });

  it("never evaluates a bar that started before the position was opened", () => {
    const bar: MonitorBar = { barTime: NOW - 20 * 60_000, high: 60_300, low: 58_000, close: 60_100 };
    const late = pos({ openedAt: NOW - 10 * 60_000 });
    expect(evaluateExit(late, bar, NOW)).toBeNull();

    const plan = planEvaluations({
      positions: [late],
      marks: { BTCUSDT: { ...BTC, bars: [bar] } },
      now: NOW,
      config: { barStaleMultiplier: 3 },
    });
    expect(plan.exits).toHaveLength(0);
  });

  it("still evaluates a bar that began after entry", () => {
    const bar: MonitorBar = { barTime: NOW - 5 * 60_000, high: 60_300, low: 59_000, close: 59_500 };
    const late = pos({ openedAt: NOW - 10 * 60_000 });
    expect(evaluateExit(late, bar, NOW)?.patch.exitReason).toBe("STOP_LOSS");
  });
});
