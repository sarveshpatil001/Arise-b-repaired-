import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Panel,
  QualityBadge,
  SignalChip,
  StatTile,
  StatusChip,
} from "@/components/arise/shared";
import { Terminal } from "@/components/arise/Terminal";
import {
  useAccount,
  useAnalysisHealth,
  useAnalysisHistory,
  useAnalysisMonitoring,
  useAnalysisPerformance,
  useLatestAnalysisRecord,
  useLatestDecision,
  useOpenPositions,
  useRunDecision,
  useRunStrategyArena,
  useSaveAnalysis,
  useSymbols,
  useFetchCatalysts,
  useEntitlements,
} from "@/hooks/use-arise";
import { DEFAULT_CONFIG } from "@/lib/arise/config";
import {
  buildModuleHealth,
  buildTradePlanCard,
  computeRiskPreview,
  type CatalystView,
  type DecisionLike,
  type MonitoringAssessment,
  type TradePlanCard,
} from "@/lib/arise/analysis";
import type { ArenaResult } from "@/lib/arise/arena";
import { fmtMoney } from "@/lib/arise/math";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  Gauge,
  History,
  Lock,
  Newspaper,
  Play,
  RefreshCw,
  Save,
  ShieldAlert,
  Swords,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNowMs } from "@/hooks/use-clock";
import { Link } from "react-router";

type Tab = "plan" | "monitoring" | "risk" | "arena" | "news" | "health" | "history";

const TABS: { id: Tab; label: string; icon: typeof BrainCircuit }[] = [
  { id: "plan", label: "TRADE ANALYSIS", icon: BrainCircuit },
  { id: "monitoring", label: "MONITORING", icon: Activity },
  { id: "risk", label: "RISK", icon: ShieldAlert },
  { id: "arena", label: "STRATEGY ARENA", icon: Swords },
  { id: "news", label: "NEWS", icon: Newspaper },
  { id: "health", label: "AI PERFORMANCE", icon: Gauge },
  { id: "history", label: "TRADE HISTORY", icon: History },
];

const INTERVALS = ["5m", "15m", "1h", "4h", "1d"];

interface AnalysisRecordRow {
  _id: string;
  decisionId: string;
  createdAt: number;
  symbol: string;
  interval: string;
  status: string;
  direction: string;
  confidence: number;
  thesis: string;
  dataQuality: string;
  dataTimestamp: number;
  tradeCard?: TradePlanCard | null;
  strategy?: { selectedId?: string | null; selectedLabel?: string | null; marketClass?: string | null; score?: number | null } | null;
  risk?: { decision?: string; reasonCode?: string } | null;
}

interface MonitoringRow {
  record: AnalysisRecordRow;
  position: {
    _id: string;
    side: string;
    qty: number;
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    status: string;
    openedAt: number;
    pnl?: number;
    exitReason?: string;
  } | null;
  assessment: MonitoringAssessment;
}

interface ArenaRun {
  arena: ArenaResult;
  riskReview: ReturnType<typeof computeRiskPreview> | null;
  riskVeto: { id: string; label: string; reasonCode: string; message: string } | null;
  provenance: {
    provider: string;
    interval: string;
    requestedInterval: string;
    fellBack: boolean;
    quality: string;
    notes: string[];
    bars: number;
    lastBarTime: number;
  };
}

interface HealthPayload {
  latestDecision: DecisionLike | null;
  latestRecord: { createdAt: number; strategy?: { selectedId?: string } | null } | null;
  monitor: { state: string; lastTickAt: number | null; detail: string } | null;
  account: { emergencyStop: boolean } | null;
  arenaRanAt: number | null;
  providerFailureCount: number;
  providerEventAt: number | null;
}

