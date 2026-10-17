// ARISE — Multi-AI Quantitative & Algorithmic Trading System. Billing + entitlements.
// Entitlement gating is server-side: the market action refuses work beyond the plan.

import { v } from "convex/values";
import { action, mutation, query, internalMutation, internalQuery } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { api, internal } from "../_generated/api";
import { requireActiveAdmin, requireActiveUser, requireActiveUserIfSignedIn } from "../lib/authz";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  PLANS,
  PLAN_MAP,
  planFor,
  createCheckoutSession,
  createPortalSession,
} from "./billing";
import {
  buildPriceMap,
  resolveSubscriptionPlan,
  ENTITLED_STATUSES,
  isEntitledStatus,
} from "../../lib/arise/subscriptionPolicy";
import { resolveBillingOrigin } from "../../lib/arise/billingOrigin";

// ---------------- plans ----------------

export const listPlans = query({
  args: {},
  handler: async () => PLANS,
});

/**
 * Seed/migrate the `plans` table from the server-side plan definitions.
 *
 * Internal-only: this writes platform pricing rows, so it is an operator action (CLI or
 * another Convex function), never something a browser can call. The customer-facing plan
 * list does not depend on this table — `listPlans` reads the in-code `PLANS` — so an
 * unseeded database never blocks a purchase. Repeated runs are idempotent: each plan is
 * upserted by key, so seeding twice cannot duplicate or fork a plan row.
 */
export const seedPlans = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const p of PLANS) {
      const existing = await ctx.db
        .query("plans")
        .withIndex("key", (q) => q.eq("key", p.key))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          name: p.name,
          priceMonthly: p.priceMonthly,
          analysisLimitPerDay: p.analysisLimitPerDay,
          symbolWatchlist: p.symbolWatchlist,
          features: p.features,
          sortOrder: p.sortOrder,
        });
      } else {
        await ctx.db.insert("plans", { ...p });
      }
    }
    return true;
  },
});

// ---------------- subscription state ----------------

export const mySubscription = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireActiveUserIfSignedIn(ctx);
    if (!viewer) return null;
    return await ctx.db
      .query("subscriptions")
      .withIndex("userId", (q) => q.eq("userId", viewer.userId))
      .first();
  },
});

export const internalGetSubscription = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) =>
    ctx.db
      .query("subscriptions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .first(),
});

