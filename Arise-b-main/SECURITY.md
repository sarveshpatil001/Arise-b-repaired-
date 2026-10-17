# ARISE V1 — Security, Secret Management & Paper-Only Contract

This document is the durable record of the security posture audited in Phase 1
(security audit, build stabilisation, paper-only lockdown). Read it before
handing a deployment to anyone else.

## 1. Scope and hard invariants

ARISE V1 is **paper-trading only**. The following are enforced in code, not by
convention:

| Invariant | Enforced in |
|---|---|
| No real-money order can be submitted | `src/lib/arise/execution.ts` — `LIVE_TRADING_ENABLED = false`; `PaperBroker` performs no network I/O |
| The only order-submitting path can never reach a live exchange | `src/lib/arise/delta.ts` — `requireDemoTrading()` requires `DELTA_TRADING_MODE === "demo"`; `resolveDeltaOrderBaseUrl()` refuses any authenticated call whose host is not a testnet host (production host is explicitly rejected) |
| No MT5 / MetaTrader execution exists | Audited: no MT5 code is present in the repository at all |
| Missing/invalid risk input cannot authorise a trade | `src/lib/arise/risk.ts` — `INPUT_VALID` fails closed on non-finite price/equity/ATR; `buildTradePlan` returns `null`; `validateExecution` rejects non-finite quantities and prices |
| Only risk-approved size reaches the paper broker | `src/convex/arise/market.ts` — `approvedQty = min(riskDecision.approvedPositionSize, plan.positionSize)` |
| A position can be opened once per execution key | `src/convex/arise/trading.ts` `openPosition` — durable `idemKey` guard backed by the `positions.idemKey` index |
| A position can be closed exactly once | `src/lib/arise/settlement.ts` `settleClose` — re-reads `status !== "OPEN"` inside the same serialized mutation |
| Emergency stop blocks new entries | `risk.ts` `EMERGENCY_STOP`; `market.decide` refuses when `paperAccounts.emergencyStop` is set |
| Manual close price cannot be invented | `src/lib/arise/freshness.ts` `validateClosePrice` (CLOSE_POLICY: fresh 5m bar) called from `trading.closePosition` |
| The evidence gate can only lower a verdict | `src/lib/arise/evidence.ts` `evaluateDecisionGate` (TRADE → WAIT → REJECT, reason codes); `market.decide` stores the outcome and any non-TRADE result is not executed |
| External text cannot redefine system policy | `src/lib/arise/untrusted.ts` `sanitizeUntrusted` runs on every ingested headline/summary (`news.ts` `parseFeedXml`, `assessNews`); flagged items stay data and cannot authorize an action |
| An unproven strategy cannot be promoted | `src/lib/arise/strategyFitness.ts` `FITNESS_POLICY` / `promotionDecision` — every gate must pass, unmeasured evidence fails closed, and `requiresHumanApproval` stays true; the gate report is stored on `backtestRuns.fitnessGates` |
| Learning cannot touch risk, execution, security or secrets | `src/lib/arise/learning.ts` `FORBIDDEN_TARGETS` / `SAFETY_LIMITS` / `TRANSITIONS`; `src/convex/arise/learning.ts` re-validates on apply and is operator/admin-only |
| A complimentary seat cannot be claimed by another account | `billingFunctions.ts` `resolveEntitlements` matches `planGrants` against the signed-in account's **own** email read from `users` (never a caller-supplied value); `grantPlanByEmail` / `revokePlanGrant` are `internalMutation`s, so no browser can call them, and an unknown plan key in a stored row is ignored rather than trusted |
| A paid plan is never masked by a grant | `resolveEntitlements` checks the active Stripe subscription first and only falls back to a grant; the Billing screen labels a grant `GRANTED SEAT` |
| `APPLIED` needs a real evaluation, not a click | `src/convex/arise/learning.ts` `advance` — `completedAt` is **server-stamped** and only when the caller attests a pass *and* names an evaluation reference; no reference ⇒ `EVALUATION_NOT_COMPLETED` |
| A Stripe event is applied once and never silently lost | `billing.ts` `stripeWebhook` + `billingFunctions.ts` `internalClaimEvent` — one atomic claim per event id (`CLAIMED`/`DUPLICATE`/`IN_FLIGHT`→409/`ABANDONED`); `processed` is set only by `internalMarkEventProcessed` after the business update, and a failed attempt stays retryable with a 5-minute stale-lease recovery |
| An unknown price or status never keeps a paid plan alive | `src/lib/arise/subscriptionPolicy.ts` `resolveSubscriptionPlan` (unknown price ⇒ free + reconciliation event; terminal status ⇒ free; recoverable status ⇒ plan remembered, not entitled) |
| Operator-only writes are `internalMutation`s | `seedPlans`, `grantPlanByEmail`, `revokePlanGrant`, every `internal*` billing function, `backtest.getBotInternal` — verified against the deployment with `bunx convex function-spec`, not against the generated `api` object |
| Bootstrap cannot be raced or reopened | `billingFunctions.ts` `bootstrapAdmin` — correct `ARISE_ADMIN_CODE` **and** no existing admin **and** no `bootstrapState` closure row, with the role patch and closure insert in one serialized mutation |
| Telemetry cannot leak per-user detail to a non-admin | `system.ts` `list` — fixed field projection, `EXECUTION`/`BILLING` message bodies replaced for non-admins, newest-first database-level page capped at 200, table-wide retention trim bounded by the cap |
| A stricter risk configuration is actually enforced | `risk.ts` `ANOMALY_LEVEL_RANK` + gate 6 — the anomaly ceiling comes from `config.maxAnomalyLevelForTrade`; an unrecognised level is never treated as safe |

