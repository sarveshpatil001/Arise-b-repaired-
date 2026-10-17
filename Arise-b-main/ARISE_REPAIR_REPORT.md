# ARISE Bot Master — Repair Report

Companion to `ARISE_MASTER_AUDIT.md`. This report records, for each confirmed defect, the
root cause, the change made, the regression test that pins it, and the command output that
proves the tree is healthy.

## 0. How to read this report (and one honest caveat)

- Every entry names the file and the symbol that carry the fix. The audit ran with **no git
  metadata** (this host blocks `git status`/`git diff`/`git log`), so this is a
  reconstruction from the working tree and from the edits made during this engagement — not
  a diff. Where a behaviour is described as "changed", the old behaviour is quoted from the
  code that was read before the edit and the new behaviour is in the tree now.
- Nothing in this report is a claim about a live venue, a live Stripe account, or
  profitability. Test counts and command results are the ones actually observed (§8).
- **Live trading was never enabled. No production operation, migration, credential change
  or financial transaction was performed.**

## 1. Critical repairs

### R-1 — Public bot lookup → internal, narrowed, ownership-scoped

- **Root cause.** `src/convex/arise/backtest.ts` exported the bot record lookup as a public
  `query` and returned the whole document. Convex exposes every exported public function to
  any signed-in client, so a bot id was enough to read another user's bot.
- **Fix.** `getBotInternal` is now `internalQuery` with an explicit projection
  (`_id`, `userId`, `name`, `strategyId`) and returns `null` for unknown ids. Callers keep
  using `internal.arise.backtest.getBotInternal`. Every public reader in the same module
  (`list`, `runs`, `get`) scopes to `getAuthUserId(ctx)`, and `runTest` authenticates and
  authorises before any provider call, reporting a foreign bot as "not found".
- **Pinning test.** `src/lib/arise/authorizationBoundaries.test.ts` — "declares the bot
  lookup internal, not public" (asserts Convex's own `isInternal` flag on the declaration
  and that `isPublic` is unset), "returns a narrowed payload to internal callers and null
  for unknown ids", "keeps every public bot reader scoped to its owner", "authenticates and
  authorizes the backtest action before touching a provider".
- **Deployment evidence.** `bunx convex function-spec` → `arise/backtest.js:getBotInternal`
  `visibility: internal`.
- **Note on the test that was corrected.** An earlier version of this test asserted that
  `api.arise.backtest.getBotInternal` is `undefined`. That premise is false — the generated
  `api` object references *every* module export, internal ones included, because visibility
  is enforced server-side. The assertion was replaced with the declaration-level flag plus
  the deployment-spec check, which is what actually proves the property.

### R-2 — System telemetry: unbounded read and over-exposure

- **Root cause.** `src/convex/arise/system.ts` `list` collected the entire `systemEvents`
  table, sorted in memory and returned full documents to any signed-in caller, including
  `EXECUTION` messages (position id, symbol, qty, entry/exit, P&L) and `BILLING` messages.
- **Fix.** Non-admin viewers get restricted-area message bodies replaced by a fixed
  placeholder; the response is a fixed field projection (`_id`, `at`, `level`, `area`,
  `code`, `message`) so a later schema column cannot leak through; the read is
  `order("desc").take(cap)` with `MAX_LIST_LIMIT = 200` / `DEFAULT_LIST_LIMIT = 50` and
  non-finite limits falling back to the default. `record` keeps a 200-row rolling window but
  trims with a bounded `order("asc").take(RETENTION + 1)` instead of collecting the table.
- **Pinning test.** `src/lib/arise/systemTelemetry.test.ts` (convex-test): unauthenticated
  refused; projection carries no `error`/`payload`; non-admin redaction with a
  payload-wide assertion that a user id and an email address appear nowhere; newest-first
  ordering; page caps (`10_000` ⇒ 200, `0` ⇒ 1, `NaN` ⇒ default) over 220 seeded events;
  admin sees the detail; retention trim via 205 real `record` writes leaves 200 rows with
  the newest surviving.

