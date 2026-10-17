# ARISE — Multi-AI Quantitative & Algorithmic Trading System

AI-powered market intelligence, decision analysis, risk control, and paper trading.
Analyze → Challenge → Risk-check → Decide → Monitor.

Multi-agent market analysis for crypto and forex. Six specialized AI agents examine live
market data, MIND challenges their conclusions, and a deterministic risk engine holds veto
power over the final call. The output is one clear, fully auditable verdict:
**BUY, SELL, or WAIT — and why.**

> **PAPER TRADING ONLY.** `LIVE_TRADING_ENABLED = false` is hardcoded with no UI or config
> path to enable live execution. Nothing in this repository is financial advice, and no
> profitability is claimed or implied.

## Commercial layer (Stripe)

- Plans: Starter (free, 5 analyses/day, 1 symbol) · Pro Trader ($49/mo, unlimited) ·
  Institutional ($199/mo, exports + 100 symbols)
- Hosted Stripe Checkout for upgrades; Stripe customer portal for self-serve management
- Webhook-driven subscription state — signature-verified and idempotent; a plan is never
  granted on the basis of an unverified client message
- Server-side entitlement gating: the decision action refuses work beyond the plan and
  meters usage per UTC day
- Billing screen at `/dashboard/billing`, admin console at `/admin` (first-admin bootstrap
  via the `ARISE_ADMIN_CODE` key)

### Stripe setup (Keys tab)

| Key | Purpose |
| --- | --- |
| `STRIPE_SECRET_KEY` | Checkout, portal, webhook signature verification |
| `STRIPE_WEBHOOK_SECRET` | Verifies webhook deliveries at `/stripe/webhook` |
| `STRIPE_PRICE_PRO` | Price ID for Pro Trader (set in `PLANS` when available) |
| `STRIPE_PRICE_INSTITUTIONAL` | Price ID for Institutional |
| `ARISE_ADMIN_CODE` | One-time first-admin bootstrap code |

Until keys are set, checkout returns an explicit `BILLING_NOT_CONFIGURED` error — the
Starter tier remains fully functional.

### Complimentary / institutional seats (no Stripe)

A seat can be provisioned directly for an email address — useful for the founder, design
partners and institutional agreements that are invoiced outside Stripe:

```bash
bunx convex run arise/billingFunctions:grantPlanByEmail \
  '{"email":"person@example.com","planKey":"institutional","note":"Founder seat"}'
bunx convex run arise/billingFunctions:revokePlanGrant '{"email":"person@example.com"}'
```

- Internal-only functions: callable from other Convex functions and the deployment CLI,
  never from a browser.
- Matched to the account's **own** email server-side, so a client cannot claim someone
  else's seat, and a seat granted before sign-up applies from that account's first request.
- A seat does **not** override a paid subscription: an active Stripe plan always wins.
- The Billing screen shows `GRANTED SEAT` rather than a Stripe status, so a complimentary
  plan is never presented as a paid subscription. Grants and revocations are written to the
  append-only system event log.

## Decision pipeline (V1)

```
MARKET DATA (Binance / Yahoo / Delta demo — real, public)
   ↓
DATA VALIDATION (dedupe, OHLC sanity, gaps, outliers, staleness — fail closed)
   ↓
QUANT ENGINE (deterministic: trend, momentum, volatility, statistics, liquidity)
   ↓
NEWS WIRE (real publisher RSS → deterministic lexicon scoring, `news-v1`)
   ↓
7 SPECIALIZED AGENTS (quant / technical / regime / anomaly / portfolio / risk / news)
   ↓
MIND (evidence normalization → debate → challenge → calibrated proposal)
   ↓
DETERMINISTIC RISK ENGINE (12 rules · veto authority · AI cannot override)
   ↓
EVIDENCE & DECISION GATE (facts / calculations / inferences / unknowns → reason
   codes → TRADE | WAIT | REJECT — it can only LOWER the verdict, never raise it)
   ↓
PAPER EXECUTION (fees, spread crossing, slippage, idempotency)
   ↓
POSITION MONITORING (SL/TP on bar extremes) → EQUITY CURVE → AUDIT TRAIL
```