export const internalUpsertSubscription = internalMutation({
  args: {
    userId: v.id("users"),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.optional(v.string()),
    stripeCheckoutSessionId: v.optional(v.string()),
    planKey: v.string(),
    status: v.string(),
    currentPeriodEnd: v.optional(v.number()),
    cancelAtPeriodEnd: v.boolean(),
  },
  handler: async (ctx, s) => {
    // Defence in depth: the caller (webhook) already validates, but no code path may
    // write a plan key that is not part of the server-controlled plan list.
    if (!PLAN_MAP.has(s.planKey)) throw new Error(`UNKNOWN_PLAN: ${s.planKey}`);
    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("userId", (q) => q.eq("userId", s.userId))
      .first();
    const patch = {
      stripeCustomerId: s.stripeCustomerId,
      stripeSubscriptionId: s.stripeSubscriptionId,
      stripeCheckoutSessionId: s.stripeCheckoutSessionId,
      planKey: s.planKey,
      status: s.status,
      currentPeriodEnd: s.currentPeriodEnd,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return ctx.db.insert("subscriptions", { userId: s.userId, ...patch });
  },
});

export const internalAttachCustomerToUser = internalMutation({
  args: { userId: v.id("users"), stripeCustomerId: v.string() },
  handler: async (ctx, { userId, stripeCustomerId }) => {
    await ctx.db.patch(userId, { stripeCustomerId });
    return true;
  },
});

/**
 * Apply a provider subscription event to the local subscription row.
 *
 * The plan is decided by `resolveSubscriptionPlan` (pure, unit-tested), never by the
 * payload alone: an unknown price maps to NO plan, a terminal status ends entitlement,
 * and a recoverable payment delay remembers the plan without granting access. The
 * previous behaviour — "unknown price keeps whatever plan was already stored" — is
 * exactly the fail-open case this replaces, so a price ARISE cannot recognise now drops
 * the row to free and raises an operator reconciliation event.
 */
export const internalApplySubscriptionChange = internalMutation({
  args: {
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    status: v.string(),
    priceId: v.optional(v.string()),
    currentPeriodEnd: v.optional(v.number()),
    cancelAtPeriodEnd: v.boolean(),
  },
  handler: async (ctx, c) => {
    const sub = await ctx.db
      .query("subscriptions")
      .withIndex("stripeCustomerId", (q) => q.eq("stripeCustomerId", c.stripeCustomerId))
      .first();
    if (!sub) {
      // Unknown customer: record and drop (fail closed — no entitlement granted).
      await ctx.runMutation(internal.arise.system.record, {
        level: "WARN",
        area: "BILLING",
        code: "UNKNOWN_CUSTOMER",
        message: `subscription event for unlinked customer ${c.stripeCustomerId}`,
        at: Date.now(),
      });
      return { ok: false, planKey: "free", reason: "UNKNOWN_CUSTOMER", reconcile: true };
    }

    const decision = resolveSubscriptionPlan({
      priceId: c.priceId ?? null,
      status: c.status,
      entries: buildPriceMap(process.env, PLANS),
    });

    await ctx.db.patch(sub._id, {
      planKey: decision.planKey,
      status: c.status,
      stripeSubscriptionId: c.stripeSubscriptionId,
      currentPeriodEnd: c.currentPeriodEnd,
      cancelAtPeriodEnd: c.cancelAtPeriodEnd,
      updatedAt: Date.now(),
    });

    if (decision.reconcile) {
      await ctx.runMutation(internal.arise.system.record, {
        level: "WARN",
        area: "BILLING",
        code: `SUBSCRIPTION_${decision.reason}`,
        message: `subscription ${c.stripeSubscriptionId}: price ${c.priceId ?? "(none)"} with status ${c.status} does not map to a plan; entitlement set to free pending reconciliation`,
        at: Date.now(),
      });
    }

    return {
      ok: decision.entitled,
      planKey: decision.planKey,
      reason: decision.reason,
      reconcile: decision.reconcile,
    };
  },
});

// ---------------- webhook event log (idempotency) ----------------

export const internalGetEvent = internalQuery({
  args: { stripeEventId: v.string() },
  handler: async (ctx, { stripeEventId }) =>
    ctx.db
      .query("stripeEvents")
      .withIndex("stripeEventId", (q) => q.eq("stripeEventId", stripeEventId))
      .first(),
});

/** How long a PROCESSING claim is honoured before another delivery may retake it. A
 *  worker that dies between claiming and finishing leaves a stale lease; Stripe retries
 *  deliveries for days, so the retry can recover the event instead of losing it. */
export const EVENT_CLAIM_STALE_MS = 5 * 60 * 1000;

/** Attempts per event before ARISE stops retrying and asks a human to reconcile. */
export const MAX_EVENT_ATTEMPTS = 8;

/** `patch` must not receive explicitly-undefined fields (that would clear a column by
 *  accident); the update is therefore built from defined keys only. */
function definedFields<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Atomically claim an event for processing. This is the idempotency gate and it runs in
 * ONE transaction, so two concurrent deliveries of the same event cannot both proceed:
 *
 *   CLAIMED    — this caller owns the event and must finish it (new event, a failed one
 *                being retried, or a stale mid-flight claim)
 *   DUPLICATE  — already PROCESSED; the business change must not be applied twice
 *   IN_FLIGHT  — another delivery is working on it right now (caller answers 409 so
 *                Stripe retries later rather than applying the change concurrently)
 *   ABANDONED  — too many failed attempts; retrying will not help, a human must
 *                reconcile the provider state
 */
export const internalClaimEvent = internalMutation({
  args: { stripeEventId: v.string(), type: v.string(), receivedAt: v.number() },
  handler: async (ctx, e) => {
    const row = await ctx.db
      .query("stripeEvents")
      .withIndex("stripeEventId", (q) => q.eq("stripeEventId", e.stripeEventId))
      .first();

    if (!row) {
      await ctx.db.insert("stripeEvents", {
        stripeEventId: e.stripeEventId,
        type: e.type,
        receivedAt: e.receivedAt,
        processed: false,
        status: "PROCESSING",
        attempts: 1,
        lastAttemptAt: e.receivedAt,
      });
      return { status: "CLAIMED" as const, attempts: 1 };
    }

    const attempts = row.attempts ?? 1;
    // A row's mere existence is not success; only a completed mark counts.
    if (row.processed || row.status === "PROCESSED") {
      return { status: "DUPLICATE" as const, attempts };
    }
    const lastAttemptAt = row.lastAttemptAt ?? row.receivedAt;
    if (row.status !== "FAILED" && e.receivedAt - lastAttemptAt < EVENT_CLAIM_STALE_MS) {
      return { status: "IN_FLIGHT" as const, attempts };
    }
    if (attempts >= MAX_EVENT_ATTEMPTS) {
      return { status: "ABANDONED" as const, attempts };
    }

    await ctx.db.patch(row._id, {
      status: "PROCESSING",
      attempts: attempts + 1,
      lastAttemptAt: e.receivedAt,
      type: e.type,
    });
    return { status: "CLAIMED" as const, attempts: attempts + 1 };
  },
});

/** Mark the event as successfully completed. Only this sets `processed`. */
export const internalMarkEventProcessed = internalMutation({
  args: { stripeEventId: v.string(), at: v.number() },
  handler: async (ctx, { stripeEventId, at }) => {
    const row = await ctx.db
      .query("stripeEvents")
      .withIndex("stripeEventId", (q) => q.eq("stripeEventId", stripeEventId))
      .first();
    if (!row) return false;
    await ctx.db.patch(
      row._id,
      definedFields({ processed: true, status: "PROCESSED", completedAt: at, error: undefined }),
    );
    return true;
  },
});

/** Mark a failed attempt. The row stays retryable (processed stays false). */
export const internalMarkEventFailed = internalMutation({
  args: { stripeEventId: v.string(), error: v.string(), at: v.number() },
  handler: async (ctx, { stripeEventId, error, at }) => {
    const row = await ctx.db
      .query("stripeEvents")
      .withIndex("stripeEventId", (q) => q.eq("stripeEventId", stripeEventId))
      .first();
    if (!row) return false;
    await ctx.db.patch(row._id, {
      processed: false,
      status: "FAILED",
      lastAttemptAt: at,
      // Provider error text is stored for operators; it never contains our secrets and
      // is truncated so a provider dump cannot bloat or leak through the event log.
      error: error.slice(0, 500),
    });
    return true;
  },
});

// ---------------- checkout / portal actions ----------------

export const startCheckout = action({
  args: { planKey: v.string() },
  handler: async (ctx, { planKey }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const user = await ctx.runQuery(api.users.currentUser, {});
    if (!user) throw new Error("No user");
    if (user.disabled === true) {
      throw new Error("ACCOUNT_DISABLED: this account has been disabled");
    }
    // Reject an unknown or free plan before any Stripe call, instead of reporting
    // "billing not configured" for a plan that can never be sold.
    if (!PLAN_MAP.has(planKey) || planKey === "free") {
      throw new Error(`UNKNOWN_PLAN: ${planKey}`);
    }
    const email = user.email ?? "customer@arise.systems";
    // Stripe must return the user to the real app, never a localhost fallback in
    // production. SITE_URL is the documented name; SERVER_URL is the legacy alias.
    const origin = resolveBillingOrigin(process.env);

    const existingSub = await ctx.runQuery(internal.arise.billingFunctions.internalGetSubscription, { userId });
    const customerId = existingSub?.stripeCustomerId ?? user.stripeCustomerId ?? null;

    const url = await createCheckoutSession({
      userId,
      userEmail: email,
      planKey,
      origin,
      existingCustomerId: customerId,
    });
    if (!url) {
      throw new Error(
        "BILLING_NOT_CONFIGURED: Stripe keys are not set. Add STRIPE_SECRET_KEY plus price IDs in the Keys tab.",
      );
    }
    return url;
  },
});

export const startPortal = action({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const sub = await ctx.runQuery(internal.arise.billingFunctions.internalGetSubscription, { userId });
    const user = await ctx.runQuery(api.users.currentUser, {});
    if (user?.disabled === true) {
      throw new Error("ACCOUNT_DISABLED: this account has been disabled");
    }
    const customerId = sub?.stripeCustomerId ?? user?.stripeCustomerId ?? null;
    if (!customerId) {
      throw new Error("No Stripe customer on file yet — subscribe to a plan first.");
    }
    const origin = resolveBillingOrigin(process.env);
    const url = await createPortalSession({ customerId, origin });
    if (!url) {
      throw new Error(
        "BILLING_NOT_CONFIGURED: Stripe keys are not set. Add STRIPE_SECRET_KEY in the Keys tab.",
      );
    }
    return url;
  },
});

