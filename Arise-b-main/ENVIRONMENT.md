# Environment configuration

This document is derived from the source, not from a deployment template. `.env.example`
contains local-development placeholders only; it contains no credentials.

## Required

| Variable | Meaning | Local example | Production |
| --- | --- | --- | --- |
| `VITE_CONVEX_URL` | Convex **client** URL used by the browser SDK | `http://127.0.0.1:3210` | `https://<deployment>.convex.cloud` |
| `CONVEX_SITE_URL` | Convex **HTTP Actions / site** origin (the auth issuer domain) | `http://127.0.0.1:3211` | `https://<deployment>.convex.site` |
| `SITE_URL` | Frontend origin used for links/redirects (Stripe Checkout/Portal returns) | `http://localhost:5173` | `https://app.example.com` |

`CONVEX_SITE_URL` is **not** the Vite frontend origin. `src/convex/auth.config.ts` rejects a
missing, non-absolute, non-http(s), credential-bearing, path-bearing, or frontend-colliding
value with an actionable error before authentication can start. `SITE_URL` is separate and
may be the frontend origin.

`CONVEX_DEPLOYMENT` is selected by `bunx convex dev` (use `local` for the in-sandbox
backend). It is deployment tooling configuration, not a runtime secret.

## Optional integrations

Leave these unset to keep the feature disabled. Missing credentials must produce an explicit
"not configured"/disabled state, never a successful-looking no-op.

| Variable | Feature | Behaviour when unset |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Checkout, customer portal, webhook signature verification | Checkout returns `BILLING_NOT_CONFIGURED`; webhook rejects |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature verification | Webhook rejects |
| `STRIPE_PRICE_PRO` | Pro Trader price ID | Pro plan is not purchasable |
| `STRIPE_PRICE_INSTITUTIONAL` | Institutional price ID | Institutional plan is not purchasable |
| `ARISE_ADMIN_CODE` | One-time first-admin bootstrap code | Admin bootstrap is refused |
| `DELTA_API_KEY` / `DELTA_API_SECRET` | Delta **demo** account/order mirror | Delta calls fail closed; paper trading continues |
| `DELTA_TRADING_MODE` | Must be exactly `demo` for any authenticated Delta call | All authenticated Delta calls are refused |
| `DELTA_BASE_URL` | Optional Delta market-data base URL; authenticated calls are separately host-locked | Demo testnet default |
| `ECONOMIC_CALENDAR_URL` | HTTPS JSON feed of upcoming economic events for Analysis → News AI | News AI shows `UNCONFIGURED` and zero events; nothing is invented |
| `ECONOMIC_CALENDAR_API_KEY` | Optional key sent as `x-api-key` to the calendar provider | No key is sent; provider may reject the request, reported as `INVALID` |
| `EMAIL_OTP_API_KEY` | freebuff OTP mailer for email sign-in | Falls back to `VLY_INTEGRATION_KEY`; with neither set, sign-in fails with a configuration error |
| `VLY_INTEGRATION_KEY` / `VLY_APP_NAME` | Optional freebuff email-integration fallback and app name | Not sent; no verification email can be delivered without either mail transport |

`ECONOMIC_CALENDAR_URL` must return JSON — either an array of events or `{ "events": [...] }`.
Each event needs `title`, `scheduledAt` (epoch ms or ISO date), `timeZone`, `source`,
`sourceUrl` (http/https) and `lastUpdatedAt`; optional fields are `affectedAssets`,
`importance`, `certainty` (`CONFIRMED`/`FORECAST`/`SPECULATION`), `consensus`, `scenarios` and
`risks`. Past events, unparseable dates, missing sources/URLs and updates older than seven days
are rejected; unvalidated items never reach the UI. The URL is read server-side only and is
never rendered or logged with its query string.

`DELTA_BASE_URL` is **not** a live-trading switch. Authenticated Delta calls resolve through
`resolveDeltaOrderBaseUrl`, which only permits the verified demo host over HTTPS, with no
path/query/fragment, no embedded credentials and no redirects. `DELTA_TRADING_MODE` must also
be exactly `demo`. `LIVE_TRADING_ENABLED` is a hardcoded `false` in `src/lib/arise/execution.ts`
and is not configurable.

## Local vs preview vs production

- **Local:** the values above point at Convex's local backend (`127.0.0.1:3210` / `3211`) and
  Vite on `localhost:5173`.
- **Preview:** supply the preview frontend origin in `SITE_URL`; `CONVEX_SITE_URL` still points
  at the Convex deployment's `.convex.site` origin, not at the preview host.
- **Production:** use the deployed Convex client and site origins and the public frontend
  origin. Do not copy the local `127.0.0.1` examples into production.

Secrets belong in the deployment's environment/Keys UI, never in git. `.env.example` is a
placeholder template and `.gitignore` excludes `.env`-family files.

## Verification

```bash
bunx tsc -b --noEmit
bun run test -- src/lib/arise/authConfig.test.ts
```

A green CI build proves the committed source typechecks/tests; it does **not** prove that a
deployment's environment is configured or that the app is production-ready.
