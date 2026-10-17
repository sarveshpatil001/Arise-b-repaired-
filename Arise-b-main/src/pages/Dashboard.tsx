import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfidenceBar, Panel, QualityBadge, SignalChip, StatTile, StatusChip } from "@/components/arise/shared";
import { Terminal } from "@/components/arise/Terminal";
import { useAccount, useEntitlements, useEnsureAccount, useLatestDecision, useRunDecision, useSymbols } from "@/hooks/use-arise";
import { fmtMoney, fmtPct } from "@/lib/arise/math";
import { DEFAULT_CONFIG } from "@/lib/arise/config";
import { markedEquity } from "@/lib/arise/ledger";
import { createFreshnessPolicy } from "@/lib/arise/freshness";
import type { DeltaAccountSnapshot } from "@/lib/arise/delta";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import {
  AlertTriangle,
  Check,
  Clock,
  Loader2,
  Play,
  RefreshCw,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";
import { Link } from "react-router";

interface DecisionResult {
  ok: boolean;
  decisionId: string;
  status: string;
  direction: string;
  confidence: number;
  regime: string;
  thesis: string;
  recommendedAction: string;
  dataQuality: string;
  dataAgeSec: number;
  execution: Record<string, unknown> | null;
  riskChecks: { rule: string; pass: boolean; detail: string }[];
  fetchMs: number;
}

interface MindPayload {
  supportingEvidence?: string[];
  contradictingEvidence?: string[];
  invalidationConditions?: string[];
  keyRisks?: string[];
  agreementPct?: number;
  debate?: { topic: string; agents: { agent: string; position: string; confidence: number }[]; resolution: string }[];
  plan?: {
    side: string;
    entry: number;
    stopLoss: number;
    takeProfit: number;
    positionSize: number;
    positionSizeQuote: number;
    maxLossQuote: number;
    maxLossPct: number;
  } | null;
}

interface AgentPayload {
  agent: string;
  signal: string;
  confidence: number;
  summary: string;
  regime?: string;
  manipulationLevel?: string;
  modelVersion: string;
}

const AGENT_LABELS: Record<string, string> = {
  quant: "QUANT AI",
  technical: "TECHNICAL AI",
  regime: "REGIME AI",
  anomaly: "ANOMALY AI",
  portfolio: "PORTFOLIO AI",
  risk: "RISK AI",
  news: "NEWS AI",
};

function fmtAge(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  if (sec < 90) return `${Math.round(sec)}s ago`;
  if (sec < 5400) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

function fmtPrice(v: number): string {
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(3);
  return v.toFixed(5);
}

function DirectionBanner({ d }: { d: DecisionResult | null; }) {
  if (!d) return null;
  const map: Record<string, { label: string; cls: string }> = {
    TRADE: {
      label: d.direction === "LONG" ? "BUY" : "SELL",
      cls: d.direction === "LONG" ? "border-success/50 bg-success/10 text-success" : "border-danger/50 bg-danger/10 text-danger",
    },
    VETOED: { label: "VETO — BLOCKED BY RISK ENGINE", cls: "border-danger/50 bg-danger/10 text-danger" },
    WAIT: { label: "WAIT — NO TRADE", cls: "border-warning/50 bg-warning/10 text-warning" },
  };
  const m = map[d.status] ?? map.WAIT;
  return (
    <div className={cn("panel flex flex-wrap items-center justify-between gap-3 border px-4 py-3", m.cls)}>
      <div>
        <div className="panel-title text-[9px]">ARISE DECISION</div>
        <div className="font-terminal text-2xl font-bold tracking-wide">{m.label}</div>
      </div>
      <div className="min-w-40 flex-1">
        <div className="mb-1 flex items-center justify-between font-terminal text-[10px] text-muted-foreground">
          <span>CONFIDENCE</span>
          <span className="tabular">{Math.round(d.confidence * 100)}%</span>
        </div>
        <ConfidenceBar value={d.confidence} />
        <div className="mt-1 text-[10px] text-muted-foreground">
          confidence reflects agreement and evidence quality, not guaranteed outcome
        </div>
      </div>
      <div className="text-right">
        <div className="panel-title text-[9px]">MARKET REGIME</div>
        <div className="font-terminal text-sm font-semibold">{d.regime.replace(/_/g, " ")}</div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  useEnsureAccount();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const ents = useEntitlements();
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval_, setInterval_] = useState("1h");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DecisionResult | null>(null);
  const symbols = useSymbols();
  const account = useAccount();
  const latest = useLatestDecision(symbol);
  const runDecision = useRunDecision();
  const events = useQuery(api.arise.system.list, { limit: 5 });
  const syncDeltaAccount = useAction(api.arise.delta.accountSnapshot);
  const [deltaAccount, setDeltaAccount] = useState<DeltaAccountSnapshot | null>(null);
  const [deltaError, setDeltaError] = useState<string | null>(null);
  const [deltaBusy, setDeltaBusy] = useState(false);
  const syncDelta = async () => {
    setDeltaBusy(true);
    setDeltaError(null);
    try {
      setDeltaAccount(await syncDeltaAccount({}));
    } catch (e) {
      setDeltaAccount(null);
      setDeltaError(e instanceof Error ? e.message : "Delta sync failed");
    } finally {
      setDeltaBusy(false);
    }
  };

  const run = async (execute: boolean) => {
    setRunning(true);
    setResult(null);
    try {
      const r = (await runDecision({ symbol, interval: interval_, execute })) as unknown as DecisionResult;
      setResult(r);
      if (execute && r.execution?.status === "FILLED") {
        toast.success(`Paper order filled: ${r.direction} ${symbol}`);
      } else if (execute && r.status === "WAIT") {
        toast.info("No trade — ARISE recommends waiting");
      } else if (execute && r.status === "VETOED") {
        toast.warning("Risk engine vetoed the proposed trade");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setRunning(false);
    }
  };

  // Auto-run analysis once the paper account exists (analyze-only).
  // Gated on account load so the action never races account creation.
  const ranRef = useRef(false);
  useEffect(() => {
    if (ranRef.current || account === undefined || account === null) return;
    ranRef.current = true;
    void run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  const shown: DecisionResult | null = result ?? (latest
    ? {
        ok: true,
        decisionId: latest._id,
        status: latest.status,
        direction: latest.direction,
        confidence: latest.confidence,
        regime: latest.regime,
        thesis: latest.thesis,
        recommendedAction: latest.recommendedAction,
        dataQuality: latest.dataQuality,
        dataAgeSec: latest.dataAgeSec,
        execution: (latest.execution as Record<string, unknown> | null) ?? null,
        riskChecks: ((latest.risk as { checks?: { rule: string; pass: boolean; detail: string }[] })?.checks ?? []),
        fetchMs: (latest.snapshotMeta as { fetchMs?: number })?.fetchMs ?? 0,
      }
    : null);

  const mind = (latest?.mind ?? null) as MindPayload | null;
  const agents = (latest?.agents ?? null) as Record<string, AgentPayload> | null;
  const meta = (latest?.snapshotMeta ?? null) as {
    lastClose?: number;
    bars?: number;
    source?: string;
    spreadPct?: number | null;
    fallback?: string | null;
  } | null;

  const botRuns = (useQuery(api.arise.backtest.runs, { limit: 30 }) ?? []) as unknown as {
    _id: string; botName: string; symbol: string; status: string; dataKind: string;
    metrics: { totalReturnPct?: number }; fitness: { verdict: string; score: number }; createdAt: number;
  }[];
  const openPositions = useQuery(api.arise.trading.openPositions, {}) ?? [];
  const latestMarks = useQuery(api.arise.trading.latestMarks, {}) ?? [];
  const [now, setNow] = useState(() => latestMarks.reduce((latest, mark) => Math.max(latest, mark.time), 0));
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const timeout = window.setTimeout(refresh, 0);
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, []);
  const marksBySymbol = Object.fromEntries(latestMarks.map((mark) => [mark.symbol, {
    symbol: mark.symbol,
    price: mark.close,
    time: mark.time,
    interval: mark.interval,
    completed: mark.completed,
  }]));
  const marked = markedEquity(account?.balance ?? 0, openPositions, marksBySymbol, { now, policy: createFreshnessPolicy(DEFAULT_CONFIG.barStaleMultiplier) });
  const equity = marked.equity;
  const hwm = account?.equityHighWaterMark ?? equity;
  const dd = hwm > 0 ? Math.max(0, ((hwm - equity) / hwm) * 100) : 0;
  const dayPnl = account ? equity - account.dayStartEquity : 0;

  const passed = botRuns.filter((r) => r.fitness.verdict === "PASS").length;
  const failed = botRuns.filter((r) => r.fitness.verdict === "FAIL").length;
  const insuf = botRuns.filter((r) => r.fitness.verdict === "INSUFFICIENT_DATA" || r.status === "INSUFFICIENT_DATA").length;

  return (
    <Terminal>
      <div className="space-y-3">
        {/* BOT TRAINING OVERVIEW — tests completed / failed / recent, reports, data + system status */}
        <Panel
          title="BOT TRAINING — TEST OVERVIEW"
          right={<Link to="/dashboard/bots" className="border border-primary/50 px-2 py-0.5 font-terminal text-[9px] text-primary hover:bg-primary/10">OPEN BOT LAB →</Link>}
        >
          {botRuns.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">No bot tests yet. Register a bot in the Bot Lab and run your first backtest — honest REAL/SYNTHETIC labeling, fees deducted, no look-ahead.</p>
              <Link to="/dashboard/bots"><Button size="sm" className="font-terminal text-[11px]">START TESTING</Button></Link>
            </div>
          ) : (
            <div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <StatTile label="TESTS COMPLETED" value={String(botRuns.length)} sub={`${passed} passed · ${failed} failed`} />
                <StatTile label="PASSED" value={String(passed)} tone="up" />
                <StatTile label="FAILED / WATCH" value={String(failed)} tone={failed > 0 ? "down" : "neutral"} />
                <StatTile label="INSUFFICIENT DATA" value={String(insuf)} sub="needs more bars" tone={insuf > 0 ? "down" : "neutral"} />
              </div>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full font-terminal text-[10px]">
                  <thead><tr className="border-b border-border text-left text-[9px] text-muted-foreground">
                    <th className="py-1 pr-2">BOT / MARKET</th><th className="py-1 pr-2">RETURN</th><th className="py-1 pr-2">VERDICT</th><th className="py-1">DATA</th>
                  </tr></thead>
                  <tbody>
                    {botRuns.slice(0, 5).map((r) => (
                      <tr key={r._id} className="border-b border-border/40">
                        <td className="py-1 pr-2">{r.botName} · {r.symbol}</td>
                        <td className={cn("py-1 pr-2 tabular", (r.metrics.totalReturnPct ?? 0) >= 0 ? "text-success" : "text-danger")}>{(r.metrics.totalReturnPct ?? 0).toFixed(2)}%</td>
                        <td className="py-1 pr-2"><SignalChip signal={r.fitness.verdict === "PASS" ? "PASS" : r.fitness.verdict === "INSUFFICIENT_DATA" ? "WAIT" : "VETO"} /></td>
                        <td className="py-1 text-muted-foreground">{r.dataKind}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Panel>
        {/* Header row */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="font-terminal text-lg font-bold tracking-wider">
              ARISE DECISION — {symbol}
              <span className="ml-3 text-xs font-normal text-muted-foreground">
                {user?.email ?? "guest"}
                {ents && (
                  <Badge variant="outline" className="ml-2 font-terminal text-[9px] text-primary">
                    {ents.planName.toUpperCase()}
                    {ents.remainingToday !== -1 && ` · ${ents.remainingToday} ANALYSES LEFT TODAY`}
                  </Badge>
                )}
              </span>
            </h1>
            <p className="text-[11px] text-muted-foreground">
              ARISE evaluates current market conditions and produces a risk-controlled decision.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={symbol} onValueChange={setSymbol}>
              <SelectTrigger className="h-8 w-36 font-terminal text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="font-terminal text-xs">
                {symbols.map((s) => (
                  <SelectItem key={s.symbol} value={s.symbol}>
                    {s.symbol}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={interval_} onValueChange={setInterval_}>
              <SelectTrigger className="h-8 w-20 font-terminal text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="font-terminal text-xs">
                {["1m", "5m", "15m", "1h", "4h", "1d"].map((iv) => (
                  <SelectItem key={iv} value={iv}>{iv}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="gap-1.5 font-terminal text-[11px]" disabled={running} onClick={() => run(false)}>
              {running ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} ANALYZE
            </Button>
            <Button size="sm" className="gap-1.5 bg-success font-terminal text-[11px] text-white hover:bg-success/90" disabled={running} onClick={() => run(true)}>
              {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} ANALYZE + PAPER EXECUTE
            </Button>
          </div>
        </div>

        {running && (
          <div className="panel px-4 py-3">
            <div className="flex items-center gap-2 font-terminal text-xs text-primary">
              <Loader2 className="size-3.5 animate-spin" />
              FETCHING VALIDATED MARKET DATA · RUNNING 6 SPECIALIST AGENTS · MIND SYNTHESIS · RISK CHECK…
            </div>
            <div className="mt-2 h-0.5 overflow-hidden bg-secondary">
              <div className="h-full w-1/3 scan-line" />
            </div>
          </div>
        )}

        {/* Decision banner */}
        {!running && shown && <DirectionBanner d={shown} />}
        {!running && !shown && (
          <div className="panel p-6 text-center font-terminal text-xs text-muted-foreground">
            <Clock className="mx-auto mb-2 size-5" />
            NO ANALYSIS YET — press ANALYZE to scan {symbol}
          </div>
        )}

        {/* Portfolio + data row */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
          <StatTile label="PAPER BALANCE" value={fmtMoney(account?.balance ?? 0)} tone="neutral" />
          <StatTile
            label="EQUITY (EST.)"
            value={fmtMoney(equity)}
            sub={marked.usedFallback.length ? `STALE · entry fallback: ${marked.usedFallback.join(", ")}` : account ? `start ${fmtMoney(account.startingBalance)}` : undefined}
          />
          <StatTile
            label="DAILY P&L"
            value={fmtMoney(dayPnl)}
            tone={dayPnl >= 0 ? "up" : "down"}
            sub={account ? fmtPct(account.dayStartEquity > 0 ? (dayPnl / account.dayStartEquity) * 100 : 0) : undefined}
          />
          <StatTile label="DRAWDOWN" value={`${dd.toFixed(2)}%`} tone={dd > 5 ? "down" : "neutral"} sub={`HWM ${fmtMoney(hwm)}`} />
          <StatTile label="ACTIVE POSITIONS" value={String(openPositions.length)} />
          <StatTile
            label="ARISE STATUS"
            value={account?.emergencyStop ? "HALTED" : "RUNNING"}
            tone={account?.emergencyStop ? "down" : "up"}
            sub={account?.emergencyStop ? "emergency stop" : "risk checks passing"}
          />
        </div>

        {shown && (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {/* LEFT: market + thesis */}
            <div className="space-y-3 lg:col-span-2">
              <Panel
                title="MIND AI — CURRENT THESIS"
                right={
                  <div className="flex items-center gap-2">
                    <QualityBadge quality={shown.dataQuality} />
                    <span className="font-terminal text-[10px] text-muted-foreground">
                      DATA {fmtAge(shown.dataAgeSec).toUpperCase()} · {(meta?.source ?? "—").toUpperCase()} · {meta?.bars ?? 0} BARS
                    </span>
                    <Link
                      to={`/decision/${shown.decisionId}`}
                      className="border border-border px-2 py-0.5 font-terminal text-[9px] text-primary hover:border-primary/50"
                    >
                      FULL RECORD →
                    </Link>
                  </div>
                }
              >
                <p className="text-sm leading-relaxed">{shown.thesis}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 font-terminal text-[10px] text-muted-foreground">
                  <Badge variant="outline" className="font-terminal text-[9px]">
                    {Object.keys(agents ?? {}).length} SPECIALISTS · {Math.round(mind?.agreementPct ?? 0)}% AGREEMENT
                  </Badge>
                  <Badge variant="outline" className="font-terminal text-[9px]">
                    MIND RECOMMENDATION: {shown.recommendedAction}
                  </Badge>
                  {shown.fetchMs ? <Badge variant="outline" className="font-terminal text-[9px]">FETCH {shown.fetchMs}MS</Badge> : null}
                  {meta?.spreadPct != null && (
                    <Badge variant="outline" className="font-terminal text-[9px]">SPREAD {meta.spreadPct.toFixed(3)}%</Badge>
                  )}
                  {meta?.fallback && <Badge variant="outline" className="font-terminal text-[9px] text-warning">FALLBACK: {meta.fallback}</Badge>}
                </div>
              </Panel>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Panel title="SUPPORTING EVIDENCE">
                  <ul className="space-y-1.5">
                    {(mind?.supportingEvidence ?? ["Run an analysis"]).map((e, i) => (
                      <li key={i} className="flex gap-2 text-xs leading-relaxed">
                        <Check className="mt-0.5 size-3 shrink-0 text-success" /> {e}
                      </li>
                    ))}
                  </ul>
                </Panel>
                <Panel title="CONTRADICTING EVIDENCE">
                  <ul className="space-y-1.5">
                    {(mind?.contradictingEvidence ?? ["—"]).map((e, i) => (
                      <li key={i} className="flex gap-2 text-xs leading-relaxed">
                        <X className="mt-0.5 size-3 shrink-0 text-danger" /> {e}
                      </li>
                    ))}
                  </ul>
                </Panel>
                <Panel title="KEY RISKS">
                  <ul className="space-y-1.5">
                    {(mind?.keyRisks ?? ["—"]).map((e, i) => (
                      <li key={i} className="flex gap-2 text-xs leading-relaxed">
                        <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" /> {e}
                      </li>
                    ))}
                  </ul>
                </Panel>
                <Panel title="INVALIDATION — WHAT CHANGES THE CALL">
                  <ul className="space-y-1.5">
                    {(mind?.invalidationConditions ?? ["—"]).map((e, i) => (
                      <li key={i} className="flex gap-2 text-xs leading-relaxed">
                        <Zap className="mt-0.5 size-3 shrink-0 text-primary" /> {e}
                      </li>
                    ))}
                  </ul>
                </Panel>
              </div>
            </div>

            {/* RIGHT: agents + risk + plan */}
            <div className="space-y-3">
              <Panel title="AI OPINIONS" right={<span className="font-terminal text-[9px] text-muted-foreground">{Object.keys(agents ?? {}).length}/7 · ENGINE {agents ? Object.values(agents)[0]?.modelVersion ?? "—" : "—"}</span>}>
                <div className="space-y-2.5">
                  {agents ? Object.entries(agents).map(([key, a]) => (
                    <div key={key} className="border-b border-border/60 pb-2 last:border-0 last:pb-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-terminal text-[10px] font-semibold tracking-wider">
                          {AGENT_LABELS[key] ?? key}
                        </span>
                        <SignalChip signal={a.signal} />
                      </div>
                      <ConfidenceBar value={a.confidence} className="mt-1" />
                      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{a.summary}</p>
                      {a.regime && (
                        <p className="mt-0.5 font-terminal text-[9px] text-primary">REGIME: {a.regime}</p>
                      )}
                      {a.manipulationLevel && a.manipulationLevel !== "NORMAL" && (
                        <p className="mt-0.5 font-terminal text-[9px] text-warning">ANOMALY: {a.manipulationLevel}</p>
                      )}
                    </div>
                  )) : (
                    <div className="py-4 text-center text-xs text-muted-foreground">Run an analysis to populate agent views</div>
                  )}
                </div>
              </Panel>

              <Panel title="RISK STATUS" right={<SignalChip signal={shown.riskChecks.every((c) => c.pass) ? "PASS" : "VETO"} />}>
                <div className="max-h-44 space-y-0 overflow-y-auto">
                  {shown.riskChecks.length > 0 ? (
                    shown.riskChecks.map((c) => (
                      <div key={c.rule} className="flex items-start gap-2 py-1">
                        {c.pass ? (
                          <Check className="mt-0.5 size-3 shrink-0 text-success" />
                        ) : (
                          <X className="mt-0.5 size-3 shrink-0 text-danger" />
                        )}
                        <div className="min-w-0">
                          <span className={cn("font-terminal text-[10px] font-semibold", c.pass ? "text-foreground" : "text-danger")}>
                            {c.rule}
                          </span>
                          <span className="ml-1.5 text-[10px] text-muted-foreground">{c.detail}</span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="py-2 text-center text-xs text-muted-foreground">No checks recorded</div>
                  )}
                </div>
              </Panel>

              {/* Trade plan */}
              {mind?.plan && (
                <Panel title="PAPER TRADE PLAN">
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-terminal text-[11px] tabular">
                    <span className="text-muted-foreground">SIDE</span>
                    <SignalChip signal={mind.plan.side} />
                    <span className="text-muted-foreground">ENTRY</span>
                    <span>{fmtPrice(mind.plan.entry)}</span>
                    <span className="text-muted-foreground">STOP LOSS</span>
                    <span className="text-danger">{fmtPrice(mind.plan.stopLoss)}</span>
                    <span className="text-muted-foreground">TARGET (2R)</span>
                    <span className="text-success">{fmtPrice(mind.plan.takeProfit)}</span>
                    <span className="text-muted-foreground">SIZE</span>
                    <span>{mind.plan.positionSize.toPrecision(6)} @ {fmtMoney(mind.plan.positionSizeQuote)}</span>
                    <span className="text-muted-foreground">MAX LOSS</span>
                    <span className="text-warning">{fmtMoney(mind.plan.maxLossQuote)} ({mind.plan.maxLossPct.toFixed(2)}%)</span>
                  </div>
                </Panel>
              )}

              {shown.execution && (
                <Panel title="EXECUTION MONITOR (PAPER)">
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-terminal text-[11px] tabular">
                    <span className="text-muted-foreground">STATUS</span>
                    <StatusChip state={shown.execution.status === "FILLED" ? "COMPLETED" : "BLOCKED"} />
                    <span className="text-muted-foreground">FILL PRICE</span>
                    <span>{fmtPrice(Number(shown.execution.fillPrice ?? 0))}</span>
                    <span className="text-muted-foreground">QTY</span>
                    <span>{Number(shown.execution.qty ?? 0).toPrecision(6)}</span>
                    <span className="text-muted-foreground">FEE</span>
                    <span>{fmtMoney(Number(shown.execution.fee ?? 0))}</span>
                    <span className="text-muted-foreground">SLIPPAGE</span>
                    <span>{String(shown.execution.slippageBps ?? "—")} BPS</span>
                  </div>
                </Panel>
              )}

              {/* MIND debate */}
              {mind?.debate && mind.debate.length > 0 && (
                <Panel title="MIND AI — DEBATE & CHALLENGE">
                  <div className="space-y-2.5">
                    {mind.debate.map((d, i) => (
                      <div key={i} className="border-l-2 border-primary/40 pl-2.5">
                        <div className="font-terminal text-[10px] font-semibold">{d.topic}</div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          {d.agents.map((a) => `${a.agent}→${a.position}`).join(" · ")}
                        </div>
                        <p className="mt-0.5 text-[10px] leading-relaxed">{d.resolution}</p>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}
            </div>
          </div>
        )}

        {/* Delta Exchange demo mirror — read-only, admin-only (shared deployment account) */}
        {isAdmin && (
        <Panel
          title="DELTA DEMO MIRROR — ACCOUNT (TESTNET)"
          right={
            <Button size="sm" variant="outline" className="font-terminal text-[10px]" disabled={deltaBusy} onClick={() => void syncDelta()}>
              {deltaBusy ? "SYNCING…" : "SYNC ACCOUNT"}
            </Button>
          }
        >
          {deltaError ? (
            <div className="text-[10px] text-danger">{deltaError}</div>
          ) : !deltaAccount ? (
            <div className="text-xs text-muted-foreground">
              Not synced yet. Reads Delta demo balances and positions (requires DELTA_TRADING_MODE=demo). Paper trading stays local — this panel is read-only.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <div className="panel-title mb-1 text-[9px]">WALLET BALANCES</div>
                {deltaAccount.balances.length === 0 ? (
                  <div className="text-[10px] text-muted-foreground">No balances returned.</div>
                ) : (
                  <table className="w-full font-terminal text-[10px]">
                    <thead><tr className="border-b border-border text-left text-[9px] text-muted-foreground"><th className="py-1 pr-2">ASSET</th><th className="py-1 pr-2 text-right">BALANCE</th><th className="py-1 text-right">AVAILABLE</th></tr></thead>
                    <tbody>
                      {deltaAccount.balances.map((b) => (
                        <tr key={b.asset} className="border-b border-border/40">
                          <td className="py-1 pr-2">{b.asset}</td>
                          <td className="py-1 pr-2 text-right tabular">{b.balance.toFixed(4)}</td>
                          <td className="py-1 text-right tabular">{b.availableBalance === null ? "—" : b.availableBalance.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div>
                <div className="panel-title mb-1 text-[9px]">OPEN POSITIONS</div>
                {deltaAccount.positions.length === 0 ? (
                  <div className="text-[10px] text-muted-foreground">No open margined positions.</div>
                ) : (
                  <table className="w-full font-terminal text-[10px]">
                    <thead><tr className="border-b border-border text-left text-[9px] text-muted-foreground"><th className="py-1 pr-2">SYMBOL</th><th className="py-1 pr-2 text-right">SIZE</th><th className="py-1 pr-2 text-right">ENTRY</th><th className="py-1 text-right">uPnL</th></tr></thead>
                    <tbody>
                      {deltaAccount.positions.map((p) => (
                        <tr key={p.symbol} className="border-b border-border/40">
                          <td className="py-1 pr-2">{p.symbol}</td>
                          <td className="py-1 pr-2 text-right tabular">{p.size}</td>
                          <td className="py-1 pr-2 text-right tabular">{p.entryPrice === null ? "—" : p.entryPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
                          <td className={cn("py-1 text-right tabular", (p.unrealizedPnl ?? 0) >= 0 ? "text-success" : "text-danger")}>{p.unrealizedPnl === null ? "—" : p.unrealizedPnl.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </Panel>
        )}

        {/* Recent system events */}
        {events && events.length > 0 && (
          <Panel title="SYSTEM FEED" className="mt-3">
            <div className="space-y-1 font-terminal text-[10px]">
              {events.map((e) => (
                <div key={e._id} className="flex items-center gap-2">
                  <Badge variant="outline" className={cn("font-terminal text-[9px]", e.level === "ERROR" && "border-danger/40 text-danger")}>
                    {e.level}
                  </Badge>
                  <span className="text-muted-foreground tabular">{new Date(e.at).toISOString().slice(11, 19)}</span>
                  <span className="text-muted-foreground">{e.area}</span>
                  <span className="truncate">{e.code}: {e.message}</span>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </div>
    </Terminal>
  );
}
