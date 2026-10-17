// ARISE V1 — COMPLIMENTARY SEAT (plan grant) tests.
// These run the real Convex functions against an in-memory backend, so they exercise
// the server-side entitlement resolver rather than a UI assumption:
//   - a seat granted to an email before that person signs up applies from their first
//     request,
//   - the seat is matched against the account's OWN email, so another account cannot
//     claim it and an unauthenticated caller gets nothing,
//   - revocation takes effect immediately,
//   - a plan the customer actually pays for always wins over a grant.
// No Stripe keys, no network, no real money.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "@/convex/schema";
import { api, internal } from "@/convex/_generated/api";
import { PLAN_MAP } from "@/convex/arise/billing";

const modules = import.meta.glob("../../convex/**/*.ts");

type TestConvex = ReturnType<typeof convexTest>;

function newBackend() {
  return convexTest(schema, modules);
}

const FOUNDER = "sarveshpatil686@gmail.com";
const INSTITUTIONAL = PLAN_MAP.get("institutional");
const FREE = PLAN_MAP.get("free");

async function seedUser(t: TestConvex, email: string) {
  return await t.run(async (ctx) => ctx.db.insert("users", { email }));
}

async function grant(t: TestConvex, email: string, planKey = "institutional") {
  return await t.mutation(internal.arise.billingFunctions.grantPlanByEmail, {
    email,
    planKey,
    note: "test seat",
    grantedBy: "test",
  });
}

describe("plan grants — provisioning", () => {
  it("grants a seat before the account exists and writes an audit event", async () => {
    const t = newBackend();
    const result = await grant(t, FOUNDER, "institutional");

    expect(result.planKey).toBe("institutional");
    expect(result.matchedUserId).toBeNull(); // no account yet — that is the point

    const events = await t.run(async (ctx) => ctx.db.query("systemEvents").collect());
    expect(events.some((e) => e.code === "PLAN_GRANTED" && e.area === "BILLING")).toBe(true);
  });

  it("refuses an unknown plan and a malformed email", async () => {
    const t = newBackend();
    await expect(grant(t, FOUNDER, "platinum")).rejects.toThrow(/UNKNOWN_PLAN/);
    await expect(grant(t, "not-an-email", "institutional")).rejects.toThrow(/INVALID_EMAIL/);
    // Nothing was stored by the refusals.
    const rows = await t.run(async (ctx) => ctx.db.query("planGrants").collect());
    expect(rows).toHaveLength(0);
  });

  it("is idempotent and links an existing account", async () => {
    const t = newBackend();
    const userId = await seedUser(t, FOUNDER);
    await grant(t, FOUNDER);
    const second = await grant(t, FOUNDER);

    expect(second.matchedUserId).toBe(userId);
    const rows = await t.run(async (ctx) => ctx.db.query("planGrants").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].appliedUserId).toBe(userId);
  });
});

describe("plan grants — entitlement resolution", () => {
  it("applies a pending seat from the account's first request", async () => {
    const t = newBackend();
    await grant(t, FOUNDER); // granted before sign-up
    const userId = await seedUser(t, "SarveshPatil686@Gmail.com"); // stored with mixed case

    const ents = await t
      .withIdentity({ subject: userId })
      .query(api.arise.billingFunctions.myEntitlements, {});

    expect(ents.planKey).toBe("institutional");
    expect(ents.planName).toBe(INSTITUTIONAL?.name);
    expect(ents.active).toBe(true);
    expect(ents.source).toBe("grant");
    expect(ents.analysisLimitPerDay).toBe(-1);
    expect(ents.remainingToday).toBe(-1);
    expect(ents.symbolWatchlist).toBe(INSTITUTIONAL?.symbolWatchlist);
  });

  it("keeps the server gate and the client view in agreement", async () => {
    const t = newBackend();
    await grant(t, FOUNDER);
    const userId = await seedUser(t, FOUNDER);
    const as = t.withIdentity({ subject: userId });

    const client = await as.query(api.arise.billingFunctions.myEntitlements, {});
    const gate = await as.query(internal.arise.billingFunctions.myEntitlementsInternal, {});
    expect(gate).toEqual(client);
  });

  it("does not hand a seat to another account or to a signed-out caller", async () => {
    const t = newBackend();
    await grant(t, FOUNDER);
    const stranger = await seedUser(t, "someone.else@example.com");

    const other = await t
      .withIdentity({ subject: stranger })
      .query(api.arise.billingFunctions.myEntitlements, {});
    expect(other.planKey).toBe("free");
    expect(other.source).toBe("none");
    expect(other.remainingToday).toBe(FREE?.analysisLimitPerDay);

    const anonymous = await t.query(api.arise.billingFunctions.myEntitlements, {});
    expect(anonymous.active).toBe(false);
    expect(anonymous.source).toBe("none");
  });

  it("revokes a seat immediately", async () => {
    const t = newBackend();
    await grant(t, FOUNDER);
    const userId = await seedUser(t, FOUNDER);
    const as = t.withIdentity({ subject: userId });

    expect((await as.query(api.arise.billingFunctions.myEntitlements, {})).planKey).toBe(
      "institutional",
    );

    const revoked = await t.mutation(internal.arise.billingFunctions.revokePlanGrant, {
      email: FOUNDER,
    });
    expect(revoked.revoked).toBe(1);

    const after = await as.query(api.arise.billingFunctions.myEntitlements, {});
    expect(after.planKey).toBe("free");
    expect(after.active).toBe(false);
    expect(after.source).toBe("none");
  });

  it("lets a paid subscription win over a granted seat", async () => {
    const t = newBackend();
    await grant(t, FOUNDER);
    const userId = await seedUser(t, FOUNDER);
    await t.run(async (ctx) =>
      ctx.db.insert("subscriptions", {
        userId,
        stripeCustomerId: "cus_test",
        stripeSubscriptionId: "sub_test",
        planKey: "pro",
        status: "active",
        cancelAtPeriodEnd: false,
        updatedAt: Date.now(),
      }),
    );

    const ents = await t
      .withIdentity({ subject: userId })
      .query(api.arise.billingFunctions.myEntitlements, {});
    expect(ents.planKey).toBe("pro");
    expect(ents.source).toBe("subscription");
  });

  it("falls back to free when a stored grant names an unknown plan", async () => {
    const t = newBackend();
    const userId = await seedUser(t, FOUNDER);
    // Bypasses the mutation's validation on purpose: a corrupt/hand-edited row must
    // not become an entitlement.
    await t.run(async (ctx) =>
      ctx.db.insert("planGrants", {
        email: FOUNDER,
        planKey: "platinum",
        grantedAt: Date.now(),
      }),
    );

    const ents = await t
      .withIdentity({ subject: userId })
      .query(api.arise.billingFunctions.myEntitlements, {});
    expect(ents.planKey).toBe("free");
    expect(ents.active).toBe(false);
  });
});
