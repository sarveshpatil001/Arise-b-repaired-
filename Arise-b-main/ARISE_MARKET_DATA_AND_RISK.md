# ARISE V1 — Market Data, Data Quality, Risk Authority and Simulated Execution

This document records what the code actually does today for market data, data
quality, risk decisions and paper execution. Every claim below names the file and
symbol it comes from; no behaviour is described that was not read in the source.

ARISE V1 is **paper-trading only** (`src/lib/arise/execution.ts` —
`LIVE_TRADING_ENABLED = false`). Nothing in this document authorises order
execution, and no statement here should be read as a profitability claim.

---

## 1. Data provenance

One module owns provider access: `src/lib/arise/providers.ts`.

| Layer | Symbol | Behaviour |
|---|---|---|
| Symbols | `listSymbols()` | 5 crypto (`BTCUSDT`, `ETHUSDT`, `SOLUSDT`, `BNBUSDT`, `XRPUSDT`) + 4 FX (`EURUSD`, `GBPUSD`, `USDJPY`, `AUDUSD`). This list is the only symbol universe; `charts.ts` and `market.decide` reject anything else. |
| Primary routing | `resolveProvider(symbol)` | `*USDT` → `binance`; FX map hit → `yahoo`; otherwise `null` (caller must reject). |
| Crypto | `fetchBinance()` | Public REST klines + `bookTicker`. Hosts tried in order: `api.binance.com`, `data-api.binance.vision`, `api.binance.us` (`BINANCE_HOSTS`). Top-of-book is best-effort: a missing ticker never fails the bar fetch, and an unparsable/zero/crossed ticker yields `bestBid = bestAsk = null`. |
| FX | `fetchYahoo()` | Yahoo chart API, `YAHOO_INTERVAL` per interval; null slots (market closed) are skipped. |
| Fallback | `fetchDelta()` | Delta Exchange **demo/testnet** public feed, crypto only. Used only after the primary provider fails. |
| Resampling | `resampleBars()` / `resampleForInterval()` | `4h`/`1d` are rebuilt from `1h` bars (epoch-aligned buckets: open=first, high/low=extremes, close=last, volume=sum) rather than relabelled. |

Provider health: `guarded()` wraps every fetch with a per-provider circuit
breaker — `BREAKER_THRESHOLD = 4` consecutive failures opens it for
`BREAKER_COOLDOWN_MS = 60_000`, after which it is `HALF_OPEN` (one attempt).
Every HTTP call uses `TIMEOUT = 10_000`.

`fetchMarketData(symbol, interval, limit)` is the only public entry point. It
returns `MarketFetch`: the bars, the interval the provider **actually resolved**,
`fellBack`, `fallbackFrom`, and the accumulated `errors[]`. Fallback order is:
primary at the requested interval → Delta (crypto) → `1h` resampled to `4h`/`1d`
→ `15m` (with `interval` rewritten to `"15m"`). If everything fails it throws with
all collected errors — there is no synthetic-data path anywhere.

Provenance travels with the data:

- `buildSnapshot(..., source: fetched.data.provider)` stores the provider on
  `MarketSnapshot.source`.
- `market.decide` persists `dataSource`, `dataTimestamp`, `dataAgeSec` and
  `snapshotMeta.source` / `snapshotMeta.fallback` /
  `snapshotMeta.fallbackFrom` on every decision row
  (`src/convex/arise/market.ts`, `decisions.record` call).
- `charts.candles` returns `source`, `fellBack` and `fallbackFrom` to the caller.

### Documented inconsistency (see §7)

`src/lib/arise/validate.ts` sets each `Bar.source` from the *symbol suffix*
(`opts.symbol.includes("USDT") ? "binance" : "yahoo"`), not from the provider that
actually answered. The authoritative provider is the separate `source` value the
callers pass into `buildSnapshot`, so a bar that came from the Delta fallback is
labelled `"binance"` on the bar itself while the snapshot correctly says
`"delta"`. The Decision Detail / decision record surface the latter.

---

## 2. The single candle-validation contract

`src/lib/arise/validate.ts` is the authoritative validation path. It is exported
as two functions and is called through `buildSnapshot()`
(`src/lib/arise/pipeline.ts`), which is what `market.decide` and `charts.candles`
use — so candles shown in the chart are the same bars a decision is made from.