## Screens

| Route | Purpose |
| --- | --- |
| `/` | Landing — product story, pipeline, pricing, safety posture |
| `/dashboard` | **HOME — the decision desk**: BUY/SELL/WAIT, confidence, regime, agent opinions, MIND debate, risk checks, trade plan, invalidation |
| `/dashboard/markets` | Real candlestick + volume chart, provider/spread/feed status |
| `/dashboard/intelligence` | Per-agent drill-down, MIND debate detail, live NEWS WIRE (cited headlines + feed health) |
| `/dashboard/trades` | Open positions, closed trades, equity curve, win rate, profit factor |
| `/dashboard/risk` | Live deterministic checks, limits, vetoes, emergency stop |
| `/dashboard/billing` | Current plan, usage, upgrade checkout, Stripe portal |
| `/dashboard/system` | Service health, data age, append-only audit log, controlled-learning proposals (operator/admin) |
| `/decision/:id` | Full immutable record of one decision (audit view) |
| `/admin` | Operations console: users, MRR, plan grants, roles, broadcast |

## Architecture

- `src/lib/arise/` — pure, deterministic core (no React, no Convex):
  - `types.ts` domain model · `config.ts` validated limits · `math.ts` statistics primitives
  - `quant.ts` feature engine · `validate.ts` data validation/freshness
  - `providers.ts` Binance/Yahoo adapters + circuit breaker + resampling
  - `agents.ts` six heuristic agents (`heuristic-v1`) · `news.ts` news wire (`news-v1`) · `mind.ts` MIND (`mind-v1`)
  - `risk.ts` risk engine (`risk-v1`) + trade planner + execution validator
  - `evidence.ts` evidence ledger + decision gate (`TRADE`/`WAIT`/`REJECT`, reason codes)
  - `untrusted.ts` external-text sanitizer (news is data, never instructions)
  - `backtest.ts` backtest engine · `strategyFitness.ts` admission gates + promotion policy
  - `learning.ts` controlled-learning proposals (forbidden targets, safety limits, state machine)
  - `execution.ts` paper broker (fee/slip model, idempotency) · `pipeline.ts` orchestrator
- `src/convex/arise/` — Convex backend: `market.ts` (decision action), `trading.ts`
  (accounts/positions/equity), `decisions.ts` (audit trail), `charts.ts`, `system.ts`, `equity.ts`,
  `news.ts` (public feed fetch), `backtest.ts` (runs + fitness gate reports),
  `learning.ts` (operator-gated proposals), `delta.ts` (Delta demo mirror)
- `src/pages/` — terminal screens · `src/components/arise/` — shell + shared UI

## Golden rules enforced in code

1. No validated data ⇒ **NO TRADE** (`validate.ts` + risk `DATA_VALID`/`DATA_FRESH`)
2. Risk engine vetoes every trade it must; reason codes are machine-readable
3. AI cannot override deterministic controls (`mind.ts` never touches execution)
4. AI cannot submit orders — only the pipeline after `evaluateRisk()` approval
5. Paper trading is the default and only mode; live is locked
6. No fabricated market data — providers fail ⇒ error state, never synthetic prices
7. Every decision is stored with agent outputs, risk checks, execution record, data timestamps
8. "No trade" is a first-class success (`status: WAIT`)
9. Missing/stale/contradictory evidence lowers the verdict (`evidence.ts`); the gate can
   only demote, so a rejection can never be read downstream as permission
10. External news is sanitized before use (`untrusted.ts`); embedded instructions to
   change policy, move risk limits or trade are flagged, never obeyed
11. A strategy with unmeasured out-of-sample / walk-forward / parameter evidence fails its
   admission gates (`strategyFitness.ts`) and stays ineligible for promotion
12. Learning may only PROPOSE: risk limits, execution mode, security policy and secrets are
   forbidden targets, and `APPLIED` needs a privileged operator plus a completed, passing,
   server-timestamped evaluation (`learning.ts`)
