import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyOpen,
  closeAmounts,
  markedEquity,
  prepareLedgerAccount,
  ratchetHwm,
  rollUtcDay,
  unrealizedPnl,
  type LedgerPosition,
  type LedgerTrade,
  type Mark,
} from "./ledger";
import { createFreshnessPolicy, isFresh } from "./freshness";

const START = 25_000;
const NOW = Date.UTC(2026, 4, 3, 12);

function expectedGross(trade: LedgerTrade): number {
  return (trade.side === "LONG" ? trade.exit - trade.entry : trade.entry - trade.exit) * trade.qty;
}

function runSequence(trades: LedgerTrade[], closeOrder: number[]) {
  let balance = START;
  let grossClosed = 0;
  let entryFees = 0;
  let exitFees = 0;
  let netPnl = 0;
  const open = new Set(trades.map((_, index) => index));
  for (const trade of trades) {
    balance = applyOpen(balance, trade.entryFee);
    entryFees += trade.entryFee;
  }
  for (const index of closeOrder) {
    const trade = trades[index];
    const amount = closeAmounts(trade);
    balance += amount.balanceDelta;
    grossClosed += amount.gross;
    exitFees += trade.exitFee;
    netPnl += amount.netPnl;
    open.delete(index);
  }
  const openEntryFees = [...open].reduce((sum, index) => sum + trades[index].entryFee, 0);
  return { balance, grossClosed, entryFees, exitFees, netPnl, openEntryFees, openCount: open.size };
}

function makeTrade(
  side: "LONG" | "SHORT",
  entry: number,
  exit: number,
  qty: number,
  entryFee: number,
  exitFee: number,
): LedgerTrade {
  return { side, entry, exit, qty, entryFee, exitFee };
}

function nextRandom(seed: { value: number }): number {
  let x = seed.value | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  seed.value = x | 0;
  return (x >>> 0) / 0x1_0000_0000;
}

