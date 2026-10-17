# ARISE Bot Master — Master Security & Integrity Audit

**Verdict: CONDITIONAL** — every P0 blocker confirmed by this audit is repaired and
covered by regression tests, but the audit also records findings that were deliberately
**not** fixed (they are product/risk-policy decisions) and verification steps that could
not run in this environment. Read §8 before treating this build as releasable.

## 1. Repository identity and revision audited

| Item | Value |
| --- | --- |
| Project | ARISE — Multi-AI Quantitative & Algorithmic Trading System ("Bot Master") |
| Stack | TypeScript · React 19 + Vite 7 (frontend) · Convex 1.30 (backend + DB) · Convex Auth · Stripe 22 · Tailwind 4 · Bun |
| Backend shape | 94 deployed Convex functions (`bunx convex function-spec`), 18 tables, 1 cron job (`src/convex/crons.ts`, `position-monitor` every 2 minutes) |
| Mode | **Paper trading only.** `src/lib/arise/execution.ts` — `LIVE_TRADING_ENABLED = false`, with no config or UI path to enable it |
| Revision | **No git metadata available.** This host blocks `git status`, `git diff` and `git log` ("Vly manages version control"), so the audit is of the working tree as it stands, and every change in this repair is described by file path in `ARISE_REPAIR_REPORT.md` rather than by diff hash |
| Evidence base | Source files in the working tree, `bunx convex function-spec` (deployment-level function visibility), and the executed checks in §7 |

Because no revision id exists, a change attribution that depends on "what the tree looked
like before" is *not* claimed anywhere in this document. Findings describe the state the
auditor read and the repairs the auditor wrote.

## 2. Scope, method, limitations

Scope: authentication and authorization, bot/plan/telemetry object-level access, Stripe
webhook correctness and recovery, market-data validation, risk-engine authority,
simulated-execution accounting, backtesting methodology, query bounds, audit integrity.

Method: read the code paths end to end (caller → function → schema), then re-derive each
claimed finding from the current source before repairing it; every repair that changes a
security or financial behaviour ships with a regression test that fails on the old
behaviour. Framework behaviour that a source reading cannot prove was checked against the
deployment itself (`bunx convex function-spec`) instead of inferred.

Limitations, stated plainly:

- No git baseline, so pre-existing test failures could not be attributed by diff; the
  suite is green in its current state (§7).
- No live Stripe account, no funded broker, no live market-data credentials were used.
  Billing tests drive the real Convex functions against an in-memory backend; the Stripe
  *signature* path is exercised as a unit contract, not against Stripe's servers.
- No production data volume exists in this environment, so bounded-read behaviour is
  proven by code reading plus explicit caps, not by load measurements.
- Live trading was **not** enabled at any point, and no external account, migration or
  financial action was performed.

## 3. Architecture as audited

```
client (React)  ──►  public Convex query/mutation/action (auth-checked per function)
                        │
                        ├─ market.ts  decide ─► providers.ts ─► validate.ts ─► quant/agents/mind
                        │                                   └─► risk.ts (veto) ─► evidence.ts (gate)
                        │                                   └─► trading.ts openPosition ─► execution.ts PaperBroker
                        ├─ charts.ts  candles      (authed proxy, bounded, validated)
                        ├─ trading.ts accounts/positions/equity (per-user, bounded)
                        ├─ decisions.ts / equity.ts / system.ts (read models)
                        ├─ billingFunctions.ts entitlements, admin console, event state machine
                        └─ backtest.ts runTest ─► walkForward.ts ─► strategyFitness.ts
                                                internal ─► backtest.getBotInternal
internal only:  system.record · billing internals · monitor tick · billing test
                helpers (seedPlans, grantPlanByEmail, …) — unreachable from a browser
```

Trust boundaries, in order of exposure: the browser (untrusted), the Stripe webhook
(authenticated by signature only), public market-data providers (untrusted responses),
and the deployment environment (the only secret store).

## 4. Findings

Severity is "impact if exploited or wrong", not "effort to fix". Every P0 finding below
was confirmed against the current source, repaired, and pinned by a test.

