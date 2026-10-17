// ARISE V1 — manual-close price rule (CLOSE_POLICY).
// A manual close is the one place a user supplies a price, so the rule that
// bounds it is a security boundary, not a formatting detail: before this rule
// existed a caller could close its own position at any price and move its own
// paper balance. These tests pin the accept/reject matrix.

import { describe, expect, it } from "vitest";
import { CLOSE_MARK_INTERVAL, CLOSE_POLICY, validateClosePrice } from "./freshness";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const MIN = 60_000;

describe("validateClosePrice (manual close, 5m CLOSE_POLICY)", () => {
  it("uses the documented 5m/15m close policy", () => {
    expect(CLOSE_MARK_INTERVAL).toBe("5m");
    expect(CLOSE_POLICY.interval).toBe("5m");
    expect(CLOSE_POLICY.barStaleMultiplier).toBe(3);
  });

  it("accepts a fresh completed 5m bar close", () => {
    const result = validateClosePrice({ price: 100, priceTime: NOW - 5 * MIN, now: NOW });
    expect(result.ok).toBe(true);
  });

  it("rejects the currently-forming bar even when it started recently", () => {
    // A forming candle's close keeps moving; settling on it would let a caller
    // pick the favourable moment inside the candle.
    const result = validateClosePrice({ price: 100, priceTime: NOW - MIN, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/has not completed/);
  });

  it("rejects a stale completed bar (older than 3 x 5m)", () => {
    const result = validateClosePrice({ price: 100, priceTime: NOW - 20 * MIN, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not a fresh 5m bar close/);
  });

  it("rejects a future-dated bar timestamp", () => {
    expect(validateClosePrice({ price: 100, priceTime: NOW + MIN, now: NOW }).ok).toBe(false);
  });

  it("rejects non-positive, NaN and infinite prices", () => {
    for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = validateClosePrice({ price, priceTime: NOW - MIN, now: NOW });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a missing/invalid bar timestamp", () => {
    for (const priceTime of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateClosePrice({ price: 100, priceTime, now: NOW }).ok).toBe(false);
    }
  });

  it("thus rejects an invented exit price that carries no real bar", () => {
    // The old attack: close at an arbitrary favourable price with no bar data.
    const attack = validateClosePrice({ price: 1_000_000, priceTime: 0, now: NOW });
    expect(attack.ok).toBe(false);
  });
});
