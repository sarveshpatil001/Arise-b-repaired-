import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Panel, StatTile, StatusDot } from "@/components/arise/shared";
import { Terminal } from "@/components/arise/Terminal";
import { LearningPanel } from "@/components/arise/LearningPanel";
import { useSystemEvents } from "@/hooks/use-arise";
import { useNowMs } from "@/hooks/use-clock";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { Database, Radio, Server, ShieldCheck, Wifi, Bot } from "lucide-react";

export default function System() {
  const events = useSystemEvents(60);
  const latestDecision = useQuery(api.arise.decisions.list, { limit: 1 });
  const { user } = useAuth();

  const nowMs = useNowMs();
  const errors = (events ?? []).filter((e) => e.level === "ERROR");
  const lastDecision = latestDecision?.[0];
  const dataAge = lastDecision ? Math.max(0, (nowMs - lastDecision.dataTimestamp) / 1000) : null;
  const dataHealth = dataAge === null ? "UNKNOWN" : dataAge < 6 * 3600 ? "OPERATIONAL" : "STALE";

  const services = [
    { name: "AI AGENTS", status: "ONLINE", detail: "7 specialists · heuristic-v1 + news-v1", icon: Bot, ok: true },
    { name: "DATA FEEDS", status: dataHealth, detail: "Binance + Yahoo Finance", icon: Wifi, ok: dataHealth !== "STALE" },
    { name: "DATABASE", status: "ONLINE", detail: "Convex (reactive)", icon: Database, ok: true },
    { name: "EXECUTION ENGINE", status: "PAPER", detail: "fees+slippage modeled · live disabled", icon: Server, ok: true },
    { name: "RISK ENGINE", status: "RUNNING", detail: "deterministic veto authority", icon: ShieldCheck, ok: true },
    { name: "AUTH SERVICE", status: user ? "ONLINE" : "OFFLINE", detail: user?.email ?? "no active session", icon: Radio, ok: !!user },
  ];

  return (
    <Terminal>
      <div className="space-y-3">
        <h1 className="font-terminal text-lg font-bold tracking-wider">SYSTEM HEALTH & AUDIT LOG</h1>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label="SYSTEM STATUS" value={errors.length === 0 ? "READY" : "DEGRADED"} tone={errors.length === 0 ? "up" : "down"} />
          <StatTile label="ERRORS (60 EVTS)" value={String(errors.length)} tone={errors.length > 0 ? "down" : "up"} />
          <StatTile label="LAST DECISION" value={lastDecision ? new Date(lastDecision.dataTimestamp).toISOString().slice(11, 16) + " UTC" : "—"} />
          <StatTile label="DATA AGE" value={dataAge === null ? "—" : `${Math.round(dataAge / 60)}m`} tone={dataHealth === "STALE" ? "down" : "up"} />
        </div>

        <Panel title="SERVICE HEALTH">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {services.map((s) => (
              <div key={s.name} className={cn("panel flex items-center gap-3 p-3", !s.ok && "border-warning/50")}>
                <s.icon className={cn("size-5", s.ok ? "text-success" : "text-warning")} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-terminal text-[11px] font-bold">{s.name}</span>
                    <StatusDot tone={s.ok ? "success" : "warning"} pulse={!s.ok} />
                  </div>
                  <div className={cn("font-terminal text-[10px]", s.ok ? "text-success" : "text-warning")}>{s.status}</div>
                  <div className="truncate text-[10px] text-muted-foreground">{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 border-t border-border pt-2 font-terminal text-[9px] text-muted-foreground">
            FAIL-SAFE RULE: if a critical dependency fails, ARISE enters SAFE MODE — no new trades. "No trade" is a valid outcome.
          </p>
        </Panel>

        <Panel title="AUDIT LOG — APPEND-ONLY">
          {(events ?? []).length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              No system events recorded. Failures (provider outages, invalid data) are logged here.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full font-terminal text-[11px]">
                <thead>
                  <tr className="border-b border-border text-left text-[9px] text-muted-foreground">
                    <th className="py-1.5 pr-3">TIME (UTC)</th>
                    <th className="py-1.5 pr-3">LEVEL</th>
                    <th className="py-1.5 pr-3">AREA</th>
                    <th className="py-1.5 pr-3">CODE</th>
                    <th className="py-1.5">DETAIL</th>
                  </tr>
                </thead>
                <tbody>
                  {(events ?? []).map((e) => (
                    <tr key={e._id} className="border-b border-border/40">
                      <td className="py-1.5 pr-3 tabular text-muted-foreground">{new Date(e.at).toISOString().slice(11, 19)}</td>
                      <td className="py-1.5 pr-3">
                        <Badge
                          variant="outline"
                          className={cn(
                            "font-terminal text-[9px]",
                            e.level === "ERROR" && "border-danger/40 text-danger",
                            e.level === "WARN" && "border-warning/40 text-warning",
                          )}
                        >
                          {e.level}
                        </Badge>
                      </td>
                      <td className="py-1.5 pr-3">{e.area}</td>
                      <td className="py-1.5 pr-3 font-semibold">{e.code}</td>
                      <td className="py-1.5 truncate text-[10px] text-muted-foreground">{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Operator-only: what the learning layer proposed, and what it refused. */}
        <LearningPanel />
      </div>
    </Terminal>
  );
}