### 4.1 Critical (P0) — all repaired

| # | Finding | Evidence (file · symbol) | Impact | Status |
| --- | --- | --- | --- | --- |
| P0-1 | The bot record lookup was a **public** query: any signed-in caller could read another user's bot by guessing an id, and it returned the whole document | `src/convex/arise/backtest.ts` · `getBotInternal` (was `query`) | Cross-user data exposure; an existence oracle over other users' bots | **Fixed**: declared `internalQuery`, narrowed projection (`_id`, `userId`, `name`, `strategyId`); `bunx convex function-spec` reports `visibility: internal` |
| P0-2 | System-event telemetry was an **unbounded, over-exposed read**: the handler collected the whole table, sorted in memory, and returned full documents (including `EXECUTION`/`BILLING` messages containing position and customer detail) to any signed-in user | `src/convex/arise/system.ts` · `list` | Per-user financial/operational detail readable by any account; query cost grew with the whole table | **Fixed**: admin-only field redaction, fixed field projection (new columns cannot leak), database-level `order("desc").take(cap)` with a 200-row cap, retention trim that no longer collects the table |
| P0-3 | Webhook processing was **not recoverable**: a recorded row was treated as success, so a crash between recording and applying the subscription change silently dropped it, and two concurrent deliveries could both apply the same change | `src/convex/arise/billing.ts` · `stripeWebhook`; `src/convex/arise/billingFunctions.ts` · `internalClaimEvent` / `internalMarkEventProcessed` / `internalMarkEventFailed` | Lost or duplicated subscription changes; entitlement drift with no operator signal | **Fixed**: one atomic claim per event with states `CLAIMED / DUPLICATE / IN_FLIGHT / ABANDONED`, `PROCESSED` set only on a completed update, `FAILED` rows retryable, stale in-flight claims recoverable after a 5-minute lease, retry ceiling with an operator reconciliation event |

### 4.2 High (P1) — repaired

| # | Finding | Evidence | Repair |
| --- | --- | --- | --- |
| P1-1 | Plan seeding was a public mutation, so any signed-in client could write plan rows | `billingFunctions.ts` · `seedPlans` | `internalMutation`, upsert-by-key (idempotent); `function-spec` reports `internal` |
| P1-2 | Admin bootstrap could race: two concurrent claims with the correct code could both create an administrator, and bootstrap could be reopened after the fact | `billingFunctions.ts` · `bootstrapAdmin` | Atomic single-transaction guard: refuse when a `bootstrapState` closure row exists, refuse when an admin already exists, patch the role and write the closure row in the same mutation. The privilege never comes from a client-supplied claim — only the `ARISE_ADMIN_CODE` env secret plus the closure row |
| P1-3 | An **unknown** Stripe price kept whatever paid plan was already stored ("fail open"), and an unmapped row could report `active: true` with free limits | `billingFunctions.ts` · `internalApplySubscriptionChange`, `resolveEntitlements` | Plan resolution moved to the pure, unit-tested `src/lib/arise/subscriptionPolicy.ts` (`resolveSubscriptionPlan`): unknown price ⇒ free **and** an operator reconciliation event; terminal status ⇒ free; recoverable status ⇒ plan remembered but **not** entitled. Entitlement now requires an entitled status *and* a non-free plan. `billing.ts` checkout grants nothing when metadata is unmappable |
| P1-4 | Candle endpoint accepted only an auth check: no symbol/interval allow-list, no bound on `limit` | `src/convex/arise/charts.ts` · `candles` | Symbol allow-list from `listSymbols()`, interval allow-list from `SUPPORTED_INTERVALS`, positive-finite limit clamped to `MAX_CANDLES = 1000` (default 300), then one authoritative `validateBars` pass |
| P1-5 | Freshness/completion was re-derived in several places, and a future-dated mark could be classified as live | `src/lib/arise/freshness.ts` (`isFresh`, `MARK_POLICY`, `CLOSE_POLICY`, `DECISION_DATA_POLICY`), `market.ts`, `monitor.ts`, `marks.ts`, `adminLogic.ts` | One freshness contract: three named policies, negative age ⇒ `INVALID` (never FRESH), incomplete bar ⇒ `INVALID`, unknown/NaN clock ⇒ `INVALID`. Admin feed state gained an explicit `INVALID` state and a clock-skew tolerance |
| P1-6 | A manual close could be priced from a **client-supplied** number, i.e. a user could invent their own exit price | `src/lib/arise/freshness.ts` · `validateClosePrice`; `src/convex/arise/trading.ts` · `closePosition` | The close price must arrive with its bar timestamp and satisfy `CLOSE_POLICY` (fresh completed 5m bar; a forming bar only if it really is the current bar; future-dated, stale or timestamp-less prices rejected). Duplicate fills are blocked by the durable `positions.idemKey` guard and by `settleClose`'s in-transaction `status !== "OPEN"` re-read |
| P1-7 | Walk-forward backtesting was not integrated into the real run flow, so fitness gates could be fed in-sample evidence | `src/lib/arise/walkForward.ts`, `src/convex/arise/backtest.ts` · `runTest`, schema `backtestRuns.walkForward` | Chronological rolling/expanding folds, candidate selection on training data only, out-of-sample aggregates recorded beside the gate report; synthetic data is refused by `precheck` before any fold runs. Method, thresholds and gaps: `ARISE_WALK_FORWARD_VALIDATION.md` |