### Simulation assumptions (never present these as guaranteed fills)

1. **No exchange-side stops exist.** Every stop-loss and take-profit is evaluated
   locally on bar extremes (`checkExit`) and booked at the stop/target level.
   There is no exchange-enforced stop, so a gapped market is filled *at the stop
   price* in the simulator — real fills would be materially worse.
2. **Fills are modelled, not matched.** Paper fills cross the spread adversely and
   add `PAPER_SLIPPAGE_BPS`; they are not real order-book matches.
3. **A missing spread is not vetoed.** `risk.ts` passes `spreadPct === null` with an
   explicit note (quote books do not exist for every instrument). Changing this to
   fail closed is a risk-parameter decision, not a bug fix.
4. **Unusable data means "no evaluation", never a fabricated price.** Stale,
   incomplete or structurally invalid bars cause skips (`assessMark`) and the
   position simply stays open.
5. **The monitor is bounded per tick.** Each tick evaluates one page of 25 OPEN
   positions and advances a persisted cursor, so every position is reached within
   ⌈N/25⌉ ticks rather than being starved behind a fixed slice.
6. **Delta is a demo mirror.** Best-effort, testnet-only, never blocks or alters a
   paper trade. A failure there is observability noise, not an execution path.

## 2. Secret inventory and rotation

Secrets live **only** in the deployment environment (Convex env / the project's
Keys tab). No secret value is committed, logged, or printed — error messages name
the *variable*, never the value.

| Variable | Purpose | Rotation |
|---|---|---|
| `EMAIL_OTP_API_KEY` | freebuff OTP mailer for sign-in codes | Revoke at the issuing provider, then set the new value in the Keys tab. Until replaced, sign-in falls back to the Vly email integration automatically. |
| `VLY_INTEGRATION_KEY` | Vly gateway (email/AI) deployment token | Rotate at the Vly/freebuff dashboard, update the Keys tab, then redeploy (`bunx convex dev --once`). |
| `DELTA_API_KEY` / `DELTA_API_SECRET` | Delta **demo** account mirror | Regenerate the demo key pair in Delta's testnet UI. Demo keys carry no real funds, but revoke anyway if a value may have leaked. |
| `ARISE_ADMIN_CODE` | one-time first-admin bootstrap code | Only accepted while no admin exists **and** no `bootstrapState` closure row is present, so the code is useless after setup. Treat a leaked code as an admin-takeover risk during first setup: rotate it immediately and verify `users.role` has exactly the intended admins. |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | billing (optional) | Roll the key in the Stripe dashboard; the webhook secret must be re-set or signature verification will fail closed (by design). |
| `CONVEX_DEPLOY_KEY` (CI) | deploy automation | Regenerate in the Convex dashboard. |
| `.env.keys` (local file) | dotenvx decryption key | **Not for version control.** Rotate with the dotenvx tooling, and re-encrypt any file that depended on the old key. |

**Revocation is a provider-side action.** This repository can remove a secret from
the tree, but only the provider can revoke one — do not consider a credential
rotated until the provider confirms revocation *and* the new value is deployed.

## 3. Repository hygiene

- `.gitignore` excludes `.env`, `.env.*` (except the placeholder `.env.example`),
  `.env.keys`, `*.pem`, `*.p12`, `*.key` and distributable archives (`*.zip`, `*.tar`).
- `.env.example` contains placeholders with empty values only; it is the single
  sanctioned place to document a variable name.
- Test files live **outside** `src/convex/` on purpose: the Convex bundler walks
  that directory and would otherwise bundle `vitest` into the deployment.
- `src/convex/_generated` is generated (and ignored); never hand-edit it.

## 4. Verifying the current state

```bash
bunx convex dev --once && bunx tsc -b --noEmit   # backend codegen + types
bun run lint                                     # eslint
bunx vitest run                                  # full suite (no network, no live prices)
bun run build                                    # production bundle
bunx convex function-spec                        # public vs internal surface (see ARISE_SECURITY_MODEL.md §3/§4)
```

The suite deliberately contains **no live calls**: auth/authorization, durable
idempotency, monitor coverage and paper-only invariants run against an in-memory
Convex backend via `convex-test`, and all market data in tests is a deterministic
fixture.
