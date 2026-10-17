# ARISE Bot Master — Security Model

Durable description of what is trusted, who may call what, and where each control lives.
It is written against the deployment's own function inventory
(`bunx convex function-spec`: 94 entries — 55 client-callable functions, 36 internal
functions, 3 HTTP routes: `/.well-known/jwks.json`, `/.well-known/openid-configuration`,
and `POST /stripe/webhook`).

Companion documents: `SECURITY.md` (paper-only invariants and secret inventory),
`ARISE_MASTER_AUDIT.md` (findings and gates), `ARISE_REPAIR_REPORT.md` (changes).

## 1. Trust boundaries

| # | Zone | Trust | Controls on the crossing |
| --- | --- | --- | --- |
| B1 | Browser / any HTTP client | **Untrusted.** Everything it sends is input, including ids, prices, timestamps and plan keys | Per-function auth check on the server; object ownership checks; validation and clamping of every numeric/string argument; no client-supplied value is used as an authoritative price or entitlement |
| B2 | Stripe webhook (`POST /stripe/webhook`) | **Untrusted until signature-verified.** No other authentication exists on an HTTP route | `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)` runs before any business logic; failure ⇒ 400 + `WEBHOOK_REJECTED`, and the deployment is treated as unconfigured when the secret is absent (`BILLING_NOT_CONFIGURED`) |
| B3 | Market-data providers (Binance, Yahoo, Delta demo) and publisher RSS | **Untrusted data.** A response is not evidence until validated | `validateBars` / `assessFreshness` in `src/lib/arise/validate.ts`, the single freshness contract in `src/lib/arise/freshness.ts`, `sanitizeUntrusted` for text, circuit breaker + timeout in `providers.ts` |
| B4 | Convex backend functions | Split: **public** (client-callable, must self-authenticate) vs **internal** (never reachable from a browser) | Declared by `query`/`mutation`/`action` vs `internalQuery`/`internalMutation`/`internalAction`; verified against the deployment spec, not against the generated `api` object |
| B5 | Deployment environment (Convex env / Keys tab) | **Trusted secret store** — the only one | Secrets are read with `process.env` inside backend code only; never logged, never bundled to the client, never returned in a response |
| B6 | `adminAudit` table | Trusted append-only record; no caller may edit or delete it | Written by `src/convex/arise/admin.ts` `audit()`; read only through admin-gated queries |

Live trading is outside the trust model entirely: `LIVE_TRADING_ENABLED = false`
(`src/lib/arise/execution.ts`) and `src/lib/arise/delta.ts` refuses any non-testnet host, so
no path in this system reaches a real venue.

## 2. Authentication and authorization rules

- **Identity.** Convex Auth (`@convex-dev/auth`) provides the session; server code resolves
  the caller with `getAuthUserId(ctx)`. A client-supplied user id is never a credential.
- **Default posture.** A function that needs identity throws `Not authenticated` (actions,
  mutations) or returns `null`/`[]` (read models). Silent-success shapes are used only where
  an empty result cannot be mistaken for data.
- **Object-level authorization.** Bot, backtest-run, position, decision, equity and
  subscription reads filter by the authenticated user id. A foreign id yields `null` /
  `[]` / `Not found` — never another user's record and never an existence oracle
  (`src/convex/arise/backtest.ts`, `decisions.ts`, `trading.ts`, `equity.ts`,
  `billingFunctions.ts`).
- **Role checks.** Admin surfaces (`src/convex/arise/admin.ts`, and `adminStats`,
  `adminUsers`, `setUserRole`, `grantPlan`, `broadcast` in `billingFunctions.ts`) re-read
  the caller's `users.role` server-side on every call and throw `Forbidden: admin only`
  otherwise. Role is never taken from the request.
- **Ownership of the money path.** `closePosition` requires the position to belong to the
  caller, and the exit price must satisfy `validateClosePrice` (fresh completed 5m bar with
  its timestamp; future-dated, stale or timestamp-less prices rejected). Duplicate fills are
  prevented by the durable `positions.idemKey` guard and by `settleClose`'s in-transaction
  `status !== "OPEN"` re-read inside a serialized Convex mutation.
- **Entitlement gating.** The decision action resolves entitlements server-side
  (`resolveEntitlements`, shared by the client query and the internal query) and meters
  usage per UTC day; a client cannot raise its own plan.

## 3. Public surface (client-callable) — 55 functions

Public means "a signed-in browser may call it", not "unauthenticated". Each of these
performs its own check; the ones marked *(auth)* refuse unauthenticated callers outright,
the rest return an empty/`null` shape.