**`validateBars(raw, { symbol, assetClass, interval, now, config })`** performs, in order:

1. **Ordering** — bars are sorted ascending by `time` before anything else.
2. **Duplicate timestamps** — later duplicates are dropped; `duplicateCount` is
   reported.
3. **Structural validity** — removed when any check fails: positive finite
   `time/open/high/low/close` (`isPosNum`), `high >= low`,
   `high >= max(open, close) - 1e-9`, `low <= min(open, close) + 1e-9`,
   `volume >= 0`.
4. **Gaps** — a step over `1.5 × intervalMs(interval)` counts as a gap
   (`gapCount`).
5. **Outliers** — per-bar returns whose z-score exceeds 8σ are counted
   (`notes`).
6. **Quality** — `removedCount > 0` ⇒ `"degraded"`, else `"valid"`.

**`assessFreshness(bars, { interval, now, config, bestBid, bestAsk })`** performs:

1. **Empty** — no bars ⇒ `quality: "invalid"`, `quoteAgeSec: Infinity`.
2. **Bar age** — `barAgeSec > intervalSeconds × config.barStaleMultiplier`
   (default `3`) ⇒ `"stale"`.
3. **Sample size** — `bars.length < config.minBars` (default `120`) ⇒
   `"degraded"`.
4. **Top-of-book sanity** — a present but non-positive or crossed book ⇒
   `"invalid"`.
5. Otherwise `"valid"`.

`buildSnapshot` combines the two: the snapshot is `"valid"` only when both stages
say `"valid"`; any `"invalid"` from freshness wins; otherwise the weaker of the
two. Zero usable bars ⇒ `snapshot: null, errorCode: "NO_VALID_DATA"`, and
`market.decide` throws `DATA_INVALID` rather than proceeding.

**Consumers of the contract**

- `src/convex/arise/market.ts` `decide` — via `buildSnapshot` for the decision
  symbol *and* for every symbol needed to mark open positions (feeds
  `trading.markAccount` and `markedEquity`).
- `src/convex/arise/charts.ts` `candles` — via `validateBars` before returning
  bars to the UI.
- `src/convex/arise/monitor.ts` `fetchMonitorMark` — via `validateBars`; an empty
  result means "no data", and the position is simply skipped.
- `src/lib/arise/risk.ts` `evaluateRisk` — consumes `dataQuality` and the quote
  age through `isFresh`, rather than trusting the caller.

**The freshness vocabulary is centralised** in `src/lib/arise/freshness.ts`:
`MARK_POLICY` (completed 15m bars, stale after `3 × 15m = 45m`),
`CLOSE_POLICY` (5m bars, stale after `3 × 5m = 15m`) and
`DECISION_DATA_POLICY(multiplier, interval)`. `isFresh()` returns
`FRESH | STALE | INVALID` and treats a **negative age (future-dated mark) as
INVALID**, never as fresh.

---

## 3. Data-quality states and trading eligibility

| State | Produced when | Effect on eligibility |
|---|---|---|
| `valid` | shape clean, fresh, enough bars, sane book | may proceed |
| `degraded` | bars were removed, or fewer than `minBars` | `risk.DATA_VALID` **passes** for `"degraded"`; the evidence gate and other risk rules still apply |
| `stale` | last bar older than `barStaleMultiplier × interval` | `risk.DATA_VALID` fails ⇒ `VETOED`, `approvedPositionSize: 0` |
| `invalid` | no bars, crossed/invalid top-of-book, future-dated mark | `risk.DATA_VALID` fails ⇒ `VETOED` |

Fail-closed paths around the data:

- Provider failure ⇒ `MARKET_DATA_UNAVAILABLE`, no decision row, no execution.
- Snapshot failure ⇒ `DATA_INVALID`, no execution.
- Missing/fresh-less marks for any open position or for the traded symbol ⇒
  `markedEquity().complete === false` ⇒ a synthetic `MARKS_UNAVAILABLE` risk
  check is appended and the decision is **forced to `VETOED`** with
  `approvedPositionSize: 0` (`src/convex/arise/market.ts`). The mark veto is
  applied before the evidence verdict, so nothing downstream can widen it.