describe("paper ledger lifecycle invariant", () => {
  it.each(["LONG", "SHORT"] as const)("settles interleaved %s SL, TP, monitor and manual closes once", (side) => {
    const trades = [
      makeTrade(side, 100, side === "LONG" ? 95 : 105, 2, 0.08, 0.076), // SL
      makeTrade(side, 100, side === "LONG" ? 110 : 90, 1.5, 0.06, 0.054), // TP
      makeTrade(side, 40, side === "LONG" ? 42 : 38, 3, 0.048, 0.051), // monitor
      makeTrade(side, 200, side === "LONG" ? 202 : 198, 0.5, 0.04, 0.04), // manual
    ];
    const result = runSequence(trades, [2, 0, 3, 1]);
    expect(result.balance).toBeCloseTo(
      START - result.entryFees + result.grossClosed - result.exitFees,
      9,
    );
    expect(result.netPnl).toBeCloseTo(result.balance - START + result.openEntryFees, 9);
  });

  it("preserves aggregate cash and closed net P&L over 256 seeded randomized sequences", () => {
    const seed = { value: 0x5eedc0de };
    for (let trial = 0; trial < 256; trial++) {
      const count = 1 + Math.floor(nextRandom(seed) * 12);
      const trades: LedgerTrade[] = [];
      for (let i = 0; i < count; i++) {
        const side = nextRandom(seed) < 0.5 ? "LONG" : "SHORT";
        const entry = 10 + nextRandom(seed) * 1_000;
        const exit = 10 + nextRandom(seed) * 1_000;
        const qty = 0.001 + nextRandom(seed) * 20;
        trades.push(makeTrade(side, entry, exit, qty, nextRandom(seed), nextRandom(seed)));
      }
      const order = trades.map((_, index) => index);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(nextRandom(seed) * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const openCount = Math.floor(nextRandom(seed) * Math.min(3, count + 1));
      const openAfter = order.slice(0, openCount);
      const closeOrder = order.slice(openCount);
      const result = runSequence(trades, closeOrder);
      expect(result.balance).toBeCloseTo(
        START - result.entryFees + result.grossClosed - result.exitFees,
        7,
      );
      expect(result.netPnl).toBeCloseTo(result.balance - START + result.openEntryFees, 7);
      expect(result.openCount).toBe(openAfter.length);
    }
  });

  it("proves legacy settlement is short by exactly one entry fee per close", () => {
    const trade = makeTrade("LONG", 100, 95, 2, 0.08, 0.076);
    const balanceAfterOpen = applyOpen(START, trade.entryFee);
    const fixed = balanceAfterOpen + closeAmounts(trade).balanceDelta;
    const legacyClose = (balance: number, t: LedgerTrade) =>
      balance + expectedGross(t) - t.entryFee - t.exitFee;
    const legacy = legacyClose(balanceAfterOpen, trade);
    expect(fixed - legacy).toBeCloseTo(trade.entryFee, 10);
  });
});

describe("fresh mark equity, day roll, and HWM", () => {
  const long: LedgerPosition = { symbol: "BTC", side: "LONG", qty: 2, entryPrice: 100 };
  const short: LedgerPosition = { symbol: "ETH", side: "SHORT", qty: 3, entryPrice: 50 };
  const marks: Record<string, Mark> = {
    BTC: { symbol: "BTC", price: 110, time: NOW - 60_000, interval: "1h", completed: true },
    ETH: { symbol: "ETH", price: 45, time: NOW - 120_000, interval: "1h", completed: true },
  };
  const policy = createFreshnessPolicy(3);

  it("rejects a daily mark older than the explicit 15-minute freshness window", () => {
    const dailyMark: Mark = {
      symbol: "BTC",
      price: 110,
      time: NOW - 2 * 86_400_000,
      interval: "1d",
      completed: true,
    };
    const explicitFinePolicy = createFreshnessPolicy(3);

    expect(isFresh(dailyMark, NOW, explicitFinePolicy).fresh).toBe(false);
  });

  it("rejects a daily position mark that exceeds the explicit fine-interval policy", () => {
    const position: LedgerPosition = { symbol: "BTC", side: "LONG", qty: 1, entryPrice: 100 };
    const dailyMark: Mark = {
      symbol: "BTC",
      price: 110,
      time: NOW - 2 * 86_400_000,
      interval: "1d",
      completed: true,
    };
    const result = markedEquity(1_000, [position], { BTC: dailyMark }, {
      now: NOW,
      policy: createFreshnessPolicy(3, "15m"),
    });

    expect(result).toEqual({ equity: 1_000, usedFallback: ["BTC"], complete: false });
  });

  it("marks multiple long and short positions to current equity", () => {
    expect(unrealizedPnl("LONG", 100, 110, 2)).toBe(20);
    expect(unrealizedPnl("SHORT", 50, 45, 3)).toBe(15);
    expect(markedEquity(1_000, [long, short], marks, { now: NOW, policy })).toEqual({
      equity: 1_035,
      usedFallback: [],
      complete: true,
    });
  });

  it("does not treat an in-progress candle as a fresh equity mark", () => {
    const forming = {
      BTC: { ...marks.BTC, completed: false },
      ETH: marks.ETH,
    };
    const result = markedEquity(1_000, [long, short], forming, { now: NOW, policy });
    expect(result).toEqual({ equity: 1_015, usedFallback: ["BTC"], complete: false });
  });

  it("marks stale or missing positions incomplete and lists fallback symbols", () => {
    const stale = { ...marks, ETH: { symbol: "ETH", price: 45, time: NOW - 4_000_000, interval: "1h", completed: true } };
    const result = markedEquity(1_000, [long, short], stale, { now: NOW, policy });
    expect(result).toEqual({ equity: 1_020, usedFallback: ["ETH"], complete: false });
    const missing = markedEquity(1_000, [long, short], { BTC: marks.BTC }, { now: NOW, policy });
    expect(missing.usedFallback).toEqual(["ETH"]);
    expect(missing.complete).toBe(false);
  });

  it("requires fresh marks for candidate symbols even when no position is open", () => {
    const unavailableCandidate = markedEquity(1_000, [], {}, {
      now: NOW,
      policy,
      requiredSymbols: ["BTC"],
    });
    expect(unavailableCandidate).toEqual({ equity: 1_000, usedFallback: ["BTC"], complete: false });

    const badCandidate = markedEquity(1_000, [], {
      BTC: { symbol: "BTC", price: Number.NaN, time: NOW - 1_000, interval: "1h", completed: true },
    }, {
      now: NOW,
      policy,
      requiredSymbols: ["BTC"],
    });
    expect(badCandidate.complete).toBe(false);
    expect(badCandidate.usedFallback).toEqual(["BTC"]);
  });

  it("never ratchets HWM or rolls the day from incomplete fallback equity", () => {
    const staleResult = markedEquity(1_000, [long, short], { BTC: marks.BTC }, { now: NOW, policy });
    const prior = { dayKey: "2026-05-02", dayStartEquity: 900 };
    expect(ratchetHwm(1_100, staleResult.equity, staleResult.complete)).toBe(1_100);
    expect(rollUtcDay(prior, staleResult.equity, staleResult.complete, NOW)).toEqual({
      ...prior,
      deferred: true,
    });
  });

  it("uses a complete equity mark for the first decision after UTC midnight", () => {
    const midnight = Date.UTC(2026, 4, 4, 0, 0, 1);
    const account = { balance: 1_000, dayKey: "2026-05-03", dayStartEquity: 900, equityHighWaterMark: 1_020 };
    const fresh = markedEquity(1_000, [long], { BTC: { symbol: "BTC", price: 105, time: midnight - 1_000, interval: "1h", completed: true } }, {
      now: midnight,
      policy,
    });
    const prepared = prepareLedgerAccount(account, fresh, midnight);
    expect(prepared.dayKey).toBe("2026-05-04");
    expect(prepared.dayStartEquity).toBe(1_010);
    expect(prepared.equityHighWaterMark).toBe(1_020);
    expect(prepared.deferred).toBe(false);
  });

  it("rolls only after UTC midnight when complete and never decreases HWM", () => {
    const before = Date.UTC(2026, 4, 3, 23, 59, 59);
    const after = Date.UTC(2026, 4, 4, 0, 0, 1);
    expect(rollUtcDay({ dayKey: "2026-05-03", dayStartEquity: 900 }, 1_035, true, before)).toEqual({
      dayKey: "2026-05-03", dayStartEquity: 900, deferred: false,
    });
    expect(rollUtcDay({ dayKey: "2026-05-03", dayStartEquity: 900 }, 1_035, true, after)).toEqual({
      dayKey: "2026-05-04", dayStartEquity: 1_035, deferred: false,
    });
    expect(ratchetHwm(1_100, 1_050, true)).toBe(1_100);
    expect(ratchetHwm(1_100, 1_150, true)).toBe(1_150);
  });
});

describe("close path source wiring guard", () => {
  it("uses settleClose in automatic, monitor, and manual close paths and forbids legacy cash patterns", () => {
    const root = process.cwd();
    const ariseDir = resolve(root, "src/convex/arise");
    const sourceFiles = readdirSync(ariseDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({ name, source: readFileSync(resolve(ariseDir, name), "utf8") }));
    const trading = sourceFiles.find((file) => file.name === "trading.ts")!.source;
    const monitor = sourceFiles.find((file) => file.name === "monitor.ts")!.source;
    const sources = sourceFiles.map((file) => file.source).join("\n");
    for (const forbidden of [/balance\s*\+\s*pnl/, /balanceDelta\s*\+=\s*pnl/, /balance\s*\+\s*openNotional/, /\+\s*remainingNotional/]) {
      expect(sources).not.toMatch(forbidden);
    }
    expect((trading.match(/settleClose\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(monitor).toMatch(/settleClose\(/);
  });
});