// ---------------- entitlements ----------------

export interface Entitlements {
  planKey: string;
  planName: string;
  status: string;
  active: boolean;
  /** Where the plan came from, so a granted seat is never read as a paid subscription. */
  source: "subscription" | "grant" | "none";
  analysisLimitPerDay: number;
  symbolWatchlist: number;
  analysesToday: number;
  remainingToday: number;
}

// Sourced from the subscription policy so the webhook and the entitlement resolver can
// never disagree about which provider statuses grant access.
const ACTIVE_STATUSES = new Set(ENTITLED_STATUSES);

/** Hard cap on the platform-wide scans behind the admin aggregates. */
const ADMIN_SCAN_CAP = 5000;

/**
 * The single source of truth for what a signed-in account may do. Both the client
 * query and the internal query the market action uses call this, so the server-side
 * gate and the UI can never disagree about a plan.
 *
 * Resolution order is deliberate:
 *   1. an ACTIVE Stripe subscription — a seat the customer is paying for always wins,
 *      so a complimentary grant can never quietly override it;
 *   2. otherwise a live `planGrants` row matching the account's OWN email, read from
 *      the users table. The email is never taken from the caller, so a client cannot
 *      claim a seat meant for someone else, and a seat provisioned before sign-up
 *      applies from the account's first request;
 *   3. otherwise the free plan.
 */