- News is never a veto and never invented: a failed feed is recorded as
  `NEWS_FETCH_FAILED` / `NEWS_FEED_DEGRADED` and the decision proceeds with the
  news agent `UNAVAILABLE` and zero directional weight.

---

## 4. Risk-engine authority

`src/lib/arise/risk.ts` `evaluateRisk()` is deterministic, labelled
`engineVersion: "risk-v1"`, and runs in `runDecisionPipeline` before any
execution decision. Every rule is appended to `checks[]`; **any** failing check
vetoes and returns `approvedPositionSize: 0`.

Rules, in order (thresholds from `DEFAULT_CONFIG`, `src/lib/arise/config.ts`):

| Rule | Condition to pass | Default thresholds |
|---|---|---|
| `EMERGENCY_STOP` | not active | — |
| `INPUT_VALID` | finite, positive entry price, equity, ATR; finite `notionalPerBar ≥ 0` | — |
| `DATA_VALID` | `dataQuality` is `"valid"` or `"degraded"` | — |
| `DATA_FRESH` | `isFresh(...)` under `DECISION_DATA_POLICY(barStaleMultiplier, interval)` | `barStaleMultiplier = 3` |
| `MAX_DAILY_LOSS` | daily loss `<` limit | `maxDailyLossPct = 3` |
| `MAX_DRAWDOWN` | drawdown from high-water mark `<` limit | `maxDrawdownPct = 10` |
| `ANOMALY_GATE` | level rank (from `ANOMALY_LEVEL_RANK`) `<=` the configured ceiling; an unrecognised level never passes | `maxAnomalyLevelForTrade = "WATCH"` |
| `MAX_SPREAD` | `spreadPct === null` or `<=` limit | `maxSpreadPct = 0.15` |
| `MIN_LIQUIDITY` | `notionalPerBar >=` minimum | `minLiquidityNotional = 0` |
| `POSITION_COUNT` | fewer than 5 open positions | literal `5` |
| `GROSS_EXPOSURE` | remaining headroom `>=` `maxPositionPct × 0.25` | `maxGrossExposurePct = 60`, `maxPositionPct = 15` |
| `BALANCE` | `balance > 0` | `startingBalance = 10_000` |

Sizing (`buildTradePlan`): stop distance is `clamp(ATR14 × 1.5, 0.4% … 6% of
entry)`, risk per trade `riskPerTradePct = 0.5%` of equity, hard-capped by
`maxPositionPct = 15%` notional, then multiplied by MIND's
`positionSizeRecommendation` and capped again by gross-exposure headroom, floored
to 6 decimals. A non-finite ATR returns `null` (no plan) instead of propagating
NaN; a size that rounds to zero returns `SIZE_TOO_SMALL`.

Why AI cannot override it: MIND only *recommends* a direction and a size
multiplier. `evaluateRisk` treats a WAIT/FLAT MIND as `MIND_ACTIONABLE` failure,
and `validateExecution` separately rejects non-finite price/quantity and a wide
spread. `market.decide` never executes when `riskDecision.decision === "VETOED"`,
and both the deterministic evidence gate (`src/lib/arise/evidence.ts`) and the
marks veto can only *lower* a verdict. Risk is never consulted for permission —
only for veto.

---

## 5. Simulated execution accounting

**Fills** — `src/lib/arise/execution.ts` `PaperBroker.submitOrder()` performs no
network I/O. It rejects a repeated `idempotencyKey` inside the instance, rejects
non-finite/`<= 0` quantities explicitly (`NaN <= 0` is false, so finiteness is
checked rather than ordering), and otherwise fills at the adverse side
(LONG → ask, SHORT → bid, falling back to last close) times
`1 ± PAPER_SLIPPAGE_BPS / 10_000`, with `PAPER_TAKER_FEE_BPS = 4` (0.04%) charged
on the filled notional. `LIVE_TRADING_ENABLED` is a hard lock; the branch that
would submit a live order is unreachable and returns `FAILED` if it somehow were.

