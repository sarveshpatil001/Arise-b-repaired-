/**
 * Central authorization helpers.
 *
 * Why this exists: authorization used to be copy-pasted per module. Some endpoints
 * checked `role === "admin"` but silently ignored `disabled`, so a disabled
 * administrator could still broadcast, read platform stats, change roles and grant
 * plans. Every server-side check must go through these helpers so the policy has a
 * single definition:
 *
 *   - authentication comes from the verified identity (`getAuthUserId`), never from
 *     an argument supplied by the caller;
 *   - privileged operations require an ACTIVE administrator;
 *   - a disabled account is rejected on every restricted path.
 *
 * Error messages are deliberately generic: they never disclose account details or
 * whether a given user exists.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type AuthCtx = QueryCtx | MutationCtx;

export interface AuthorizedUser {
  userId: Id<"users">;
  user: Doc<"users">;
}

/** Authenticated caller with an existing user row. */
export async function requireAuthenticatedUser(ctx: AuthCtx): Promise<AuthorizedUser> {
  const raw = await getAuthUserId(ctx);
  if (raw === null) throw new Error("Not authenticated");
  const user = await ctx.db.get(raw as Id<"users">);
  if (!user) throw new Error("Not authenticated");
  return { userId: user._id, user };
}

/** Authenticated caller whose account is not disabled. */
export async function requireActiveUser(ctx: AuthCtx): Promise<AuthorizedUser> {
  const authorized = await requireAuthenticatedUser(ctx);
  if (authorized.user.disabled === true) {
    throw new Error("ACCOUNT_DISABLED: this account has been disabled");
  }
  return authorized;
}

/**
 * Read-path companion to `requireActiveUser`: anonymous callers get `null` (the
 * existing empty-read contract), but a signed-in account that is missing or
 * disabled is rejected before any tenant data is returned. A disabled session can
 * still authenticate; it must not keep reading accounts, positions or billing.
 */
export async function requireActiveUserIfSignedIn(ctx: AuthCtx): Promise<AuthorizedUser | null> {
  const raw = await getAuthUserId(ctx);
  if (raw === null) return null;
  const user = await ctx.db.get(raw as Id<"users">);
  if (!user) return null;
  if (user.disabled === true) {
    throw new Error("ACCOUNT_DISABLED: this account has been disabled");
  }
  return { userId: user._id, user };
}

/** Active administrator — the only authorization for administrative endpoints. */
export async function requireActiveAdmin(ctx: AuthCtx): Promise<AuthorizedUser> {
  const authorized = await requireActiveUser(ctx);
  if (authorized.user.role !== "admin") {
    throw new Error("Forbidden: admin only");
  }
  return authorized;
}