### R-3 — Stripe webhook: idempotency, concurrency and crash recovery

- **Root cause.** The webhook recorded an event and treated the row's existence as success.
  A crash between recording and the subscription update lost the change, and two concurrent
  deliveries of the same event could both apply it (double entitlement changes).
- **Fix.**
  - `src/convex/arise/billingFunctions.ts` `internalClaimEvent` is the single atomic gate:
    `CLAIMED` (new / previously failed / stale in-flight lease), `DUPLICATE` (already
    `processed`), `IN_FLIGHT` (another delivery holds a live lease, < `EVENT_CLAIM_STALE_MS
    = 5 min`), `ABANDONED` (≥ `MAX_EVENT_ATTEMPTS = 8`).
  - `internalMarkEventProcessed` is the only writer of `processed: true`
    (`status: "PROCESSED"`); `internalMarkEventFailed` leaves the row retryable
    (`processed: false`, `status: "FAILED"`, error truncated to 500 chars).
  - `src/convex/arise/billing.ts` `stripeWebhook`: signature verified against the raw body
    before anything else (unverifiable traffic is rejected 400 and logged), then
    `DUPLICATE` → 200, `IN_FLIGHT` → **409** so Stripe retries later, `ABANDONED` → 200 with
    a `EVENT_ABANDONED` operator event, failure during processing → 500 with the row left
    retryable.
  - `checkout.session.completed` no longer defaults an unmappable session to a paid plan: it
    grants nothing and raises `CHECKOUT_UNMAPPED`.
- **Pinning test.** `src/lib/arise/stripeWebhook.test.ts` — duplicate delivery, concurrent
  delivery (in-flight conflict), failure-then-retry, successful replay prevention, stale
  claim recovery, attempt ceiling, plus the unmapped-metadata case.
  `src/lib/arise/authorizationBoundaries.test.ts` — "stripe events are never silently lost"
  (a failed event stays visible with its state).
- **Operational note.** `stripeEvents` gained `status`, `attempts`, `lastAttemptAt`,
  `completedAt` and a `status` index (see the schema migration note in §7). Failed or
  abandoned rows are the reconciliation queue; the System page surfaces the
  `BILLING` area events.

## 2. High and medium repairs