async function resolveEntitlements(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users"> | null,
  now: number,
): Promise<Entitlements> {
  const free = planFor("free");
  if (userId === null) {
    return {
      planKey: free.key, planName: free.name, status: "none", active: false, source: "none",
      analysisLimitPerDay: free.analysisLimitPerDay, symbolWatchlist: free.symbolWatchlist,
      analysesToday: 0, remainingToday: free.analysisLimitPerDay,
    };
  }

  const sub = await ctx.db
    .query("subscriptions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .first();
  // An entitled subscription needs BOTH a status that grants access and a plan that is
  // actually a paid plan. Without the second check, a row left as `planKey: "free"` by an
  // unmapped price event would report `active: true` while granting free-tier limits —
  // billing status and real entitlement would disagree.
  const subActive = !!sub && isEntitledStatus(sub.status) && sub.planKey !== "free";

  let planKey = "free";
  let status = sub?.status ?? "none";
  let active = false;
  let source: Entitlements["source"] = "none";

  if (sub && subActive) {
    planKey = sub.planKey;
    status = sub.status;
    active = true;
    source = "subscription";
  } else {
    // Provider says the subscription is live but ARISE has no plan for it (an unmapped
    // price, for example). Report that honestly rather than showing ACTIVE with free
    // limits; the matching system event tells an operator to reconcile.
    if (sub && isEntitledStatus(sub.status)) status = "REVIEW_REQUIRED";
    const user = await ctx.db.get(userId);
    const email = user?.email?.trim().toLowerCase();
    if (email) {
      const grants = await ctx.db
        .query("planGrants")
        .withIndex("email", (q) => q.eq("email", email))
        .collect();
      // Newest live grant wins; a revoked row or an unrecognised plan key is ignored.
      const grant = grants
        .filter((g) => g.revokedAt === undefined && PLAN_MAP.has(g.planKey))
        .sort((a, b) => b.grantedAt - a.grantedAt)[0];
      if (grant) {
        planKey = grant.planKey;
        status = "active";
        active = true;
        source = "grant";
      }
    }
  }

  const plan = planFor(active ? planKey : "free");
  const dayKey = new Date(now).toISOString().slice(0, 10);
  const usage = await ctx.db
    .query("analysisUsage")
    .withIndex("userId_day", (q) => q.eq("userId", userId).eq("dayKey", dayKey))
    .first();
  const analysesToday = usage?.count ?? 0;
  const remaining =
    plan.analysisLimitPerDay === -1 ? -1 : Math.max(0, plan.analysisLimitPerDay - analysesToday);
  return {
    planKey: plan.key,
    planName: plan.name,
    status,
    active,
    source,
    analysisLimitPerDay: plan.analysisLimitPerDay,
    symbolWatchlist: plan.symbolWatchlist,
    analysesToday,
    remainingToday: remaining,
  };
}

export const myEntitlements = query({
  args: {},
  handler: async (ctx): Promise<Entitlements> => {
    const viewer = await requireActiveUserIfSignedIn(ctx);
    return await resolveEntitlements(ctx, viewer?.userId ?? null, Date.now());
  },
});

// -------- internal wrappers used by the market action --------

export const myEntitlementsInternal = internalQuery({
  args: {},
  handler: async (ctx): Promise<Entitlements> => {
    return await resolveEntitlements(ctx, await getAuthUserId(ctx), Date.now());
  },
});

// ---------------- complimentary seats (provisioned out of band) ----------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Grant a plan to an email address without Stripe. Internal-only: it is callable
 * from other Convex functions and from the deployment CLI, never from a browser.
 *
 * The email is normalised to lowercase, the plan key must exist in PLANS, and an
 * existing account is linked immediately — otherwise the grant sits waiting and
 * applies when that address first signs in. Every grant and revocation is written to
 * the append-only system event log.
 */
export const grantPlanByEmail = internalMutation({
  args: {
    email: v.string(),
    planKey: v.string(),
    note: v.optional(v.string()),
    grantedBy: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const email = a.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new Error(`INVALID_EMAIL: ${a.email}`);
    if (!PLAN_MAP.has(a.planKey)) throw new Error(`UNKNOWN_PLAN: ${a.planKey}`);
    const now = Date.now();

    const existing = await ctx.db
      .query("planGrants")
      .withIndex("email", (q) => q.eq("email", email))
      .collect();
    const live = existing.find((g) => g.revokedAt === undefined && g.planKey === a.planKey);
    const match = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();

    if (live) {
      await ctx.db.patch(live._id, {
        note: a.note ?? live.note,
        grantedBy: a.grantedBy ?? live.grantedBy,
        appliedUserId: match?._id ?? live.appliedUserId,
      });
    } else {
      await ctx.db.insert("planGrants", {
        email,
        planKey: a.planKey,
        note: a.note,
        grantedBy: a.grantedBy,
        grantedAt: now,
        appliedUserId: match?._id,
      });
    }

    await ctx.db.insert("systemEvents", {
      level: "INFO",
      area: "BILLING",
      code: "PLAN_GRANTED",
      message: `${a.planKey} seat granted to ${email}${
        match ? "" : " (no account yet — applies at first sign-in)"
      }`.slice(0, 400),
      at: now,
    });

    return { email, planKey: a.planKey, matchedUserId: match?._id ?? null };
  },
});

/** Revoke every live seat for an address (optionally just one plan). */
export const revokePlanGrant = internalMutation({
  args: { email: v.string(), planKey: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const email = a.email.trim().toLowerCase();
    const rows = await ctx.db
      .query("planGrants")
      .withIndex("email", (q) => q.eq("email", email))
      .collect();
    const now = Date.now();
    let revoked = 0;
    for (const g of rows) {
      if (g.revokedAt !== undefined) continue;
      if (a.planKey && g.planKey !== a.planKey) continue;
      await ctx.db.patch(g._id, { revokedAt: now });
      revoked += 1;
    }
    if (revoked > 0) {
      await ctx.db.insert("systemEvents", {
        level: "WARN",
        area: "BILLING",
        code: "PLAN_GRANT_REVOKED",
        message: `${revoked} seat(s) revoked for ${email}`,
        at: now,
      });
    }
    return { email, revoked };
  },
});

/** Operational read of every grant, live and revoked. */
export const planGrantsInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("planGrants").collect();
    return rows.sort((a, b) => b.grantedAt - a.grantedAt);
  },
});

