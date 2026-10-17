import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useParams, Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfidenceBar, Panel, QualityBadge, SignalChip } from "@/components/arise/shared";
import { cn } from "@/lib/utils";
import { ArrowLeft, FileSearch } from "lucide-react";
import { Terminal } from "@/components/arise/Terminal";
import { useEntitlements } from "@/hooks/use-arise";

interface AgentPayload {
  agent: string;
  signal: string;
  confidence: number;
  summary: string;
  evidence?: string[];
  risks?: string[];
  invalidation?: string[];
  regime?: string;
  manipulationLevel?: string;
  modelVersion: string;
}

interface MindPayload {
  supportingEvidence?: string[];
  contradictingEvidence?: string[];
  invalidationConditions?: string[];
  keyRisks?: string[];
  agreementPct?: number;
  plan?: {
    side: string; entry: number; stopLoss: number; takeProfit: number;
    positionSize: number; positionSizeQuote: number; maxLossQuote: number; maxLossPct: number;
  } | null;
}

/** What `market.decide` persists for the deterministic evidence gate: the
 *  assessment plus the candidate outcome it was allowed to lower. */
interface EvidencePayload {
  outcome: "TRADE" | "WAIT" | "REJECT";
  candidate: "TRADE" | "WAIT" | "REJECT";
  downgraded: boolean;
  reasons: { code: string; level: "BLOCK" | "HOLD" | "INFO"; detail: string }[];
  reasonCodes: string[];
  evidenceQuality: "STRONG" | "MODERATE" | "WEAK" | "ABSENT";
  confidenceCeiling: number;
  supporting: string[];
  contradicting: string[];
  unknowns: { id: string; description: string; impact: string }[];
  totals: Record<string, number>;
}

const AGENT_LABELS: Record<string, string> = {
  quant: "QUANT AI", technical: "TECHNICAL AI", regime: "REGIME AI",
  anomaly: "ANOMALY AI", portfolio: "PORTFOLIO AI", risk: "RISK AI",
  news: "NEWS AI",
};

function fmtPrice(v: number): string {
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(3);
  return v.toFixed(5);
}