| ID | Root cause | Fix (file · symbol) | Pinning test |
| --- | --- | --- | --- |
| R-4 | `seedPlans` was a public mutation | `billingFunctions.ts` · `seedPlans` → `internalMutation`, upsert-by-key so re-seeding cannot fork a plan row; `listPlans` reads in-code `PLANS`, so an unseeded DB never blocks a purchase | `authorizationBoundaries.test.ts` — "declares plan seeding internal, not public", "is idempotent when run repeatedly" (`function-spec`: `internal`) |
| R-5 | `bootstrapAdmin` could race and could be re-opened | `billingFunctions.ts` · `bootstrapAdmin` — refuse if a `bootstrapState` closure row exists or an admin already exists; role patch + closure insert happen in one mutation; privilege requires the `ARISE_ADMIN_CODE` env secret, never a client claim | `src/lib/arise/convexAuthz.test.ts` — code required, wrong code refused, second claimant refused, closure row written, replay after closure refused, concurrent bootstrap yields one admin |
| R-6 | Unknown Stripe price kept the stored paid plan (fail-open); an unmapped row could report `active: true` with free limits | New pure policy `src/lib/arise/subscriptionPolicy.ts` (`resolveSubscriptionPlan`, `ENTITLED_STATUSES`, `RECOVERABLE_STATUSES`, `TERMINAL_STATUSES`, `buildPriceMap`, `planKeyForPrice`); `billingFunctions.ts` · `internalApplySubscriptionChange` uses it and raises `SUBSCRIPTION_*` reconciliation events; `resolveEntitlements` now requires an entitled status **and** a non-free plan, and reports `REVIEW_REQUIRED` instead of a false ACTIVE | `src/lib/arise/subscriptionPolicy.test.ts` (14 tests) and `stripeWebhook.test.ts` (unknown price ⇒ free + reconcile; terminal ⇒ free; recoverable ⇒ remembered, not entitled; upgrade/downgrade; duplicate) |
| R-7 | Candle endpoint had no input validation beyond authentication | `src/convex/arise/charts.ts` · `candles` — symbol allow-list, `SUPPORTED_INTERVALS` allow-list, positive-finite limit clamped to `MAX_CANDLES = 1000` (default 300), then `validateBars` | `src/lib/arise/providers.test.ts` / `validate` coverage; endpoint behaviour asserted through the shared validation path |
| R-8 | Client-supplied manual close price was authoritative | `src/lib/arise/freshness.ts` · `validateClosePrice` + `CLOSE_POLICY`; `src/convex/arise/trading.ts` · `closePosition` requires `priceTime` and fails closed on stale/future-dated/timestamp-less prices; duplicate fills blocked by `positions.idemKey` and `settleClose`'s in-transaction `status !== "OPEN"` re-read | `src/lib/arise/closePrice.test.ts` (8 tests), `src/lib/arise/paperExecution.test.ts`, `src/lib/arise/marks.test.ts` |
| R-9 | One freshness contract was re-derived in several modules; a future-dated mark could read as fresh/live | `src/lib/arise/freshness.ts` (`isFresh`, `MARK_POLICY`, `CLOSE_POLICY`, `DECISION_DATA_POLICY`), consumed by `market.ts`, `monitor.ts`, `marks.ts`, `trading.ts`, `risk.ts`; `src/lib/arise/adminLogic.ts` gained `FeedState "INVALID"` + `CLOCK_SKEW_TOLERANCE_SEC = 120`, and `src/convex/arise/admin.ts` uses the shared classifier instead of inline ternaries | `src/lib/arise/adminLogic.test.ts`, `src/lib/arise/marks.test.ts`, `src/lib/arise/monitor.test.ts`, `src/lib/arise/riskEngine.test.ts` |
| R-10 | The anomaly gate ignored `config.maxAnomalyLevelForTrade` (fail-open against a stricter config) and compared levels by ad-hoc equality | `src/lib/arise/risk.ts` — new exported `ANOMALY_LEVEL_RANK` (`NORMAL`/`WATCH`/`HIGH`) and a gate that compares the observed level's rank against the configured ceiling; unknown level ⇒ veto; `src/lib/arise/learning.ts` reuses the table and keeps its explicit "only NORMAL or WATCH is tradeable" proposal rule | `src/lib/arise/riskEngine.test.ts` — "enforces the configured anomaly ceiling instead of a hardcoded pair", "never treats an unknown anomaly vocabulary as safe"; `src/lib/arise/learning.test.ts` unchanged and green |
| R-11 | Unbounded `.collect()` on account history | `src/convex/arise/trading.ts` · `closedPositions` (newest-first `order("desc").take(≤500)`, default 100) and `latestMarks` (`MARK_SCAN_LIMIT = 120`) | Existing trading/paper-execution suites plus `use-arise.ts` `closedPositions({ limit: 100 })` call site |
| R-12 | Admin aggregates could clip silently | `billingFunctions.ts` · `adminStats`, `adminUsers` — `ADMIN_SCAN_CAP = 5000` with `truncated` reported; newest-first decision scan so a 24h count is not taken from the oldest page | `authorizationBoundaries.test.ts` — "refuses non-admins and reports an untruncated scan for small data" |
| R-13 | Telemetry retention destroyed audit history | `src/convex/arise/system.ts` `RETENTION = 200` is now documented as a rolling **health** window; the append-only `adminAudit` trail is separate and admin-gated (`src/convex/arise/admin.ts` `audit()`, `recentAdminActivity`, `auditLog`) | `src/lib/arise/systemTelemetry.test.ts` retention test; `src/lib/arise/learningConvex.test.ts` / `convexAuthz.test.ts` audit assertions |
| R-14 | Backtesting could be fed in-sample evidence | `src/lib/arise/walkForward.ts` (new) wired into `src/convex/arise/backtest.ts` · `runTest`, persisted on `backtestRuns.walkForward` beside `fitnessGates` | `src/lib/arise/walkForward.test.ts` (18 tests), `src/lib/arise/strategyFitness.test.ts` (38), `src/lib/arise/backtest.test.ts` (10) |