| Module | Public functions | Note |
| --- | --- | --- |
| `arise/market` | `decide` *(auth)* | The only path that can open a paper position; runs providers → validation → agents → MIND → risk veto → evidence gate → execution |
| `arise/trading` | `myAccount`, `openPositions`, `closedPositions`, `latestMarks` | Per-user reads; `closedPositions` is newest-first and capped at 500 (default 100); `latestMarks` scans at most the 120 most recent decisions |
| `arise/trading` | `createAccount`, `resetAccount`, `setEmergencyStop` *(auth)* | Account state only; `resetAccount` refuses while positions are open |
| `arise/trading` | `closePosition` *(auth)* | Ownership + validated exit price (see §2) |
| `arise/decisions` | `list`, `latest`, `byId` | User-scoped read models |
| `arise/equity` | `list` | User-scoped, `userId_t` index, bounded page |
| `arise/charts` | `candles` *(auth)* | Symbol + interval allow-lists, limit clamped to 1000, output re-validated before it leaves the server |
| `arise/news` | `assess` | Publisher-feed assessment; external text is sanitised and never an instruction |
| `arise/backtest` | `create`, `list`, `runs`, `get`, `runTest`, `adminRuns` | Bot ownership enforced; `runTest` authenticates and authorises before any provider work, and treats a foreign bot as "not found" |
| `arise/billingFunctions` | `listPlans`, `mySubscription`, `myEntitlements`, `startCheckout`, `startPortal` | Prices come from the server-side map (`buildPriceMap`), never from the request |
| `arise/billingFunctions` | `adminStats`, `adminUsers`, `setUserRole`, `grantPlan`, `broadcast` | Admin-gated; capped scans report `truncated` |
| `arise/billingFunctions` | `bootstrapAdmin` | One-shot first-admin bootstrap, see §5 |
| `arise/learning` | `list`, `byProposalId`, `propose`, `advance`, `rollback` | Operator/admin-gated; can only propose, never apply a control change |
| `arise/admin` | `overview`, `listUsers`, `platformStatus`, `setTradingHalt`, `setUserDisabled`, `setUserRole`, `grantPlan`, `agentMonitor`, `marketDataStatus`, `auditLog`, `recentAdminActivity` | All admin-gated |
| `arise/monitor` | `adminStatus` | Admin-gated monitor health |
| `arise/delta` | `accountSnapshot` *(auth)* | Demo mirror, read-only |
| `arise/system` | `list` *(auth)* | Redacted for non-admins: a fixed field projection, `EXECUTION`/`BILLING` message bodies replaced by a placeholder, newest-first page capped at 200 |
| `users` / `auth` | `currentUser`, `isAuthenticated`, `signIn`, `signOut` | Identity plumbing |

## 4. Internal surface — 36 functions

Internal functions are unreachable from a browser by construction; they exist for the
scheduler, for other backend functions, and for operator CLI use (`bunx convex run`).

| Module | Internal functions | Purpose |
| --- | --- | --- |
| `arise/system` | `record` | Telemetry writer with a bounded 200-row rolling trim |
| `arise/billingFunctions` | `seedPlans`, `grantPlanByEmail`, `revokePlanGrant`, `planGrantsInternal`, `incrementUsageInternal`, `myEntitlementsInternal` | Plan seeding (idempotent upsert), operator seat management, usage metering |
| `arise/billingFunctions` | `internalGetSubscription`, `internalUpsertSubscription`, `internalAttachCustomerToUser`, `internalApplySubscriptionChange`, `internalClaimEvent`, `internalMarkEventProcessed`, `internalMarkEventFailed`, `internalGetEvent` | The webhook state machine and the entitlement resolver |
| `arise/backtest` | `getBotInternal`, `recordRun` | Owner-scoped bot projection (`_id`, `userId`, `name`, `strategyId`) and run persistence |
| `arise/trading` | `openPosition`, `markAccount`, `maintainPositions`, `recordEquityPoint`, `internalGetAccount`, `listOpenPositions` | Simulated execution, marking and settlement; `openPosition` carries the durable idempotency guard |
| `arise/monitor` | `tick`, `guardedTick`, `claimRun`, `completeRun`, `recordTick`, `openPositionsBatch`, `saveOpenCursor`, `applyExit` | The 2-minute `position-monitor` cron; lease + pagination cursor keep runs from overlapping or starving |
| `arise/decisions`, `arise/news`, `arise/delta`, `arise/admin` | `record`, `fetchForAssetClass`, `mirrorOrder`, `platformHaltState` | Audit-trail insert, feed fetch, demo mirror, halt state |

Verified in the deployment, not inferred: `bunx convex function-spec` reports
`arise/backtest.js:getBotInternal` and `arise/billingFunctions.js:seedPlans` as
`internal`, and reports the intended public surfaces as `public`.

## 5. Admin bootstrap (trust mechanism)

`billingFunctions.bootstrapAdmin` is public **on purpose** — it has to be callable by a
signed-in human during first setup — and it is constrained by four independent conditions:

1. The caller must be authenticated.
2. `ARISE_ADMIN_CODE` must be set in the deployment environment and must match the supplied
   code exactly (the code is a secret; the privilege never derives from a client claim,
   an email pattern, or a predictable id).
