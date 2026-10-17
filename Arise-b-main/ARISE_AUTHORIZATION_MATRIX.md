# ARISE — Public endpoint authorization matrix

Verified against the actual handlers in `src/convex/` on 2026-10-17. "Public" means
reachable from a client (Convex `query` / `mutation` / `action`); `internal*`
functions are listed only where they carry a settlement or authorization decision.

Legend for requirements:
- **active user** — authenticated identity, existing user row, `disabled !== true`
  (`requireActiveUser` / `internal.arise.trading.activeViewer`)
- **active admin** — the above plus `role === "admin"` (`requireActiveAdmin`)
- **operator** — `role` is `admin` or `operator` and not disabled
- **own** — reads only rows whose `userId` is the authenticated user; anonymous
  callers get `null`/`[]`, never another user's row

| Module | Endpoint | Kind | Requirement | Ownership / notes |
| --- | --- | --- | --- | --- |
| users | `currentUser` | query | authenticated (optional) | returns own row, or `null` |
| backtest | `create` | mutation | active user | bot stored under caller's `userId` |
| backtest | `list`, `runs`, `get` | query | own | `runs(botId)` verifies bot ownership, otherwise returns `[]` |
| backtest | `runTest` | action | active user | bot ownership + plan entitlement; disabled rejected |
| backtest | `adminRuns` | query | **active admin** | platform-wide; fixed in this pass (previously ignored `disabled`) |
| learning | `propose`, `advance`, `rollback` | mutation | operator | disabled rejected; policy lives in `lib/arise/learning.ts` |
| learning | `list`, `byProposalId` | query | operator | read-denied to analysts/users by design |
| system | `list` | query | authenticated | `EXECUTION`/`BILLING` bodies redacted for non-admins |
| admin | `platformStatus`, `overview`, `listUsers`, `recentAdminActivity`, `auditLog`, `agentMonitor`, `marketDataStatus` | query | **active admin** | platform aggregates; bounded scans |
| admin | `setTradingHalt`, `setUserDisabled`, `setUserRole`, `grantPlan` | mutation | **active admin** | audited; cannot disable self |
| billing | `listPlans` | query | public | static server-side plan definitions |
| billing | `mySubscription`, `myEntitlements` | query | own (auth optional) | free entitlements for anonymous |
| billing | `startCheckout`, `startPortal` | action | active user | plan key validated server-side; Stripe customer from own row |
| billing | `bootstrapAdmin` | mutation | active user + deployment code | one-time, permanently closed after first success |
| billing | `broadcast`, `adminStats`, `adminUsers`, `setUserRole`, `grantPlan` | mutation/query | **active admin** | legacy surface now also writes `adminAudit` and requires an existing target |
| trading | `myAccount`, `openPositions`, `closedPositions`, `latestMarks` | query | own (auth optional) | bounded reads |
| trading | `createAccount`, `resetAccount`, `setEmergencyStop` | mutation | active user | account resolved from identity |
| trading | `closePosition` | action | active user | position ownership re-checked; server prices the exit |
| trading | `activeViewer`, `positionForClose`, `settleCloseAt` | internal | service-internal | `settleCloseAt` re-validates the bar before settling |
| monitor | `adminStatus` | query | authenticated | platform status only (no per-user rows); documented, not admin-gated |
| charts | `candles` | action | **active user** | per-user quota; symbol/interval/limit validated first |
| news | `assess` | action | **active user** | third-party fetch on the deployment's behalf |
| delta | `accountSnapshot` | action | **active user** | reads the SHARED demo/testnet account (not user-owned); demo mode + host allowlist enforced |
| decisions | `list`, `byId`, `latest` | query | own | `byId` returns `null` for another user's decision |
| equity | `list` | query | own | own equity points |
| market | `decide` | action | active user | platform halt, plan entitlement, paper account, risk/evidence gates |

## Policy notes

- Reads of a user's own data remain available to a disabled account; every mutation
  and every provider-proxying or trading action is blocked. Disabling revokes the
  ability to act, not the ability to see one's own record.
- `delta.accountSnapshot` returns the deployment's single Delta demo account, not a
  per-user resource. It is gated to active accounts and demo mode, and must be
  re-scoped if Delta credentials ever become per-user.
- No client-supplied user id or role is trusted anywhere; ownership is always resolved
  from `getAuthUserId`.
