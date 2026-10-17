# ARISE V1 — Walk-Forward Validation and Strategy Fitness

Scope: how a strategy is measured out-of-sample in ARISE, what the fitness gates
require, what the resulting verdict does and does not authorise, and which parts of
the methodology are **not** implemented. Every claim below is tied to a symbol and
file that exists in this repository. Nothing here is a performance claim.

## 1. Where the methodology lives

| Concern | Module |
|---|---|
| Fold construction, candidate selection, out-of-sample measurement | `src/lib/arise/walkForward.ts` (`runWalkForward`, `defaultWFConfig`, `layoutFoldLayout`, `precheck`) |
| Per-window simulation engine (signals, fills, costs, equity) | `src/lib/arise/backtest.ts` (`runBacktest`, `strategySignal`, `enumerateCandidates`, `PARAM_SPACE`, `DEFAULT_BT_CONFIG`) |
| Admission decision from measurements | `src/lib/arise/strategyFitness.ts` (`evaluateStrategyFitness`, `FITNESS_POLICY`, `promotionDecision`) |
| Real-flow wiring (data fetch → engine → gates → persistence) | `src/convex/arise/backtest.ts` (`runTest`, `recordRun`) |
| Candle structural validity / freshness | `src/lib/arise/validate.ts` (`validateBars`, `assessFreshness`) |

The engine is pure: no network, no clock reads of its own (`runWalkForward` only
uses the `now` it is handed), and `deterministic: true` is part of its result.

## 2. Chronological split and fold structure

`layoutFoldLayout(n, cfg)` lays out index ranges over the completed bars, anchored
to the **newest** bars so the most recent evidence is always evaluated
(`base = n - (folds * testBars + trainBars)`):

- `ROLLING` (default): train `[base + i·test, base + i·test + train)`, test
  `[train.to, train.to + test)`.
- `EXPANDING`: train `[base, base + train + i·test)`, same test window.

In both, the test window starts strictly after the training window ends and the last
test window ends on the last completed bar. Each window is evaluated as an
**independent `runBacktest` call** with `inSamplePct: 0` (`windowConfig`), so every
trade inside a test window is out-of-sample with respect to the fold-level split. The
split boundary is therefore enforced at fold level, not inside a window.

Defaults (`defaultWFConfig`): `folds: 3`, `trainBars: 150`, `testBars: 60`,
`anchor: "ROLLING"`, `minBarsPerWindow: 60`. Requiring 150 + 3×60 = 330 completed
bars is why the Convex action fetches 400. `src/convex/arise/backtest.ts` `runTest`
passes `intervalMs(fetchedInterval)`, the run's cost/size settings, the seed and
`dataKind`.

## 3. Candidate selection and parameter tuning

- Candidates come from a fixed, small allow-list: `PARAM_SPACE` in
  `src/lib/arise/backtest.ts` (sma-cross: fast × slow, rsi-mean: rsiPeriod ×
  rsiOversold, arise-momentum: rocPeriod × momentumThreshold, buy-hold: none).
  `enumerateCandidates` is a deterministic cartesian product in declaration order,
  dropping degenerate combinations (e.g. `fast >= slow`).
- For each fold, every candidate is evaluated on that fold's **training window
  only**. The winner is chosen by a deterministic comparator chain: highest training
  return, then shallower drawdown, then fewer trades, then declaration order
  (`runWalkForward`).
- The selected candidate is then evaluated on the fold's test window, and that
  number — `WFFold.testReturnPct` — is what `foldReturnsPct`, `meanOosReturnPct`,
  `profitableFoldFraction` and `foldsForFitness` are built from.
- Training and test results are reported separately (`trainReturnPct` vs
  `testReturnPct` per fold) and are never collapsed into a single headline number.
- Every candidate (not just the winner) is also probed on the test window, so
  `WFResult.variants` is a parameter-fragility measurement rather than a restatement
  of the selection result.

## 4. Leakage prevention — what exists

| Mechanism | Where |
|---|---|
| Signals see closed history only (`closes[0..i]`) | `strategySignal` (`closes.slice(0, i + 1)`) |
| Entries and signal exits fill at the **next** bar's open | `runBacktest` (`data[i + 1].open`) |
| Test window contains no training bars (verified per fold) | `walkForward.test.ts` "keeps train and test windows strictly separated…" |
| Windows are independent runs, so no state, cache or position crosses a fold | `runWalkForward` per-window `runBacktest` calls |
| Future-dated bars are refused (`FUTURE_TIMESTAMP`) | `precheck` |
| Still-forming bars are dropped, and the drop is reported as a limitation | `precheck` (`usable = bars.filter((b) => b.time + cfg.intervalMs <= cfg.now)`) |
| Non-monotonic / duplicate timestamps are refused | `precheck` (`NON_MONOTONIC_TIMESTAMPS`, `DUPLICATE_TIMESTAMP`) |
| Determinism: seeded fill jitter, no wall-clock reads inside the engine | `mulberry32(c.seed)`; `now` is a parameter |
| Leakage evidence must be supplied to the gates, or they fail closed | `leakageGuard` in `evaluateStrategyFitness` |