13. A billing event is applied **once** and never silently lost: one atomic claim per event
   id, `processed` set only after the subscription update, failed events retryable, and an
   unknown price or status drops entitlement to free with a reconciliation event
   (`billing.ts`, `subscriptionPolicy.ts`)
14. Operator-only writes are internal functions (`seedPlans`, `grantPlanByEmail`, the
   billing internals, `backtest.getBotInternal`), verified against the deployment with
   `bunx convex function-spec` — the generated `api` object lists internal functions too and
   cannot be used to prove visibility

## Audit and integrity documents

| Document | Contents |
| --- | --- |
| `ARISE_MASTER_AUDIT.md` | Findings by severity, evidence, repaired vs open items, acceptance gates, verification results |
| `ARISE_REPAIR_REPORT.md` | Per-defect root cause, fix, regression test, behaviour changes, schema notes, commands |
| `ARISE_SECURITY_MODEL.md` | Trust boundaries, authn/authz rules, public vs internal function surface, admin bootstrap, secrets, webhook trust, audit records |
| `ARISE_MARKET_DATA_AND_RISK.md` | Provider provenance, the single candle-validation contract, data-quality states, risk-engine authority, simulated-execution accounting |
| `ARISE_WALK_FORWARD_VALIDATION.md` | Out-of-sample methodology, candidate selection, leakage prevention, cost model, fold-boundary policy, fitness gates, limitations |
| `SECURITY.md` | Durable paper-only invariants, secret inventory and rotation |

## Known limitations (V1, honest)

- Agents are deterministic heuristic engines (`heuristic-v1`), not LLMs — structured, auditable,
  and cheap by design; an `AIProvider` abstraction point exists for future LLM layers.
- The **News AI** (`news-v1`) reads real headlines from public keyless publisher feeds
  (CoinDesk, The Block, Cointelegraph, Decrypt, InvestingLive, Investing.com) fetched by
  `src/convex/arise/news.ts`. Scoring is a fixed, exported lexicon — no LLM, no synthesis — so
  every score cites the headline and source that produced it. Fail-closed rules: undated items
  are excluded (age cannot be assumed), coverage beyond the freshness horizon makes the
  assessment `STALE`, and no usable coverage makes it `UNAVAILABLE` with a null score — never a
  guessed sentiment. An absent news layer is **not** a veto: the news agent returns NEUTRAL with
  zero confidence and contributes no directional weight. A dedicated **Macro model** (rates,
  inflation nowcasting, positioning data) is still **not implemented**.
- Feeds are third-party and can block, rate-limit or change shape; each feed fails in isolation
  and the dashboard discloses per-feed health instead of hiding the gap.
- FX has no top-of-book (Yahoo limitation): spread checks treat it as unavailable, not zero.
- Equity marks open positions at entry price between decisions.
- Backtesting, multi-project strategies, and learning-weight updates are out of V1 scope.

## Development

```bash
bun install
bun convex dev --once && bun tsc -b --noEmit   # verify backend + types
```

The platform runs the dev server and Convex dev processes; do not run them manually.

## Configuration (verified semantics)

| Variable | Purpose |
|---|---|
| `VITE_CONVEX_URL` | Convex **client** URL. Local: `http://127.0.0.1:3210`; hosted: `https://<deployment>.convex.cloud`. Public configuration, not a secret. |
| `CONVEX_SITE_URL` | Convex **HTTP Actions / site** origin. Convex Auth uses it as the OIDC issuer domain for the deployment's own tokens. Local: `http://127.0.0.1:3211`; hosted: `https://<deployment>.convex.site`. **Not** the frontend URL — pointing it at the Vite origin breaks sign-in, and `auth.config.ts` now fails with a clear message instead of an opaque auth error. |
| `SITE_URL` | Frontend origin, used only for links/redirects (Stripe return URLs, emails). |
| `CONVEX_DEPLOYMENT` | Deployment selected by `bunx convex dev` (`local` for the in-sandbox backend). |

