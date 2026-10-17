// ARISE — Multi-AI Quantitative & Algorithmic Trading System. Stripe billing.
// Webhook is the source of truth for subscription state. Fail-closed:
// unverified events are rejected; entitlements only widen on verified events.

import Stripe from "stripe";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { buildPriceMap, priceIdForPlan } from "../../lib/arise/subscriptionPolicy";

/** The price → plan map is server-controlled: deployment env first, plan definitions
 *  in code as a fallback. No price id is ever accepted from a client or inferred from
 *  an incoming payload. */
function configuredPriceEntries() {
  return buildPriceMap(process.env, PLANS);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let stripeClient: Stripe | null = null;

export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!stripeClient) stripeClient = new Stripe(key);
  return stripeClient;
}

export interface PlanDef {
  key: string;
  name: string;
  priceMonthly: number;
  analysisLimitPerDay: number;
  symbolWatchlist: number;
  stripePriceId?: string;
  features: string[];
  sortOrder: number;
}

export const PLANS: PlanDef[] = [
  {
    key: "free",
    name: "Starter",
    priceMonthly: 0,
    analysisLimitPerDay: 5,
    symbolWatchlist: 1,
    features: [
      "5 market analyses per day",
      "1 watchlist symbol",
      "Full BUY / SELL / WAIT verdicts",
      "MIND debate and risk checks",
      "Paper trading execution",
    ],
    sortOrder: 0,
  },
  {
    key: "pro",
    name: "Pro Trader",
    priceMonthly: 4900,
    analysisLimitPerDay: -1,
    symbolWatchlist: 25,
    features: [
      "Unlimited market analyses",
      "25 watchlist symbols across crypto and FX",
      "All six AI agents with full evidence drill-down",
      "Complete decision audit trail",
      "Paper execution with fees and slippage modeling",
      "Priority data feeds",
    ],
    sortOrder: 1,
  },
  {
    key: "institutional",
    name: "Institutional",
    priceMonthly: 19900,
    analysisLimitPerDay: -1,
    symbolWatchlist: 100,
    features: [
      "Everything in Pro",
      "100 watchlist symbols",
      "Full decision detail exports for compliance",
      "Early access to new agents",
      "Priority support",
    ],
    sortOrder: 2,
  },
];

export const PLAN_MAP = new Map(PLANS.map((p) => [p.key, p]));

export function planFor(key: string) {
  return PLAN_MAP.get(key) ?? PLANS[0];
}