/**
 * Atomic analysis-quota reservation. This is the ONLY gate that may authorize a
 * billable analysis: the check and the increment happen in one serialized mutation,
 * so two concurrent requests cannot both consume the last remaining analysis. The
 * previous read-then-increment-later flow let every concurrent request observe the
 * same remaining count and exceed the daily plan limit.
 */
export const reserveAnalysisInternal = internalMutation({
  args: {},
  handler: async (ctx): Promise<Entitlements> => {
    const { userId } = await requireActiveUser(ctx);
    const now = Date.now();
    const ents = await resolveEntitlements(ctx, userId, now);
    if (ents.remainingToday === 0) {
      throw new Error(
        `PLAN_LIMIT_REACHED: The ${ents.planName} plan allows ${ents.analysisLimitPerDay} analyses per day. Upgrade to continue.`,
      );
    }
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const row = await ctx.db
      .query("analysisUsage")
      .withIndex("userId_day", (q) => q.eq("userId", userId).eq("dayKey", dayKey))
      .first();
    const analysesToday = (row?.count ?? 0) + 1;
    if (row) {
      await ctx.db.patch(row._id, { count: analysesToday });
    } else {
      await ctx.db.insert("analysisUsage", { userId, dayKey, count: 1 });
    }
    return {
      ...ents,
      analysesToday,
      remainingToday:
        ents.analysisLimitPerDay === -1
          ? -1
          : Math.max(0, ents.analysisLimitPerDay - analysesToday),
    };
  },
});