export default function Analysis() {
  const symbols = useSymbols();
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setInterval] = useState("1h");
  const [tab, setTab] = useState<Tab>("plan");
  const [busy, setBusy] = useState<"analyze" | "save" | "arena" | "catalysts" | null>(null);
  const [arenaRun, setArenaRun] = useState<ArenaRun | null>(null);
  const [arenaError, setArenaError] = useState<string | null>(null);
  const [catalystView, setCatalystView] = useState<CatalystView | null>(null);
  const [catalystError, setCatalystError] = useState<string | null>(null);

  const account = useAccount();
  const open = useOpenPositions();
  const entitlements = useEntitlements();
  const latestDecision = useLatestDecision(symbol);
  const latestRecord = useLatestAnalysisRecord(symbol) as AnalysisRecordRow | null | undefined;
  const historyRows = useAnalysisHistory(80) as AnalysisRecordRow[] | undefined;
  const monitoringRows = useAnalysisMonitoring() as MonitoringRow[] | undefined;
  const performance = useAnalysisPerformance();
  const health = useAnalysisHealth() as HealthPayload | undefined;

  const runDecision = useRunDecision();
  const saveAnalysis = useSaveAnalysis();
  const runArena = useRunStrategyArena();
  const fetchCatalysts = useFetchCatalysts();
  const now = useNowMs();

  const decision = (latestDecision ?? null) as DecisionLike | null;
  const savedCard = latestRecord?.tradeCard ?? null;
  const liveCard = useMemo(
    () => (decision ? buildTradePlanCard(decision, now) : null),
    [decision, now],
  );
  // A saved card is frozen evidence; once its entry window expires the current view
  // must show the expiry rather than a stale "available" plan.
  const card = useMemo(() => {
    if (!savedCard) return liveCard;
    if (savedCard.entryWindowExpiresAt && now > savedCard.entryWindowExpiresAt) return liveCard;
    return savedCard;
  }, [savedCard, liveCard, now]);

  const riskPreview = useMemo(() => {
    if (!decision || !decision.snapshotMeta?.lastClose || !decision.features?.volatility?.atr14) return null;
    const side = decision.direction === "LONG" || decision.direction === "SHORT" ? decision.direction : null;
    if (!side) return null;
    return computeRiskPreview({
      side,
      entry: decision.snapshotMeta.lastClose,
      atr: decision.features.volatility.atr14,
      equity: account?.balance ?? DEFAULT_CONFIG.startingBalance,
      balance: account?.balance ?? 0,
      dayStartEquity: account?.dayStartEquity ?? 0,
      highWaterMark: account?.equityHighWaterMark ?? 0,
      openNotional: open.reduce((sum, p) => sum + p.qty * p.entryPrice, 0),
      openPositions: open.length,
      emergencyStop: account?.emergencyStop ?? true,
      config: DEFAULT_CONFIG,
    });
  }, [decision, account, open]);

  const modules = useMemo(() => {
    if (!health) return [];
    return buildModuleHealth({
      now,
      latestDecision: health.latestDecision,
      latestRecord: health.latestRecord,
      monitor: health.monitor,
      account: health.account,
      catalysts: catalystView,
      arenaRanAt: arenaRun?.arena.evaluatedAt ?? health.arenaRanAt,
      providerFailureCount: health.providerFailureCount,
      providerEventAt: health.providerEventAt,
    });
  }, [health, catalystView, arenaRun, now]);

  const loadCatalysts = async (force = false) => {
    if (catalystView && !force) return;
    setBusy("catalysts");
    setCatalystError(null);
    try {
      const view = (await fetchCatalysts({ symbol })) as CatalystView;
      setCatalystView(view);
    } catch (e) {
      setCatalystError(e instanceof Error ? e.message : "Catalyst request failed");
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if ((tab !== "news" && tab !== "health") || catalystView || busy === "catalysts") return;
    // Deferred so the effect body itself does not set state synchronously.
    const timer = window.setTimeout(() => void loadCatalysts(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const analyze = async () => {
    setBusy("analyze");
    try {
      const result = await runDecision({ symbol, interval, execute: false });
      await saveAnalysis({ decisionId: result.decisionId });
      toast.success(
        `${result.direction === "FLAT" ? "NO TRADE" : result.direction} · ${result.status} · signal recorded (no order placed)`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setBusy(null);
    }
  };

  const saveCurrent = async () => {
    if (!latestDecision?._id) return;
    setBusy("save");
    try {
      await saveAnalysis({ decisionId: latestDecision._id as never });
      toast.success("Analysis saved to the immutable trade history");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  };

  const runArenaAction = async () => {
    setBusy("arena");
    setArenaError(null);
    try {
      const result = (await runArena({ symbol, interval: interval as "5m" | "15m" | "1h" | "4h" | "1d" })) as ArenaRun;
      setArenaRun(result);
    } catch (e) {
      setArenaError(e instanceof Error ? e.message : "Arena run failed");
    } finally {
      setBusy(null);
    }
  };

  const saveWithArena = async () => {
    if (!latestDecision?._id || !arenaRun?.arena.selected) return;
    setBusy("save");
    try {
      await saveAnalysis({
        decisionId: latestDecision._id as never,
        strategy: {
          selectedId: arenaRun.arena.selected.id,
          selectedLabel: arenaRun.arena.selected.label,
          marketClass: arenaRun.arena.marketClass,
          score: arenaRun.arena.selected.score,
          ranking: arenaRun.arena.ranking.map((r) => ({ id: r.id, label: r.label, score: r.score, status: r.status })),
        },
      });
      toast.success("Arena selection attached to a new immutable analysis record");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Terminal>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="font-terminal text-lg font-bold tracking-wider">
              ANALYSIS
              <span className="ml-3 text-xs font-normal text-muted-foreground">
                SIGNALS · RISK · STRATEGY EVIDENCE · PAPER ONLY
              </span>
            </h1>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Generating an analysis never places an order. Hard risk controls are deterministic and cannot be overridden by AI.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={symbol} onValueChange={setSymbol}>
              <SelectTrigger className="h-8 w-36 font-terminal text-xs"><SelectValue /></SelectTrigger>
              <SelectContent className="font-terminal text-xs">
                {symbols.map((s) => <SelectItem key={s.symbol} value={s.symbol}>{s.symbol}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={interval} onValueChange={setInterval}>
              <SelectTrigger className="h-8 w-20 font-terminal text-xs"><SelectValue /></SelectTrigger>
              <SelectContent className="font-terminal text-xs">
                {INTERVALS.map((i) => <SelectItem key={i} value={i}>{i}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              className="h-8 gap-1.5 font-terminal text-[10px]"
              disabled={busy !== null}
              onClick={() => void analyze()}
            >
              <Play className="size-3" /> {busy === "analyze" ? "RUNNING…" : "RUN ANALYSIS"}
            </Button>
          </div>
        </div>

        <div className="panel flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 font-terminal text-[10px] tracking-wider">
          <StatusChip state="PAPER" />
          <span className="flex items-center gap-1 text-muted-foreground"><Lock className="size-3" /> LIVE EXECUTION DISABLED</span>
          <span className="text-muted-foreground">
            PLAN <span className="text-foreground">{entitlements?.planName ?? "—"}</span>
          </span>
          <span className="text-muted-foreground">
            ANALYSES LEFT TODAY{" "}
            <span className="text-foreground">
              {entitlements ? (entitlements.remainingToday === -1 ? "UNLIMITED" : entitlements.remainingToday) : "—"}
            </span>
          </span>
          {account?.emergencyStop && (
            <span className="flex items-center gap-1 text-danger"><AlertTriangle className="size-3" /> PAPER TRADING PAUSED</span>
          )}
        </div>

        <div className="flex gap-1 overflow-x-auto border-b border-border pb-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 font-terminal text-[10px] tracking-wider transition-colors",
                tab === t.id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              <t.icon className="size-3" /> {t.label}
            </button>
          ))}
        </div>

        {tab === "plan" && (
          <TradePlanTab
            symbol={symbol}
            interval={interval}
            card={card}
            decision={decision}
            latestRecord={latestRecord ?? null}
            busy={busy}
            onSave={() => void saveCurrent()}
            onAnalyze={() => void analyze()}
            arenaRun={arenaRun}
            onSaveArena={() => void saveWithArena()}
          />
        )}

        {tab === "monitoring" && <MonitoringTab rows={monitoringRows} now={now} />}

        {tab === "risk" && <RiskTab preview={riskPreview} account={account} openCount={open.length} />}

        {tab === "arena" && (
          <ArenaTab run={arenaRun} error={arenaError} busy={busy === "arena"} onRun={() => void runArenaAction()} />
        )}

        {tab === "news" && (
          <NewsTab view={catalystView} error={catalystError} busy={busy === "catalysts"} onRefresh={() => void loadCatalysts(true)} />
        )}

        {tab === "health" && <HealthTab modules={modules} performance={performance} health={health} />}

        {tab === "history" && <HistoryTab rows={historyRows ?? []} />}
      </div>
    </Terminal>
  );
}

// ---------------------------------------------------------------- trade plan

function TradePlanTab({
  symbol,
  interval,
  card,
  decision,
  latestRecord,
  busy,
  onSave,
  onAnalyze,
  arenaRun,
  onSaveArena,
}: {
  symbol: string;
  interval: string;
  card: TradePlanCard | null;
  decision: DecisionLike | null;
  latestRecord: AnalysisRecordRow | null;
  busy: string | null;
  onSave: () => void;
  onAnalyze: () => void;
  arenaRun: ArenaRun | null;
  onSaveArena: () => void;
}) {
  if (!decision) {
    return (
      <EmptyState
        icon={<BrainCircuit className="size-8" />}
        title={`NO ANALYSIS YET FOR ${symbol}/${interval}`}
        body="Run a trade analysis to generate a structured plan. It is a signal only — no order is placed until you explicitly paper-execute from the existing workflow."
        action={<Button size="sm" className="font-terminal text-[10px]" onClick={onAnalyze}>RUN ANALYSIS</Button>}
      />
    );
  }
  if (!card) return <EmptyState icon={<BrainCircuit className="size-8" />} title="NO PLAN" body="The stored analysis has no readable plan." />;

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <Panel
        title={`TRADE PLAN — ${symbol}/${interval}`}
        className="lg:col-span-2"
        right={
          <div className="flex flex-wrap items-center gap-1.5">
            <QualityBadge quality={card.dataQuality} />
            <SignalChip signal={card.available ? (card.side ?? "NEUTRAL") : "NO TRADE"} />
            {latestRecord ? <Badge variant="outline" className="font-terminal text-[9px]">SAVED</Badge> : null}
          </div>
        }
      >
        {!card.available ? (
          <div className="border border-warning/40 bg-warning/10 p-3">
            <div className="flex items-center gap-2 font-terminal text-sm font-bold text-warning">
              <AlertTriangle className="size-4" /> NO TRADE — {card.noTradeReason}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{card.noTradeDetail}</p>
            <p className="mt-2 text-[11px] leading-relaxed">{card.explanation}</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatTile label="ENTRY" value={fmtPrice(card.entry)} sub={card.entryRange ? `band ${fmtPrice(card.entryRange.low)}–${fmtPrice(card.entryRange.high)}` : "quoted band"} />
              <StatTile label="STOP LOSS" value={fmtPrice(card.stopLoss)} tone="down" sub="predefined; never widened" />
              <StatTile label="R:R (TP2)" value={card.riskReward ? `${card.riskReward.toFixed(2)} : 1` : "n/a"} sub="plan target" />
              <StatTile label="CONFIDENCE" value={card.confidence === null ? "N/A" : `${Math.round(card.confidence * 100)}%`} sub={card.confidence === null ? "no defensible basis" : "heuristic ensemble"} />
            </div>

            <div className="overflow-x-auto">
              <table className="w-full font-terminal text-[11px]">
                <thead>
                  <tr className="border-b border-border text-left text-[9px] text-muted-foreground">
                    <th className="py-1.5 pr-3">TARGET</th>
                    <th className="py-1.5 pr-3 text-right">PRICE</th>
                    <th className="py-1.5 pr-3 text-right">R MULTIPLE</th>
                    <th className="py-1.5">SOURCE</th>
                  </tr>
                </thead>
                <tbody>
                  {card.targets.map((t) => (
                    <tr key={t.label} className="border-b border-border/40">
                      <td className="py-1.5 pr-3 font-semibold text-success">{t.label}</td>
                      <td className="py-1.5 pr-3 text-right tabular">{fmtPrice(t.price)}</td>
                      <td className="py-1.5 pr-3 text-right tabular">{t.rMultiple.toFixed(2)}R</td>
                      <td className="py-1.5 text-[10px] text-muted-foreground">{t.derived ? "DERIVED R-MULTIPLE" : "PIPELINE PLAN"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ListBlock title="ENTRY CONDITIONS" items={card.entryConditions} tone="text-foreground" />
              <ListBlock title="CLOSE CONDITIONS" items={card.closeConditions} tone="text-muted-foreground" />
            </div>

            <div className="grid grid-cols-2 gap-2 border-t border-border pt-2 font-terminal text-[10px] sm:grid-cols-4">
              <KV k="ENTRY WINDOW" v={card.entryWindowExpiresAt ? `${fmtTime(card.entryWindowExpiresAt)} UTC` : "—"} tone={card.entryWindowExpired ? "text-warning" : ""} />
              <KV k="HOLD ESTIMATE" v={card.estimatedHoldingHours ? `${card.estimatedHoldingHours.min}–${card.estimatedHoldingHours.max}h` : "—"} />
              <KV k="PROVIDER" v={card.provider} />
              <KV k="CREATED" v={`${fmtTime(card.createdAt)} UTC`} />
            </div>
          </div>
        )}

        <p className="mt-3 border-t border-border pt-2 text-[11px] leading-relaxed">{card.explanation}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!latestRecord && decision._id ? (
            <Button size="sm" variant="outline" className="gap-1.5 font-terminal text-[10px]" disabled={busy !== null} onClick={onSave}>
              <Save className="size-3" /> SAVE IMMUTABLE RECORD
            </Button>
          ) : (
            <span className="font-terminal text-[9px] text-muted-foreground">
              SAVED {latestRecord ? `${fmtTime(latestRecord.createdAt)} UTC` : ""} · THE ORIGINAL PREDICTION IS NEVER REWRITTEN
            </span>
          )}
          {arenaRun?.arena.selected && !latestRecord ? (
            <Button size="sm" variant="secondary" className="gap-1.5 font-terminal text-[10px]" disabled={busy !== null} onClick={onSaveArena}>
              <Swords className="size-3" /> SAVE WITH ARENA SELECTION
            </Button>
          ) : null}
        </div>
      </Panel>

      <div className="space-y-3">
        <Panel title="EVIDENCE & PROVENANCE">
          <div className="space-y-1.5">
            {card.evidence.map((e, i) => (
              <p key={i} className="border-l-2 border-primary/40 pl-2 text-[10px] leading-relaxed text-muted-foreground">{e}</p>
            ))}
          </div>
        </Panel>
        <Panel title="WHAT THIS IS">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            A generated signal. It is <span className="text-foreground">not</span> an executed paper trade, and it is not financial advice.
            The strategy label is rule-based: the pipeline is a deterministic heuristic ensemble with MIND synthesis and an evidence gate — not an LLM.
          </p>
          <div className="mt-2 space-y-1 font-terminal text-[10px]">
            <KV k="STRATEGY" v={latestRecord?.strategy?.selectedLabel ?? card.strategy ?? "pipeline"} />
            <KV k="MODE" v="PAPER ONLY" />
            <KV k="ORDER PLACED" v="NO" tone="text-success" />
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- monitoring

function MonitoringTab({ rows, now }: { rows: MonitoringRow[] | undefined; now: number }) {
  if (rows === undefined) return <LoadingState label="LOADING MONITORING RECORDS…" />;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Activity className="size-8" />}
        title="NO SAVED PREDICTIONS TO MONITOR"
        body="Save an analysis first. Monitoring compares the saved prediction with later completed market data; it never evaluates a pre-entry candle."
      />
    );
  }
  return (
    <div className="space-y-3">
      <p className="font-terminal text-[10px] text-muted-foreground">
        Monitoring evaluates only completed observations at or after the paper entry. Stale or unavailable data is shown as unavailable — never filled in.
      </p>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {rows.map(({ record, position, assessment }) => (
          <Panel
            key={record._id}
            title={`${record.symbol}/${record.interval} · ${fmtTime(record.dataTimestamp)} UTC`}
            right={
              <div className="flex items-center gap-1.5">
                <SignalChip signal={record.direction} />
                <span className={cn("border px-1.5 py-0.5 font-terminal text-[9px]", thesisTone(assessment.thesisStatus))}>
                  {assessment.thesisStatus}
                </span>
              </div>
            }
          >
            <p className="text-[11px] leading-relaxed text-muted-foreground">{record.thesis}</p>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-terminal text-[10px] sm:grid-cols-3">
              <KV k="PREDICTED" v={record.direction} />
              <KV k="CURRENT" v={assessment.currentPrice !== null ? fmtPrice(assessment.currentPrice) : "—"} />
              <KV k="MOVE" v={assessment.currentDirection} />
              <KV k="PAPER ENTRY" v={position ? fmtPrice(position.entryPrice) : "not executed"} />
              <KV k="POSITION" v={assessment.positionState} />
              <KV k="P&L (EST.)" v={assessment.unrealizedPnl !== null ? fmtMoney(assessment.unrealizedPnl) : assessment.realizedPnl !== null ? fmtMoney(assessment.realizedPnl) : "—"} tone={(assessment.unrealizedPnl ?? assessment.realizedPnl ?? 0) >= 0 ? "text-success" : "text-danger"} />
              <KV k="STOP" v={assessment.stopStatus} />
              <KV k="TARGET" v={assessment.targetStatus} />
              <KV k="FOLLOWING" v={assessment.followingPrediction === null ? "n/a" : assessment.followingPrediction ? "YES" : "NO"} />
            </div>
            <div className={cn("mt-2 border-l-2 pl-2 text-[10px] leading-relaxed", assessment.status === "OK" ? "border-primary/40 text-muted-foreground" : "border-warning/50 text-warning")}>
              <span className="font-terminal">{assessment.status}:</span> {assessment.reason}
              {assessment.markTime ? ` Observation ${fmtTime(assessment.markTime)} UTC${assessment.markAgeSec !== null ? ` (${Math.round(assessment.markAgeSec / 60)}m old)` : ""}.` : ""}
            </div>
            {assessment.invalidationReasons.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {assessment.invalidationReasons.map((r, i) => <li key={i} className="text-[10px] text-warning">• {r}</li>)}
              </ul>
            )}
            <div className="mt-2 flex items-center justify-between border-t border-border pt-1.5 font-terminal text-[9px] text-muted-foreground">
              <span>MONITORED {fmtTime(now)} UTC</span>
              <Link to={`/decision/${record.decisionId}`} className="text-primary hover:underline">ORIGINAL RECORD →</Link>
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- risk

function RiskTab({
  preview,
  account,
  openCount,
}: {
  preview: ReturnType<typeof computeRiskPreview> | null;
  account: { balance?: number; emergencyStop?: boolean } | null | undefined;
  openCount: number;
}) {
  if (!preview) {
    return (
      <EmptyState
        icon={<ShieldAlert className="size-8" />}
        title="NO RISK PREVIEW AVAILABLE"
        body="Run a trade analysis with a directional plan first. A risk preview is deterministic and always reports NO TRADE when a limit fails."
      />
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <Panel
        title="RISK AI — DETERMINISTIC PREVIEW"
        className="lg:col-span-2"
        right={<StatusChip state={preview.decision === "NO_TRADE" ? "BLOCKED" : preview.decision === "REDUCED" ? "WARNING" : "PASS"} />}
      >
        <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
          This is not an AI opinion. Stops, position size and limits are arithmetic; an AI explanation cannot override them. No order is placed by this preview.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="STOP LOSS" value={fmtPrice(preview.stopLoss)} tone="down" sub={preview.stopDistance ? `ATR-based distance ${preview.stopDistance.toFixed(4)}` : "not set"} />
          <StatTile label="RISK" value={preview.riskAmount ? fmtMoney(preview.riskAmount) : "—"} sub={`${preview.riskPct.toFixed(2)}% of equity`} tone={preview.riskPct > 1 ? "down" : "neutral"} />
          <StatTile label="POSITION" value={preview.qty ? preview.qty.toPrecision(6) : "—"} sub={preview.notional ? fmtMoney(preview.notional) : "no size"} />
          <StatTile label="COSTS (EST.)" value={fmtMoney(preview.estimatedCosts)} sub="fees + slippage, both sides" />
        </div>
        <div className="mt-3 space-y-1">
          {preview.checks.map((c) => (
            <div key={c.rule} className="flex items-start gap-2 border-b border-border/40 py-1 last:border-0">
              <span className={cn("mt-0.5 font-terminal text-[10px]", c.pass ? "text-success" : "text-danger")}>{c.pass ? "PASS" : "FAIL"}</span>
              <span className="font-terminal text-[10px] font-semibold">{c.rule}</span>
              <span className="ml-auto text-right text-[10px] text-muted-foreground">{c.detail}</span>
            </div>
          ))}
        </div>
        <div className={cn("mt-2 border px-2 py-1.5 font-terminal text-[10px]", preview.decision === "NO_TRADE" ? "border-danger/40 bg-danger/10 text-danger" : "border-primary/40 bg-primary/10 text-primary")}>
          {preview.decision}: {preview.reasonCode} — {preview.message}
        </div>
      </Panel>

      <div className="space-y-3">
        <Panel title="ASSUMPTIONS & AUDIT">
          <ul className="space-y-1">
            {preview.assumptions.map((a, i) => <li key={i} className="text-[10px] leading-relaxed text-muted-foreground">• {a}</li>)}
          </ul>
        </Panel>
        <Panel title="PAPER ACCOUNT">
          <div className="space-y-1 font-terminal text-[10px]">
            <KV k="BALANCE" v={fmtMoney(account?.balance ?? 0)} />
            <KV k="OPEN POSITIONS" v={String(openCount)} />
            <KV k="PAUSE" v={account?.emergencyStop ? "ACTIVE" : "CLEAR"} tone={account?.emergencyStop ? "text-danger" : "text-success"} />
            <KV k="LIVE TRADING" v="DISABLED" tone="text-success" />
          </div>
          <p className="mt-2 border-t border-border pt-2 text-[10px] text-muted-foreground">
            Use the existing Risk screen for the emergency-stop control. It halts new paper entries; it does not close existing positions.
          </p>
        </Panel>
        {preview.targets.length > 0 && (
          <Panel title="TARGET LADDER">
            <div className="space-y-1 font-terminal text-[10px]">
              {preview.targets.map((t) => <KV key={t.label} k={`${t.label} (${t.rMultiple}R)`} v={fmtPrice(t.price)} />)}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- arena

function ArenaTab({ run, error, busy, onRun }: { run: ArenaRun | null; error: string | null; busy: boolean; onRun: () => void }) {
  return (
    <div className="space-y-3">
      <div className="panel flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div>
          <div className="font-terminal text-[11px] font-bold tracking-wider">STRATEGY AI ARENA — TEN RULE-BASED CANDIDATES</div>
          <p className="text-[10px] text-muted-foreground">Same bars, same timeframe, same costs. This is not ten independent AI models.</p>
        </div>
        <Button size="sm" className="gap-1.5 font-terminal text-[10px]" disabled={busy} onClick={onRun}>
          <RefreshCw className={cn("size-3", busy && "animate-spin")} /> {busy ? "EVALUATING…" : "RUN ARENA"}
        </Button>
      </div>

      {error && <div className="border border-danger/40 bg-danger/10 px-3 py-2 font-terminal text-[10px] text-danger">{error}</div>}
      {!run && !error && (
        <EmptyState
          icon={<Swords className="size-8" />}
          title="NO ARENA RUN ON RECORD"
          body="Run the arena on a validated series. It reserves one analysis from the daily quota before fetching data and never claims metrics it did not measure."
          action={<Button size="sm" className="font-terminal text-[10px]" disabled={busy} onClick={onRun}>RUN ARENA</Button>}
        />
      )}

      {run && (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <StatTile label="MARKET CLASS" value={run.arena.marketClass} sub={run.arena.marketClassReason.slice(0, 80)} />
            <StatTile label="VALID BARS" value={String(run.arena.bars)} sub={`${fmtTime(run.arena.dataStart)} → ${fmtTime(run.arena.dataEnd)} UTC`} />
            <StatTile label="PROVIDER" value={run.provenance.provider} sub={`${run.provenance.interval} · ${run.provenance.quality}`} />
            <StatTile label="SELECTION" value={run.arena.selected?.label ?? "NO TRADE"} tone={run.arena.selected ? "up" : "down"} sub={run.arena.selected ? `score ${run.arena.selected.score?.toFixed(2)}` : "no strategy qualified"} />
          </div>

          {run.arena.noTradeReason && (
            <div className="border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning">
              {run.arena.noTradeReason} {run.riskReview ? `Risk review: ${run.riskReview.decision} — ${run.riskReview.message}` : ""}
            </div>
          )}

          <Panel title="STRATEGY RANKING — OUT-OF-SAMPLE EVIDENCE" right={<Badge variant="outline" className="font-terminal text-[9px]">RULE-BASED · COSTS INCLUDED</Badge>}>
            <div className="overflow-x-auto">
              <table className="w-full font-terminal text-[10px]">
                <thead>
                  <tr className="border-b border-border text-left text-[9px] text-muted-foreground">
                    <th className="py-1.5 pr-2">#</th>
                    <th className="py-1.5 pr-2">STRATEGY</th>
                    <th className="py-1.5 pr-2">STATUS</th>
                    <th className="py-1.5 pr-2">SIGNAL</th>
                    <th className="py-1.5 pr-2 text-right">SCORE</th>
                    <th className="py-1.5 pr-2 text-right">TRADES</th>
                    <th className="py-1.5 pr-2 text-right">WIN %</th>
                    <th className="py-1.5 pr-2 text-right">PF</th>
                    <th className="py-1.5 pr-2 text-right">EXPECTANCY</th>
                    <th className="py-1.5 pr-2 text-right">MAX DD</th>
                    <th className="py-1.5">STABILITY</th>
                  </tr>
                </thead>
                <tbody>
                  {[...run.arena.strategies].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).map((s, i) => (
                    <tr key={s.id} className={cn("border-b border-border/40 align-top", s.id === run.arena.selectedId && "bg-success/5")}>
                      <td className="py-1.5 pr-2 text-muted-foreground">{s.score !== null ? i + 1 : "—"}</td>
                      <td className="py-1.5 pr-2">
                        <div className="font-semibold">{s.label}</div>
                        <div className="text-[9px] text-muted-foreground">{s.signalReason}</div>
                      </td>
                      <td className="py-1.5 pr-2"><ArenaStatusChip status={s.status} /></td>
                      <td className="py-1.5 pr-2">{s.signal === 1 ? "LONG" : s.signal === -1 ? "SHORT" : "NONE"}</td>
                      <td className="py-1.5 pr-2 text-right tabular">{s.score?.toFixed(2) ?? "—"}</td>
                      <td className="py-1.5 pr-2 text-right tabular">{s.metrics?.trades ?? "—"}</td>
                      <td className="py-1.5 pr-2 text-right tabular">{pct(s.metrics?.winRatePct)}</td>
                      <td className="py-1.5 pr-2 text-right tabular">{s.metrics?.profitFactor?.toFixed(2) ?? "—"}</td>
                      <td className={cn("py-1.5 pr-2 text-right tabular", (s.metrics?.expectancy ?? 0) >= 0 ? "text-success" : "text-danger")}>
                        {s.metrics?.expectancy !== null && s.metrics?.expectancy !== undefined ? fmtMoney(s.metrics.expectancy) : "—"}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular">{pct(s.metrics?.maxDrawdownPct)}</td>
                      <td className="py-1.5 tabular">{s.metrics?.stability !== null && s.metrics?.stability !== undefined ? `${Math.round(s.metrics.stability * 100)}%` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {run.arena.selected && (
              <div className="mt-3 border-t border-border pt-2">
                <div className="font-terminal text-[10px] font-semibold text-primary">SELECTED: {run.arena.selected.label}</div>
                <p className="mt-1 text-[11px] leading-relaxed">{run.arena.selectedReason}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">{run.arena.selected.reason}</p>
                <ul className="mt-1 space-y-0.5">
                  {run.arena.selected.weaknesses.map((w, i) => <li key={i} className="text-[10px] text-warning">• {w}</li>)}
                </ul>
              </div>
            )}
          </Panel>

          {run.riskReview && (
            <Panel title="STAGE 4 — DETERMINISTIC RISK REVIEW" right={<StatusChip state={run.riskReview.decision === "NO_TRADE" ? "BLOCKED" : "PASS"} />}>
              <div className="grid grid-cols-2 gap-2 font-terminal text-[10px] sm:grid-cols-5">
                <KV k="DECISION" v={run.riskReview.decision} />
                <KV k="RISK" v={fmtMoney(run.riskReview.riskAmount)} />
                <KV k="STOP" v={fmtPrice(run.riskReview.stopLoss)} />
                <KV k="SIZE" v={run.riskReview.qty ? run.riskReview.qty.toPrecision(6) : "0"} />
                <KV k="REASON" v={run.riskReview.reasonCode} />
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">
                The arena proposes; the risk engine can only reduce or veto. A failed review is a NO TRADE, never an override.
              </p>
            </Panel>
          )}

          <Panel title="METHODOLOGY & LIMITATIONS">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ListBlock title="METHOD" items={run.arena.methodology} tone="text-muted-foreground" />
              <ListBlock title="LIMITATIONS" items={run.arena.limitations} tone="text-warning" />
            </div>
            <p className="mt-2 border-t border-border pt-2 text-[9px] text-muted-foreground">
              Data: {run.provenance.provider} · {run.provenance.bars} bars · quality {run.provenance.quality}. Fallback: {run.provenance.fellBack ? "YES — refused" : "no"}.
              {run.provenance.notes.length > 0 ? ` ${run.provenance.notes.join("; ")}` : ""}
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- news

function NewsTab({ view, error, busy, onRefresh }: { view: CatalystView | null; error: string | null; busy: boolean; onRefresh: () => void }) {
  return (
    <div className="space-y-3">
      <div className="panel flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div>
          <div className="font-terminal text-[11px] font-bold tracking-wider">NEWS AI — TOP THREE UPCOMING CATALYSTS</div>
          <p className="text-[10px] text-muted-foreground">Verified events only, with source timestamp and link. A potential reaction is never presented as a certainty.</p>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5 font-terminal text-[10px]" disabled={busy} onClick={onRefresh}>
          <RefreshCw className={cn("size-3", busy && "animate-spin")} /> {busy ? "LOADING…" : "REFRESH"}
        </Button>
      </div>

      {error && <div className="border border-danger/40 bg-danger/10 px-3 py-2 font-terminal text-[10px] text-danger">{error}</div>}
      {!view && !error && <LoadingState label="CHECKING CATALYST PROVIDER…" />}

      {view && view.status !== "CONFIGURED" && (
        <div className={cn("border px-3 py-2", view.status === "UNCONFIGURED" ? "border-warning/40 bg-warning/10" : "border-danger/40 bg-danger/10")}>
          <div className="font-terminal text-[11px] font-bold tracking-wider">
            NEWS AI: {view.status} — NO UPCOMING EVENTS ARE SHOWN
          </div>
          <ul className="mt-1 space-y-0.5">
            {view.notes.map((n, i) => <li key={i} className="text-[10px] text-muted-foreground">• {n}</li>)}
          </ul>
        </div>
      )}

      {view?.status === "CONFIGURED" && view.events.length === 0 && (
        <EmptyState icon={<Newspaper className="size-8" />} title="NO VERIFIED UPCOMING CATALYSTS" body="The provider is configured but no verified future event matched this market. Nothing is invented to fill the space." />
      )}

      {view?.events.map((event) => (
        <Panel
          key={`${event.title}-${event.scheduledAt}`}
          title={event.title}
          right={
            <div className="flex items-center gap-1.5">
              <span className={cn("border px-1.5 py-0.5 font-terminal text-[9px]", event.certainty === "CONFIRMED" ? "border-success/40 bg-success/10 text-success" : event.certainty === "FORECAST" ? "border-warning/40 bg-warning/10 text-warning" : "border-border text-muted-foreground")}>
                {event.certainty}
              </span>
              <span className="border border-border px-1.5 py-0.5 font-terminal text-[9px] text-muted-foreground">{event.importance} IMPORTANCE</span>
            </div>
          }
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-terminal text-[10px] sm:grid-cols-4">
            <KV k="SCHEDULED" v={`${fmtTime(event.scheduledAt)} UTC`} />
            <KV k="TIMEZONE" v={event.timeZone} />
            <KV k="SOURCE" v={event.source} />
            <KV k="UPDATED" v={`${fmtTime(event.lastUpdatedAt)} UTC`} />
            <KV k="AFFECTS" v={event.affectedAssets.length > 0 ? event.affectedAssets.join(", ") : "broad market"} />
            <KV k="PUBLISHED AGE" v={`${Math.round(event.ageSec / 3600)}h`} />
            <KV k="CONSENSUS" v={event.consensus ?? "not provided"} />
            <KV k="VERIFIED" v="source + timestamp" tone="text-success" />
          </div>
          {event.scenarios && (
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Scenario label="BULLISH" text={event.scenarios.bullish} tone="text-success" />
              <Scenario label="BEARISH" text={event.scenarios.bearish} tone="text-danger" />
              <Scenario label="UNCERTAIN" text={event.scenarios.uncertain} tone="text-warning" />
            </div>
          )}
          {event.risks.length > 0 && (
            <div className="mt-2">
              <div className="panel-title mb-1 text-[9px]">RISKS</div>
              <ul className="space-y-0.5">{event.risks.map((r, i) => <li key={i} className="text-[10px] text-warning">• {r}</li>)}</ul>
            </div>
          )}
          <div className="mt-2 flex items-center justify-between border-t border-border pt-1.5 font-terminal text-[9px]">
            <a href={event.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline">OPEN ORIGINAL SOURCE →</a>
            <span className="text-muted-foreground">NEWS NEVER BYPASSES RISK CONTROLS</span>
          </div>
        </Panel>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- health

function HealthTab({
  modules,
  performance,
  health,
}: {
  modules: ReturnType<typeof buildModuleHealth>;
  performance: ReturnType<typeof useAnalysisPerformance>;
  health: HealthPayload | undefined;
}) {
  return (
    <div className="space-y-3">
      <Panel title="MODULE HEALTH — CONFIGURED IS NOT THE SAME AS WORKING">
        {modules.length === 0 ? (
          <LoadingState label="LOADING MODULE HEALTH…" />
        ) : (
          <div className="space-y-1.5">
            {modules.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-2 border-b border-border/40 py-1.5 last:border-0">
                <span className="w-36 font-terminal text-[11px] font-semibold">{m.label}</span>
                <span className="w-20"><ModuleStateChip state={m.state} /></span>
                <span className="border border-border px-1.5 py-0.5 font-terminal text-[8px] text-muted-foreground">{m.kind}</span>
                <span className="text-[10px] text-muted-foreground">
                  configured {m.configured ? "yes" : "no"} · reachable {m.reachable ? "yes" : "no"} · run {m.lastRunAt ? `${fmtTime(m.lastRunAt)} UTC` : "—"} · fresh {m.dataFresh === null ? "unknown" : m.dataFresh ? "yes" : "no"}
                </span>
                <span className="ml-auto max-w-full text-right text-[10px] text-muted-foreground">{m.detail}</span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 border-t border-border pt-2 text-[10px] text-muted-foreground">
          A successful API response is not predictive accuracy. Only measured predictions and closed paper trades count as evidence.
        </p>
      </Panel>

      {!performance ? (
        <LoadingState label="LOADING PERFORMANCE…" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-7">
            <StatTile label="DIRECTIONAL ACCURACY" value={pct(performance.overall.accuracyPct)} sub={`${performance.overall.evaluatedPredictions} evaluated`} />
            <StatTile label="WIN RATE" value={pct(performance.overall.winRatePct)} sub={`${performance.overall.trades} closed trades`} />
            <StatTile label="PROFIT FACTOR" value={performance.overall.profitFactor?.toFixed(2) ?? "—"} sub="after costs" />
            <StatTile label="EXPECTANCY" value={performance.overall.expectancy !== null ? fmtMoney(performance.overall.expectancy) : "—"} sub="per trade" tone={(performance.overall.expectancy ?? 0) >= 0 ? "up" : "down"} />
            <StatTile label="AVG WIN / LOSS" value={performance.overall.avgWin !== null ? fmtMoney(performance.overall.avgWin) : "—"} sub={performance.overall.avgLoss !== null ? `loss ${fmtMoney(performance.overall.avgLoss)}` : "no losses in sample"} />
            <StatTile label="MAX DRAWDOWN" value={pct(performance.overall.maxDrawdownPct)} sub="equity curve" />
            <StatTile label="EST. FEES" value={performance.overall.totalFees !== null ? fmtMoney(performance.overall.totalFees) : "—"} sub="closed trades" />
          </div>

          <div className={cn("border px-3 py-2 font-terminal text-[10px]", performance.overall.evidenceSufficient ? "border-success/40 bg-success/10 text-success" : "border-warning/40 bg-warning/10 text-warning")}>
            {performance.overall.evidenceSufficient
              ? "SAMPLE IS ABOVE THE EVIDENCE THRESHOLD — performance is still historical, not a forecast."
              : "INSUFFICIENT EVIDENCE — do not read this as proof the AI works. "}
            {performance.evidenceStandard}
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Panel title="BY STRATEGY">
              {performance.byStrategy.length === 0 ? (
                <p className="py-2 text-[11px] text-muted-foreground">No closed paper trades are attributable to a strategy yet.</p>
              ) : (
                <PerformanceTable rows={performance.byStrategy} />
              )}
            </Panel>
            <Panel title="BY MARKET / TIMEFRAME">
              <PerformanceTable rows={performance.byMarket} />
              {performance.byTimeframe.length > 0 && (
                <div className="mt-2 border-t border-border pt-2">
                  <PerformanceTable rows={performance.byTimeframe} />
                </div>
              )}
            </Panel>
          </div>

          <Panel title="EVALUATION PERIOD & METHOD">
            <div className="grid grid-cols-2 gap-2 font-terminal text-[10px] sm:grid-cols-4">
              <KV k="PERIOD START" v={performance.overall.periodStart ? `${fmtTime(performance.overall.periodStart)} UTC` : "—"} />
              <KV k="PERIOD END" v={performance.overall.periodEnd ? `${fmtTime(performance.overall.periodEnd)} UTC` : "—"} />
              <KV k="PREDICTIONS" v={String(performance.overall.evaluatedPredictions)} />
              <KV k="CLOSED TRADES" v={String(performance.overall.trades)} />
              <KV k="CALIBRATION" v="not reported (no calibrated probabilities)" />
              <KV k="MONITORING" v={health?.monitor?.state ?? "—"} />
            </div>
            <ul className="mt-2 space-y-0.5 border-t border-border pt-2">
              {performance.notes.map((n, i) => <li key={i} className="text-[10px] leading-relaxed text-muted-foreground">• {n}</li>)}
            </ul>
          </Panel>
        </>
      )}
    </div>
  );
}

function PerformanceTable({ rows }: { rows: { key: string; label: string; trades: number; winRatePct: number | null; profitFactor: number | null; expectancy: number | null; maxDrawdownPct: number | null }[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-terminal text-[10px]">
        <thead>
          <tr className="border-b border-border text-left text-[9px] text-muted-foreground">
            <th className="py-1 pr-2">GROUP</th>
            <th className="py-1 pr-2 text-right">TRADES</th>
            <th className="py-1 pr-2 text-right">WIN %</th>
            <th className="py-1 pr-2 text-right">PF</th>
            <th className="py-1 pr-2 text-right">EXPECTANCY</th>
            <th className="py-1 text-right">MAX DD</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-border/40">
              <td className="py-1 pr-2">{r.label}</td>
              <td className="py-1 pr-2 text-right tabular">{r.trades}</td>
              <td className="py-1 pr-2 text-right tabular">{pct(r.winRatePct)}</td>
              <td className="py-1 pr-2 text-right tabular">{r.profitFactor?.toFixed(2) ?? "—"}</td>
              <td className={cn("py-1 pr-2 text-right tabular", (r.expectancy ?? 0) >= 0 ? "text-success" : "text-danger")}>{r.expectancy !== null ? fmtMoney(r.expectancy) : "—"}</td>
              <td className="py-1 text-right tabular">{pct(r.maxDrawdownPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- history

function HistoryTab({ rows }: { rows: AnalysisRecordRow[] }) {
  if (rows.length === 0) {
    return <EmptyState icon={<History className="size-8" />} title="NO SAVED ANALYSES" body="Saved analyses appear here as an immutable audit trail. Later analyses and paper outcomes never rewrite the original prediction." />;
  }
  return (
    <Panel title="IMMUTABLE ANALYSIS HISTORY" right={<Badge variant="outline" className="font-terminal text-[9px]">APPEND-ONLY</Badge>}>
      <div className="overflow-x-auto">
        <table className="w-full font-terminal text-[10px]">
          <thead>
            <tr className="border-b border-border text-left text-[9px] text-muted-foreground">
              <th className="py-1.5 pr-2">CREATED (UTC)</th>
              <th className="py-1.5 pr-2">MARKET</th>
              <th className="py-1.5 pr-2">CALL</th>
              <th className="py-1.5 pr-2">STATUS</th>
              <th className="py-1.5 pr-2">STRATEGY</th>
              <th className="py-1.5 pr-2">DATA</th>
              <th className="py-1.5 pr-2">THESIS</th>
              <th className="py-1.5">RECORD</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r._id} className="border-b border-border/40 align-top">
                <td className="py-1.5 pr-2 tabular text-muted-foreground">{fmtTime(r.createdAt)}</td>
                <td className="py-1.5 pr-2 font-semibold">{r.symbol}<span className="ml-1 text-[9px] text-muted-foreground">{r.interval}</span></td>
                <td className="py-1.5 pr-2"><SignalChip signal={r.direction} /></td>
                <td className="py-1.5 pr-2">{r.status}</td>
                <td className="py-1.5 pr-2">{r.strategy?.selectedLabel ?? "pipeline"}</td>
                <td className="py-1.5 pr-2"><QualityBadge quality={r.dataQuality} /></td>
                <td className="max-w-72 truncate py-1.5 pr-2 text-muted-foreground">{r.thesis}</td>
                <td className="py-1.5"><Link to={`/decision/${r.decisionId}`} className="text-primary hover:underline">OPEN →</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- shared bits

function EmptyState({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="panel p-8 text-center">
      <div className="mx-auto mb-3 text-muted-foreground">{icon}</div>
      <p className="font-terminal text-xs font-semibold tracking-wider">{title}</p>
      <p className="mx-auto mt-2 max-w-2xl text-[11px] leading-relaxed text-muted-foreground">{body}</p>
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return <div className="panel animate-pulse p-6 text-center font-terminal text-[10px] text-muted-foreground">{label}</div>;
}

function ListBlock({ title, items, tone }: { title: string; items: string[]; tone?: string }) {
  return (
    <div>
      <div className="panel-title mb-1 text-[9px]">{title}</div>
      <ul className="space-y-0.5">{items.map((item, i) => <li key={i} className={cn("text-[10px] leading-relaxed", tone ?? "text-muted-foreground")}>• {item}</li>)}</ul>
    </div>
  );
}

function Scenario({ label, text, tone }: { label: string; text: string; tone: string }) {
  return (
    <div className="border border-border/60 p-2">
      <div className={cn("font-terminal text-[9px] font-semibold tracking-wider", tone)}>{label}</div>
      <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{text}</p>
    </div>
  );
}

function KV({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/30 pb-0.5">
      <span className="text-muted-foreground">{k}</span>
      <span className={cn("truncate text-right font-semibold tabular", tone)}>{v}</span>
    </div>
  );
}

function ArenaStatusChip({ status }: { status: string }) {
  const tone = status === "ELIGIBLE" ? "text-success border-success/40 bg-success/10" : status === "NOT_SUITABLE" ? "text-muted-foreground border-border" : "text-warning border-warning/40 bg-warning/10";
  return <span className={cn("inline-flex border px-1 py-0.5 font-terminal text-[8px] tracking-wider", tone)}>{status}</span>;
}

function ModuleStateChip({ state }: { state: string }) {
  const tone = state === "HEALTHY" ? "text-success border-success/40 bg-success/10" : state === "UNCONFIGURED" || state === "NOT_RUN" ? "text-muted-foreground border-border" : state === "OFFLINE" ? "text-danger border-danger/40 bg-danger/10" : "text-warning border-warning/40 bg-warning/10";
  return <span className={cn("inline-flex border px-1.5 py-0.5 font-terminal text-[9px] tracking-wider", tone)}>{state.replace("_", " ")}</span>;
}

function thesisTone(status: string): string {
  return status === "INTACT"
    ? "border-success/40 bg-success/10 text-success"
    : status === "TARGET_REACHED"
      ? "border-primary/40 bg-primary/10 text-primary"
      : status === "INVALIDATED"
        ? "border-danger/40 bg-danger/10 text-danger"
        : status === "WEAKENED"
          ? "border-warning/40 bg-warning/10 text-warning"
          : "border-border text-muted-foreground";
}

function pct(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}%`;
}

function fmtPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function fmtTime(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return "—";
  return new Date(value).toISOString().slice(5, 16).replace("T", " ");
}
