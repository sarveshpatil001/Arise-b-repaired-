import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Panel, SignalChip, StatTile } from "@/components/arise/shared";
import { Terminal } from "@/components/arise/Terminal";
import { useAccount, useClosedPositions, useOpenPositions } from "@/hooks/use-arise";
import { useMonitorStatus } from "@/hooks/use-monitor";
import { StatusDot, StatusChip } from "@/components/arise/shared";
import { fmtMoney } from "@/lib/arise/math";
import { markedEquity } from "@/lib/arise/ledger";
import { DEFAULT_CONFIG } from "@/lib/arise/config";
import { createFreshnessPolicy } from "@/lib/arise/freshness";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useEffect, useMemo, useState } from "react";

export default function Trades() {
  const account = useAccount();
  const open = useOpenPositions();
  const closed = useClosedPositions();
  const monitor = useMonitorStatus();
  const closePosition = useAction(api.arise.trading.closePosition);
  const equityPoints = useQuery(api.arise.equity.list, {});
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
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tab, setTab] = useState<"open" | "closed">("open");

  const marked = markedEquity(account?.balance ?? 0, open, marksBySymbol, { now, policy: createFreshnessPolicy(DEFAULT_CONFIG.barStaleMultiplier) });
  const equity = marked.equity;
  const totalPnl = (account?.balance ?? 0) - (account?.startingBalance ?? 0);
  const wins = (closed ?? []).filter((p) => (p.pnl ?? 0) > 0);
  const losses = (closed ?? []).filter((p) => (p.pnl ?? 0) <= 0);
  const winRate = closed && closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((a, p) => a + (p.pnl ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, p) => a + (p.pnl ?? 0), 0) / losses.length) : 0;
  const grossWin = wins.reduce((a, p) => a + (p.pnl ?? 0), 0);
  const grossLoss = losses.reduce((a, p) => a + Math.abs(p.pnl ?? 0), 0);
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  const equityData = useMemo(
    () =>
      (equityPoints ?? []).map((p) => ({
        t: p.t,
        equity: p.equity,
        label: new Date(p.t).toISOString().slice(5, 16).replace("T", " "),
      })),
    [equityPoints],
  );

  const doClose = async (id: string, symbol: string) => {
    setBusyId(id);
    try {
      // The server prices the exit from provider data; the client names only the
      // position, so a manipulated price cannot influence settlement.
      const result = await closePosition({ positionId: id as never });
      toast.success(
        `Closed ${symbol} at ${result.exitPrice.toLocaleString("en-US", { maximumFractionDigits: 4 })}`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Close failed");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Terminal>
      <div className="space-y-3">
        <h1 className="font-terminal text-lg font-bold tracking-wider">
          EXECUTION MONITOR — PAPER TRADING
          <span className="ml-3 text-xs font-normal text-muted-foreground">FEES · SPREAD · SLIPPAGE MODELED ON EVERY FILL</span>
        </h1>

        {/* Background monitoring strip — SL/TP are enforced server-side, independent of this page */}
        <div className="panel flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 font-terminal text-[10px] tracking-wider">
          <span className="flex items-center gap-2 text-muted-foreground">
            MONITORING
            {monitor === undefined ? (
              <StatusChip state="READY" />
            ) : (
              <StatusChip state={monitor.state} />
            )}
            <StatusDot
              tone={monitor === undefined ? "muted" : monitor.state === "HEALTHY" ? "success" : monitor.state === "DEGRADED" ? "warning" : "danger"}
              pulse={monitor?.runningNow}
            />
          </span>
          <span className="text-muted-foreground">
            LAST CHECKED{" "}
            <span className="tabular text-foreground">
              {monitor?.lastTickAt ? new Date(monitor.lastTickAt).toISOString().slice(11, 19) : "—"}
            </span>{" "}
            UTC
          </span>
          <span className="text-muted-foreground">SCHEDULE <span className="text-foreground">{monitor?.schedule ?? "EVERY 2 MIN"}</span></span>
          <span className="text-muted-foreground">
            OPEN <span className="tabular text-foreground">{monitor?.openPositions ?? open.length}</span>
          </span>
          {monitor?.detail ? <span className="text-muted-foreground/70 normal-case tracking-normal">{monitor.detail}</span> : null}
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <StatTile label="EQUITY (EST.)" value={fmtMoney(equity)} sub={marked.usedFallback.length ? `STALE · entry fallback: ${marked.usedFallback.join(", ")}` : undefined} />
          <StatTile label="PAPER BALANCE" value={fmtMoney(account?.balance ?? 0)} />
          <StatTile label="TOTAL P&L" value={fmtMoney(totalPnl)} tone={totalPnl >= 0 ? "up" : "down"} />
          <StatTile label="WIN RATE" value={`${winRate.toFixed(1)}%`} tone={winRate >= 50 ? "up" : "neutral"} />
          <StatTile label="PROFIT FACTOR" value={profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)} />
          <StatTile label="CLOSED TRADES" value={String(closed?.length ?? 0)} />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <Panel title="EQUITY CURVE" className="lg:col-span-2">
            {equityData.length > 1 ? (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={equityData}>
                  <defs>
                    <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3fb950" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#3fb950" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="label" tick={{ fill: "#8b98a9", fontSize: 9, fontFamily: "JetBrains Mono" }} stroke="#1d2632" />
                  <YAxis
                    domain={["auto", "auto"]}
                    tick={{ fill: "#8b98a9", fontSize: 9, fontFamily: "JetBrains Mono" }}
                    stroke="#1d2632"
                    width={64}
                    tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                  />
                  <Tooltip
                    contentStyle={{ background: "#11161d", border: "1px solid #1d2632", fontFamily: "JetBrains Mono", fontSize: 11 }}
                    formatter={(v: number) => [`$${v.toFixed(2)}`, "Equity"]}
                  />
                  <Area type="monotone" dataKey="equity" stroke="#3fb950" fill="url(#eq)" strokeWidth={1.5} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-52 items-center justify-center text-xs text-muted-foreground">
                Run analyses to build the equity curve — points are recorded with every decision.
              </div>
            )}
            <div className="mt-2 flex items-center gap-3 border-t border-border pt-2 font-terminal text-[10px] text-muted-foreground">
              <span>AVG WIN <span className="text-success">{fmtMoney(avgWin)}</span></span>
              <span>AVG LOSS <span className="text-danger">-{fmtMoney(avgLoss).replace("$", "$")}</span></span>
              <span>EXPECTANCY <span className={totalPnl >= 0 ? "text-success" : "text-danger"}>
                {closed && closed.length > 0 ? fmtMoney(totalPnl / closed.length) : "—"}
              </span></span>
            </div>
          </Panel>

          <Panel title="TRADE SUMMARY">
            <div className="space-y-2 font-terminal text-[11px]">
              <KV k="OPEN POSITIONS" v={String(open.length)} />
              <KV k="WINNERS" v={String(wins.length)} tone="text-success" />
              <KV k="LOSERS" v={String(losses.length)} tone="text-danger" />
              <KV k="AVG WIN" v={fmtMoney(avgWin)} tone="text-success" />
              <KV k="AVG LOSS" v={`$${avgLoss.toFixed(2)}`} tone="text-danger" />
              <KV k="GROSS WIN" v={fmtMoney(grossWin)} />
              <KV k="GROSS LOSS" v={`$${grossLoss.toFixed(2)}`} />
              <KV k="HIGH WATER MARK" v={fmtMoney(account?.equityHighWaterMark ?? 0)} />
              <KV k="EMERGENCY STOP" v={account?.emergencyStop ? "ACTIVE" : "CLEAR"} tone={account?.emergencyStop ? "text-danger" : "text-success"} />
            </div>
          </Panel>
        </div>

        <Panel
          title="POSITIONS & TRADE RECORD"
          right={
            <div className="flex gap-1">
              {(["open", "closed"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "px-2 py-0.5 font-terminal text-[10px] tracking-wider",
                    tab === t ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
          }
        >
          {tab === "open" ? (
            open.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                No open positions. Use ANALYZE + PAPER EXECUTE on the HOME screen.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full font-terminal text-[11px]">
                  <thead>
                    <tr className="border-b border-border text-left text-[9px] text-muted-foreground">
                      <th className="py-1.5 pr-3">SYMBOL</th>
                      <th className="py-1.5 pr-3">SIDE</th>
                      <th className="py-1.5 pr-3 text-right">QTY</th>
                      <th className="py-1.5 pr-3 text-right">ENTRY</th>
                      <th className="py-1.5 pr-3 text-right">STOP</th>
                      <th className="py-1.5 pr-3 text-right">TARGET</th>
                      <th className="py-1.5 pr-3">OPENED</th>
                      <th className="py-1.5">ACTION</th>
                    </tr>
                  </thead>
                  <tbody>
                    {open.map((p) => (
                      <tr key={p._id} className="border-b border-border/40">
                        <td className="py-1.5 pr-3 font-semibold">{p.symbol}</td>
                        <td className="py-1.5 pr-3"><SignalChip signal={p.side} /></td>
                        <td className="py-1.5 pr-3 text-right tabular">{p.qty.toPrecision(6)}</td>
                        <td className="py-1.5 pr-3 text-right tabular">{p.entryPrice.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                        <td className="py-1.5 pr-3 text-right tabular text-danger">{p.stopLoss.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                        <td className="py-1.5 pr-3 text-right tabular text-success">{p.takeProfit.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                        <td className="py-1.5 pr-3 text-muted-foreground">{new Date(p.openedAt).toISOString().slice(5, 16).replace("T", " ")}</td>
                        <td className="py-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 font-terminal text-[9px]"
                            disabled={busyId === p._id}
                            onClick={() => void doClose(p._id, p.symbol)}
                          >
                            CLOSE
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (closed ?? []).length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">No closed trades yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full font-terminal text-[11px]">
                <thead>
                  <tr className="border-b border-border text-left text-[9px] text-muted-foreground">
                    <th className="py-1.5 pr-3">SYMBOL</th>
                    <th className="py-1.5 pr-3">SIDE</th>
                    <th className="py-1.5 pr-3 text-right">ENTRY</th>
                    <th className="py-1.5 pr-3 text-right">EXIT</th>
                    <th className="py-1.5 pr-3 text-right">P&L (NET)</th>
                    <th className="py-1.5 pr-3">REASON</th>
                    <th className="py-1.5 pr-3">CLOSED (UTC)</th>
                    <th className="py-1.5">THESIS</th>
                  </tr>
                </thead>
                <tbody>
                  {(closed ?? []).map((p) => (
                    <tr key={p._id} className="border-b border-border/40">
                      <td className="py-1.5 pr-3 font-semibold">{p.symbol}</td>
                      <td className="py-1.5 pr-3"><SignalChip signal={p.side} /></td>
                      <td className="py-1.5 pr-3 text-right tabular">{p.entryPrice.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                      <td className="py-1.5 pr-3 text-right tabular">{(p.exitPrice ?? 0).toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                      <td className={cn("py-1.5 pr-3 text-right tabular font-bold", (p.pnl ?? 0) >= 0 ? "text-success" : "text-danger")}>
                        {fmtMoney(p.pnl ?? 0)}
                      </td>
                      <td className="py-1.5 pr-3">
                        <ExitReasonBadge reason={p.exitReason} />
                      </td>
                      <td className="py-1.5 pr-3 text-muted-foreground tabular">
                        {p.closedAt ? new Date(p.closedAt).toISOString().slice(5, 16).replace("T", " ") : "—"}
                      </td>
                      <td className="py-1.5 max-w-72 truncate text-[10px] text-muted-foreground">{p.thesis ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </Terminal>
  );
}

function KV({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/50 pb-1.5">
      <span className="text-muted-foreground">{k}</span>
      <span className={cn("tabular font-semibold", tone)}>{v}</span>
    </div>
  );
}

/** Exit reason in the standardized vocabulary: TAKE PROFIT / STOP LOSS / MANUAL. */
function ExitReasonBadge({ reason }: { reason?: string | null }) {
  const label =
    reason === "TAKE_PROFIT"
      ? "EXIT — TAKE PROFIT"
      : reason === "STOP_LOSS"
        ? "EXIT — STOP LOSS"
        : reason === "MANUAL_CLOSE"
          ? "EXIT — MANUAL"
          : (reason ?? "—").replace("_", " ");
  const tone =
    reason === "TAKE_PROFIT"
      ? "text-success border-success/40 bg-success/10"
      : reason === "STOP_LOSS"
        ? "text-danger border-danger/40 bg-danger/10"
        : reason === "MANUAL_CLOSE"
          ? "text-primary border-primary/40 bg-primary/10"
          : "text-muted-foreground border-border bg-secondary";
  return (
    <span className={cn("inline-flex items-center border px-1.5 py-0.5 font-terminal text-[9px] font-semibold tracking-wider", tone)}>
      {label}
    </span>
  );
}