/** Creates a Stripe Checkout session for a plan. Returns null if Stripe is not configured. */
export async function createCheckoutSession(args: {
  userId: string;
  userEmail: string;
  planKey: string;
  origin: string;
  existingCustomerId: string | null;
}): Promise<{ url: string } | null> {
  const stripe = getStripe();
  if (!stripe) return null;
  const plan = PLAN_MAP.get(args.planKey);
  if (!plan || plan.key === "free") return null;
  // Prices come from the deployment environment (Keys tab) via the shared server-side
  // map, so a plan can be sold only when its price is actually configured here.
  const priceId = priceIdForPlan(plan.key, configuredPriceEntries());
  if (!priceId) return null;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: args.existingCustomerId ? undefined : args.userEmail,
    customer: args.existingCustomerId ?? undefined,
    client_reference_id: args.userId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${args.origin}/dashboard/billing?checkout=success`,
    cancel_url: `${args.origin}/dashboard/billing?checkout=cancelled`,
    metadata: { userId: args.userId, planKey: plan.key },
  });
  return session.url ? { url: session.url } : null;
}

/** Creates a billing portal session. Returns null if Stripe is not configured. */
export async function createPortalSession(args: {
  customerId: string;
  origin: string;
}): Promise<{ url: string } | null> {
  const stripe = getStripe();
  if (!stripe) return null;
  const session = await stripe.billingPortal.sessions.create({
    customer: args.customerId,
    return_url: `${args.origin}/dashboard/billing`,
  });
  return session.url ? { url: session.url } : null;
}

/** Verifies the Stripe signature header against the webhook secret. Throws on failure. */
export function verifyWebhook(payload: string, sig: string | null): Stripe.Event {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) {
    throw new Error("BILLING_NOT_CONFIGURED");
  }
  if (!sig) {
    throw new Error("MISSING_SIGNATURE");
  }
  return stripe.webhooks.constructEvent(payload, sig, secret);
}

// ---------------- HTTP routes ----------------

export const stripeWebhook = httpAction(async (ctx, request) => {
  const payload = await request.text();
  const sig = request.headers.get("stripe-signature");

  let event: Stripe.Event;
  try {
    event = verifyWebhook(payload, sig);
  } catch (e) {
    // Fail closed: reject unverifiable traffic.
    await ctx.runMutation(internal.arise.system.record, {
      level: "ERROR",
      area: "BILLING",
      code: "WEBHOOK_REJECTED",
      message: (e as Error).message,
      at: Date.now(),
    }).catch(() => undefined);
    return new Response(JSON.stringify({ error: { code: "WEBHOOK_REJECTED" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Idempotency and concurrency are handled by ONE atomic claim: a row merely existing is
  // not success, only a completed mark is. A failed event is retryable; a stale in-flight
  // claim can be recovered by the next delivery; a live claim makes the caller ask Stripe
  // to retry instead of applying the same change twice.
  const claim = await ctx.runMutation(internal.arise.billingFunctions.internalClaimEvent, {
    stripeEventId: event.id,
    type: event.type,
    receivedAt: Date.now(),
  });

  if (claim.status === "DUPLICATE") {
    return json({ received: true, duplicate: true }, 200);
  }
  if (claim.status === "IN_FLIGHT") {
    return json({ error: { code: "EVENT_IN_FLIGHT" } }, 409);
  }
  if (claim.status === "ABANDONED") {
    // Retrying cannot help; stop the storm and make the gap an operator's problem.
    await ctx.runMutation(internal.arise.system.record, {
      level: "ERROR",
      area: "BILLING",
      code: "EVENT_ABANDONED",
      message: `stripe event ${event.type} exceeded the retry limit; provider state must be reconciled by hand`,
      at: Date.now(),
    }).catch(() => undefined);
    return json({ received: true, abandoned: true }, 200);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = session.client_reference_id ?? session.metadata?.userId;
        const planKey = session.metadata?.planKey ?? null;
        const customerId =
          typeof session.customer === "string" ? session.customer : session.customer?.id;
        // Fail closed. This used to default to "pro", so a session without usable metadata
        // silently granted the paid tier; now an unmappable session grants nothing and is
        // surfaced for reconciliation.
        if (!userId || !customerId || !planKey || planKey === "free" || !PLAN_MAP.has(planKey)) {
          await ctx.runMutation(internal.arise.system.record, {
            level: "WARN",
            area: "BILLING",
            code: "CHECKOUT_UNMAPPED",
            message: `checkout session ${session.id}: plan ${planKey ?? "(none)"} is not a server-side plan; no entitlement granted`,
            at: Date.now(),
          }).catch(() => undefined);
          break;
        }
        await ctx.runMutation(internal.arise.billingFunctions.internalUpsertSubscription, {
          userId: userId as never,
          stripeCustomerId: customerId,
          stripeCheckoutSessionId: session.id,
          planKey,
          status: "active",
          currentPeriodEnd: undefined,
          cancelAtPeriodEnd: false,
        });
        await ctx.runMutation(internal.arise.billingFunctions.internalAttachCustomerToUser, {
          userId: userId as never,
          stripeCustomerId: customerId,
        });
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const customerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const item = sub.items.data[0];
        const priceId = item?.price?.id ?? null;
        await ctx.runMutation(internal.arise.billingFunctions.internalApplySubscriptionChange, {
          stripeCustomerId: customerId,
          stripeSubscriptionId: sub.id,
          status: sub.status,
          priceId: priceId ?? undefined,
          currentPeriodEnd: (sub as unknown as { current_period_end?: number }).current_period_end
            ? (sub as unknown as { current_period_end: number }).current_period_end * 1000
            : undefined,
          cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
        });
        break;
      }
      default:
        break; // unhandled event types are recorded then ignored
    }
    await ctx.runMutation(internal.arise.billingFunctions.internalMarkEventProcessed, {
      stripeEventId: event.id,
      at: Date.now(),
    });
    return json({ received: true }, 200);
  } catch (e) {
    // Left retryable on purpose (processed stays false) — a transient failure between
    // the claim and the business update must not lose the subscription change.
    await ctx.runMutation(internal.arise.billingFunctions.internalMarkEventFailed, {
      stripeEventId: event.id,
      error: (e as Error).message,
      at: Date.now(),
    }).catch(() => undefined);
    return json({ error: { code: "PROCESSING_FAILED" } }, 500);
  }
});
