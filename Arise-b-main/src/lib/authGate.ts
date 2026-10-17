/**
 * Auth route-gate decision logic (pure — no React, no network, no clock reads
 * of its own; it only uses the elapsed time it is handed).
 *
 * Why this exists: when the Convex backend is unreachable (missing or wrong
 * `VITE_CONVEX_URL`), `useQuery(api.users.currentUser)` and the auth handshake
 * never resolve, so a naive `isLoading` gate spins forever with no diagnostic.
 * This module turns the client's connection state plus the time spent loading
 * into an explicit view so the gate can fail with an explanation instead of an
 * endless spinner.
 */

export type AuthGateState = {
  /** Auth handshake or currentUser query still pending. */
  isLoading: boolean;
  /** Convex Auth reports a signed-in user. */
  isAuthenticated: boolean;
  /** The Convex client has ever opened a WebSocket to the "ready" state. */
  hasEverConnected: boolean;
  /** Failed connection attempts so far (Convex client connection state). */
  connectionRetries: number;
  /** Milliseconds spent in the loading state on the current attempt. */
  loadingElapsedMs: number;
};

export type AuthGateView =
  /** Keep showing the loading spinner. */
  | "loading"
  /** Backend cannot be reached — show the connection diagnostic. */
  | "backend-unreachable"
  /** Auth resolved, nobody signed in — redirect to /auth. */
  | "sign-in-required"
  /** Signed in — render the protected route. */
  | "render";

/** After this many failed connection attempts we stop waiting. */
export const BACKEND_UNREACHABLE_AFTER_RETRIES = 2;

/** Fallback deadline in case retries never accumulate (slow DNS, etc.). */
export const BACKEND_UNREACHABLE_AFTER_MS = 8_000;

export function authGateView(state: AuthGateState): AuthGateView {
  if (!state.isLoading) {
    return state.isAuthenticated ? "render" : "sign-in-required";
  }

  // Still loading. If the client has never connected to any backend at all,
  // the handshake will never resolve — surface that instead of spinning.
  if (
    !state.hasEverConnected &&
    (state.connectionRetries >= BACKEND_UNREACHABLE_AFTER_RETRIES ||
      state.loadingElapsedMs >= BACKEND_UNREACHABLE_AFTER_MS)
  ) {
    return "backend-unreachable";
  }

  return "loading";
}