export const incrementUsageInternal = internalMutation({
  args: { userId: v.id("users"), dayKey: v.string() },
  handler: async (ctx, { userId, dayKey }) => {
    const row = await ctx.db
      .query("analysisUsage")
      .withIndex("userId_day", (q) => q.eq("userId", userId).eq("dayKey", dayKey))
      .first();
    if (row) {
      await ctx.db.patch(row._id, { count: row.count + 1 });
      return row.count + 1;
    }
    await ctx.db.insert("analysisUsage", { userId, dayKey, count: 1 });
    return 1;
  },
});

// ---------------- admin ----------------

/**
 * First-admin bootstrap. The trust anchor is the deployment-held `ARISE_ADMIN_CODE`
 * (server-side env, never a client-supplied claim or a predictable id). The whole flow is
 * ONE transaction — check the code, check for an existing admin, grant the role, and
 * write the one-time closure marker — so:
 *   - two concurrent claims cannot both succeed (the second conflicts and retries into
 *     the closed/„exists" branch), and
 *   - bootstrap can never be re-opened afterwards, even if every admin account is later
 *     deleted and the setup code is replayed.
 */
export const bootstrapAdmin = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    // Bootstrap is a privilege grant, so a disabled account must not be able to
    // claim it (the account would be an admin with no active session).
    const { userId } = await requireActiveUser(ctx);
    const expected = process.env.ARISE_ADMIN_CODE;
    if (!expected) throw new Error("ARISE_ADMIN_CODE is not set in the Keys tab");
    if (code !== expected) throw new Error("Invalid setup code");

    const state = await ctx.db
      .query("bootstrapState")
      .withIndex("key", (q) => q.eq("key", "admin"))
      .first();
    if (state) throw new Error("Administrator bootstrap is already closed");

    const existingAdmins = await ctx.db
      .query("users")
      .withIndex("role", (q) => q.eq("role", "admin"))
      .take(2);
    if (existingAdmins.length > 0) throw new Error("An administrator already exists");

    await ctx.db.patch(userId, { role: "admin" as const });
    await ctx.db.insert("bootstrapState", {
      key: "admin" as const,
      completedAt: Date.now(),
      completedBy: userId,
    });
    return true;
  },
});

export const broadcast = mutation({
  args: { message: v.string() },
  handler: async (ctx, { message }) => {
    await requireActiveAdmin(ctx);
    await ctx.db.insert("systemEvents", {
      level: "INFO",
      area: "SYSTEM",
      code: "BROADCAST",
      message: message.slice(0, 300),
      at: Date.now(),
    });
    return true;
  },
});

export const adminStats = query({
  args: {},
  handler: async (ctx) => {
    await requireActiveAdmin(ctx);

    // Bounded scans. These are platform-wide aggregates and `decisions` is by far the
    // largest table, so each read is capped and the response carries `truncated` rather
    // than quietly under-reporting when the cap is reached.
    const subs = await ctx.db.query("subscriptions").take(ADMIN_SCAN_CAP);
    const users = await ctx.db.query("users").take(ADMIN_SCAN_CAP);
    // Newest first: a 24h count taken from the oldest page of the table would be wrong.
    const decisions = await ctx.db.query("decisions").order("desc").take(ADMIN_SCAN_CAP);
    const truncated =
      subs.length >= ADMIN_SCAN_CAP ||
      users.length >= ADMIN_SCAN_CAP ||
      decisions.length >= ADMIN_SCAN_CAP;

    const mrrCents = subs
      .filter((s) => ACTIVE_STATUSES.has(s.status))
      .reduce((acc, s) => acc + (PLAN_MAP.get(s.planKey)?.priceMonthly ?? 0), 0);
    const byPlan: Record<string, number> = {};
    for (const s of subs) {
      if (ACTIVE_STATUSES.has(s.status)) byPlan[s.planKey] = (byPlan[s.planKey] ?? 0) + 1;
    }
    const last24h = Date.now() - 24 * 3600 * 1000;
    return {
      totalUsers: users.length,
      paidUsers: Object.values(byPlan).reduce((a, b) => a + b, 0),
      mrrCents,
      byPlan,
      decisions24h: decisions.filter((d) => d.dataTimestamp > last24h).length,
      /** True when any of the capped scans above was clipped — the numbers are a floor,
       *  not a total, and the console says so. */
      truncated,
      recentSubs: subs
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 10)
        .map((s) => ({
          planKey: s.planKey,
          status: s.status,
          updatedAt: s.updatedAt,
          userId: s.userId,
        })),
    };
  },
});