export default function DecisionDetail() {
  const { id } = useParams<{ id: string }>();
  const decision = useQuery(
    api.arise.decisions.byId,
    id ? { id: id as Id<"decisions"> } : "skip",
  );
  const ents = useEntitlements();

  if (decision === undefined) {
    return (
      <Terminal>
        <div className="panel p-8 text-center font-terminal text-xs text-muted-foreground">LOADING…</div>
      </Terminal>
    );
  }
  if (decision === null) {
    return (
      <Terminal>
        <div className="panel p-8 text-center">
          <FileSearch className="mx-auto mb-2 size-6 text-muted-foreground" />
          <p className="font-terminal text-xs text-muted-foreground">DECISION NOT FOUND</p>
          <Link to="/dashboard" className="mt-3 inline-block">
            <Button size="sm" variant="outline" className="gap-1.5 font-terminal text-[11px]">
              <ArrowLeft className="size-3" /> BACK TO TERMINAL
            </Button>
          </Link>
        </div>
      </Terminal>
    );
  }

  const agents = decision.agents as Record<string, AgentPayload> | null;
  const mind = decision.mind as MindPayload | null;
  const risk = decision.risk as { decision?: string; reasonCode?: string; message?: string; checks?: { rule: string; pass: boolean; detail: string }[] } | null;
  const meta = decision.snapshotMeta as {
    notes?: string[]; bars?: number; lastClose?: number; spreadPct?: number | null;
    fetchMs?: number; source?: string; fallback?: string | null;
  } | null;
  const execution = decision.execution as Record<string, unknown> | null;
  const evidence = decision.evidence as EvidencePayload | null;

  const gateLocked = !ents || (!ents.active && ents.planKey === "free" && false); // detail pages are free-tier visible

  return (
    <Terminal>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <Link to="/dashboard">
              <Button size="sm" variant="ghost" className="gap-1.5 px-2 font-terminal text-[11px]">
                <ArrowLeft className="size-3.5" /> HOME
              </Button>
            </Link>
            <h1 className="font-terminal text-lg font-bold tracking-wider">
              DECISION RECORD — {decision.symbol}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <QualityBadge quality={decision.dataQuality} />
            <SignalChip
              signal={decision.status === "TRADE" ? decision.direction : decision.status === "VETOED" ? "VETO" : "WAIT"}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {[
            { label: "DIRECTION", v: decision.direction },
            { label: "CONFIDENCE", v: `${Math.round(decision.confidence * 100)}%` },
            { label: "REGIME", v: decision.regime.replace(/_/g, " ") },
            { label: "ACTION", v: decision.recommendedAction },
            { label: "DATA AGE AT RUN", v: `${Math.round(decision.dataAgeSec)}s` },
          ].map((s) => (
            <div key={s.label} className="panel px-3 py-2">
              <div className="panel-title text-[9px]">{s.label}</div>
              <div className="mt-1 font-terminal text-sm font-bold">{s.v}</div>
            </div>
          ))}
        </div>

        <Panel title="THESIS">
          <p className="text-sm leading-relaxed">{decision.thesis}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant="outline" className="font-terminal text-[9px]">
              {new Date(decision.dataTimestamp).toISOString().replace("T", " ").slice(0, 16)} UTC
            </Badge>
            <Badge variant="outline" className="font-terminal text-[9px]">interval {decision.interval}</Badge>
            <Badge variant="outline" className="font-terminal text-[9px]">mode {decision.mode}</Badge>
            <Badge variant="outline" className="font-terminal text-[9px]">source {meta?.source ?? "—"}</Badge>
            {meta?.fetchMs != null && <Badge variant="outline" className="font-terminal text-[9px]">fetch {meta.fetchMs}ms</Badge>}
          </div>
        </Panel>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Panel title="AGENT RECORD (IMMUTABLE AT DECISION TIME)">
            <div className="space-y-3">
              {agents ? Object.entries(agents).map(([key, a]) => (
                <div key={key} className="border-b border-border/60 pb-3 last:border-0 last:pb-0">
                  <div className="flex items-center justify-between">
                    <span className="font-terminal text-[10px] font-semibold tracking-wider">{AGENT_LABELS[key] ?? key}</span>
                    <div className="flex items-center gap-1.5">
                      <span className="font-terminal text-[9px] text-muted-foreground">{a.modelVersion}</span>
                      <SignalChip signal={a.signal} />
                    </div>
                  </div>
                  <ConfidenceBar value={a.confidence} className="mt-1" />
                  <p className="mt-1 text-[10px] text-muted-foreground">{a.summary}</p>
                  {a.evidence && a.evidence.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {a.evidence.map((e, i) => (
                        <li key={i} className="text-[10px] text-success">• {e}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )) : (
                <p className="text-xs text-muted-foreground">No agent payload stored.</p>
              )}
            </div>
          </Panel>

          <div className="space-y-3">
            <Panel title="RISK ENGINE DECISION">
              <div className="flex items-center gap-2">
                <SignalChip signal={risk?.decision === "VETOED" ? "VETO" : "PASS"} />
                <span className="font-terminal text-[10px]">{risk?.reasonCode ?? "—"}</span>
                <span className="text-[10px] text-muted-foreground">{risk?.message ?? ""}</span>
              </div>
              <div className="mt-2 space-y-0.5">
                {(risk?.checks ?? []).map((c) => (
                  <div key={c.rule} className="flex items-start gap-2 py-0.5">
                    <span className={cn("mt-0.5 font-terminal text-[10px]", c.pass ? "text-success" : "text-danger")}>
                      {c.pass ? "✓" : "✗"}
                    </span>
                    <span className="font-terminal text-[10px] font-semibold">{c.rule}</span>
                    <span className="ml-auto text-right text-[10px] text-muted-foreground">{c.detail}</span>
                  </div>
                ))}
              </div>
            </Panel>

            {evidence && (
              <Panel title="EVIDENCE GATE (DETERMINISTIC)">
                <div className="flex flex-wrap items-center gap-2">
                  <SignalChip
                    signal={evidence.outcome === "TRADE" ? "PASS" : evidence.outcome === "WAIT" ? "WAIT" : "VETO"}
                  />
                  <span className="font-terminal text-[10px] font-semibold">{evidence.outcome}</span>
                  {evidence.downgraded && (
                    <Badge variant="outline" className="border-warning/40 font-terminal text-[9px] text-warning">
                      LOWERED FROM {evidence.candidate}
                    </Badge>
                  )}
                  <Badge variant="outline" className="font-terminal text-[9px]">
                    EVIDENCE {evidence.evidenceQuality}
                  </Badge>
                  <Badge variant="outline" className="font-terminal text-[9px]">
                    CONFIDENCE CEILING {Math.round(evidence.confidenceCeiling * 100)}%
                  </Badge>
                </div>

                {(evidence.reasons ?? []).length === 0 ? (
                  <p className="mt-2 text-[10px] text-muted-foreground">
                    No blocking or holding reason was recorded for this run.
                  </p>
                ) : (
                  <div className="mt-2 space-y-0.5">
                    {evidence.reasons.map((r, i) => (
                      <div key={`${r.code}-${i}`} className="flex items-start gap-2 py-0.5">
                        <span
                          className={cn(
                            "w-10 font-terminal text-[9px] font-bold",
                            r.level === "BLOCK"
                              ? "text-danger"
                              : r.level === "HOLD"
                                ? "text-warning"
                                : "text-muted-foreground",
                          )}
                        >
                          {r.level}
                        </span>
                        <span className="font-terminal text-[10px] font-semibold">{r.code}</span>
                        <span className="ml-auto text-right text-[10px] text-muted-foreground">
                          {r.detail}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-terminal text-[10px] tabular">
                  <span className="text-muted-foreground">OBSERVED FACTS</span>
                  <span>{evidence.totals?.OBSERVED ?? 0}</span>
                  <span className="text-muted-foreground">CALCULATED</span>
                  <span>{evidence.totals?.CALCULATED ?? 0}</span>
                  <span className="text-muted-foreground">INFERENCES (NOT FACTS)</span>
                  <span>{evidence.totals?.INFERENCE ?? 0}</span>
                  <span className="text-muted-foreground">HYPOTHESES</span>
                  <span>{evidence.totals?.HYPOTHESIS ?? 0}</span>
                </div>

                {(evidence.unknowns ?? []).length > 0 && (
                  <div className="mt-2 space-y-0.5">
                    <div className="panel-title text-[9px]">
                      UNKNOWNS — MISSING INPUT, NOT NEGATIVE EVIDENCE
                    </div>
                    {evidence.unknowns.map((u) => (
                      <div key={u.id} className="flex items-start gap-2 py-0.5">
                        <Badge
                          variant="outline"
                          className={cn(
                            "font-terminal text-[9px]",
                            u.impact === "BLOCKS_TRADE"
                              ? "border-danger/40 text-danger"
                              : u.impact === "REDUCES_SIZE"
                                ? "border-warning/40 text-warning"
                                : "text-muted-foreground",
                          )}
                        >
                          {u.impact}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">{u.description}</span>
                      </div>
                    ))}
                  </div>
                )}

                {(evidence.contradicting ?? []).length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {evidence.contradicting.map((c, i) => (
                      <li key={i} className="text-[10px] text-danger">
                        • {c}
                      </li>
                    ))}
                  </ul>
                )}

                <p className="mt-2 border-t border-border pt-2 font-terminal text-[9px] text-muted-foreground">
                  The gate can only lower a verdict. It never authorizes anything, and no downstream stage
                  may read it as permission to trade.
                </p>
              </Panel>
            )}

            {mind?.plan && (
              <Panel title="TRADE PLAN (AT DECISION TIME)">
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-terminal text-[11px] tabular">
                  <span className="text-muted-foreground">SIDE</span><span>{mind.plan.side}</span>
                  <span className="text-muted-foreground">ENTRY</span><span>{fmtPrice(mind.plan.entry)}</span>
                  <span className="text-muted-foreground">STOP</span><span className="text-danger">{fmtPrice(mind.plan.stopLoss)}</span>
                  <span className="text-muted-foreground">TARGET</span><span className="text-success">{fmtPrice(mind.plan.takeProfit)}</span>
                  <span className="text-muted-foreground">MAX LOSS</span><span className="text-warning">${mind.plan.maxLossQuote.toFixed(2)}</span>
                </div>
              </Panel>
            )}

            {execution && (
              <Panel title="EXECUTION RECORD (PAPER)">
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-terminal text-[11px] tabular">
                  <span className="text-muted-foreground">STATUS</span><span>{String(execution.status)}</span>
                  <span className="text-muted-foreground">FILL</span><span>{fmtPrice(Number(execution.fillPrice ?? 0))}</span>
                  <span className="text-muted-foreground">QTY</span><span>{Number(execution.qty ?? 0).toPrecision(6)}</span>
                  <span className="text-muted-foreground">FEE</span><span>${Number(execution.fee ?? 0).toFixed(4)}</span>
                  <span className="text-muted-foreground">SLIPPAGE</span><span>{String(execution.slippageBps ?? "—")} bps</span>
                </div>
              </Panel>
            )}

            {meta?.notes && meta.notes.length > 0 && (
              <Panel title="DATA QUALITY NOTES">
                <ul className="space-y-0.5">
                  {meta.notes.map((n, i) => (
                    <li key={i} className="text-[10px] text-muted-foreground">• {n}</li>
                  ))}
                </ul>
              </Panel>
            )}
          </div>
        </div>

        {gateLocked && null}
      </div>
    </Terminal>
  );
}
