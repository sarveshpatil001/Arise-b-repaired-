// ARISE Bot Training System — BOT LAB.
// ADD BOT → SELECT DATA → CONFIGURE TEST → RUN BACKTEST → STRESS TEST →
// COMPARE → MARKET FITNESS → TEST REPORT. Honest labeling throughout:
// REAL vs SYNTHETIC data, INSUFFICIENT DATA handling, no profit claims.

import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Panel, StatTile, StatusChip } from "@/components/arise/shared";
import { Terminal } from "@/components/arise/Terminal";
import { useSymbols } from "@/hooks/use-arise";
import { STRATEGY_LABELS } from "@/lib/arise/backtest";
import { cn } from "@/lib/utils";
import { FlaskConical, Loader2, Play, Plus, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const STRATEGIES = [
  { id: "sma-cross", label: "SMA 20/50 trend" },
  { id: "rsi-mean", label: "RSI-14 mean reversion" },
  { id: "arise-momentum", label: "ARISE momentum" },
  { id: "buy-hold", label: "Buy & hold (baseline)" },
];

const STRESSES = [
  { id: "none", label: "BASELINE" },
  { id: "gap-down", label: "GAP-DOWN SHOCK" },
  { id: "vol-spike", label: "VOLATILITY SPIKE" },
  { id: "low-liquidity", label: "LOW LIQUIDITY" },
  { id: "high-cost", label: "HIGH COST (5× slip)" },
];

type RunDoc = {
  _id: string;
  botId: string;
  botName: string;
  strategyId: string;
  symbol: string;
  interval: string;
  dataKind: string;
  dataSource: string;
  barCount: number;
  seed: number;
  feeBps: number;
  slippageBps: number;
  positionPct: number;
  stopPct: number;
  targetPct: number;
  stress: string;
  status: string;
  metrics: Record<string, number>;
  fitness: { score: number; grade: string; verdict: string; reasons: string[] };
  /**
   * Deterministic admission-gate report from src/lib/arise/strategyFitness.ts.
   * Optional: runs recorded before the report existed have no such field, so every
   * read of it below is guarded.
   */
  fitnessGates?: GatesReport | null;
  equityCurve: { t: number; equity: number }[];
  trades: Record<string, number | string>[];
  createdAt: number;
};

/** Mirrors FitnessGate in src/lib/arise/strategyFitness.ts (view-only copy). */
type GateView = {
  id: string;
  label: string;
  pass: boolean;
  value: number | null;
  threshold: number | null;
  critical: boolean;
  reason: string;
};

type GatesReport = {
  eligible: boolean;
  score: number;
  gates: GateView[];
  blockers: string[];
  notes: string[];
};

/** Passed / total gate count, or null when the run predates the report. */
function gateTally(r: RunDoc): string | null {
  const g = r.fitnessGates;
  if (!g || !Array.isArray(g.gates) || g.gates.length === 0) return null;
  return `${g.gates.filter((x) => x.pass).length}/${g.gates.length}`;
}

function verdictChip(v: string): string {
  if (v === "PASS") return "PASS";
  if (v === "WATCH") return "WARNING";
  if (v === "INSUFFICIENT_DATA") return "STALE";
  return "VETO";
}

export default function Bots() {
  const symbols = useSymbols();
  const bots = useQuery(api.arise.backtest.list, {}) ?? [];
  const runsRaw = useQuery(api.arise.backtest.runs, { limit: 30 });
  // Memoized so the `?? []` fallback keeps a stable identity across renders.
  const runs = useMemo(
    () => (runsRaw ?? []) as unknown as RunDoc[],
    [runsRaw],
  );
  const createBot = useMutation(api.arise.backtest.create);
  const runTest = useAction(api.arise.backtest.runTest);

  // ADD BOT form
  const [botName, setBotName] = useState("");
  const [strategy, setStrategy] = useState("sma-cross");
  const [creating, setCreating] = useState(false);

  // SELECT DATA + CONFIGURE
  const [botId, setBotId] = useState("");
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval_, setInterval_] = useState("1h");
  const [synthetic, setSynthetic] = useState(false);
  const [stress, setStress] = useState("none");
  const [feeBps, setFeeBps] = useState("4");
  const [slipBps, setSlipBps] = useState("2");
  const [positionPct, setPositionPct] = useState("15");
  const [stopPct, setStopPct] = useState("1.5");
  const [targetPct, setTargetPct] = useState("3");
  const [seed, setSeed] = useState("42");

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);

  const selected = useMemo(() => runs.find((r) => r._id === selectedId) ?? runs[0] ?? null, [runs, selectedId]);
  const compared = useMemo(() => runs.find((r) => r._id === compareId) ?? null, [runs, compareId]);

  const activeBotId = botId || (bots[0] as unknown as { _id: string } | undefined)?._id || "";

  const doCreate = async () => {
    setCreating(true);
    try {
      const id = await createBot({ name: botName.trim(), strategyId: strategy });
      setBotName("");
      setBotId(id as unknown as string);
      toast.success("Bot registered — now select data and configure the test");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to register bot");
    } finally {
      setCreating(false);
    }
  };

  const baseArgs = () => ({
    botId: activeBotId as never,
    symbol,
    interval: interval_,
    stress,
    feeBps: Number(feeBps) || 4,
    slippageBps: Number(slipBps) || 2,
    positionPct: Number(positionPct) || 15,
    stopPct: Number(stopPct) || 1.5,
    targetPct: Number(targetPct) || 3,
    seed: Math.floor(Number(seed) || 42),
    useSynthetic: synthetic,
  });

  const doRun = async (overrideStress?: string) => {
    if (!activeBotId) {
      toast.error("Register a bot first (step 1)");
      return;
    }
    setRunning(true);
    setRunError(null);
    try {
      const r = (await runTest({ ...baseArgs(), stress: overrideStress ?? stress })) as unknown as { runId: string; status: string; dataKind: string };
      setSelectedId(r.runId);
      if (r.status === "INSUFFICIENT_DATA") toast.warning("Test completed with INSUFFICIENT DATA — see report");
      else toast.success(`Backtest completed on ${r.dataKind} data`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Backtest failed";
      setRunError(msg);
      toast.error(msg);
    } finally {
      setRunning(false);
    }
  };

  const doStressSuite = async () => {
    if (!activeBotId) {
      toast.error("Register a bot first (step 1)");
      return;
    }
    setRunning(true);
    setRunError(null);
    try {
      for (const s of STRESSES) {
        const r = (await runTest({ ...baseArgs(), stress: s.id })) as unknown as { runId: string };
        setSelectedId(r.runId);
      }
      toast.success("Stress suite completed — 5 scenarios recorded");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stress suite failed";
      setRunError(msg);
      toast.error(msg);
    } finally {
      setRunning(false);
    }
  };

  const m = selected?.metrics;

  return (
    <Terminal>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="flex items-center gap-2 font-terminal text-lg font-bold tracking-wider">
              <FlaskConical className="size-5 text-primary" /> BOT LAB — TEST YOUR BOT BEFORE YOU TRUST IT
            </h1>
            <p className="text-[11px] text-muted-foreground">
              Deterministic backtests on real market data. Fees and slippage deducted. No look-ahead. Backtests are hypothetical — past results do not predict future returns.
            </p>
          </div>
          <StatusChip state="PAPER" />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {/* STEP 1 — ADD BOT */}
          <Panel title="1 · ADD BOT">
            <div className="space-y-2">
              <Input value={botName} onChange={(e) => setBotName(e.target.value)} placeholder="Bot name (e.g. trend-rider-01)" className="h-8 font-terminal text-xs" />
              <Select value={strategy} onValueChange={setStrategy}>
                <SelectTrigger className="h-8 font-terminal text-xs"><SelectValue /></SelectTrigger>
                <SelectContent className="font-terminal text-xs">
                  {STRATEGIES.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button size="sm" className="w-full gap-1.5 font-terminal text-[11px]" disabled={creating || botName.trim().length < 2} onClick={doCreate}>
                {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} REGISTER BOT
              </Button>
              <div className="border-t border-border pt-2">
                {bots.length === 0 ? (
                  <p className="py-2 text-center text-[11px] text-muted-foreground">No bots yet — register your first bot above.</p>
                ) : (
                  <div className="max-h-36 space-y-1 overflow-y-auto">
                    {bots.map((b: { _id: string; name: string; strategyId: string }) => (
                      <button key={b._id} onClick={() => setBotId(b._id)}
                        className={cn("flex w-full items-center justify-between border px-2 py-1.5 font-terminal text-[11px]",
                          (botId || (bots[0] as { _id: string })._id) === b._id ? "border-primary/60 bg-primary/5" : "border-border/60 hover:border-primary/30")}>
                        <span className="truncate">{b.name}</span>
                        <span className="ml-2 shrink-0 text-[9px] text-muted-foreground">{STRATEGY_LABELS[b.strategyId as keyof typeof STRATEGY_LABELS] ?? b.strategyId}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </Panel>

          {/* STEP 2 — SELECT DATA */}
          <Panel title="2 · SELECT DATA" right={synthetic ? <StatusChip state="WARNING" className="text-[9px]" /> : <StatusChip state="LIVE" className="text-[9px]" />}>
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Select value={symbol} onValueChange={setSymbol}>
                  <SelectTrigger className="h-8 font-terminal text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent className="font-terminal text-xs">
                    {symbols.map((s) => <SelectItem key={s.symbol} value={s.symbol}>{s.symbol}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={interval_} onValueChange={setInterval_}>
                  <SelectTrigger className="h-8 font-terminal text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent className="font-terminal text-xs">
                    {["1m", "5m", "15m", "1h", "4h", "1d"].map((iv) => <SelectItem key={iv} value={iv}>{iv}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setSynthetic(false)} className={cn("flex-1 border px-2 py-1.5 font-terminal text-[10px]", !synthetic ? "border-success/60 bg-success/10 text-success" : "border-border text-muted-foreground")}>
                  REAL MARKET DATA
                </button>
                <button onClick={() => setSynthetic(true)} className={cn("flex-1 border px-2 py-1.5 font-terminal text-[10px]", synthetic ? "border-warning/60 bg-warning/10 text-warning" : "border-border text-muted-foreground")}>
                  SYNTHETIC DATA
                </button>
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {synthetic ? "SYNTHETIC: seeded random-walk bars for engine checks only — never presented as market performance." : "REAL: live exchange bars via Binance/Yahoo. Labeled REAL in every report. Fails closed when unavailable."}
              </p>
            </div>
          </Panel>

          {/* STEP 3 — CONFIGURE TEST */}
          <Panel title="3 · CONFIGURE TEST">
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: "FEE BPS/SIDE", v: feeBps, set: setFeeBps },
                { label: "SLIP BPS/SIDE", v: slipBps, set: setSlipBps },
                { label: "POSITION %", v: positionPct, set: setPositionPct },
                { label: "STOP %", v: stopPct, set: setStopPct },
                { label: "TARGET %", v: targetPct, set: setTargetPct },
                { label: "SEED", v: seed, set: setSeed },
              ].map((f) => (
                <label key={f.label} className="block">
                  <span className="font-terminal text-[9px] text-muted-foreground">{f.label}</span>
                  <Input value={f.v} onChange={(e) => f.set(e.target.value)} inputMode="decimal" className="mt-0.5 h-8 font-terminal text-xs tabular" />
                </label>
              ))}
            </div>
            <div className="mt-2">
              <span className="font-terminal text-[9px] text-muted-foreground">STRESS SCENARIO</span>
              <Select value={stress} onValueChange={setStress}>
                <SelectTrigger className="mt-0.5 h-8 font-terminal text-xs"><SelectValue /></SelectTrigger>
                <SelectContent className="font-terminal text-xs">
                  {STRESSES.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="mt-2 flex gap-2">
              <Button size="sm" className="flex-1 gap-1.5 bg-success font-terminal text-[11px] text-white hover:bg-success/90" disabled={running} onClick={() => doRun()}>
                {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} RUN BACKTEST
              </Button>
              <Button size="sm" variant="outline" className="flex-1 gap-1.5 font-terminal text-[11px]" disabled={running} onClick={doStressSuite}>
                {running ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />} STRESS SUITE
              </Button>
            </div>
            {runError && <p className="mt-2 border border-danger/40 bg-danger/10 px-2 py-1.5 font-terminal text-[10px] text-danger">{runError}</p>}
          </Panel>
        </div>

        {/* RESULTS */}
        {!selected ? (
          <div className="panel p-8 text-center font-terminal text-xs text-muted-foreground">
            NO TESTS YET — register a bot, select data, and run your first backtest.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-8">
              <StatTile label="VERDICT" value={<StatusChip state={verdictChip(selected.fitness.verdict)} />} sub={`${selected.fitness.score}/100 · grade ${selected.fitness.grade}`} />
              <StatTile label="TOTAL RETURN" value={`${(selected.metrics.totalReturnPct ?? 0).toFixed(2)}%`} tone={(selected.metrics.totalReturnPct ?? 0) >= 0 ? "up" : "down"} sub="net of fees" />
              <StatTile label="IN-SAMPLE" value={`${(selected.metrics.inSampleReturnPct ?? 0).toFixed(2)}%`} sub="first 70% of bars" />
              <StatTile label="OUT-SAMPLE" value={`${(selected.metrics.outSampleReturnPct ?? 0).toFixed(2)}%`} tone={(selected.metrics.outSampleReturnPct ?? 0) >= 0 ? "up" : "down"} sub="last 30% — overfit check" />
              <StatTile label="MAX DRAWDOWN" value={`${(selected.metrics.maxDrawdownPct ?? 0).toFixed(2)}%`} tone={(selected.metrics.maxDrawdownPct ?? 0) > 25 ? "down" : "neutral"} />
              <StatTile label="WIN RATE" value={`${(selected.metrics.winRatePct ?? 0).toFixed(1)}%`} sub={`${selected.metrics.tradeCount ?? 0} trades`} />
              <StatTile label="PROFIT FACTOR" value={Number(selected.metrics.profitFactor ?? 0).toFixed(2)} sub={`PF ${Number(selected.metrics.sharpe ?? 0).toFixed(2)} Sharpe`} />
              <StatTile label="DATA" value={selected.dataKind} tone={selected.dataKind === "REAL" ? "up" : "down"} sub={`${selected.barCount} bars · ${selected.dataSource}`} />
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <Panel title="EQUITY CURVE (NET OF FEES)" className="lg:col-span-2"
                right={<span className="font-terminal text-[9px] text-muted-foreground">{selected.botName} · {selected.symbol} {selected.interval} · seed {selected.seed}</span>}>
                {selected.equityCurve.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted-foreground">INSUFFICIENT DATA — equity curve unavailable.</p>
                ) : (
                  <div className="h-52">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={selected.equityCurve.map((p) => ({ ...p }))}>
                        <XAxis dataKey="t" hide />
                        <YAxis domain={["auto", "auto"]} tick={{ fontSize: 9 }} width={52} tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`} />
                        <Tooltip formatter={(v) => [`$${Number(v).toFixed(2)}`, "equity"]} labelFormatter={(t) => new Date(Number(t)).toISOString().slice(0, 10)} />
                        <Area type="monotone" dataKey="equity" stroke="#22c55e" fill="#22c55e22" strokeWidth={1.5} dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
                {m && (
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-terminal text-[10px] text-muted-foreground">
                    <span>FEES PAID <b className="text-foreground">${Number(m.feesTotal ?? 0).toFixed(2)}</b></span>
                    <span>EXPECTANCY <b className="text-foreground">${Number(m.expectancy ?? 0).toFixed(2)}/trade</b></span>
                    <span>AVG HOLD <b className="text-foreground">{Number(m.avgHoldingBars ?? 0).toFixed(1)} bars</b></span>
                    <span>EXPOSURE <b className="text-foreground">{Number(m.exposurePct ?? 0).toFixed(1)}%</b></span>
                  </div>
                )}
              </Panel>

              {/* MARKET FITNESS + REPORT */}
              <Panel title="ARISE BOT TEST REPORT"
                right={<StatusChip state={selected.dataKind === "REAL" ? "LIVE" : "STALE"} className="text-[9px]" />}>
                <div className="space-y-1.5 font-terminal text-[10px]">
                  <div className="flex justify-between border-b border-border/50 pb-1"><span className="text-muted-foreground">BOT</span><span>{selected.botName}</span></div>
                  <div className="flex justify-between border-b border-border/50 pb-1"><span className="text-muted-foreground">STRATEGY</span><span>{STRATEGY_LABELS[selected.strategyId as keyof typeof STRATEGY_LABELS] ?? selected.strategyId}</span></div>
                  <div className="flex justify-between border-b border-border/50 pb-1"><span className="text-muted-foreground">DATASET</span><span>{selected.dataKind} · {selected.symbol} {selected.interval}</span></div>
                  <div className="flex justify-between border-b border-border/50 pb-1"><span className="text-muted-foreground">SOURCE</span><span>{selected.dataSource}</span></div>
                  <div className="flex justify-between border-b border-border/50 pb-1"><span className="text-muted-foreground">BARS / SPLIT</span><span className="tabular">{selected.barCount} · 70/30</span></div>
                  <div className="flex justify-between border-b border-border/50 pb-1"><span className="text-muted-foreground">COSTS</span><span className="tabular">{selected.feeBps}bps fee · {selected.slippageBps}bps slip</span></div>
                  <div className="flex justify-between border-b border-border/50 pb-1"><span className="text-muted-foreground">SIZE / SL / TP</span><span className="tabular">{selected.positionPct}% · {selected.stopPct}% / {selected.targetPct}%</span></div>
                  <div className="flex justify-between border-b border-border/50 pb-1"><span className="text-muted-foreground">STRESS</span><span>{selected.stress}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">SEED</span><span className="tabular">{selected.seed}</span></div>
                </div>
                <div className="mt-2 border-t border-border pt-2">
                  <div className="font-terminal text-[9px] text-muted-foreground">FITNESS ASSESSMENT</div>
                  <ul className="mt-1 space-y-1">
                    {selected.fitness.reasons.map((r, i) => (
                      <li key={i} className="text-[10px] leading-relaxed text-muted-foreground">· {r}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">
                    Hypothetical test on historical data with modeled fills. Not a prediction of future returns. Do not trade real capital on the basis of a backtest alone.
                  </p>
                </div>

                {/* ADMISSION GATES — deterministic, and the reason a strategy is or
                    is not promotable. Not measured fails closed, so this list is the
                    honest answer to "why can't I promote this bot?". */}
                <div className="mt-2 border-t border-border pt-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-terminal text-[9px] text-muted-foreground">ADMISSION GATES (DETERMINISTIC)</span>
                    {selected.fitnessGates ? (
                      <span className={cn("font-terminal text-[9px]", selected.fitnessGates.eligible ? "text-success" : "text-warning")}>
                        {gateTally(selected)} PASS · {selected.fitnessGates.eligible ? "ELIGIBLE" : "NOT ELIGIBLE"}
                      </span>
                    ) : (
                      <span className="font-terminal text-[9px] text-muted-foreground">NOT RECORDED</span>
                    )}
                  </div>
                  {selected.fitnessGates ? (
                    <>
                      <ul className="mt-1 space-y-1">
                        {selected.fitnessGates.gates
                          .filter((g) => !g.pass)
                          .slice(0, 6)
                          .map((g) => (
                            <li key={g.id} className="text-[10px] leading-relaxed text-muted-foreground">
                              <span className={cn("font-semibold", g.critical ? "text-danger" : "text-warning")}>
                                ✗ {g.label}
                              </span>{" — "}{g.reason}
                              {g.critical && <span className="ml-1 text-danger">(blocking)</span>}
                            </li>
                          ))}
                        {selected.fitnessGates.gates.every((g) => g.pass) && (
                          <li className="text-[10px] leading-relaxed text-success">
                            ✓ every gate passed — eligible for promotion review. Promotion still requires privileged human approval.
                          </li>
                        )}
                      </ul>
                      <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">
                        Gates that were never measured fail closed. One historical run supplies no walk-forward or parameter-sensitivity evidence, so it cannot be promoted on that run alone. NOT ELIGIBLE means NOT promotable.
                      </p>
                    </>
                  ) : (
                    <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                      This test predates the admission-gate report. Re-run it to record gate evidence.
                    </p>
                  )}
                </div>
              </Panel>
            </div>

            {/* COMPARE */}
            <Panel title="COMPARE TESTS"
              right={
                <Select value={compareId ?? ""} onValueChange={(v) => setCompareId(v || null)}>
                  <SelectTrigger className="h-7 w-52 font-terminal text-[10px]"><SelectValue placeholder="Select second test…" /></SelectTrigger>
                  <SelectContent className="font-terminal text-[10px]">
                    {runs.filter((r) => r._id !== selected._id).map((r) => (
                      <SelectItem key={r._id} value={r._id}>{r.botName} · {r.symbol} · {r.stress} · {new Date(r.createdAt).toISOString().slice(5, 16)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }>
              <CompareTable a={selected} b={compared} />
            </Panel>

            {/* TRADES + HISTORY */}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Panel title={`TRADES — SELECTED TEST (${selected.trades.length})`}>
                {selected.trades.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">No trades executed in this test.</p>
                ) : (
                  <div className="max-h-56 overflow-y-auto">
                    <table className="w-full font-terminal text-[10px]">
                      <thead><tr className="border-b border-border text-left text-[9px] text-muted-foreground">
                        <th className="py-1 pr-2">SIDE</th><th className="py-1 pr-2">ENTRY</th><th className="py-1 pr-2">EXIT</th>
                        <th className="py-1 pr-2">PNL</th><th className="py-1">REASON</th>
                      </tr></thead>
                      <tbody>
                        {selected.trades.slice(0, 60).map((t, i) => (
                          <tr key={i} className="border-b border-border/40">
                            <td className={cn("py-1 pr-2 font-semibold", t.side === "LONG" ? "text-success" : "text-danger")}>{t.side}</td>
                            <td className="py-1 pr-2 tabular">{Number(t.entryPrice).toFixed(2)}</td>
                            <td className="py-1 pr-2 tabular">{Number(t.exitPrice).toFixed(2)}</td>
                            <td className={cn("py-1 pr-2 tabular", Number(t.pnl) >= 0 ? "text-success" : "text-danger")}>{Number(t.pnl) >= 0 ? "+" : ""}{Number(t.pnl).toFixed(2)}</td>
                            <td className="py-1 text-muted-foreground">{t.exitReason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
              <Panel title={`TEST HISTORY (${runs.length})`}>
                {runs.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">No tests recorded yet.</p>
                ) : (
                  <div className="max-h-56 overflow-y-auto">
                    <table className="w-full font-terminal text-[10px]">
                      <thead><tr className="border-b border-border text-left text-[9px] text-muted-foreground">
                        <th className="py-1 pr-2">BOT / MARKET</th><th className="py-1 pr-2">RETURN</th><th className="py-1 pr-2">VERDICT</th><th className="py-1 pr-2">GATES</th><th className="py-1">DATA</th>
                      </tr></thead>
                      <tbody>
                        {runs.map((r) => (
                          <tr key={r._id}>
                            <td className="py-1 pr-2">
                              <button className={cn("hover:text-primary", r._id === selected._id && "text-primary")} onClick={() => setSelectedId(r._id)}>
                                {r.botName} · {r.symbol} · {r.stress}
                              </button>
                              <span className="ml-1 text-[9px] text-muted-foreground">{new Date(r.createdAt).toISOString().slice(5, 16)}</span>
                            </td>
                            <td className={cn("py-1 pr-2 tabular", (r.metrics.totalReturnPct ?? 0) >= 0 ? "text-success" : "text-danger")}>
                              {(r.metrics.totalReturnPct ?? 0).toFixed(2)}%
                            </td>
                            <td className="py-1 pr-2"><StatusChip state={verdictChip(r.fitness.verdict)} className="text-[9px]" /></td>
                            <td className={cn("py-1 pr-2 tabular", r.fitnessGates && !r.fitnessGates.eligible ? "text-warning" : "text-muted-foreground")}>
                              {gateTally(r) ?? "—"}
                            </td>
                            <td className="py-1 text-muted-foreground">{r.dataKind}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </div>
          </>
        )}
      </div>
    </Terminal>
  );
}

function CompareTable({ a, b }: { a: RunDoc; b: RunDoc | null }) {
  if (!b) return <p className="py-3 text-center text-xs text-muted-foreground">Select a second test to compare side-by-side.</p>;
  const rows: [string, (m: Record<string, number>) => string][] = [
    ["Total return %", (m) => `${(m.totalReturnPct ?? 0).toFixed(2)}%`],
    ["Out-of-sample %", (m) => `${(m.outSampleReturnPct ?? 0).toFixed(2)}%`],
    ["Max drawdown %", (m) => `${(m.maxDrawdownPct ?? 0).toFixed(2)}%`],
    ["Win rate %", (m) => `${(m.winRatePct ?? 0).toFixed(1)}%`],
    ["Profit factor", (m) => Number(m.profitFactor ?? 0).toFixed(2)],
    ["Sharpe", (m) => Number(m.sharpe ?? 0).toFixed(2)],
    ["Trades", (m) => String(m.tradeCount ?? 0)],
    ["Fees paid $", (m) => Number(m.feesTotal ?? 0).toFixed(2)],
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-terminal text-[11px]">
        <thead><tr className="border-b border-border text-left text-[9px] text-muted-foreground">
          <th className="py-1.5 pr-3">METRIC</th>
          <th className="py-1.5 pr-3">A · {a.botName} · {a.stress}</th>
          <th className="py-1.5">B · {b.botName} · {b.stress}</th>
        </tr></thead>
        <tbody>
          {rows.map(([label, fn]) => (
            <tr key={label} className="border-b border-border/40">
              <td className="py-1.5 pr-3 text-muted-foreground">{label}</td>
              <td className="py-1.5 pr-3 tabular">{fn(a.metrics)}</td>
              <td className="py-1.5 tabular">{fn(b.metrics)}</td>
            </tr>
          ))}
          <tr>
            <td className="py-1.5 pr-3 text-muted-foreground">FITNESS</td>
            <td className="py-1.5 pr-3">{a.fitness.score}/100 · {a.fitness.verdict}</td>
            <td className="py-1.5">{b.fitness.score}/100 · {b.fitness.verdict}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