## 3. Files in the repair set

| Area | Files |
| --- | --- |
| Bot lookup / authz | `src/convex/arise/backtest.ts`, `src/lib/arise/authorizationBoundaries.test.ts` (new) |
| Telemetry | `src/convex/arise/system.ts`, `src/lib/arise/systemTelemetry.test.ts` (new), `src/lib/arise/adminLogic.ts`, `src/lib/arise/adminLogic.test.ts`, `src/convex/arise/admin.ts` |
| Billing | `src/convex/arise/billing.ts`, `src/convex/arise/billingFunctions.ts`, `src/lib/arise/subscriptionPolicy.ts` (new), `src/lib/arise/subscriptionPolicy.test.ts` (new), `src/lib/arise/stripeWebhook.test.ts` (new), `src/lib/arise/convexAuthz.test.ts`, `src/pages/Billing.tsx` (unused import that broke `bun run lint`) |
| Risk / learning | `src/lib/arise/risk.ts`, `src/lib/arise/riskEngine.test.ts`, `src/lib/arise/learning.ts` |
| Trading / execution | `src/convex/arise/trading.ts` (bounded reads; idempotency and close-price validation behaviour verified in place) |
| Walk-forward / fitness | `src/lib/arise/walkForward.ts` (new), `src/lib/arise/walkForward.test.ts` (new), `src/convex/arise/backtest.ts` |
| Schema | `src/convex/schema.ts` — `stripeEvents` state machine columns + `status` index, `bootstrapState`, `backtestRuns.walkForward` / `fitnessGates` |
| Documentation | `README.md`, `SECURITY.md`, `ARISE_MASTER_AUDIT.md`, `ARISE_REPAIR_REPORT.md`, `ARISE_SECURITY_MODEL.md`, `ARISE_MARKET_DATA_AND_RISK.md`, `ARISE_WALK_FORWARD_VALIDATION.md` |

## 4. Tests added (this engagement)

| File | Focus |
| --- | --- |
| `src/lib/arise/walkForward.test.ts` | Fold layout, training-only selection, leakage refusal (future timestamp, forming bar, duplicate/non-monotonic timestamps), costs, fold-boundary positions, insufficient samples, instability, synthetic-data rejection |
| `src/lib/arise/stripeWebhook.test.ts` | Duplicate, concurrent, failed→retry, replay, unknown price, unmapped checkout metadata |
| `src/lib/arise/subscriptionPolicy.test.ts` | Entitlement policy truth table (statuses × price mapping) |
| `src/lib/arise/systemTelemetry.test.ts` | Telemetry authz, redaction, projection, caps, retention |
| `src/lib/arise/authorizationBoundaries.test.ts` | Internal declarations, cross-user bot/run access, plan-seeding authority, admin aggregate gating, lost-event visibility |
| `src/lib/arise/riskEngine.test.ts` (extended) | Anomaly ceiling from config, unknown anomaly vocabulary |
| `src/lib/arise/adminLogic.test.ts` (extended) | `INVALID` feed state, clock skew, invalid timestamps |
| `src/lib/arise/convexAuthz.test.ts` (extended) | Bootstrap closure/replay/concurrency guarantees |

All test data is deterministic fixtures; no test performs network I/O or reads live prices.

## 5. Behaviour changes an operator should know

1. **A failed/abandoned Stripe event is now a queue item, not a silent loss.** Watch the
   `BILLING` area of the System page for `SUBSCRIPTION_*`, `CHECKOUT_UNMAPPED` and
   `EVENT_ABANDONED`; an abandoned event needs manual reconciliation with Stripe.
2. **An unknown price now drops the stored plan to free** (previously the paid plan
   persisted). Reconciliation event codes are stable strings.