### 4.3 Medium (P1/P2) — repaired

| # | Finding | Evidence | Repair |
| --- | --- | --- | --- |
| M-1 | The risk engine's anomaly gate hardcoded `NORMAL \| WATCH`, so an operator who tightened `config.maxAnomalyLevelForTrade` to `NORMAL` was silently ignored (fail-open against the stricter configuration), and an unrecognised level was compared by ad-hoc string equality | `src/lib/arise/risk.ts` · `ANOMALY_LEVEL_RANK`, gate 6 | The gate now compares ranks against the configured ceiling; an unknown level is never treated as safe. Proposal validation in `src/lib/arise/learning.ts` reuses the same vocabulary table |
| M-2 | Closed-trade history and decision marks were read with unbounded `.collect()` | `src/convex/arise/trading.ts` · `closedPositions`, `latestMarks` | Newest-first database reads with explicit caps (`MAX_CLOSED_POSITIONS = 500`, `MARK_SCAN_LIMIT = 120`) instead of loading a whole account history to slice it in memory |
| M-3 | Admin aggregates could under-report without saying so | `billingFunctions.ts` · `adminStats`, `adminUsers` | Capped scans (`ADMIN_SCAN_CAP = 5000`) plus a `truncated` flag the console reports, so a clipped number is never presented as a total |
| M-4 | Audit retention and telemetry retention were conflated | `src/convex/arise/system.ts` (`RETENTION = 200`, health window), `src/convex/arise/admin.ts` · `adminAudit` | Telemetry is documented and treated as a rolling health window; the administrative trail is a separate append-only table written by `admin.ts` `audit()`; audit reads are admin-gated |

### 4.4 Verified secure — no change required

- **Risk engine fail-closed posture**: `INPUT_VALID` rejects non-finite price/equity/ATR,
  `buildTradePlan` returns `null` rather than propagating NaN into sizing, `validateExecution`
  rejects non-finite quantities and prices, `EMERGENCY_STOP` is an absolute veto, and no
  MIND/AI output can raise a verdict (only `evidence.ts` can lower it).
- **Ownership scoping**: every public bot/backtest/position/decision reader filters by the
  authenticated user id, and unauthenticated calls return empty or throw.
- **Paper-only lock**: `LIVE_TRADING_ENABLED = false`; `src/lib/arise/delta.ts`
  `requireDemoTrading()`/`resolveDeltaOrderBaseUrl()` refuse non-testnet hosts — the
  production Delta host is explicitly rejected.
- **External text is data**: `untrusted.ts` sanitises ingested headlines; nothing in the
  news path can move a risk limit.
