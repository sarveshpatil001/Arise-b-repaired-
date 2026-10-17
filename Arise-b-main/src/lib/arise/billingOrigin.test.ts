import { describe, expect, it } from "vitest";
import { DEFAULT_BILLING_ORIGIN, resolveBillingOrigin } from "./billingOrigin";

describe("resolveBillingOrigin", () => {
  it("prefers the documented SITE_URL over the legacy SERVER_URL", () => {
    expect(
      resolveBillingOrigin({ SITE_URL: "https://arise.example", SERVER_URL: "https://old.example" }),
    ).toBe("https://arise.example");
  });

  it("keeps supporting the legacy SERVER_URL", () => {
    expect(resolveBillingOrigin({ SERVER_URL: "https://legacy.example" })).toBe(
      "https://legacy.example",
    );
  });

  it("normalises trailing slashes and whitespace", () => {
    expect(resolveBillingOrigin({ SITE_URL: "  https://arise.example/  " })).toBe(
      "https://arise.example",
    );
  });

  it("falls back to localhost only when neither is configured", () => {
    expect(resolveBillingOrigin({})).toBe(DEFAULT_BILLING_ORIGIN);
    expect(resolveBillingOrigin({ SITE_URL: "   ", SERVER_URL: "" })).toBe(
      DEFAULT_BILLING_ORIGIN,
    );
  });
});
