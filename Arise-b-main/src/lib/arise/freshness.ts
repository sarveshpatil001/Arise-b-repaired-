import { intervalMs } from "./quant";

export interface FreshnessMark {
  time: number;
  price: number;
  interval: string;
  completed: boolean;
}

export interface FreshnessPolicy {
  barStaleMultiplier: number;
  interval: string;
}

export const FINE_MARK_INTERVAL = "15m";
export const CLOSE_MARK_INTERVAL = "5m";

export function createFreshnessPolicy(barStaleMultiplier: number, interval = FINE_MARK_INTERVAL): FreshnessPolicy {
  return { barStaleMultiplier, interval };
}

/**
 * The only three freshness vocabularies in ARISE (multiplier 3 everywhere):
 * - MARK_POLICY — equity marks are always COMPLETED 15m bars; stale after 3×15m = 45m.
 * - CLOSE_POLICY — T5 manual-close prices are 5m bars; stale after 3×5m = 15m.
 * - DECISION_DATA_POLICY(interval) — a decision's own candle data; stale after 3× its interval.
 */
export const MARK_POLICY: FreshnessPolicy = createFreshnessPolicy(3, FINE_MARK_INTERVAL);
export const CLOSE_POLICY: FreshnessPolicy = createFreshnessPolicy(3, CLOSE_MARK_INTERVAL);

/** Decision-candle data policy (risk.ts DATA_FRESH). */
export function DECISION_DATA_POLICY(barStaleMultiplier: number, interval: string): FreshnessPolicy {
  return createFreshnessPolicy(barStaleMultiplier, interval);
}

export type FreshnessStatus = "FRESH" | "STALE" | "INVALID";

export interface FreshnessResult {
  fresh: boolean;
  status: FreshnessStatus;
  ageMs: number | null;
  maxAgeMs: number | null;
  /** Why the mark is INVALID; null when the mark is well-formed (FRESH or STALE). */
  reason: string | null;
}

function invalid(reason: string): FreshnessResult {
  return { fresh: false, status: "INVALID", ageMs: null, maxAgeMs: null, reason };
}

/**
 * T5 manual-close price rule (CLOSE_POLICY) — the only defence against a caller
 * inventing a favourable exit price for their own position.
 *
 * A manual close must be priced from a COMPLETED 5m bar close supplied with its
 * bar timestamp, and fails closed otherwise:
 *   - the bar must have finished (its start + 5m is not after `now`). A forming
 *     candle's close keeps moving, so it is not an exit price — accepting it was
 *     the original defect, and the server action now only ever offers completed
 *     bars;
 *   - a completed bar is accepted only while it is still fresh under CLOSE_POLICY
 *     (3 × 5m = 15m), the documented manual-close staleness bound;
 *   - anything else — missing/invalid price, missing timestamp, future-dated,
 *     forming, or stale — is rejected.
 */
export function validateClosePrice(args: {
  price: number;
  priceTime: number;
  now: number;
}): { ok: boolean; reason: string } {
  if (!Number.isFinite(args.price) || args.price <= 0) {
    return { ok: false, reason: "close price must be a positive finite number" };
  }
  if (!Number.isFinite(args.priceTime) || args.priceTime <= 0) {
    return { ok: false, reason: `a ${CLOSE_MARK_INTERVAL} bar timestamp is required` };
  }
  if (!Number.isFinite(args.now)) {
    return { ok: false, reason: "invalid clock" };
  }

  const ageMs = args.now - args.priceTime;
  if (ageMs < 0) {
    return { ok: false, reason: "close price bar is future-dated" };
  }

  const completed = args.priceTime + intervalMs(CLOSE_MARK_INTERVAL) <= args.now;
  if (!completed) {
    return { ok: false, reason: `close price bar has not completed (a forming ${CLOSE_MARK_INTERVAL} candle is not an exit price)` };
  }

  const fresh = isFresh(
    {
      time: args.priceTime,
      price: args.price,
      interval: CLOSE_MARK_INTERVAL,
      completed: true,
    },
    args.now,
    CLOSE_POLICY,
  );
  if (!fresh.fresh) {
    return {
      ok: false,
      reason: `close price is not a fresh ${CLOSE_MARK_INTERVAL} bar close (${fresh.status}${
        fresh.reason ? `: ${fresh.reason}` : ""
      })`,
    };
  }
  return { ok: true, reason: "OK" };
}

export function isFresh(
  mark: FreshnessMark | null | undefined,
  now: number,
  policy: FreshnessPolicy,
): FreshnessResult {
  if (!mark) return invalid("missing mark");
  if (!mark.completed) return invalid("incomplete bar");
  if (!Number.isFinite(mark.price) || mark.price <= 0) return invalid("invalid price");
  if (!Number.isFinite(mark.time) || mark.time <= 0) return invalid("invalid mark time");
  if (!Number.isFinite(now)) return invalid("invalid clock");
  if (!Number.isFinite(policy.barStaleMultiplier) || policy.barStaleMultiplier < 0) {
    return invalid("invalid freshness policy");
  }

  const ageMs = now - mark.time;
  const maxAgeMs = intervalMs(policy.interval) * policy.barStaleMultiplier;
  if (!Number.isFinite(ageMs)) {
    return { fresh: false, status: "INVALID", ageMs, maxAgeMs, reason: "invalid mark time" };
  }
  if (ageMs < 0) {
    // Negative age = future-dated mark (e.g. a negative quote age in risk.ts).
    return { fresh: false, status: "INVALID", ageMs, maxAgeMs, reason: "future-dated mark (negative age)" };
  }
  if (ageMs > maxAgeMs) {
    return { fresh: false, status: "STALE", ageMs, maxAgeMs, reason: null };
  }
  return { fresh: true, status: "FRESH", ageMs, maxAgeMs, reason: null };
}
