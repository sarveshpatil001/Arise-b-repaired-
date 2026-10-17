import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfidenceBar, Panel, QualityBadge, SignalChip } from "@/components/arise/shared";
import { Terminal } from "@/components/arise/Terminal";
import { NewsWire } from "@/components/arise/NewsWire";
import { useLatestDecision, useSymbols } from "@/hooks/use-arise";
import { cn } from "@/lib/utils";
import { Brain, Crosshair, Swords } from "lucide-react";
import { useState } from "react";

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
  debate?: { topic: string; agents: { agent: string; position: string; confidence: number }[]; resolution: string }[];
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

export default function Intelligence() {
  const symbols = useSymbols();
  const [symbol, setSymbol] = useState("BTCUSDT");
  const latest = useLatestDecision(symbol);

  const agents = (latest?.agents ?? null) as Record<string, AgentPayload> | null;
  const mind = (latest?.mind ?? null) as MindPayload | null;
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <Terminal>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-terminal text-lg font-bold tracking-wider">
            AGENT MONITOR — {symbol}
            <span className="ml-3 text-xs font-normal text-muted-foreground">
              {latest ? `DATA ${new Date(latest.dataTimestamp).toISOString().replace("T", " ").slice(0, 16)} UTC` : "NO ANALYSIS ON RECORD"}
            </span>
          </h1>
          <div className="flex items-center gap-2">
            <Select value={symbol} onValueChange={setSymbol}>
              <SelectTrigger className="h-8 w-40 font-terminal text-xs"><SelectValue /></SelectTrigger>
              <SelectContent className="font-terminal text-xs">
                {symbols.map((s) => (
                  <SelectItem key={s.symbol} value={s.symbol}>{s.symbol}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Badge variant="outline" className="font-terminal text-[9px]">
              ENGINE: {agents ? Object.values(agents)[0]?.modelVersion ?? "—" : "—"}
            </Badge>
          </div>
        </div>

        {!latest && (
          <div className="panel p-8 text-center">
            <Brain className="mx-auto mb-3 size-8 text-muted-foreground" />
            <p className="font-terminal text-xs text-muted-foreground">
              NO ANALYSIS ON RECORD for {symbol}. Run ANALYZE from the HOME screen.
            </p>
          </div>
        )}

        <NewsWire symbol={symbol} />

        {latest && (
          <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {agents ? Object.entries(agents).map(([key, a]) => {
                const isSel = selected === key;
                return (
                  <button
                    key={key}
                    className={cn(
                      "panel p-3 text-left transition-colors",
                      isSel ? "border-primary/60" : "hover:border-primary/30",
                    )}
                    onClick={() => setSelected(isSel ? null : key)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-terminal text-[11px] font-bold tracking-wider">
                        {AGENT_LABELS[key] ?? key}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {a.regime && <span className="font-terminal text-[9px] text-primary">{a.regime}</span>}
                        {a.manipulationLevel && a.manipulationLevel !== "NORMAL" && (
                          <span className="font-terminal text-[9px] text-warning">{a.manipulationLevel}</span>
                        )}
                        <SignalChip signal={a.signal} />
                      </div>
                    </div>
                    <ConfidenceBar value={a.confidence} className="mt-2" />
                    <p className="mt-2 text-[11px] leading-relaxed text-foreground/90">{a.summary}</p>
                    {isSel && (
                      <div className="mt-3 space-y-2 border-t border-border pt-2">
                        {a.evidence && a.evidence.length > 0 && (
                          <Detail title="EVIDENCE" items={a.evidence} tone="text-success" />
                        )}
                        {a.risks && a.risks.length > 0 && (
                          <Detail title="RISKS" items={a.risks} tone="text-warning" />
                        )}
                        {a.invalidation && a.invalidation.length > 0 && (
                          <Detail title="INVALIDATION" items={a.invalidation} tone="text-primary" />
                        )}
                      </div>
                    )}
                  </button>
                );
              }) : (
                <div className="panel p-6 text-center text-xs text-muted-foreground md:col-span-2 xl:col-span-3">
                  No agent payload stored in the latest decision.
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Panel
                title="MIND AI — DEBATE & CONFLICT RESOLUTION"
                right={
                  <div className="flex items-center gap-2">
                    <Swords className="size-3.5 text-primary" />
                    <Badge variant="outline" className="font-terminal text-[9px]">
                      agreement {Math.round(mind?.agreementPct ?? 0)}%
                    </Badge>
                  </div>
                }
              >
                {mind?.debate && mind.debate.length > 0 ? (
                  <div className="space-y-3">
                    {mind.debate.map((d, i) => (
                      <div key={i} className="border-l-2 border-primary/40 pl-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Crosshair className="size-3 text-primary" />
                          <span className="font-terminal text-[11px] font-semibold">{d.topic}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {d.agents.map((a, j) => (
                            <span key={j} className="border border-border bg-secondary px-1.5 py-0.5 font-terminal text-[9px]">
                              {a.agent} → {a.position} ({Math.round(a.confidence * 100)}%)
                            </span>
                          ))}
                        </div>
                        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{d.resolution}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    No conflicts detected in the latest analysis — agents were aligned or neutral.
                  </p>
                )}
              </Panel>

              <Panel
                title="MIND AI — SYNTHESIS"
                right={<QualityBadge quality={latest.dataQuality} />}
              >
                <p className="text-xs leading-relaxed">{latest.thesis}</p>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <div className="panel-title mb-1 text-[9px]">SUPPORTING</div>
                    <ul className="space-y-1">
                      {(mind?.supportingEvidence ?? []).map((e, i) => (
                        <li key={i} className="text-[10px] leading-relaxed text-success">• {e}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="panel-title mb-1 text-[9px]">CONTRADICTING</div>
                    <ul className="space-y-1">
                      {(mind?.contradictingEvidence ?? []).map((e, i) => (
                        <li key={i} className="text-[10px] leading-relaxed text-danger">• {e}</li>
                      ))}
                    </ul>
                  </div>
                </div>
                {mind?.invalidationConditions && mind.invalidationConditions.length > 0 && (
                  <div className="mt-3 border-t border-border pt-2">
                    <div className="panel-title mb-1 text-[9px]">INVALIDATION CONDITIONS</div>
                    <ul className="space-y-1">
                      {mind.invalidationConditions.map((e, i) => (
                        <li key={i} className="text-[10px] leading-relaxed text-warning">• {e}</li>
                      ))}
                    </ul>
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

function Detail({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  return (
    <div>
      <div className="panel-title mb-1 text-[9px]">{title}</div>
      <ul className="space-y-0.5">
        {items.map((e, i) => (
          <li key={i} className={cn("text-[10px] leading-relaxed", tone)}>• {e}</li>
        ))}
      </ul>
    </div>
  );
}
