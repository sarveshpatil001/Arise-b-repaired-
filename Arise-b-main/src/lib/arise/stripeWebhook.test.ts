// ARISE V1 — Stripe webhook delivery tests (claiming, recovery, replay, price mapping).
//
// The webhook is the one place where an unauthenticated remote party can change what a
// customer is entitled to, so this suite pins the properties an auditor cares about:
//   - a MERELY RECORDED event is never treated as a successfully processed one,
//   - a duplicate delivery cannot apply the same subscription change twice,
//   - a concurrent delivery cannot apply it in parallel,
//   - a failed attempt stays retryable, and a dead in-flight attempt is recoverable,
//   - a price ARISE cannot map (or a status it does not recognise) fails closed instead
//     of silently keeping a paid plan alive,
//   - signature verification refuses anything it cannot verify.
// No Stripe network calls: signature checks are exercised with bogus input, which is the
// fail-closed path, and all state changes go through the real Convex functions.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import schema from "@/convex/schema";
import { api, internal } from "@/convex/_generated/api";
import { verifyWebhook } from "@/convex/arise/billing";

const modules = import.meta.glob("../../convex/**/*.ts");

type TestConvex = ReturnType<typeof convexTest>;

function newBackend() {
  return convexTest(schema, modules);
}

const CUSTOMER = "cus_test_1";
const PRO_PRICE = "price_pro_test";

/** The price map is read from the deployment environment, so the tests configure it the
 *  same way a deployment does (fake ids — no real Stripe values anywhere). */
function configurePrices() {
  process.env.STRIPE_PRICE_PRO = PRO_PRICE;
  process.env.STRIPE_PRICE_INSTITUTIONAL = "price_inst_test";
}

beforeEach(() => {
  configurePrices();
  process.env.STRIPE_SECRET_KEY = "sk_test_not_a_real_key";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_not_a_real_secret";
});

afterEach(() => {
  delete process.env.STRIPE_PRICE_PRO;
  delete process.env.STRIPE_PRICE_INSTITUTIONAL;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

async function seedSubscription(t: TestConvex, planKey = "pro", status = "active") {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", { email: "buyer@example.com" }));
  await t.run(async (ctx) =>
    ctx.db.insert("subscriptions", {
      userId,
      stripeCustomerId: CUSTOMER,
      stripeSubscriptionId: "sub_1",
      planKey,
      status,
      cancelAtPeriodEnd: false,
      updatedAt: Date.now(),
    }),
  );
  return userId;
}

async function claim(t: TestConvex, id: string, at = 1_000_000) {
  return await t.mutation(internal.arise.billingFunctions.internalClaimEvent, {
    stripeEventId: id,
    type: "customer.subscription.updated",
    receivedAt: at,
  });
}

async function appliedStatus(t: TestConvex, userId: string) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("subscriptions").collect();
    const mine = rows.filter((r) => r.userId === userId);
    return { count: mine.length, planKey: mine[0]?.planKey, status: mine[0]?.status };
  });
}

describe("webhook signature verification", () => {
  it("fails closed when billing is not configured", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(() => verifyWebhook("{}", "t=1,v1=abc")).toThrow(/BILLING_NOT_CONFIGURED/);
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_not_a_real_secret";
    expect(() => verifyWebhook("{}", "t=1,v1=abc")).toThrow(/BILLING_NOT_CONFIGURED/);
  });

  it("refuses a delivery with no signature header", () => {
    expect(() => verifyWebhook("{}", null)).toThrow(/MISSING_SIGNATURE/);
  });

  it("refuses a forged signature", () => {
    // A well-formed but wrong signature must not verify — this is the path an attacker
    // who discovered the endpoint would take.
    expect(() => verifyWebhook('{"id":"evt_forged"}', "t=123,v1=deadbeef")).toThrow();
  });
});