- **Learning cannot touch controls**: `FORBIDDEN_TARGETS` (risk limits, execution mode,
  security policy, secrets) plus operator-only transitions; `APPLIED` requires a
  server-stamped completed evaluation.
- **Secret handling**: secrets are read from the environment only, error messages name the
  variable and never the value, and no secret is logged or bundled.

### 4.5 Open findings — recorded, not repaired

These are honest gaps. None is an unauthenticated-access hole, and none was hidden by
weakening a check.

| # | Severity | Finding | Why it was not repaired here | Recommended owner action |
| --- | --- | --- | --- | --- |
| O-1 | Low | Admin-only console queries (`admin.ts` `agentMonitor`, `marketDataStatus`, `auditLog`, `recentAdminActivity`) still read with `.collect()` over `decisions` / `adminAudit` / `systemEvents` | They are admin-gated and their aggregates are built from the whole table by design; capping them would **silently** change the numbers a console shows. Bounding them correctly means adding a `truncated` field and surfacing it in `Admin.tsx` | Add the cap + `truncated` flag in the same shape as `adminStats`, then update the console |
| O-2 | Low | No rate limiter on the `charts.candles` action (quota is per-day on `market.decide` only) | Rate limiting needs a storage/decision policy (per-user bucket, provider quota budget) that this audit should not invent | Add a per-user token bucket over `analysisUsage`-style storage, or a provider-level quota guard |
| O-3 | Low | `spreadPct === null` (FX has no top-of-book) is **not** vetoed | Documented policy in `SECURITY.md` §1 item 3: changing it alters a risk threshold | Decide policy; if vetoed, ship as a risk change with its own tests |
| O-4 | Low | `validate.ts` labels a bar's `source` from the symbol suffix, which can disagree with the true provider when a fallback feed served the data | Cosmetic-to-moderate provenance defect; the true provider is still recorded on `MarketSnapshot.source`/`snapshotMeta` | Derive `source` from the provider that actually answered |
| O-5 | Info | No market-session/calendar validation (gaps are counted but do not lower data quality), and no reconciliation of the Delta demo mirror | Product-scope decisions (crypto is 24/7; Delta is observability-only) | Define session policy per asset class if FX session gating is wanted |
| O-6 | Info | The Convex `runTest` wiring of the walk-forward engine has no direct test; `missing-bars` stress exists in the engine but is not in the Convex stress allow-list | Time-bounded; the engine itself is covered by 18 tests | Add a convex-test that drives `runTest` with a stub provider and asserts the persisted `walkForward`/`fitnessGates` payload |

## 5. What this audit does not claim

- No profitability, edge or "production-ready trading" claim. Historical and
  walk-forward results are research evidence, and `ELIGIBLE_FOR_HUMAN_REVIEW` is not a
  literal state in this repository — promotion is `eligible: true` plus
  `promotionDecision(...) === "PROMOTE"` with `requiresHumanApproval: true`, which
  authorises *review*, never execution.
- No claim that the paper simulator matches a live venue: fills are modelled (fees, spread
  crossing, slippage bps), not matched against an order book.
- No claim that the audited tree equals any git revision (§1).

## 6. Security-hardening sweep results

| Check | Result |
| --- | --- |
| Public internal functions | Fixed for the two confirmed cases (P0-1, P1-1); verified against the deployment spec, not the `api` object |
| Missing admin checks on admin surfaces | `adminStats`, `adminUsers`, `setUserRole`, `grantPlan`, `broadcast`, `admin.ts` helpers all re-read the caller's role server-side; tests assert the non-admin refusal |
| Broken object-level authorization | Bot/backtest/position/decision readers scope by authenticated user; cross-user access returns empty or "not found" (no existence oracle) |
| Secret leakage in logs/client bundles | No secret value is logged; errors name variables; `.env.example` holds placeholders only; `.gitignore` excludes `.env*`, `*.pem`, `*.key` |
| Injection / unsafe deserialization | No SQL/NoSQL string building (Convex typed queries); external text sanitised via `untrusted.ts`; provider responses validated with `validateBars` before use |
| Unsafe redirects | Billing and portal redirects are built from Stripe-returned URLs and `SERVER_URL`, not from request parameters |
| Race conditions in privilege/billing/accounting | Bootstrap (P1-2), webhook claim (P0-3) and duplicate fills (P1-6) are the three that were confirmed; each now uses a single-transaction guard plus a regression test |
| Dependency vulnerabilities | **NOT RUN** — no reliable, offline audit tool in this environment; `bun audit`/`npm audit` require registry access that was not exercised |