export const adminUsers = query({
  args: {},
  handler: async (ctx) => {
    await requireActiveAdmin(ctx);
    // Bounded, newest-first reads (the response is capped at 200 rows anyway).
    const users = await ctx.db.query("users").order("desc").take(ADMIN_SCAN_CAP);
    const subs = await ctx.db.query("subscriptions").take(ADMIN_SCAN_CAP);
    const subByUser = new Map(subs.map((s) => [s.userId, s]));
    return users.slice(0, 200).map((u) => {
      const s = subByUser.get(u._id);
      return {
        _id: u._id,
        email: u.email ?? u.name ?? "(no email)",
        role: u.role ?? "user",
        planKey: s && ACTIVE_STATUSES.has(s.status) ? s.planKey : "free",
        subStatus: s?.status ?? "none",
        joined: u._creationTime,
      };
    });
  },
});

/**
 * Legacy user-management endpoints (the admin console uses `arise/admin.ts`).
 * They remain for compatibility, so they must apply the SAME policy: an active
 * administrator, an existing target, and an append-only audit record. Previously
 * they changed roles and plans with no audit entry, which made a privileged change
 * invisible to incident review.
 */
export const setUserRole = mutation({
  args: { targetUserId: v.id("users"), role: v.union(v.literal("user"), v.literal("member"), v.literal("admin")) },
  handler: async (ctx, { targetUserId, role }) => {
    const { userId, user: actor } = await requireActiveAdmin(ctx);
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new Error("User not found");
    // Never remove the last active administrator (bootstrap cannot re-open).
    if (target.role === "admin" && role !== "admin" && target.disabled !== true) {
      const admins = await ctx.db
        .query("users")
        .withIndex("role", (q) => q.eq("role", "admin"))
        .collect();
      if (admins.filter((u) => u.disabled !== true).length <= 1) {
        throw new Error("LAST_ADMIN: the last active administrator cannot be demoted");
      }
    }
    await ctx.db.patch(targetUserId, { role });
    await ctx.db.insert("adminAudit", {
      at: Date.now(),
      actorId: userId,
      actorEmail: actor.email ?? undefined,
      action: `Role changed for ${target.email ?? targetUserId}`,
      component: "USER MANAGEMENT",
      prevState: target.role ?? "user",
      newState: role,
      result: "SUCCESS",
    });
    return true;
  },
});

export const grantPlan = mutation({
  args: { targetUserId: v.id("users"), planKey: v.string() },
  handler: async (ctx, { targetUserId, planKey }) => {
    const { userId, user: actor } = await requireActiveAdmin(ctx);
    if (!PLAN_MAP.has(planKey)) throw new Error("Unknown plan");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new Error("User not found");
    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("userId", (q) => q.eq("userId", targetUserId))
      .first();
    const patch = {
      planKey,
      status: "active",
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("subscriptions", {
        userId: targetUserId,
        stripeCustomerId: `manual:${targetUserId}`,
        cancelAtPeriodEnd: false,
        ...patch,
      });
    }
    await ctx.db.insert("adminAudit", {
      at: Date.now(),
      actorId: userId,
      actorEmail: actor.email ?? undefined,
      action: `Plan ${planKey} granted to ${target.email ?? targetUserId}`,
      component: "USER MANAGEMENT",
      prevState: existing?.planKey ?? "free",
      newState: planKey,
      result: "SUCCESS",
    });
    return true;
  },
});