describe("event claiming — recorded is not processed", () => {
  it("claims a new event, and the row starts unprocessed", async () => {
    const t = newBackend();
    expect(await claim(t, "evt_1")).toMatchObject({ status: "CLAIMED", attempts: 1 });

    const row = await t.run(async (ctx) => ctx.db.query("stripeEvents").collect());
    expect(row).toHaveLength(1);
    expect(row[0].processed).toBe(false);
    expect(row[0].status).toBe("PROCESSING");
  });

  it("treats a second delivery of a still-processing event as in-flight, not duplicate", async () => {
    const t = newBackend();
    await claim(t, "evt_2");
    // Same millisecond-scale window: the first claim's lease is still live.
    expect(await claim(t, "evt_2", 1_000_001)).toMatchObject({ status: "IN_FLIGHT" });
    // …and it must NOT be counted as done.
    const row = await t.run(async (ctx) => ctx.db.query("stripeEvents").collect());
    expect(row[0].processed).toBe(false);
  });

  it("refuses to reprocess a completed event, and refuses to lose a failed one", async () => {
    const t = newBackend();
    await claim(t, "evt_3");
    await t.mutation(internal.arise.billingFunctions.internalMarkEventProcessed, {
      stripeEventId: "evt_3",
      at: 1_000_100,
    });
    expect(await claim(t, "evt_3", 9_999_999)).toMatchObject({ status: "DUPLICATE" });

    await claim(t, "evt_4");
    await t.mutation(internal.arise.billingFunctions.internalMarkEventFailed, {
      stripeEventId: "evt_4",
      error: "provider timeout",
      at: 1_000_200,
    });
    // A failed attempt is retryable — this is the case the old code silently dropped.
    expect(await claim(t, "evt_4", 1_000_300)).toMatchObject({ status: "CLAIMED", attempts: 2 });

    const row = await t.run(async (ctx) =>
      (await ctx.db.query("stripeEvents").collect()).find((r) => r.stripeEventId === "evt_4"),
    );
    expect(row?.processed).toBe(false);
    expect(row?.status).toBe("PROCESSING");
    expect(row?.error).toBe("provider timeout");
  });

  it("recovers an event whose delivery died mid-flight", async () => {
    const t = newBackend();
    await claim(t, "evt_5", 1_000_000);
    // No completion and no failure: the lease goes stale, so a later retry may take over.
    expect(await claim(t, "evt_5", 1_000_000 + 6 * 60 * 1000)).toMatchObject({ status: "CLAIMED" });
  });

  it("stops retrying an event that keeps failing and asks for reconciliation", async () => {
    const t = newBackend();
    for (let i = 0; i < 8; i++) {
      await claim(t, "evt_6", 1_000_000 + i * 1_000_000);
      await t.mutation(internal.arise.billingFunctions.internalMarkEventFailed, {
        stripeEventId: "evt_6",
        error: `attempt ${i + 1}`,
        at: 1_000_000 + i * 1_000_000 + 1,
      });
    }
    expect(await claim(t, "evt_6", 1_000_000 + 9_000_000)).toMatchObject({ status: "ABANDONED" });
  });
});