## 7. Verification actually executed

| Command | Exit | Result |
| --- | --- | --- |
| `bunx convex dev --once` | 0 | Backend codegen + schema validation clean |
| `bunx tsc -b --noEmit` | 0 | No type errors (frontend + backend) |
| `bunx vitest run` | 0 | 26 files, **442 tests** pass (incl. the new authorization, telemetry, webhook, subscription-policy, walk-forward and risk-gate suites) |
| `bun run lint` | 0 | `eslint .` clean |
| `bun run build` | 0 | `tsc -b` + `vite build` succeed (6.03s) |
| `bunx convex function-spec` | 0 | 94 functions; `arise/backtest.js:getBotInternal` and `arise/billingFunctions.js:seedPlans` report `visibility: internal`; public surfaces are the intended ones |
| `git status --short`, `git diff --check` | **NOT RUN** | Blocked by the host: "Git and GitHub commands are blocked; Vly manages version control" |
| Dependency vulnerability scan | **NOT RUN** | No registry-backed scanner available here (§6) |
| Live Stripe / live provider end-to-end | **NOT RUN** | No live credentials used, by design; the signature and entitlement logic is covered by unit/convex-test contracts instead |

## 8. Acceptance gates

| Gate | Status |
| --- | --- |
| No unresolved critical unauthorized-access finding | **PASS** — P0-1/P0-2 fixed and pinned; the two internal declarations verified against the deployment spec |
| Billing events are idempotent and recoverable | **PASS** (logic + tests); not exercised against live Stripe deliveries |
| Entitlements fail safely on unknown state | **PASS** — unknown price / unknown status / terminal status ⇒ free with a reconciliation event |
| Market-data validation enforced end to end | **PASS** for the pipeline and charts paths; provenance labelling defect O-4 remains |
| Client input cannot manipulate simulated accounting | **PASS** — close price validated server-side; duplicate fills blocked by a durable key + status guard |
| Walk-forward results are demonstrably out-of-sample | **PASS** at engine level (18 tests); the Convex wiring lacks a direct test (O-6) |
| Critical regression tests pass | **PASS** — 442/442 |
| Typecheck, lint, build, codegen pass | **PASS** |
| Remaining high-severity findings resolved or blocking | **PASS** — the open list is Low/Info only |
| Live trading remains disabled | **PASS** — `LIVE_TRADING_ENABLED = false`, testnet-only Delta host check; never enabled during this audit |
| No unsupported profitability/readiness claims | **PASS** — every document states research-only status |

**Verdict: CONDITIONAL.** All P0/P1 code blockers are repaired, tested and type-clean.
The condition is operational: the open items in §4.5 (O-1, O-2) should be closed before a
public multi-tenant launch, the webhook recovery path should be observed once against real
Stripe deliveries, and the checks marked **NOT RUN** in §7 (git baseline, dependency
scan) must be re-run in an environment that permits them.

## 9. Related documents

- `ARISE_REPAIR_REPORT.md` — every file touched, root cause, fix and test.
- `ARISE_SECURITY_MODEL.md` — trust boundaries, authz rules, public vs internal surface.
- `ARISE_MARKET_DATA_AND_RISK.md` — data provenance, validation states, risk authority, execution accounting.
- `ARISE_WALK_FORWARD_VALIDATION.md` — out-of-sample methodology, gates, limitations.
- `SECURITY.md` — durable paper-only invariants and secret inventory.