Warm-up is handled implicitly: each window is a fresh run, so a strategy simply
produces no signal until its own guard is satisfied (`hist.length < slow + 2`,
`< n + 2`, etc.). No cross-fold indicator state exists because no state survives a
window.

## 5. Costs and execution assumptions actually modelled

`DEFAULT_BT_CONFIG` (`src/lib/arise/backtest.ts`): `feeBps: 4`, `slippageBps: 2`,
`positionPct: 15`, `stopPct: 1.5`, `targetPct: 3.0`, `allowShort: true`, `seed: 42`,
`startingEquity: 10_000`, `inSamplePct: 0.7`, `minBars: 120`.

- Fees are charged per side in bps on the trade's notional; the entry fee is deducted
  immediately and the exit fee on the fill's proceeds (`runBacktest`, `feesTotal`).
- Slippage is applied adversely per side, plus a deterministic ±1bp jitter.
- Stress scenarios multiply slippage by 5 (`high-cost`, `low-liquidity`), and
  `applyStress` also models `gap-down`, `vol-spike` and `low-liquidity` (volume ×0.2).
- `src/convex/arise/backtest.ts` records the **effective** slippage
  (`effectiveSlippageBps`) when a multiplying stress was applied, and the walk-forward
  config is built with the same figure.
- Not modelled: order-book depth, exchange fees tiers, spread crossing inside the
  backtest engine (the paper broker models spread; the historical engine does not),
  borrow/funding costs, and partial fills.

## 6. Fold-boundary policy

Positions open at the end of any window are closed by `runBacktest` at that window's
last close with `exitReason: "END_OF_DATA"`. Nothing is carried across a fold, and the
behaviour is reported in `WFResult.limitations`. The cost of the policy — a position
that would have continued is force-closed — is accepted rather than hidden, and is
pinned by the test "closes a position still open at a fold boundary at END_OF_DATA".

## 7. Data-quality handling

| Case | Behaviour |
|---|---|
| Empty input | `EMPTY_INPUT`, no folds |
| Non-finite / non-positive OHLC or volume | `INVALID_BAR` |
| OHLC ordering violated beyond a relative epsilon | `INVALID_OHLC` |
| Bar stamped after the supplied clock | `FUTURE_TIMESTAMP` |
| Equal consecutive timestamps | `DUPLICATE_TIMESTAMP` |
| Time going backwards | `NON_MONOTONIC_TIMESTAMPS` |
| Every bar still forming | `NO_COMPLETED_BARS` |
| Fewer completed bars than the layout needs | `INSUFFICIENT_BARS` |
| Gaps larger than 1.5× the nominal spacing | Counted and reported as a limitation; layout stays by **bar index**, so a gap widens the calendar span without moving the train/test boundary |
| Synthetic provenance | `SYNTHETIC_DATA` — refused before a single fold is computed |
| Unusable fold configuration | `INVALID_CONFIG` |

Refusals are explicit reason codes, never a silent empty verdict. Upstream,
`validateBars` separately removes duplicate timestamps and structurally invalid bars,
labels quality `valid`/`degraded`, and counts gaps and >8σ return outliers;
`assessFreshness` classifies the latest bar as `valid`, `degraded`, `stale` or
`invalid`.

Synthetic rejection reaches the real flow as follows: `runTest` accepts
`useSynthetic`, builds `syntheticBars`, records `dataKind: "SYNTHETIC"`, and passes
the same `dataKind` into `defaultWFConfig`. The engine refuses, so
`walkForward.ok === false`, `walkForwardFolds`/`parameterVariants` are `null`, and the
corresponding gates fail closed as blockers. A simulated series therefore cannot
qualify a strategy for real-market consideration.

## 8. Fitness gates and thresholds

`FITNESS_POLICY` (`src/lib/arise/strategyFitness.ts`), each with an explicit
`rationale`:

