// Tests for src/lib/arise/marks.ts — the pure mark-selection layer.
// Pure functions; no Convex, no network.

import { describe, expect, it } from "vitest";
import { loadMarks, selectCompletedMark, shouldUpsert, type MarkRow } from "./marks";
import { CLOSE_POLICY, DECISION_DATA_POLICY, isFresh, MARK_POLICY } from "./freshness";
import { markedEquity, type LedgerPosition } from "./ledger";
import { intervalMs } from "./quant";

const NOW = 1_800_000_000_000; // fixed "current time"
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const position: LedgerPosition = { symbol: "BTCUSDT", side: "LONG", qty: 1, entryPrice: 100 };

describe("named freshness policies", () => {
  it("keeps the approved multipliers and thresholds unchanged", () => {
    expect(MARK_POLICY).toEqual({ barStaleMultiplier: 3, interval: "15m" });
    expect(CLOSE_POLICY).toEqual({ barStaleMultiplier: 3, interval: "5m" });
    expect(intervalMs(MARK_POLICY.interval) * MARK_POLICY.barStaleMultiplier).toBe(45 * MINUTE);
    expect(intervalMs(CLOSE_POLICY.interval) * CLOSE_POLICY.barStaleMultiplier).toBe(15 * MINUTE);
    expect(DECISION_DATA_POLICY(3, "1d")).toEqual({ barStaleMultiplier: 3, interval: "1d" });
    expect(intervalMs(DECISION_DATA_POLICY(3, "1d").interval) * 3).toBe(3 * DAY);
  });
});

describe("selectCompletedMark", () => {
  it("never selects a forming bar", () => {
    const bars = [{ time: NOW - 5 * MINUTE, close: 105 }]; // 15m bar still forming
    expect(selectCompletedMark(bars, { interval: "15m", now: NOW })).toBeNull();
  });

  it("selects the last completed bar and ignores later forming bars", () => {
    const bars = [
      { time: NOW - 35 * MINUTE, close: 101 },
      { time: NOW - 20 * MINUTE, close: 102 },
      { time: NOW - 5 * MINUTE, close: 103 }, // forming
    ];
    expect(selectCompletedMark(bars, { interval: "15m", now: NOW })).toEqual({
      price: 102,
      time: NOW - 20 * MINUTE,
      interval: "15m",
      completed: true,
    });
  });

  it("produces no mark when the provider resolves an interval other than the requested one", () => {
    const bars = [{ time: NOW - 20 * MINUTE, close: 110 }];
    expect(selectCompletedMark(bars, { interval: "1h", requestedInterval: "15m", now: NOW })).toBeNull();
    expect(selectCompletedMark(bars, { interval: "15m", requestedInterval: "15m", now: NOW })).toEqual({
      price: 110,
      time: NOW - 20 * MINUTE,
      interval: "15m",
      completed: true,
    });
  });
});

describe("loadMarks", () => {
  it("rejects a 1d row as stale under MARK_POLICY (a 1d decision cannot use a stale mark)", () => {
    const rows: MarkRow[] = [{ symbol: "BTCUSDT", price: 110, time: NOW - 2 * DAY, interval: "1d" }];
    const dailyMark = { time: rows[0].time, price: rows[0].price, interval: "1d", completed: true };
    expect(isFresh(dailyMark, NOW, MARK_POLICY).status).toBe("STALE");
    expect(loadMarks(rows, ["BTCUSDT"], NOW, MARK_POLICY)).toEqual({});
  });

  it("ignores rows whose bar interval is not the policy interval", () => {
    const rows: MarkRow[] = [{ symbol: "BTCUSDT", price: 110, time: NOW - 20 * MINUTE, interval: "1h" }];
    expect(loadMarks(rows, ["BTCUSDT"], NOW, MARK_POLICY)).toEqual({});
  });

  it("fails closed when a required symbol has no usable row", () => {
    const marks = loadMarks([], ["BTCUSDT"], NOW, MARK_POLICY);
    expect(marks).toEqual({});
    const result = markedEquity(1_000, [position], marks, {
      now: NOW,
      policy: MARK_POLICY,
      requiredSymbols: ["BTCUSDT"],
    });
    expect(result).toEqual({ equity: 1_000, usedFallback: ["BTCUSDT"], complete: false });
  });

  it("treats age exactly at the 45m limit as fresh and one millisecond older as stale", () => {
    expect(intervalMs(MARK_POLICY.interval) * MARK_POLICY.barStaleMultiplier).toBe(45 * MINUTE);
    const atLimit: MarkRow[] = [{ symbol: "BTCUSDT", price: 110, time: NOW - 45 * MINUTE, interval: "15m" }];
    expect(loadMarks(atLimit, ["BTCUSDT"], NOW, MARK_POLICY)).toEqual({
      BTCUSDT: { symbol: "BTCUSDT", price: 110, time: NOW - 45 * MINUTE, interval: "15m", completed: true },
    });
    const pastLimit: MarkRow[] = [{ symbol: "BTCUSDT", price: 110, time: NOW - 45 * MINUTE - 1, interval: "15m" }];
    expect(loadMarks(pastLimit, ["BTCUSDT"], NOW, MARK_POLICY)).toEqual({});
  });

  it.each(["1h", "4h", "1d"])(
    "a %s decision is not blocked by its decision interval when the 15m mark is fresh",
    (decisionInterval) => {
      const rows: MarkRow[] = [{ symbol: "BTCUSDT", price: 110, time: NOW - 20 * MINUTE, interval: "15m" }];
      const marks = loadMarks(rows, ["BTCUSDT"], NOW, MARK_POLICY);
      expect(Object.keys(marks)).toEqual(["BTCUSDT"]);
      const result = markedEquity(1_000, [position], marks, {
        now: NOW,
        policy: MARK_POLICY,
        requiredSymbols: ["BTCUSDT"],
      });
      expect(result).toEqual({ equity: 1_010, usedFallback: [], complete: true });

      // The decision's own completed candle can never serve as the equity mark:
      // its bar-open age is at least one decision interval (> 45m for 1h/4h/1d).
      const decisionBar = {
        time: NOW - intervalMs(decisionInterval),
        price: 110,
        interval: decisionInterval,
        completed: true,
      };
      expect(isFresh(decisionBar, NOW, MARK_POLICY).fresh).toBe(false);
    },
  );
});

describe("shouldUpsert", () => {
  it("writes only when the incoming bar time is strictly newer", () => {
    const existing = { symbol: "BTCUSDT", price: 100, time: 1_000, interval: "15m" };
    expect(shouldUpsert(existing, { time: 999 })).toBe(false); // older
    expect(shouldUpsert(existing, { time: 1_000 })).toBe(false); // equal
    expect(shouldUpsert(existing, { time: 1_001 })).toBe(true); // newer
    expect(shouldUpsert(null, { time: 1 })).toBe(true);
    expect(shouldUpsert(undefined, { time: 1 })).toBe(true);
  });
});
