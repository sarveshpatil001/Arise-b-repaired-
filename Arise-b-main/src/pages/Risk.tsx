import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Panel, SignalChip, StatTile } from "@/components/arise/shared";
import { Terminal } from "@/components/arise/Terminal";
import { useAccount, useOpenPositions, useDecisionList } from "@/hooks/use-arise";
import { DEFAULT_CONFIG } from "@/lib/arise/config";
import { dailyLossPct, drawdownPct } from "@/lib/arise/risk";
import { fmtMoney } from "@/lib/arise/math";
import { markedEquity } from "@/lib/arise/ledger";
import { createFreshnessPolicy } from "@/lib/arise/freshness";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Check, X, ShieldAlert, Power } from "lucide-react";
import { useEffect, useState } from "react";

export default function Risk() {
  const account = useAccount();
  const open = useOpenPositions();
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
  const decisions = useDecisionList(60);
  const setEstop = useMutation(api.arise.trading.setEmergencyStop);
  const resetAcct = useMutation(api.arise.trading.resetAccount);
  const [busy, setBusy] = useState(false);

  const openNotional = open.reduce((a, p) => a + p.qty * p.entryPrice, 0);
  const marked = markedEquity(account?.balance ?? 0, open, marksBySymbol, { now, policy: createFreshnessPolicy(DEFAULT_CONFIG.barStaleMultiplier) });
  const equity = marked.equity;
  const dl = dailyLossPct({ dayStartEquity: account?.dayStartEquity ?? 0, equity });
  const dd = drawdownPct({ highWaterMark: account?.equityHighWaterMark ?? 0, equity });
  const grossPct = equity > 0 ? (openNotional / equity) * 100 : 0;
  const vetoes = (decisions ?? []).filter((d) => d.status === "VETOED");
  const limits = DEFAULT_CONFIG;

  const liveChecks = [
    { rule: "MAX_DAILY_LOSS", pass: dl < limits.maxDailyLossPct, detail: `${dl.toFixed(2)}% vs ${limits.maxDailyLossPct}% limit` },
    { rule: "MAX_DRAWDOWN", pass: dd < limits.maxDrawdownPct, detail: `${dd.toFixed(2)}% vs ${limits.maxDrawdownPct}% limit` },
    { rule: "MAX_POSITION", pass: true, detail: `${limits.maxPositionPct}% of equity per position` },
    { rule: "GROSS_EXPOSURE", pass: grossPct < limits.maxGrossExposurePct, detail: `${grossPct.toFixed(1)}% vs ${limits.maxGrossExposurePct}% limit` },
    { rule: "LEVERAGE", pass: true, detail: `1.0x vs ${limits.maxLeverage}x limit` },
    { rule: "POSITION_COUNT", pass: open.length < 5, detail: `${open.length} open vs max 5` },
    { rule: "EMERGENCY_STOP", pass: !account?.emergencyStop, detail: account?.emergencyStop ? "ACTIVE — trading halted" : "clear" },
  ];

  return (
    <Terminal>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-terminal text-lg font-bold tracking-wider">RISK CONTROL — DETERMINISTIC VETO AUTHORITY</h1>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1 font-terminal text-[9px]">
              DETERMINISTIC · NO AI OVERRIDE · risk-v1
            </Badge>
          </div>
        </div>

        {account?.emergencyStop && (
          <div className="panel border-danger/50 bg-danger/10 px-4 py-3">
            <div className="flex items-center gap-2 font-terminal text-sm font-bold text-danger">
              <ShieldAlert className="size-4" /> EMERGENCY STOP ACTIVE — NO NEW TRADES WILL BE APPROVED
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Existing positions remain monitored. Manual clearance required to resume.
            </p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <StatTile label="EQUITY (EST.)" value={fmtMoney(equity)} sub={marked.usedFallback.length ? `STALE · entry fallback: ${marked.usedFallback.join(", ")}` : undefined} />
          <StatTile label="EXPOSURE" value={`${grossPct.toFixed(1)}%`} tone={grossPct > limits.maxGrossExposurePct * 0.8 ? "down" : "neutral"} sub={fmtMoney(openNotional)} />
          <StatTile label="DAILY LOSS" value={`${dl.toFixed(2)}%`} tone={dl > 0 ? "down" : "neutral"} sub={`limit ${limits.maxDailyLossPct}%`} />
          <StatTile label="DRAWDOWN" value={`${dd.toFixed(2)}%`} tone={dd > 5 ? "down" : "neutral"} sub={`limit ${limits.maxDrawdownPct}%`} />
          <StatTile label="LEVERAGE" value="1.0x" sub={`limit ${limits.maxLeverage}x`} />
          <StatTile label="RISK VETOES (60)" value={String(vetoes.length)} tone={vetoes.length > 0 ? "down" : "neutral"} />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <Panel title="ACTIVE RISK CHECKS" className="lg:col-span-2">
            <div className="space-y-1">
              {liveChecks.map((c) => (
                <div key={c.rule} className="flex items-start gap-2 border-b border-border/40 py-1.5 last:border-0">
                  {c.pass ? <Check className="mt-0.5 size-3.5 shrink-0 text-success" /> : <X className="mt-0.5 size-3.5 shrink-0 text-danger" />}
                  <span className={cn("font-terminal text-[11px] font-semibold", c.pass ? "" : "text-danger")}>{c.rule}</span>
                  <span className="ml-auto text-right text-[10px] text-muted-foreground">{c.detail}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 border-t border-border pt-2 font-terminal text-[9px] leading-relaxed text-muted-foreground">
              THE RISK ENGINE IS NOT AI. It is deterministic software with veto authority.
              No agent output, confidence score, or user command can override these rules in the pipeline.
            </div>
          </Panel>

          <div className="space-y-3">
            <Panel title="EMERGENCY CONTROLS">
              <div className="space-y-2">
                <Button
                  variant={account?.emergencyStop ? "default" : "destructive"}
                  size="sm"
                  className="w-full gap-2 font-terminal text-[11px]"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await setEstop({ active: !account?.emergencyStop });
                      toast.success(account?.emergencyStop ? "Emergency stop cleared" : "EMERGENCY STOP ENGAGED");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Power className="size-3.5" />
                  {account?.emergencyStop ? "CLEAR EMERGENCY STOP" : "ENGAGE EMERGENCY STOP"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full gap-2 font-terminal text-[11px]"
                  disabled={busy || open.length > 0}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await resetAcct({});
                      toast.success("Paper account reset to starting balance");
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Reset failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  RESET PAPER ACCOUNT ($10,000)
                </Button>
                {open.length > 0 && (
                  <p className="text-[10px] text-warning">Close open positions before resetting.</p>
                )}
              </div>
            </Panel>

            <Panel title="CONFIGURED LIMITS">
              <div className="space-y-1.5 font-terminal text-[10px]">
                <KV k="RISK / TRADE" v={`${limits.riskPerTradePct}%`} />
                <KV k="MAX POSITION" v={`${limits.maxPositionPct}% equity`} />
                <KV k="MAX GROSS EXPOSURE" v={`${limits.maxGrossExposurePct}%`} />
                <KV k="MAX DAILY LOSS" v={`${limits.maxDailyLossPct}%`} />
                <KV k="MAX DRAWDOWN" v={`${limits.maxDrawdownPct}%`} />
                <KV k="MAX SPREAD" v={`${limits.maxSpreadPct}%`} />
                <KV k="MIN VALIDATED BARS" v={String(limits.minBars)} />
                <KV k="STALE MULTIPLIER" v={`${limits.barStaleMultiplier}× interval`} />
              </div>
            </Panel>
          </div>
        </div>

        <Panel title="RECENT RISK VETOES">
          {vetoes.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              No vetoes recorded. The engine has been approving or no trades were proposed.
            </div>
          ) : (
            <div className="space-y-1.5">
              {vetoes.slice(0, 12).map((d) => {
                const rk = d.risk as { reasonCode?: string; message?: string } | null;
                return (
                  <div key={d._id} className="flex flex-wrap items-center gap-2 border-b border-border/40 pb-1.5 text-[11px]">
                    <SignalChip signal="VETO" />
                    <span className="font-terminal font-semibold">{d.symbol}</span>
                    <Badge variant="outline" className="font-terminal text-[9px]">{rk?.reasonCode ?? d.status}</Badge>
                    <span className="text-[10px] text-muted-foreground">{rk?.message ?? d.thesis}</span>
                    <span className="ml-auto font-terminal text-[9px] text-muted-foreground tabular">
                      {new Date(d.dataTimestamp).toISOString().slice(5, 16).replace("T", " ")}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>
    </Terminal>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/40 pb-1">
      <span className="text-muted-foreground">{k}</span>
      <span className="tabular font-semibold">{v}</span>
    </div>
  );
}
