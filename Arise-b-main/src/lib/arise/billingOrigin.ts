/**
 * Frontend origin used for Stripe Checkout/Portal return URLs.
 *
 * `SITE_URL` is the documented name (README/ENVIRONMENT). `SERVER_URL` is the
 * legacy name kept for existing deployments. A bare origin is required because
 * the caller appends `/dashboard/billing...`; trailing slashes are normalised so
 * the redirect never becomes `//dashboard/...`.
 */
export interface BillingOriginEnv {
  SITE_URL?: string;
  SERVER_URL?: string;
}

export const DEFAULT_BILLING_ORIGIN = "http://localhost:5173";

export function resolveBillingOrigin(env: BillingOriginEnv): string {
  const site = env.SITE_URL?.trim();
  if (site) return site.replace(/\/+$/, "");
  const legacy = env.SERVER_URL?.trim();
  if (legacy) return legacy.replace(/\/+$/, "");
  return DEFAULT_BILLING_ORIGIN;
}
