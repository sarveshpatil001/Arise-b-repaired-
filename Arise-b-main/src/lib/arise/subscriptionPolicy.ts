// ARISE V1 — subscription policy (pure, deterministic, no Convex and no Stripe import).
//
// WHY this is separate from the Stripe webhook: the webhook is I/O and retries, but the
// question it has to answer — "which plan, if any, does this provider event entitle?" —
// is a policy decision that must be unit-testable and must fail closed when the provider
// sends something ARISE does not recognise.
//
// Hard rule: an unknown price, an unrecognised status, or a terminal status must NEVER
// silently keep a paid plan alive. The provider is the source of truth for entitlements,
// and "we could not map this event" is not evidence of payment.

/**
 * Minimal structural plan shape this policy needs. Declared here on purpose: this module
 * lives in the pure engine layer, which must not import the Convex billing module (that
 * one pulls in the Stripe SDK and HTTP handlers). Any `{ key, stripePriceId? }` works.
 */
export interface PlanLike {
  key: string;
  stripePriceId?: string;
}

/** Statuses that grant an entitlement. Kept in one place so the webhook and the
 *  entitlement resolver cannot drift apart. */
export const ENTITLED_STATUSES: readonly string[] = ["active", "trialing"];

/**
 * Statuses Stripe still considers recoverable (a failed payment being retried). ARISE
 * does NOT extend access during these states — the entitlement policy above is the only
 * place access is granted — but the mapped plan is remembered on the subscription row so
 * that a later `active` event restores the same plan without needing the price again.
 */
export const RECOVERABLE_STATUSES: readonly string[] = ["past_due", "incomplete", "paused"];

/** Terminal statuses: entitlement ends and the plan is reset to free. */
export const TERMINAL_STATUSES: readonly string[] = [
  "canceled",
  "cancelled",
  "unpaid",
  "incomplete_expired",
];

export function isEntitledStatus(status: string): boolean {
  return ENTITLED_STATUSES.includes(status.trim().toLowerCase());
}

export function isKnownStatus(status: string): boolean {
  const s = status.trim().toLowerCase();
  return (
    ENTITLED_STATUSES.includes(s) ||
    RECOVERABLE_STATUSES.includes(s) ||
    TERMINAL_STATUSES.includes(s)
  );
}

export interface PriceEntry {
  priceId: string;
  planKey: string;
}

/** Env var name for a plan's price, e.g. `pro` → `STRIPE_PRICE_PRO`. */
export function priceEnvVarName(planKey: string): string {
  return `STRIPE_PRICE_${planKey.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * Server-controlled price → plan map. Built from the deployment environment (the Keys
 * tab) with the in-code plan definitions as a fallback, so no price id is ever inferred
 * from the client or from the event payload itself.
 */
export function buildPriceMap(
  env: Record<string, string | undefined>,
  plans: readonly PlanLike[],
): PriceEntry[] {
  const entries: PriceEntry[] = [];
  for (const plan of plans) {
    if (plan.key === "free") continue;
    const fromEnv = env[priceEnvVarName(plan.key)]?.trim();
    const priceId = fromEnv && fromEnv.length > 0 ? fromEnv : plan.stripePriceId?.trim();
    if (priceId) entries.push({ priceId, planKey: plan.key });
  }
  return entries;
}

export function planKeyForPrice(priceId: string | null, entries: readonly PriceEntry[]): string | null {
  if (!priceId) return null;
  const found = entries.find((e) => e.priceId === priceId);
  return found ? found.planKey : null;
}

/** The configured price id for a plan, or null when the deployment has none. Checkout
 *  sessions are built from this server-side map instead of a hardcoded price. */
export function priceIdForPlan(planKey: string, entries: readonly PriceEntry[]): string | null {
  const found = entries.find((e) => e.planKey === planKey);
  return found ? found.priceId : null;
}

export interface SubscriptionDecision {
  /** What to store on the subscription row. */
  planKey: string;
  /** True only when this event entitles the account to paid features right now. */
  entitled: boolean;
  /** Reason code for the audit trail — stable strings, shown to operators. */
  reason: string;
  /** True when an operator must reconcile the provider state by hand. */
  reconcile: boolean;
}

/**
 * Decide what a subscription event means for entitlement. Fail closed:
 *   - a price ARISE cannot map ⇒ free, and an operator reconciliation event;
 *   - a status ARISE does not recognise ⇒ free, and an operator reconciliation event;
 *   - a terminal status ⇒ free (the paid plan is not retained);
 *   - a recoverable delay ⇒ the mapped plan is remembered but NOT entitled.
 */
export function resolveSubscriptionPlan(args: {
  priceId: string | null;
  status: string;
  entries: readonly PriceEntry[];
}): SubscriptionDecision {
  const status = (args.status ?? "").trim().toLowerCase();

  if (!isKnownStatus(status)) {
    return {
      planKey: "free",
      entitled: false,
      reason: "STATUS_UNRECOGNISED",
      reconcile: true,
    };
  }

  const mapped = planKeyForPrice(args.priceId, args.entries);

  if (mapped === null) {
    return {
      planKey: "free",
      entitled: false,
      reason: args.priceId ? "PRICE_UNMAPPED" : "PRICE_MISSING",
      reconcile: true,
    };
  }

  if (TERMINAL_STATUSES.includes(status)) {
    return { planKey: "free", entitled: false, reason: "STATUS_TERMINAL", reconcile: false };
  }

  if (RECOVERABLE_STATUSES.includes(status)) {
    return { planKey: mapped, entitled: false, reason: "STATUS_RECOVERABLE", reconcile: false };
  }

  return { planKey: mapped, entitled: true, reason: "ENTITLED", reconcile: false };
}
