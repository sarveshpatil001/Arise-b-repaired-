// ARISE V1 — subscription policy tests.
//
// These pin the fail-closed rules that decide what a Stripe event entitles. The point of
// the suite is that an unrecognised price or status can never quietly keep a paid plan
// alive, and that a recoverable payment delay does not silently grant access either.

import { describe, expect, it } from "vitest";
import {
  buildPriceMap,
  isEntitledStatus,
  isKnownStatus,
  planKeyForPrice,
  priceEnvVarName,
  resolveSubscriptionPlan,
  ENTITLED_STATUSES,
  RECOVERABLE_STATUSES,
  TERMINAL_STATUSES,
  type PriceEntry,
} from "./subscriptionPolicy";

const PLANS = [
  { key: "free" },
  { key: "pro" },
  { key: "institutional" },
];

const ENTRIES: PriceEntry[] = [
  { priceId: "price_pro_123", planKey: "pro" },
  { priceId: "price_inst_999", planKey: "institutional" },
];

describe("price → plan mapping", () => {
  it("derives the env var name per plan", () => {
    expect(priceEnvVarName("pro")).toBe("STRIPE_PRICE_PRO");
    expect(priceEnvVarName("institutional")).toBe("STRIPE_PRICE_INSTITUTIONAL");
    expect(priceEnvVarName("team-seat")).toBe("STRIPE_PRICE_TEAM_SEAT");
  });

  it("reads price ids from the server environment, falling back to code", () => {
    const fromEnv = buildPriceMap(
      { STRIPE_PRICE_PRO: "price_env_pro", STRIPE_PRICE_INSTITUTIONAL: "  " },
      PLANS,
    );
    expect(fromEnv).toEqual([{ priceId: "price_env_pro", planKey: "pro" }]);

    const fromCode = buildPriceMap({}, [
      { key: "free" },
      { key: "pro", stripePriceId: "price_code_pro" },
    ]);
    expect(fromCode).toEqual([{ priceId: "price_code_pro", planKey: "pro" }]);

    // Free is never a paid mapping; an unconfigured deployment maps nothing.
    expect(buildPriceMap({}, PLANS)).toEqual([]);
    expect(buildPriceMap({ STRIPE_PRICE_PRO: "   " }, PLANS)).toEqual([]);
  });

  it("maps only exact, known price ids", () => {
    expect(planKeyForPrice("price_pro_123", ENTRIES)).toBe("pro");
    expect(planKeyForPrice("price_pro_124", ENTRIES)).toBeNull();
    expect(planKeyForPrice(null, ENTRIES)).toBeNull();
    expect(planKeyForPrice("", ENTRIES)).toBeNull();
  });
});

describe("status policy", () => {
  it("classifies statuses into entitled, recoverable and terminal", () => {
    for (const s of ENTITLED_STATUSES) expect(isEntitledStatus(s)).toBe(true);
    for (const s of RECOVERABLE_STATUSES) expect(isEntitledStatus(s)).toBe(false);
    for (const s of TERMINAL_STATUSES) expect(isEntitledStatus(s)).toBe(false);
    expect(isEntitledStatus("ACTIVE")).toBe(true); // provider casing must not matter
    expect(isKnownStatus("active")).toBe(true);
    expect(isKnownStatus("trialing")).toBe(true);
    expect(isKnownStatus("past_due")).toBe(true);
    expect(isKnownStatus("incomplete_expired")).toBe(true);
    expect(isKnownStatus("weird_new_status")).toBe(false);
    expect(isKnownStatus("")).toBe(false);
  });
});

describe("resolveSubscriptionPlan — fail closed on anything unrecognised", () => {
  it("entitles a known price with an active status", () => {
    const d = resolveSubscriptionPlan({ priceId: "price_pro_123", status: "active", entries: ENTRIES });
    expect(d).toEqual({ planKey: "pro", entitled: true, reason: "ENTITLED", reconcile: false });
  });

  it("maps an upgrade and a downgrade by price, not by history", () => {
    const up = resolveSubscriptionPlan({
      priceId: "price_inst_999",
      status: "active",
      entries: ENTRIES,
    });
    expect(up.planKey).toBe("institutional");
    const down = resolveSubscriptionPlan({ priceId: "price_pro_123", status: "active", entries: ENTRIES });
    expect(down.planKey).toBe("pro");
  });

  it("drops to free on an unknown price and asks for reconciliation", () => {
    const d = resolveSubscriptionPlan({
      priceId: "price_mystery_777",
      status: "active",
      entries: ENTRIES,
    });
    expect(d.planKey).toBe("free");
    expect(d.entitled).toBe(false);
    expect(d.reason).toBe("PRICE_UNMAPPED");
    expect(d.reconcile).toBe(true);
  });

  it("treats a missing price as unmapped rather than inheriting a plan", () => {
    const d = resolveSubscriptionPlan({ priceId: null, status: "active", entries: ENTRIES });
    expect(d.planKey).toBe("free");
    expect(d.reason).toBe("PRICE_MISSING");
    expect(d.reconcile).toBe(true);
  });

  it("fails closed when no price map is configured at all", () => {
    const d = resolveSubscriptionPlan({ priceId: "price_pro_123", status: "active", entries: [] });
    expect(d.planKey).toBe("free");
    expect(d.entitled).toBe(false);
    expect(d.reconcile).toBe(true);
  });

  it("ends entitlement on terminal statuses", () => {
    for (const status of ["canceled", "unpaid", "incomplete_expired"]) {
      const d = resolveSubscriptionPlan({ priceId: "price_pro_123", status, entries: ENTRIES });
      expect(d.planKey).toBe("free");
      expect(d.entitled).toBe(false);
      expect(d.reason).toBe("STATUS_TERMINAL");
      expect(d.reconcile).toBe(false);
    }
  });

  it("remembers the plan through a recoverable delay without granting access", () => {
    const d = resolveSubscriptionPlan({ priceId: "price_pro_123", status: "past_due", entries: ENTRIES });
    expect(d.planKey).toBe("pro"); // retained so a later 'active' restores it
    expect(d.entitled).toBe(false); // but no access during the delay
    expect(d.reason).toBe("STATUS_RECOVERABLE");
  });

  it("fails closed on a status ARISE does not recognise", () => {
    const d = resolveSubscriptionPlan({ priceId: "price_pro_123", status: "quantum_state", entries: ENTRIES });
    expect(d.planKey).toBe("free");
    expect(d.entitled).toBe(false);
    expect(d.reason).toBe("STATUS_UNRECOGNISED");
    expect(d.reconcile).toBe(true);
  });

  it("validates status before price, so an unmapped price cannot mask a bad status", () => {
    const d = resolveSubscriptionPlan({ priceId: "price_mystery", status: "nonsense", entries: ENTRIES });
    expect(d.reason).toBe("STATUS_UNRECOGNISED");
  });

  it("is deterministic for identical input", () => {
    const args = { priceId: "price_inst_999", status: "trialing", entries: ENTRIES };
    expect(resolveSubscriptionPlan(args)).toEqual(resolveSubscriptionPlan(args));
  });
});