| Gate | Threshold |
|---|---|
| `DATA_ADEQUACY` | bar count ≥ `minBars` (critical) |
| `SAMPLE_SIZE` | ≥ 30 closed trades (critical) |
| `OOS_SAMPLE` | ≥ 10 out-of-sample trades (critical) |
| `OOS_EVIDENCE` | out-of-sample trades > 0 and both returns measured (critical) |
| `OVERFIT_DEGRADATION` | in-sample − out-of-sample ≤ 15pp, and not "in-sample positive, out-of-sample negative" (critical) |
| `LEAKAGE_GUARD` | look-ahead checked, next-open fills, deterministic seed (critical) |
| `COST_REALISM` | fees > 0 charged and slippage ≥ 0 with fee bps > 0 (critical) |
| `WALK_FORWARD_STABILITY` | ≥ 3 folds and ≥ 60% of folds positive |
| `PARAMETER_STABILITY` | ≥ 5 variants and spread ≤ 8pp |
| `MAX_DRAWDOWN` | ≤ 20% |
| `PROFIT_FACTOR` | ≥ 1.2 |
| `EXPECTANCY` | > 0 (exclusive) |

A missing or non-finite measurement is always a failure (`missing()` helper) and
always lands in `blockers` — absent evidence fails closed as a blocker, even for
gates whose *measured* failure is soft. `eligible` requires **every** gate to pass;
`blockers` lists failed critical gates plus every fail-closed unmeasured gate, which
is what drives demotion.

### What the positive verdict means

The literal string `ELIGIBLE_FOR_HUMAN_REVIEW` does not exist anywhere in this
repository. The equivalent outcome is:

- `evaluateStrategyFitness(...).eligible === true` with `blockers: []`, together with
- `promotionDecision(currentStatus, result).action === "PROMOTE"` and
  `requiresHumanApproval: true` (which is `true` on every branch of
  `promotionDecision`, including HOLD, DEMOTE and RETIRE).

**That verdict is a research finding, never permission to trade.** No code path
converts it into an order: `runTest` records the gate report on
`backtestRuns.fitnessGates` and the walk-forward evidence on `backtestRuns.walkForward`,
then charges one analysis credit and returns. The stored report is a record that may be
read (for display or review); nothing persists a promotion, and no execution module
consults a fitness result.

Paper-only execution is enforced independently of any fitness verdict, in
`src/lib/arise/execution.ts` (`LIVE_TRADING_ENABLED = false`; `PaperBroker` performs
no network I/O) and `src/lib/arise/delta.ts` (`requireDemoTrading` requires
`DELTA_TRADING_MODE === "demo"`; `resolveDeltaOrderBaseUrl` refuses any non-testnet
host). A strategy passing every gate changes none of that.

## 9. Limitations the numbers must not be read past

`WFResult.limitations` states, per run: fold boundaries are hard so an open position
is closed at END_OF_DATA; fills are modelled (fees plus adverse slippage), not matched
against an order book, so fold returns are optimistic relative to a real venue; fold
returns are historical measurements, not a forecast; folds share overlapping history,
so the fold count overstates the number of independent observations; parameter
variants are perturbations of one strategy, not independent strategies; and the
selection used training bars only.

Additionally:

- `FITNESS_POLICY` thresholds are ARISE policy, not universal truths, and the code says
  so per threshold. 30 trades and 3 folds are minimum credibility bars, not
  statistical significance.
- A fold in which the strategy never traded scores exactly 0, which is a measurement
  rather than a loss; the engine reports it and the gates judge it.
- `backtestRuns.fitness.verdict` (from `scoreFitness`: `PASS`/`WATCH`/`FAIL`/
  `INSUFFICIENT_DATA`) is a coarse in-run summary and is **not** the admission
  decision — `fitnessGates` is.

## 10. Test coverage

Walk-forward (`src/lib/arise/walkForward.test.ts`, deterministic fixtures only):

- Split/boundary and ordering: "keeps train and test windows strictly separated and
  chronologically ordered", "supports an expanding anchor without overlapping windows".
- Data acceptance: "refuses synthetic data without producing a single fold", "refuses
  bars stamped in the future", "drops a still-forming final candle and says so",
  "refuses when every bar is still forming", "refuses empty and malformed input with
  explicit reasons" (covers NaN prices, inverted high/low, open above high, duplicate
  and non-monotonic timestamps), "refuses to produce a verdict when there is not enough
  history", "refuses an unusable configuration rather than guessing", "lays windows out
  by bar index when the series has gaps" (missing-bar stress).
- Costs and boundaries: "charges fees and slippage on every fold" (strictly worse at
  higher cost), "closes a position still open at a fold boundary at END_OF_DATA".