**Durable duplicate-fill guard** — `src/convex/arise/trading.ts`
`openPosition` takes `idemKey` and looks it up through the `positions.idemKey`
index *inside the mutation* before doing any work; a hit returns
`{ duplicate: true }` with the original position id and **no** balance change.
`market.decide` derives the key deterministically as
`p:{userId}:{symbol}:{interval}:{latestBarTime}`, so one candle can never open two
positions, including across retries and concurrent requests. The broker's
in-memory set is deliberately *not* relied on (a new broker is constructed per
request — documented in the schema comment for `idemKey`).

**Open** — `applyOpen(balance, entryFee) = balance - entryFee`; the account
anchors (`dayKey`, `dayStartEquity`, `equityHighWaterMark`) are refreshed only
when the mark set is complete (`markedEquity().complete`).

**Equity marks** — `src/lib/arise/ledger.ts` `markedEquity()` values each open
position with its fresh completed mark, and for a symbol without a fresh mark it
falls back to **entry price** (no unrealised P&L) and adds the symbol to
`usedFallback`, setting `complete: false`. `prepareLedgerAccount()` rolls the UTC
day and ratchets the high-water mark **only when complete** — an incomplete mark
set can never inflate the HWM or reset the daily anchor.

**Close** — one implementation, `src/lib/arise/settlement.ts` `settleClose()`:
re-reads the position in the same serialized mutation, returns
`ALREADY_CLOSED` unless `status === "OPEN"`, throws on a non-finite/non-positive
exit price, computes `exitFee` server-side at `PAPER_TAKER_FEE_BPS`, and writes
`status/closedAt/exitPrice/exitReason/pnl/exitFee` plus the new balance and
anchors. P&L is `closePnl()` = `(exit - entry) × qty` for LONG (inverted for
SHORT) minus both fees.

**Manual close cannot invent a price** — `src/convex/arise/trading.ts`
`closePosition` requires `price` *and* `priceTime` from the caller and rejects the
request unless `validateClosePrice()` (`src/lib/arise/freshness.ts`) accepts it
under `CLOSE_POLICY`: positive finite price, real 5m bar timestamp, not
future-dated, and either a fresh completed 5m bar (`≤ 3 × 5m = 15m` old) or the
genuinely current forming bar. A caller with no real bar gets
`INVALID_CLOSE_PRICE` and the position stays open
(`src/lib/arise/closePrice.test.ts` pins the accept/reject matrix, including the
invented-price attack).

**Monitor closes** — `src/convex/arise/monitor.ts` `applyExit` is an
`internalMutation` that re-reads the position and applies only while it is still
`OPEN` (`applyExitToPosition` gate), then settles through the same
`settleClose`/ledger path. `checkExit()` evaluates SL/TP on validated bar
extremes with **stop priority** when one bar touches both; a gapped stop is
booked *at the stop price* — a documented simulation optimism, not a guarantee.

**Bounded work in this area**

- `trading.ts` `closedPositions` — newest-first bounded read
  (`MAX_CLOSED_POSITIONS = 500`, default `100`) instead of loading all history.
- `trading.ts` `latestMarks` — descending scan capped at `MARK_SCAN_LIMIT = 120`
  decisions.
- `charts.ts` `candles` — `DEFAULT_CANDLES = 300`, `MAX_CANDLES = 1000`.
- `monitor.ts` — `MAX_POSITIONS_PER_TICK = 25` OPEN positions per tick via a
  persisted `openCursor`, `BARS_FOR_MONITORING = 3`, `TICK_HISTORY = 10`,
  `CLAIM_EXPIRY_MS = 5 * 60_000` for stale-lease takeover; the `position-monitor`
  cron runs the lease-guarded entry point `monitor.guardedTick` every 2 minutes
  (`src/convex/crons.ts`).

---

## 6. Where each guarantee is enforced (quick reference)

| Guarantee | Enforced in |
|---|---|
| No synthetic prices, ever | `providers.ts` (throws when every source fails) |
| One validation contract | `validate.ts` via `pipeline.buildSnapshot` |
| Future-dated data is never fresh | `freshness.ts` `isFresh` (`ageMs < 0` ⇒ `INVALID`) |
| Unknown risk state fails closed | `risk.ts` (`INPUT_VALID`, `DATA_VALID`, `DATA_FRESH`) |
| Only risk-approved size reaches the broker | `market.ts` (`min(approvedPositionSize, plan.positionSize)`) |
| One position per candle | `trading.ts` `idemKey` + `positions.idemKey` index |
| One close per position | `settlement.ts` `settleClose` status guard |
| Manual exit price must be a real bar | `freshness.ts` `validateClosePrice` from `trading.closePosition` |
| Marks unavailable ⇒ no trade, no HWM move | `market.ts` marks veto; `ledger.ts` `prepareLedgerAccount` |
| Live trading impossible | `execution.ts` `LIVE_TRADING_ENABLED = false`; `delta.ts` `requireDemoTrading` + testnet-only host check |

