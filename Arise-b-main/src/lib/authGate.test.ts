import { describe, expect, it } from "vitest";
import {
  BACKEND_UNREACHABLE_AFTER_MS,
  authGateView,
  type AuthGateState,
} from "./authGate";

const base: AuthGateState = {
  isLoading: true,
  isAuthenticated: false,
  hasEverConnected: false,
  connectionRetries: 0,
  loadingElapsedMs: 0,
};

describe("authGateView", () => {
  it("keeps the spinner while a healthy connection is still resolving", () => {
    expect(
      authGateView({
        ...base,
        hasEverConnected: true,
        loadingElapsedMs: BACKEND_UNREACHABLE_AFTER_MS * 10,
      }),
    ).toBe("loading");
  });

  it("keeps the spinner briefly before any connection attempt resolves", () => {
    expect(authGateView({ ...base, loadingElapsedMs: 1_000 })).toBe("loading");
    expect(
      authGateView({ ...base, connectionRetries: 1, loadingElapsedMs: 500 }),
    ).toBe("loading");
  });

  // Regression: with an unreachable backend (missing/wrong VITE_CONVEX_URL)
  // the pre-fix gate spun forever because isLoading never resolved. The gate
  // must surface "backend-unreachable" instead of an endless loader.
  it("reports backend-unreachable after repeated failed connection attempts", () => {
    expect(
      authGateView({ ...base, connectionRetries: 2, loadingElapsedMs: 1_000 }),
    ).toBe("backend-unreachable");
  });

  it("reports backend-unreachable once the loading deadline passes without ever connecting", () => {
    expect(
      authGateView({
        ...base,
        loadingElapsedMs: BACKEND_UNREACHABLE_AFTER_MS,
      }),
    ).toBe("backend-unreachable");
    expect(
      authGateView({
        ...base,
        connectionRetries: 50,
        loadingElapsedMs: BACKEND_UNREACHABLE_AFTER_MS * 5,
      }),
    ).toBe("backend-unreachable");
  });

  it("never demotes a previously connected session to backend-unreachable", () => {
    expect(
      authGateView({
        ...base,
        hasEverConnected: true,
        connectionRetries: 20,
        loadingElapsedMs: BACKEND_UNREACHABLE_AFTER_MS * 5,
      }),
    ).toBe("loading");
  });

  it("redirects to sign-in when auth resolves without a user", () => {
    expect(
      authGateView({
        ...base,
        isLoading: false,
        hasEverConnected: true,
      }),
    ).toBe("sign-in-required");
  });

  it("renders the protected route for an authenticated user", () => {
    expect(
      authGateView({
        ...base,
        isLoading: false,
        isAuthenticated: true,
        hasEverConnected: true,
      }),
    ).toBe("render");
  });
});