- Selection: "selects on training bars only, and does so deterministically" (re-runs
  the training-only selection independently and compares), "reports every candidate as
  a parameter variant, including the untuned ones".
- Aggregates: "keeps training results distinct from out-of-sample results", "reports a
  profitable-fold fraction below one when folds disagree", "reports the loss instead of
  refusing when no candidate is profitable out-of-sample", "marks its own output as
  deterministic and documents the limitations".

Engine (`src/lib/arise/backtest.test.ts`): "is deterministic given the same seed",
"deducts fees and reconciles equity = start + realized pnl", "fills at next open (no
look-ahead): signal sees only history", "maps SL before TP conservatively and respects
stop/target", "splits in-sample / out-of-sample without leakage", "returns
INSUFFICIENT_DATA when bars are too few", "buy-hold baseline enters once and holds",
"checks the entry bar after the next-open fill and prioritizes the stop", "fills long
and short stops at the adverse bar open after a gap", "models low liquidity with higher
execution costs than baseline".

Gates (`src/lib/arise/strategyFitness.test.ts`): the happy path ("marks a fully
measured strong result eligible with no blockers"); insufficiency and fail-closed
("fails closed when the out-of-sample trade count was never measured", "fails the OOS
evidence gate when no out-of-sample trades exist", "fails the data-adequacy gate when
the engine reported insufficient data"); overfitting and instability ("fails when
in-sample is positive and out-of-sample is negative", "fails when degradation exceeds
the policy allowance", "fails with too few walk-forward folds", "fails an unstable
walk-forward run even when the headline return is good", "fails a fragile optimum whose
result collapses under small parameter changes"); drawdown and cost realism ("fails
when drawdown exceeds the policy maximum", "rejects a cost-free backtest as not
evidence", "rejects a run that charged no fees at all"); leakage and profitability
("fails closed when no leakage evidence is supplied", "fails when the leakage guard is
incomplete", "fails a profit factor below the policy minimum", "fails a non-positive
expectancy"); lifecycle ("recommends promotion for an eligible candidate but always
requires human approval", "never promotes when the strategy is not eligible", "demotes
an ACTIVE strategy whose critical gate now fails", "retires a previously demoted
strategy that fails again", "never revives a retired strategy in place").

### Not covered

- **The Convex wiring is covered only for the synthetic-refusal path.**
  `src/lib/arise/convexWalkForwardIntegration.test.ts` drives the real `runTest`
  action with `useSynthetic` and asserts the `walkForward.ok ? foldsForFitness :
  null` mapping, the persisted `walkForward` refusal, and a `blockers`-non-empty,
  `eligible: false` `fitnessGates` report. The genuine-data path (a real run with
  `walkForward.ok === true` and the `oosTradeCount` fallback on a refused run) still
  has no automated test.
- **Every candidate must be rejected** is covered only at the library layer:
  `walkForward.test.ts` covers a run where no candidate is profitable out-of-sample,
  and the gate tests cover rejection of a candidate.
- **Warm-up inside a fold.** No test asserts that a test window's first bars cannot
  trade before the strategy's indicator warm-up completes; this is inherited from the
  per-window guards rather than asserted.
- **`missing-bars` stress** exists in `runBacktest` but is absent from the Convex
  `STRESSES` allow-list (`none`, `gap-down`, `vol-spike`, `low-liquidity`, `high-cost`)
  and has no test.
- **Session/calendar constraints.** No market-hours or session filter exists, and no
  test covers weekend/holiday gaps beyond the generic gap counter.
- **`minBarsPerWindow` (60) differs from `DEFAULT_BT_CONFIG.minBars` (120)**, so a
  60-bar window is evaluable. This is deliberate for the fold layout but is not
  documented anywhere except the code.

## 11. Gaps / not implemented

- No strategy registry or lifecycle persistence: `StrategyLifecycleStatus` and
  `promotionDecision` are pure code; `src/convex/schema.ts` has no strategies table, so
  no stored DRAFT/CANDIDATE/ACTIVE status exists and nothing can be promoted by a
  request. The gate report is a record, not a state transition.
- No scheduled/automatic re-validation of stored runs and no alerting when a strategy
  would now fail its gates.
- No walk-forward engine exposure through the UI beyond what already returns from
  `runTest`; the persisted `walkForward` summary is stored but its presentation is not
  asserted by tests.
- Parameter search is the fixed `PARAM_SPACE` only — no randomised search, no
  out-of-sample-consistent re-selection across the full history, and no
  multiple-comparison correction for having tried 9 candidate sets per fold.
- No spread, borrow or funding cost in the historical engine (see section 5).