3. No `bootstrapState` closure row may exist and no administrator may already exist.
4. The role patch and the closure insert happen inside one serialized mutation, so two
   concurrent correct-code claims cannot both become admin, and bootstrap cannot be reopened
   after the fact — even if every admin account is later deleted.

Recovery from a lost admin is therefore a deliberate operator action, not a replay of the
setup code. Tests: `src/lib/arise/convexAuthz.test.ts`.

## 6. Secret management

- Secrets live only in the deployment environment (Convex env / the project Keys tab).
  `README.md` documents the variable names; `SECURITY.md` §2 documents purpose and rotation.
- Backend-only access via `process.env`; error messages name the variable and never the
  value. No secret is written to logs, telemetry, `adminAudit`, responses or the client
  bundle.
- `.env.example` holds empty placeholders; `.gitignore` excludes `.env*`, `.env.keys`,
  `*.pem`, `*.p12`, `*.key`. `.env` files are never edited by tooling here — the user
  manages keys through the Keys/API keys UI.
- Missing secrets fail closed with an explicit error (`BILLING_NOT_CONFIGURED`,
  `ARISE_ADMIN_CODE is not set in the Keys tab`) rather than degrading into an
  unverified path.
- **Revocation is a provider-side action.** Removing a value from the tree does not revoke
  it; treat a credential as rotated only after the provider confirms revocation *and* the
  new value is deployed.

## 7. Webhook trust and event handling

- **Verification.** The raw request body plus the `stripe-signature` header are verified
  against `STRIPE_WEBHOOK_SECRET` before any parsing of business fields. Unverified traffic
  is rejected and recorded (`WEBHOOK_REJECTED`).
- **Idempotency.** One atomic claim per `event.id`
  (`internalClaimEvent`): `CLAIMED`, `DUPLICATE` (already `processed`), `IN_FLIGHT` (a live
  5-minute lease ⇒ HTTP 409 so Stripe retries later instead of applying the change
  concurrently), `ABANDONED` (≥ 8 attempts ⇒ stop retrying, raise an operator event).
- **Completion semantics.** `processed: true` / `status: "PROCESSED"` is set **only** by
  `internalMarkEventProcessed`, after the business update has been applied. A row's mere
  existence is never success.
- **Recovery.** A failure between claim and completion leaves the row `FAILED` and
  retryable; a delivery that dies mid-flight leaves a stale `PROCESSING` lease that the next
  Stripe retry may retake. Abandoned events are an operator reconciliation queue surfaced as
  `BILLING` telemetry.
- **Entitlement policy.** `src/lib/arise/subscriptionPolicy.ts` is the single decision point
  (`resolveSubscriptionPlan`): entitled statuses (`active`, `trialing`) grant access;
  terminal statuses (`canceled`, `unpaid`, `incomplete_expired`, …) end it and drop the plan
  to free; recoverable statuses (`past_due`, `incomplete`, `paused`) remember the plan but
  grant nothing; an unmapped or missing price ⇒ free **plus** a reconciliation event. The
  webhook and the entitlement resolver share this module, so they cannot drift.

## 8. Audit-event handling

| Record | Table | Semantics |
| --- | --- | --- |
| Administrative/security trail | `adminAudit` | **Append-only.** `at`, `actorId`, `actorEmail`, `action`, `component`, `prevState`, `newState`, `result` (SUCCESS/FAILED). Written by `admin.ts` `audit()` on every privileged change; read only through admin-gated queries |
| Operational telemetry | `systemEvents` | A rolling health window (`RETENTION = 200`) powering the System page. Explicitly **not** the security audit trail; non-admins see a redacted projection |
| Decision record | `decisions` (+ `evidence`, `risk`, `plan`, `execution`) | Immutable per-decision evidence: agent outputs, risk checks, evidence gate outcome, data provenance and timestamps |
| Execution record | `positions` | Immutable close fields (`closedAt`, `exitPrice`, `exitReason`, `pnl`, `exitFee`) plus the `idemKey` that proves a single open per execution key |
| Billing record | `subscriptions`, `stripeEvents`, `planGrants` | Subscription state, the event state machine (reconciliation queue) and seat grants/revocations |

Authorization failures that matter operationally (rejected webhooks, unmapped prices,
abandoned events, unknown customers) are recorded rather than swallowed. Retention of the
audit trail is deliberately **not** implemented as a delete-on-cap: the append-only table is
the record of who changed what, and a security-relevant delete would need an archival policy
first (see `ARISE_MASTER_AUDIT.md` §4.5).

## 9. Operating this security model

```bash
bunx convex dev --once && bunx tsc -b --noEmit   # backend codegen + types
bun run lint                                     # eslint
bunx vitest run                                  # full suite (no network, no live prices)
bunx convex function-spec                        # public vs internal surface (this document's §3/§4)
```

Re-run `convex function-spec` after any change to a function declaration: reviewing the
generated `api` object does **not** tell you whether a function is internal — that object
references every module export, internal ones included.