describe("subscription changes — fail closed and idempotent", () => {
  it("entitles a known price and is idempotent under duplicate delivery", async () => {
    const t = newBackend();
    const userId = await seedSubscription(t);
    const args = {
      stripeCustomerId: CUSTOMER,
      stripeSubscriptionId: "sub_1",
      status: "active",
      priceId: PRO_PRICE,
      cancelAtPeriodEnd: false,
    };

    const first = await t.mutation(
      internal.arise.billingFunctions.internalApplySubscriptionChange,
      args,
    );
    expect(first).toMatchObject({ ok: true, planKey: "pro", reason: "ENTITLED" });

    // Replay: same event applied twice must not duplicate or degrade anything.
    const second = await t.mutation(
      internal.arise.billingFunctions.internalApplySubscriptionChange,
      args,
    );
    expect(second).toMatchObject({ ok: true, planKey: "pro" });
    expect(await appliedStatus(t, userId)).toEqual({ count: 1, planKey: "pro", status: "active" });
  });

  it("drops to free on an unmapped price and records a reconciliation event", async () => {
    const t = newBackend();
    const userId = await seedSubscription(t);

    const result = await t.mutation(
      internal.arise.billingFunctions.internalApplySubscriptionChange,
      {
        stripeCustomerId: CUSTOMER,
        stripeSubscriptionId: "sub_1",
        status: "active",
        priceId: "price_from_another_planet",
        cancelAtPeriodEnd: false,
      },
    );

    expect(result).toMatchObject({ ok: false, planKey: "free", reason: "PRICE_UNMAPPED", reconcile: true });
    // The previously stored paid plan must NOT silently survive.
    expect((await appliedStatus(t, userId)).planKey).toBe("free");

    const events = await t.run(async (ctx) => ctx.db.query("systemEvents").collect());
    expect(
      events.some((e) => e.code === "SUBSCRIPTION_PRICE_UNMAPPED" && e.area === "BILLING"),
    ).toBe(true);

    // …and the customer's entitlements really are gone.
    const ents = await t
      .withIdentity({ subject: userId })
      .query(api.arise.billingFunctions.myEntitlements, {});
    expect(ents.active).toBe(false);
    expect(ents.planKey).toBe("free");
  });

  it("fails closed on a missing price and on an unrecognised status", async () => {
    const t = newBackend();
    await seedSubscription(t);

    const missing = await t.mutation(
      internal.arise.billingFunctions.internalApplySubscriptionChange,
      {
        stripeCustomerId: CUSTOMER,
        stripeSubscriptionId: "sub_1",
        status: "active",
        priceId: undefined,
        cancelAtPeriodEnd: false,
      },
    );
    expect(missing).toMatchObject({ planKey: "free", reason: "PRICE_MISSING", reconcile: true });

    const weird = await t.mutation(
      internal.arise.billingFunctions.internalApplySubscriptionChange,
      {
        stripeCustomerId: CUSTOMER,
        stripeSubscriptionId: "sub_1",
        status: "some_new_provider_status",
        priceId: PRO_PRICE,
        cancelAtPeriodEnd: false,
      },
    );
    expect(weird).toMatchObject({ planKey: "free", reason: "STATUS_UNRECOGNISED", reconcile: true });
  });

  it("ends entitlement on cancellation but remembers the plan through a recoverable delay", async () => {
    const t = newBackend();
    const userId = await seedSubscription(t);

    const pastDue = await t.mutation(
      internal.arise.billingFunctions.internalApplySubscriptionChange,
      {
        stripeCustomerId: CUSTOMER,
        stripeSubscriptionId: "sub_1",
        status: "past_due",
        priceId: PRO_PRICE,
        cancelAtPeriodEnd: false,
      },
    );
    expect(pastDue).toMatchObject({ ok: false, planKey: "pro", reason: "STATUS_RECOVERABLE" });
    // Plan remembered for a later 'active', but no access during the delay.
    expect(await appliedStatus(t, userId)).toMatchObject({ planKey: "pro", status: "past_due" });
    const duringDelay = await t
      .withIdentity({ subject: userId })
      .query(api.arise.billingFunctions.myEntitlements, {});
    expect(duringDelay.active).toBe(false);

    // Recovery: the same subscription returning to active needs no new price lookup.
    const recovered = await t.mutation(
      internal.arise.billingFunctions.internalApplySubscriptionChange,
      {
        stripeCustomerId: CUSTOMER,
        stripeSubscriptionId: "sub_1",
        status: "active",
        priceId: PRO_PRICE,
        cancelAtPeriodEnd: false,
      },
    );
    expect(recovered).toMatchObject({ ok: true, planKey: "pro" });

    // Cancellation ends it.
    const canceled = await t.mutation(
      internal.arise.billingFunctions.internalApplySubscriptionChange,
      {
        stripeCustomerId: CUSTOMER,
        stripeSubscriptionId: "sub_1",
        status: "canceled",
        priceId: PRO_PRICE,
        cancelAtPeriodEnd: true,
      },
    );
    expect(canceled).toMatchObject({ ok: false, planKey: "free", reason: "STATUS_TERMINAL" });
    const after = await t
      .withIdentity({ subject: userId })
      .query(api.arise.billingFunctions.myEntitlements, {});
    expect(after.active).toBe(false);
  });

  it("maps an upgrade by price and refuses an unlinked customer", async () => {
    const t = newBackend();
    const userId = await seedSubscription(t, "pro");

    const upgraded = await t.mutation(
      internal.arise.billingFunctions.internalApplySubscriptionChange,
      {
        stripeCustomerId: CUSTOMER,
        stripeSubscriptionId: "sub_1",
        status: "active",
        priceId: "price_inst_test",
        cancelAtPeriodEnd: false,
      },
    );
    expect(upgraded).toMatchObject({ ok: true, planKey: "institutional" });
    expect((await appliedStatus(t, userId)).planKey).toBe("institutional");

    const unknownCustomer = await t.mutation(
      internal.arise.billingFunctions.internalApplySubscriptionChange,
      {
        stripeCustomerId: "cus_never_seen",
        stripeSubscriptionId: "sub_9",
        status: "active",
        priceId: PRO_PRICE,
        cancelAtPeriodEnd: false,
      },
    );
    expect(unknownCustomer).toMatchObject({ ok: false, planKey: "free", reason: "UNKNOWN_CUSTOMER" });
  });

  it("with no price map configured at all, a paid event grants nothing", async () => {
    const t = newBackend();
    await seedSubscription(t);
    delete process.env.STRIPE_PRICE_PRO;
    delete process.env.STRIPE_PRICE_INSTITUTIONAL;

    const result = await t.mutation(
      internal.arise.billingFunctions.internalApplySubscriptionChange,
      {
        stripeCustomerId: CUSTOMER,
        stripeSubscriptionId: "sub_1",
        status: "active",
        priceId: PRO_PRICE,
        cancelAtPeriodEnd: false,
      },
    );
    expect(result).toMatchObject({ ok: false, planKey: "free", reconcile: true });
  });
});
