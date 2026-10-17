# Environment configuration (reviewable workaround)

## Why this file exists

The audited defect is that `.env.example` contains

```
CONVEX_SITE_URL=http://localhost:5173
```

`CONVEX_SITE_URL` is the **Convex HTTP Actions / site origin**, which Convex Auth uses
as the OIDC issuer domain for the deployment's own tokens. `http://localhost:5173` is
the **Vite frontend** origin, which serves no OIDC discovery document, so sign-in can
never confirm.

The application fix is in `src/convex/auth.config.ts`: it now rejects a missing,
non-absolute, non-http(s), or path-bearing value with an actionable message, and
normalises a trailing slash. This is covered by `src/lib/arise/authConfig.test.ts`.

## Host limitation

This sandbox blocks reads and writes of `.env`-family files, including
`.env.example`, so the example file itself could not be edited in this pass. The
block is a host safety control, not a repository permission issue. No secret was read
or added.

## Safe workaround

Apply this block to `.env.example` in a normal editor (it contains no secrets), or
keep this file as the source of truth and copy it:

```
# Convex client URL (public configuration, not a secret)
VITE_CONVEX_URL=http://127.0.0.1:3210

# Convex HTTP Actions / site origin — the auth issuer. NOT the frontend URL.
# Local: http://127.0.0.1:3211
# Hosted: https://<deployment>.convex.site
CONVEX_SITE_URL=http://127.0.0.1:3211

# Frontend origin, used only for links/redirects (Stripe return URLs, emails)
SITE_URL=http://localhost:5173

# Selected by `bunx convex dev` for the local backend
CONVEX_DEPLOYMENT=local
```

Optional integrations (`STRIPE_*`, `ARISE_ADMIN_CODE`, `DELTA_*`,
`EMAIL_OTP_API_KEY`) are documented in `README.md`. Leave them unset to keep those
features disabled. Values belong in Settings → Environment, never in git.

## Verification

```bash
bun run test -- src/lib/arise/authConfig.test.ts
```

The tests assert: missing/blank values fail, a frontend-style or non-absolute value
fails, `ftp:` fails, a path-bearing origin fails, and valid local/hosted origins are
accepted with the trailing slash normalised.