Optional integrations (`STRIPE_*`, `ARISE_ADMIN_CODE`, `DELTA_*`, `EMAIL_OTP_API_KEY`) stay disabled
when unset. Nothing in this repository contains a real secret.

## Data-quality states and gating

`validateBars` produces `valid` or `degraded`; freshness adds `stale`/`invalid`. Rules:

- an **unexplained gap** (missing candle inside an open session) and any removed structurally
  invalid bar degrade the snapshot;
- the documented **FX weekend closure** (Fri 17:00 → Sun 17:00 **America/New_York**, so the UTC
  boundary follows daylight saving) is not a defect — no holiday calendar is integrated,
  so holiday gaps still degrade (conservative);
- a >8σ return is reported as a note but does **not** invalidate data (a real crypto move is not
  corruption);
- `degraded` snapshots produce a `WAIT`, never a `TRADE` (`DATA_QUALITY_DEGRADED`), so a high
  signal score cannot override missing information.

## Authorization

All server checks resolve the caller from the verified identity (`convex/lib/authz.ts`):
`requireAuthenticatedUser`, `requireActiveUser`, `requireActiveAdmin`. Administrative endpoints
require an **active** administrator — a disabled admin is rejected everywhere. Client-supplied user
IDs or roles are never trusted; ownership is checked against the authenticated user.

The complete public-endpoint inventory (every query/mutation/action and its requirement) is in
[`ARISE_AUTHORIZATION_MATRIX.md`](./ARISE_AUTHORIZATION_MATRIX.md).

## Settlement authority

A manual close names only the position. The server resolves the instrument from the position,
fetches a 5m series, validates it with the same candle contract as every other consumer, and
selects the newest **completed** bar (never a forming, future or stale bar). A fallback provider
or interval is refused rather than relabelled — a Delta demo perpetual cannot settle a Binance
spot position. Settlement runs through one idempotent path and re-validates the bar. If no trustworthy price exists the close fails with
`CLOSE_PRICE_UNAVAILABLE` and the position stays open; the UI shows the error and never a false
success.

## Delta demo guard

Authenticated Delta calls accept only the verified demo hostname `cdn-ind.testnet.deltaex.org`
(confirmed in Delta's official API docs and Python REST client as the India testnet REST base),
over HTTPS on port 443 (or implied), with no embedded credentials. Matching is exact — a hostname
that merely contains “testnet” is refused. The production host is always refused, host validation
runs before credentials are read, and authenticated requests refuse HTTP redirects so the
`api-key`/signature headers cannot be replayed to another origin.

## Verification commands

```bash
bun install --frozen-lockfile
bunx convex dev --once        # generates src/convex/_generated (anonymous local deployment)
bunx tsc -b --noEmit
bun run lint
bun run test                  # vitest: unit + in-memory Convex backend tests
bun run build                 # tsc -b && vite build
bun audit                     # dependency advisories
```

`bun.lock` is the lockfile of record. CI (`.github/workflows/ci.yml`) verifies a **clean checkout of
the committed source tree** — it does not extract the archive — on Ubuntu 24.04, and runs install,
typecheck, lint, tests, build and audit. Convex generated types under `src/convex/_generated/` are
committed so this needs no Convex login or local environment file; regenerate them with
`bunx convex dev --once` after adding or renaming a Convex function.

## Environment example

`.env.example` is host-protected in the repair sandbox, so the corrected values (in particular
`CONVEX_SITE_URL=http://127.0.0.1:3211`, **not** the Vite origin) are documented in
[`ENVIRONMENT.md`](./ENVIRONMENT.md), together with the precise limitation and a reviewable
workaround.

## Repository layout

This repository still tracks the application as `Arise-b-main-repaired.zip`; the verified source is
extracted at `Arise-b-main/`. The archive is the **pre-repair** snapshot, so CI must not be pointed
at it. [`MIGRATION.md`](../MIGRATION.md) is the reviewable plan for exposing the source at the
repository root (archive checksum, verification gates, history and rollback), to be executed from
the Changes panel in one reviewed commit.
