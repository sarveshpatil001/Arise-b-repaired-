// Auth environment semantics (audited defect): CONVEX_SITE_URL must be the Convex
// HTTP Actions origin (the OIDC issuer), not the Vite frontend origin. A wrong value
// used to produce an opaque sign-in failure; it now fails with a clear message.
//
// The module reads process.env at import time, so each case re-imports it with a
// fresh module registry.

import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEY = "CONVEX_SITE_URL";
const ORIGINAL = process.env[ENV_KEY];
const ORIGINAL_SITE = process.env.SITE_URL;

async function loadConfig(value: string | undefined, siteUrl?: string | undefined) {
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  if (siteUrl === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = siteUrl;
  vi.resetModules();
  return await import("../../convex/auth.config");
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL;
  if (ORIGINAL_SITE === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = ORIGINAL_SITE;
  vi.resetModules();
});

describe("auth.config CONVEX_SITE_URL", () => {
  it("fails with an actionable message when it is missing", async () => {
    await expect(loadConfig(undefined)).rejects.toThrow(/CONVEX_SITE_URL is not set/);
    await expect(loadConfig("   ")).rejects.toThrow(/CONVEX_SITE_URL is not set/);
  });

  it("rejects a frontend-style or non-absolute value", async () => {
    await expect(loadConfig("localhost:3211")).rejects.toThrow(/absolute http\(s\) origin/);
    await expect(loadConfig("ftp://127.0.0.1:3211")).rejects.toThrow(/absolute http\(s\) origin/);
    await expect(loadConfig("http://127.0.0.1:3211/oauth")).rejects.toThrow(
      /origin with no path/,
    );
  });

  it("rejects credentials embedded in the site URL", async () => {
    await expect(loadConfig("https://user:pass@example.convex.site")).rejects.toThrow(
      /must not embed credentials/,
    );
  });

  it("rejects a value that equals the known frontend origin (SITE_URL)", async () => {
    await expect(loadConfig("http://localhost:5173", "http://localhost:5173")).rejects.toThrow(
      /not the frontend origin/,
    );
    // A different frontend origin is fine (local backend vs Vite).
    await expect(
      loadConfig("http://127.0.0.1:3211", "http://localhost:5173"),
    ).resolves.toBeDefined();
  });

  it("accepts the local HTTP Actions origin and normalises a trailing slash", async () => {
    const config = await loadConfig("http://127.0.0.1:3211");
    const providers = config.default.providers as Array<Record<string, unknown>>;
    expect(providers[0]).toMatchObject({ domain: "http://127.0.0.1:3211", applicationID: "convex" });

    const trailing = await loadConfig("https://example.convex.site/");
    const trailingProviders = trailing.default.providers as Array<Record<string, unknown>>;
    expect(trailingProviders[0]).toMatchObject({ domain: "https://example.convex.site" });
  });

  it("keeps the deployment's own provider first and the federated provider second", async () => {
    const config = await loadConfig("http://127.0.0.1:3211");
    const providers = config.default.providers as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(2);
    expect(providers[0].type).toBeUndefined();
    expect(providers[1]).toMatchObject({ type: "customJwt", applicationID: "vly-convex" });
  });
});