---

## 7. Gaps / not implemented

Verified absences, not speculations:

1. **No request rate limiter on the market-data entry points.** `charts.candles`
   requires authentication, validates symbol/interval/limit, and has no quota of
   any kind. `market.decide` has only the *daily* plan quota
   (`analysisLimitPerDay` via `myEntitlementsInternal`, plus account-disabled and
   platform-halt guards). A signed-in caller can therefore issue repeated candle
   requests or analyses within a day and consume provider quota; the per-provider
   circuit breaker limits damage only after 4 consecutive failures.
2. **No market-session / calendar validation.** `validateBars` and
   `assessFreshness` contain no session or weekend logic. FX weekend gaps are
   *counted* (`gapCount` + note) but **gaps alone do not change `quality`** — only
   structurally removed bars do. A long gap can therefore be reported as
   `"valid"` as long as the last bar is fresh.
3. **Fallback data is recorded, not gated.** `snapshotMeta.fallback` /
   `dataSource` record that the Delta demo feed or a resampled `15m` series
   answered, but nothing in `risk.ts`, `evidence.ts` or `market.decide` forbids a
   decision on fallback-derived data as long as validation and freshness pass.
4. **The mark rule is re-implemented in the action path.** `marks.ts` provides the
   pure `selectCompletedMark` / `loadMarks` / `shouldUpsert` layer (tested by
   `marks.test.ts`), but `market.decide` and `monitor.fetchMonitorMark` each
   re-derive "last completed bar + `isFresh`" inline instead of calling it, so the
   single-source-of-truth property holds for the *policy* constants only.
5. **Bar-level `source` is inferred from the symbol suffix** in `validate.ts`
   (`"binance"` vs `"yahoo"`), which contradicts the true provider for
   fallback-served data (see §1).
6. **`config.staleDataSec` is not read by `risk.ts`** — quote-age freshness there is the
   shared `DECISION_DATA_POLICY(barStaleMultiplier, interval)`, while `staleDataSec` is
   consumed by the evidence ledger (`evidence.ts`) instead. The anomaly gate *does* read
   `config.maxAnomalyLevelForTrade` (rank-compared against `ANOMALY_LEVEL_RANK`, unknown
   level ⇒ veto). The position-count limit is still a literal `5` with no config field.
7. **`spreadPct === null` is not a veto** (explicitly documented in
   `SECURITY.md`); a missing book passes `MAX_SPREAD` with a note.
8. **`degraded` data can still trade.** `DATA_VALID` accepts `"degraded"`; the
   documented meaning of `"degraded"` includes bars that were dropped as
   structurally invalid.
9. **The Delta demo mirror is observability only.** `delta.mirrorOrder` is
   best-effort and testnet-only; a failure is recorded as a system event and never
   blocks or alters a paper trade. Nothing verifies the mirrored order's outcome,
   and no reconciliation of mirrored vs paper state exists.
10. **Monitoring coverage is page-based, not real-time.** Positions are evaluated
    once per 2-minute tick in pages of 25, with data fetched at `15m`; a
    stop/target can therefore be acted on up to a tick later than the bar that
    touched it.
11. **No dependency or provider-contract verification** is performed on provider
    payloads beyond the structural checks listed in §2 (no schema validation, no
    exchange-vs-candle consistency check).
12. **Everything above is paper.** No arithmetic in `ledger.ts`, `settlement.ts`,
    `execution.ts` or `trading.ts` has been tested against a live venue, and the
    simulated fill/stop assumptions in `SECURITY.md` (no exchange-side stops,
    gapped stops booked at the stop price, modelled slippage) remain the dominant
    sources of optimism in any future P&L claim.