3. **A future-dated feed mark is `INVALID`,** not `LIVE`, and a future-dated manual close is
   rejected. Admin feed rows may therefore show `INVALID` where they previously showed
   `LIVE`.
4. **A stricter `maxAnomalyLevelForTrade` now actually applies** — configuring `NORMAL`
   vetoes `WATCH`.
5. **`bootstrapAdmin` is one-shot.** Once the closure row is written, replaying the setup
   code is refused even if every admin account is later deleted; recovery is a deliberate
   operator intervention, not a re-run.

## 6. Migration / schema requirements

`src/convex/schema.ts` changed. Convex applies schema on `convex dev`/`deploy`; the audit
ran `bunx convex dev --once` successfully (exit 0), which is the schema-validation gate
available here. Two things to note on a real deployment:

- `stripeEvents` gained optional columns (`status`, `attempts`, `lastAttemptAt`,
  `completedAt`) and a `status` index. Existing rows have no `status`; the claim logic
  treats a row without a completed mark as not-processed, which is the safe reading, and
  `processed` remains the authoritative "success" flag.
- `bootstrapState` is new. On a deployment that already has an administrator, insert the
  closure row (or simply never call bootstrap again) — the function also refuses when an
  admin already exists, so no privilege is created by the migration.
- No data migration, backfill or destructive operation is required.

## 7. Commands executed (with results)

| Command | Exit | Result |
| --- | --- | --- |
| `bunx convex dev --once` | 0 | Functions ready, schema accepted |
| `bunx tsc -b --noEmit` | 0 | Clean |
| `bunx vitest run` | 0 | **26 files / 442 tests passed** |
| `bun run lint` | 0 | `eslint .` clean (after removing an unused `useMutation` import in `src/pages/Billing.tsx`) |
| `bun run build` | 0 | `tsc -b` + `vite build`, 6.03s, no errors |
| `bunx convex function-spec` | 0 | 94 functions; internal declarations verified |
| `git status --short` / `git diff --check` | **NOT RUN** | Blocked by the host ("Vly manages version control") |
| Dependency vulnerability scan | **NOT RUN** | No registry-backed scanner available in this environment |
| Live Stripe/provider end-to-end | **NOT RUN** | No live credentials used by design |

## 8. Not implemented (recommendations, not code changes)

Carried from `ARISE_MASTER_AUDIT.md` §4.5 and deliberately left to the product owner:
bounding the remaining admin-only console reads with a surfaced `truncated` flag (O-1), a
rate limiter on the candle action (O-2), the `spreadPct === null` veto policy (O-3),
provider-accurate bar provenance labelling in `validate.ts` (O-4), session/calendar
validation for FX (O-5), and a convex-test that drives the real `runTest` flow end to end
(O-6).

## Follow-up hardening pass — 2026-10-16

Applied to the supplied `Arise-b-main.zip` source tree:

- Added an authenticated, server-side fixed-window quota for the candle proxy (30 requests per user per minute), with one reusable row per user.
- Candle `limit` now must be a safe integer in `[1, 1000]`; non-integer, zero, negative, and oversized requests are rejected instead of silently rounded/clamped.
- Added deterministic Convex integration tests for the candle quota and the real `runTest` action path. The walk-forward integration fixture asserts synthetic data is refused, the refusal is persisted, and fitness eligibility remains false with blockers.
- Replaced unbounded `.collect()` calls in the admin control plane with explicit scan ceilings and surfaced partial-scan indicators in overview, user, agent, audit, and market-data screens.
- Removed the accidentally included `.env.keys` file from this repair artifact. Rotate/revoke the corresponding dotenvx private key if it was ever used with shared or committed encrypted environment data; removing it from this ZIP does not rotate the key itself.

Validation limitation: dependency installation timed out in this environment, so Vitest, TypeScript, ESLint, Convex code generation, and production build could not be executed here. These changes are not represented as passing tests until run in a working dependency environment. Live execution remains hard-locked off (`LIVE_TRADING_ENABLED = false`).
