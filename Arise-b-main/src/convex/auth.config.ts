import type { AuthConfig } from "convex/server";

// Freebuff-signed federated tokens (see freebuff web's
// src/lib/vly-convex-jwt.ts) let a signed-in freebuff.com user carry their
// identity into this project without going through local sign-in. customJwt
// is correct for this provider: freebuff's tokens and JWKS both carry a
// `kid` header, which the customJwt validation path requires.
// CONVEX_SITE_URL is the deployment's HTTP Actions origin (e.g.
// http://127.0.0.1:3211 locally, https://<deployment>.convex.site hosted).
// It is NOT the frontend origin: using the Vite origin here points OIDC
// discovery at a server that serves no discovery document, so sign-in can never
// confirm. Fail with a clear message instead of an opaque auth error.
function requireSiteOrigin(raw: string | undefined): string {
  const guidance =
    "Set it to the deployment's HTTP Actions origin " +
    "(local: http://127.0.0.1:3211, hosted: https://<deployment>.convex.site) — " +
    "not the frontend URL.";
  if (!raw || raw.trim() === "") {
    throw new Error(`CONVEX_SITE_URL is not set. ${guidance}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    // Never echo the raw value: a malformed URL can still contain credentials.
    throw new Error(`CONVEX_SITE_URL must be an absolute http(s) origin. ${guidance}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `CONVEX_SITE_URL must be an absolute http(s) origin (got "${parsed.protocol}"). ${guidance}`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(`CONVEX_SITE_URL must not embed credentials. ${guidance}`);
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`CONVEX_SITE_URL must be an origin with no path, query or hash. ${guidance}`);
  }
  // A trailing slash is normalised away; Convex Auth compares `domain` with the
  // token issuer, so the canonical origin is what must be configured.
  return parsed.origin;
}

const siteUrl = requireSiteOrigin(process.env.CONVEX_SITE_URL);

// The audited misconfiguration was a valid URL pointing at the wrong service:
// CONVEX_SITE_URL set to the frontend origin. When the frontend origin is known
// (SITE_URL), a collision is provably wrong — Convex Auth's OIDC discovery would
// be requested from the Vite server, which does not serve it.
const frontendUrl = process.env.SITE_URL?.trim();
if (frontendUrl) {
  try {
    if (new URL(frontendUrl).origin === siteUrl) {
      throw new Error(
        "CONVEX_SITE_URL must be the Convex HTTP Actions origin, not the frontend origin " +
          "(SITE_URL). Point it at http://127.0.0.1:3211 locally or " +
          "https://<deployment>.convex.site when hosted.",
      );
    }
  } catch (e) {
    // Re-throw only our own collision error; a malformed SITE_URL is not this
    // config's concern and must not be reported as an auth-issuer failure.
    if (e instanceof Error && e.message.startsWith("CONVEX_SITE_URL must be")) throw e;
  }
}

const freebuffIssuer =
  process.env.VLY_CONVEX_AUTH_ISSUER ?? "https://freebuff.com";

export default {
  providers: [
    // Standard Convex Auth provider for this project's own sign-in ("Get
    // Started" email/guest, see src/convex/auth.ts). The deployment
    // self-issues JWTs (iss = CONVEX_SITE_URL, no `kid` header) validated
    // via OIDC discovery at `${domain}/.well-known/openid-configuration`,
    // served by auth.addHttpRoutes() in convex/http.ts. Do NOT convert this
    // entry to `type: "customJwt"` — that path rejects tokens without a
    // `kid` header, so sign-in would silently never confirm and RequireAuth
    // would loop back to /auth forever.
    {
      domain: siteUrl,
      applicationID: "convex",
    },
    {
      type: "customJwt",
      issuer: freebuffIssuer,
      jwks: `${freebuffIssuer}/api/web/.well-known/jwks.json`,
      applicationID: "vly-convex",
      algorithm: "RS256",
    },
  ],
} satisfies AuthConfig;
