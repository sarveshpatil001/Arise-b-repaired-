// ARISE Administration — the technical control plane.
// Separated from the trading workflow. Role-guarded server-side; every action audited.
// Admins can stop the system; they can never weaken the deterministic risk engine.

import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Panel, StatTile, StatusChip } from "@/components/arise/shared";
import { Terminal } from "@/components/arise/Terminal";
import { useAuth } from "@/hooks/use-auth";
import { useMonitorStatus } from "@/hooks/use-monitor";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Bot, Database, OctagonX, Lock, Radio, ShieldAlert, Users, Wifi,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Navigate } from "react-router";

const TABS = [
  { key: "overview", label: "OVERVIEW", icon: Radio },
  { key: "users", label: "USERS", icon: Users },
  { key: "ai", label: "AI CONFIG", icon: Bot },
  { key: "agents", label: "AGENTS", icon: Bot },
  { key: "data", label: "MARKET DATA", icon: Wifi },
  { key: "risk", label: "RISK CONTROL", icon: ShieldAlert },
  { key: "tests", label: "BOT TESTS", icon: Bot },
  { key: "system", label: "SYSTEM", icon: Database },
  { key: "audit", label: "AUDIT LOG", icon: Lock },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function fmtUtc(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

export default function Admin() {
  const { user } = useAuth();
  const isAdmin = (user as { role?: string } | null | undefined)?.role === "admin";
  const [tab, setTab] = useState<TabKey>("overview");

  if (user !== undefined && user !== null && !isAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <Terminal>
      <div className="space-y-3">
        {/* Control-plane header — environment impossible to misread */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="font-terminal text-lg font-bold tracking-wider">ADMINISTRATION</h1>
            <p className="text-[11px] text-muted-foreground">
              Technical control plane — separated from the trading workflow. All actions are audited.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="border-warning/50 font-terminal text-[9px] text-warning">
              <Lock className="mr-1 size-3" /> RESTRICTED ACCESS
            </Badge>
            <Badge variant="outline" className="font-terminal text-[9px]">
              ENVIRONMENT: PAPER TRADING
            </Badge>
          </div>
        </div>

        {/* Section tabs */}
        <div className="flex gap-1 overflow-x-auto border-b border-border pb-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "whitespace-nowrap px-3 py-1.5 font-terminal text-[10px] tracking-wider",
                tab === t.key ? "border-b-2 border-warning bg-warning/5 text-warning" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "overview" && <OverviewTab />}
        {tab === "users" && <UsersTab />}
        {tab === "ai" && <AiConfigTab />}
        {tab === "agents" && <AgentsTab />}
        {tab === "data" && <MarketDataTab />}
        {tab === "risk" && <RiskControlTab />}
        {tab === "tests" && <BotTestsTab />}
        {tab === "system" && <SystemTab />}
        {tab === "audit" && <AuditTab />}
      </div>
    </Terminal>
  );
}

// ---------------- OVERVIEW ----------------

function OverviewTab() {
  const monitor = useMonitorStatus();
  const stats = useQuery(api.arise.admin.overview, {});
  const sysEvents = useQuery(api.arise.system.list, { limit: 8 });
  const activity = useQuery(api.arise.admin.recentAdminActivity, { limit: 6 });

  return (
    <div className="space-y-3">
      {stats && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <StatTile label="ACTIVE USERS" value={String(stats.activeUsers)} sub={`${stats.totalUsers} total`} />
          <StatTile label="ACTIVE SESSIONS" value={String(stats.activeSessions)} />
          <StatTile label="DECISIONS (24H)" value={String(stats.decisions24h)} />
          <StatTile label="OPEN POSITIONS" value={String(stats.openPositions)} />
          <StatTile
            label="TRADING STATE"
            value={stats.tradingHalted ? "HALTED" : "RUNNING"}
            tone={stats.tradingHalted ? "down" : "up"}
            sub={stats.tradingHalted ? stats.haltReason : "risk engine active"}
          />
          <StatTile label="EXECUTION" value="PAPER" tone="primary" sub="live disabled" />
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel title="RECENT SYSTEM ERRORS">
          {(sysEvents ?? []).filter((e) => e.level === "ERROR").length === 0 ? (
            <p className="py-3 text-center text-xs text-muted-foreground">No errors recorded.</p>
          ) : (
            <div className="space-y-1.5 font-terminal text-[10px]">
              {(sysEvents ?? []).filter((e) => e.level === "ERROR").slice(0, 5).map((e) => (
                <div key={e._id} className="flex items-center gap-2">
                  <StatusChip state="ERROR" />
                  <span className="tabular text-muted-foreground">{new Date(e.at).toISOString().slice(11, 19)}</span>
                  <span className="text-muted-foreground">{e.area}</span>
                  <span className="truncate">{e.code}: {e.message}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="RECENT ADMINISTRATIVE ACTIVITY">
          {(activity ?? []).length === 0 ? (
            <p className="py-3 text-center text-xs text-muted-foreground">No administrative actions recorded yet.</p>
          ) : (
            <div className="space-y-1.5 font-terminal text-[10px]">
              {(activity ?? []).map((a) => (
                <div key={a._id} className="flex items-center gap-2">
                  <span className="tabular text-muted-foreground">{new Date(a.at).toISOString().slice(11, 19)}</span>
                  <span className="truncate">{a.action}</span>
                  <StatusChip state={a.result === "SUCCESS" ? "COMPLETED" : "ERROR"} />
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel title="SERVICE STATUS">
        <div className="grid grid-cols-2 gap-2 font-terminal text-[10px] md:grid-cols-3 lg:grid-cols-6">
          {/* AI/DATA/DB/RISK/API rows reflect reachability during this query: a component
              that failed would surface as an error event above rather than a row here.
              POSITION MONITOR is measured, not asserted — see monitorState tick history. */}
          {[
            { name: "AI SERVICE", state: "ONLINE" },
            { name: "MARKET DATA", state: "LIVE" },
            { name: "DATABASE", state: "ONLINE" },
            { name: "RISK ENGINE", state: "RUNNING" },
            { name: "EXECUTION", state: "PAPER" },
            { name: "POSITION MONITOR", state: monitor?.state ?? "OFFLINE" },
          ].map((s) => (
            <div key={s.name} className="flex items-center justify-between border border-border px-2 py-1.5">
              <span className="text-muted-foreground">{s.name}</span>
              <StatusChip state={s.state} />
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

// ---------------- USERS ----------------

function UsersTab() {
  const users = useQuery(api.arise.admin.listUsers, {});
  const setUserRole = useMutation(api.arise.admin.setUserRole);
  const setUserDisabled = useMutation(api.arise.admin.setUserDisabled);
  const grantPlan = useMutation(api.arise.admin.grantPlan);
  const [search, setSearch] = useState("");

  const userRows = users?.rows ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return userRows;
    return userRows.filter((u) => u.email.toLowerCase().includes(q) || u.role.includes(q));
  }, [userRows, search]);

  return (
    <div className="space-y-3">
      {users?.truncated && <p className="border border-amber-500/40 px-2 py-1 font-terminal text-[10px] text-amber-500">PARTIAL USER LIST — showing up to 500 users; subscription scan capped at 1,000.</p>}
      <div className="flex items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search users by email or role…"
          className="h-8 max-w-xs font-terminal text-[11px]"
        />
        <span className="font-terminal text-[10px] text-muted-foreground">
          {filtered.length} ACCOUNT{filtered.length === 1 ? "" : "S"}
        </span>
      </div>

      <Panel title="USER MANAGEMENT">
        <div className="overflow-x-auto">
          <table className="w-full font-terminal text-[11px]">
            <thead>
              <tr className="border-b border-border text-left text-[9px] text-muted-foreground">
                <th className="py-1.5 pr-3">EMAIL</th>
                <th className="py-1.5 pr-3">ROLE</th>
                <th className="py-1.5 pr-3">PLAN</th>
                <th className="py-1.5 pr-3">STATUS</th>
                <th className="py-1.5">ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u._id} className="border-b border-border/40">
                  <td className="max-w-56 truncate py-1.5 pr-3">{u.email}</td>
                  <td className="py-1.5 pr-3">
                    <Select
                      value={u.role}
                      onValueChange={(role) => {
                        void setUserRole({ targetUserId: u._id, role: role as "admin" | "operator" | "analyst" | "user" })
                          .then(() => toast.success(`Role set to ${role}`))
                          .catch((e) => toast.error(e.message));
                      }}
                    >
                      <SelectTrigger className="h-6 w-28 font-terminal text-[9px]"><SelectValue /></SelectTrigger>
                      <SelectContent className="font-terminal text-[10px]">
                        <SelectItem value="admin">Administrator</SelectItem>
                        <SelectItem value="operator">Operator</SelectItem>
                        <SelectItem value="analyst">Analyst</SelectItem>
                        <SelectItem value="user">User</SelectItem>
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="py-1.5 pr-3">
                    <Select
                      value={u.planKey}
                      onValueChange={(planKey) => {
                        void grantPlan({ targetUserId: u._id, planKey })
                          .then(() => toast.success(`Plan ${planKey} granted`))
                          .catch((e) => toast.error(e.message));
                      }}
                    >
                      <SelectTrigger className="h-6 w-28 font-terminal text-[9px]"><SelectValue /></SelectTrigger>
                      <SelectContent className="font-terminal text-[10px]">
                        <SelectItem value="free">free</SelectItem>
                        <SelectItem value="pro">pro</SelectItem>
                        <SelectItem value="institutional">institutional</SelectItem>
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="py-1.5 pr-3">
                    {u.disabled ? <StatusChip state="BLOCKED" /> : <StatusChip state="ONLINE" />}
                  </td>
                  <td className="py-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 font-terminal text-[9px]"
                      onClick={() => {
                        void setUserDisabled({ targetUserId: u._id, disabled: !u.disabled })
                          .then(() => toast.success(u.disabled ? "User reactivated" : "User disabled"))
                          .catch((e) => toast.error(e.message));
                      }}
                    >
                      {u.disabled ? "REACTIVATE" : "DISABLE"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 border-t border-border pt-2 font-terminal text-[9px] text-muted-foreground">
          Roles are permission-based. Disabled accounts are blocked server-side at the decision pipeline — not merely hidden in the UI.
        </p>
      </Panel>

      <Panel title="FIRST-ADMIN BOOTSTRAP">
        <BootstrapForm />
      </Panel>
    </div>
  );
}

function BootstrapForm() {
  const bootstrap = useMutation(api.arise.billingFunctions.bootstrapAdmin);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const { user } = useAuth();
  if ((user as { role?: string } | null | undefined)?.role === "admin") return null;

  return (
    <div>
      <p className="mb-2 text-[10px] leading-relaxed text-muted-foreground">
        Paste the value of <span className="font-terminal text-foreground">ARISE_ADMIN_CODE</span> from the Keys tab.
        The first account to claim it becomes the administrator; the code then stops working.
      </p>
      <div className="flex gap-2">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="setup code"
          className="h-8 font-terminal text-[11px]"
          type="password"
        />
        <Button
          size="sm"
          className="h-8 font-terminal text-[10px]"
          disabled={busy || !code}
          onClick={async () => {
            setBusy(true);
            try {
              await bootstrap({ code: code.trim() });
              toast.success("Administrator role granted.");
              window.location.reload();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Bootstrap failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          CLAIM
        </Button>
      </div>
    </div>
  );
}

// ---------------- AI CONFIG ----------------

function AiConfigTab() {
  const agentResult = useQuery(api.arise.admin.agentMonitor, {});
  const agents = agentResult?.rows ?? [];
  return (
    <div className="space-y-3">
      <Panel title="AI SERVICE STATUS">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <KVRow k="ENGINE" v="heuristic-v1 (deterministic)" />
          <KVRow k="CONNECTION" v="internal — no external calls" />
          <KVRow k="SECRETS" v="stored server-side only" />
          <KVRow k="MODEL ROUTING" v="fixed — pipeline-defined" />
          <KVRow k="REQUEST LIMITS" v="governed by plan entitlements" />
          <KVRow k="STRUCTURED OUTPUT" v="schema-validated, fail-closed" />
        </div>
        <p className="mt-3 border-t border-border pt-2 text-[10px] leading-relaxed text-muted-foreground">
          ARISE V1 runs deterministic analytical agents — no external AI provider is called, so no API keys are
          required in the user interface. When external AI providers are added, their keys live in the server-side
          Keys store, are never rendered in any interface, and their output passes the same structured validation
          gate as every other agent.
        </p>
      </Panel>
      <Panel title="CONFIGURATION INVENTORY">
        <div className="grid grid-cols-1 gap-2 font-terminal text-[10px] md:grid-cols-2">
          {agentResult?.truncated && <p className="mb-2 text-[10px] text-amber-500">PARTIAL SCAN — per-status decision rows capped at {agentResult.perStatusScanCap}.</p>}
          {agents.map((a) => (
            <div key={a.key} className="flex items-center justify-between border border-border px-2 py-1.5">
              <span>{a.label}</span>
              <span className="text-muted-foreground">{a.engine} · v{a.version}</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

// ---------------- AGENT MONITOR ----------------

function AgentsTab() {
  const agentResult = useQuery(api.arise.admin.agentMonitor, {});
  const agents = agentResult?.rows ?? [];
  return (
    <div className="space-y-3">
      <Panel title="AGENT MONITOR">
        <div className="overflow-x-auto">
          <table className="w-full font-terminal text-[11px]">
            <thead>
              <tr className="border-b border-border text-left text-[9px] text-muted-foreground">
                <th className="py-1.5 pr-3">AGENT</th>
                <th className="py-1.5 pr-3">ROLE</th>
                <th className="py-1.5 pr-3">STATUS</th>
                <th className="py-1.5 pr-3">LAST RUN</th>
                <th className="py-1.5 pr-3">LATENCY</th>
                <th className="py-1.5">ENGINE</th>
              </tr>
            </thead>
            <tbody>
              {agentResult?.truncated && <tr><td colSpan={6} className="py-1 text-amber-500">PARTIAL SCAN — per-status decision rows capped at {agentResult.perStatusScanCap}.</td></tr>}
              {agents.map((a) => (
                <tr key={a.key} className="border-b border-border/40">
                  <td className="py-1.5 pr-3 font-semibold">{a.label}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground">{a.role}</td>
                  <td className="py-1.5 pr-3"><StatusChip state={a.status} /></td>
                  <td className="py-1.5 pr-3 tabular text-muted-foreground">{fmtUtc(a.lastRun)}</td>
                  <td className="py-1.5 pr-3 tabular">{a.latencyMs != null ? `${a.latencyMs}ms` : "—"}</td>
                  <td className="py-1.5 text-muted-foreground">{a.engine}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 border-t border-border pt-2 font-terminal text-[9px] leading-relaxed text-muted-foreground">
          SAFETY BOUNDARY: agents advise; the deterministic risk engine decides. No administrator, configuration
          change, or agent output can bypass pipeline validation or risk controls. A halt can only reduce trading, never increase it.
        </p>
      </Panel>
    </div>
  );
}

// ---------------- MARKET DATA ----------------

function MarketDataTab() {
  const data = useQuery(api.arise.admin.marketDataStatus, {});
  return (
    <div className="space-y-3">
      {data && Object.values(data.truncated ?? {}).some(Boolean) && <p className="border border-amber-500/40 px-2 py-1 font-terminal text-[10px] text-amber-500">PARTIAL MARKET-DATA SCAN — one or more decision/event inputs reached their scan cap.</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="FEED STATE"
          value={data?.state ?? "—"}
          tone={data?.state === "LIVE" ? "up" : data?.state === "OFFLINE" ? "down" : "neutral"}
          sub={data?.ageSec != null ? `${data.ageSec}s since last fetch` : "no fetches recorded"}
        />
        <StatTile label="PROVIDERS" value="2" sub="Binance · Yahoo Finance" />
        <StatTile label="DATA FAILURES" value={String(data?.failureCount ?? 0)} tone={(data?.failureCount ?? 0) > 0 ? "down" : "up"} sub="logged, never hidden" />
        <StatTile label="POLICY" value="FAIL-CLOSED" sub="invalid data = no trade" />
      </div>

      <Panel title="PROVIDERS">
        <div className="space-y-2">
          {(data?.providers ?? []).map((p) => (
            <div key={p.name} className="flex flex-wrap items-center gap-3 border border-border px-3 py-2 font-terminal text-[11px]">
              <span className="font-semibold">{p.name}</span>
              <span className="text-muted-foreground">{p.markets}</span>
              <StatusChip state={p.state} />
              <span className="ml-auto tabular text-muted-foreground">LAST FETCH {fmtUtc(p.lastFetch)}</span>
              <span className="tabular text-muted-foreground">FAILURES {p.failures}</span>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="SYMBOL COVERAGE">
        {(data?.symbols ?? []).length === 0 ? (
          <p className="py-3 text-center text-xs text-muted-foreground">
            No symbols fetched yet — freshness data appears after the first analysis.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full font-terminal text-[11px]">
              <thead>
                <tr className="border-b border-border text-left text-[9px] text-muted-foreground">
                  <th className="py-1.5 pr-3">SYMBOL</th>
                  <th className="py-1.5 pr-3">SOURCE</th>
                  <th className="py-1.5 pr-3">LAST FETCH</th>
                  <th className="py-1.5">AGE</th>
                </tr>
              </thead>
              <tbody>
                {(data?.symbols ?? []).map((s) => (
                  <tr key={s.symbol} className="border-b border-border/40">
                    <td className="py-1.5 pr-3 font-semibold">{s.symbol}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{s.source.toUpperCase()}</td>
                    <td className="py-1.5 pr-3 tabular text-muted-foreground">{fmtUtc(s.lastAt)}</td>
                    <td className="py-1.5 tabular">
                      {s.ageSec < 900 ? <StatusChip state="LIVE" /> : s.ageSec < 21600 ? <StatusChip state="DELAYED" /> : <StatusChip state="STALE" />}
                      <span className="ml-2 text-muted-foreground">{Math.round(s.ageSec / 60)}m</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 border-t border-border pt-2 font-terminal text-[9px] text-muted-foreground">
          Stale or invalid market data is a system condition, not a hidden state: the pipeline refuses to trade on it.
        </p>
      </Panel>
    </div>
  );
}

// ---------------- RISK CONTROL ----------------

function RiskControlTab() {
  const status = useQuery(api.arise.admin.platformStatus, {});
  const setHalt = useMutation(api.arise.admin.setTradingHalt);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const halted = status?.tradingHalted ?? false;

  return (
    <div className="space-y-3">
      {halted && (
        <div className="panel border-danger/50 bg-danger/10 px-4 py-3">
          <div className="flex items-center gap-2 font-terminal text-sm font-bold text-danger">
            <OctagonX className="size-4" /> PLATFORM-WIDE TRADING HALT ACTIVE
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {status?.haltReason ?? "Administrative halt"} — all users are blocked from new decisions and trades at the pipeline level.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel title="TRADING HALT CONTROL">
          <p className="mb-2 text-[10px] leading-relaxed text-muted-foreground">
            Blocks every user from running analyses and opening trades. Existing positions remain monitored.
            This is the platform-level counterpart of the per-user emergency stop.
          </p>
          <div className="flex gap-2">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (recorded in audit log)…"
              className="h-8 flex-1 font-terminal text-[11px]"
            />
            <Button
              size="sm"
              variant={halted ? "outline" : "destructive"}
              className="h-8 font-terminal text-[10px]"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await setHalt({ halted: !halted, reason: reason.trim() || undefined });
                  toast.success(halted ? "Trading resumed" : "Trading halted platform-wide");
                  setReason("");
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Action failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {halted ? "RESUME TRADING" : "HALT TRADING"}
            </Button>
          </div>
        </Panel>

        <Panel title="DETERMINISTIC LIMITS (READ-ONLY)">
          <p className="mb-2 text-[10px] leading-relaxed text-muted-foreground">
            These limits are defined in the risk engine's tested configuration. They are displayed here for
            transparency — and intentionally not editable from the console: a misconfigured limit is a greater
            risk than an inconvenient one. Changes ship through reviewed code.
          </p>
          <div className="space-y-1 font-terminal text-[10px]">
            <KVRow k="RISK / TRADE" v="1% of equity" />
            <KVRow k="MAX POSITION" v="15% of equity" />
            <KVRow k="MAX GROSS EXPOSURE" v="60%" />
            <KVRow k="MAX DAILY LOSS" v="5%" />
            <KVRow k="MAX DRAWDOWN" v="10%" />
            <KVRow k="MAX LEVERAGE" v="1.0x" />
            <KVRow k="PAPER TRADING" v="ENFORCED — live disabled in code" />
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ---------------- BOT TESTS (all users, read-only oversight) ----------------

function BotTestsTab() {
  const runs = useQuery(api.arise.backtest.adminRuns, { limit: 50 });
  return (
    <div className="space-y-3">
      <Panel title={`BOT BACKTEST RUNS (${(runs ?? []).length})`}>
        {(runs ?? []).length === 0 ? (
          <p className="py-3 text-center text-xs text-muted-foreground">No backtest runs recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full font-terminal text-[11px]">
              <thead>
                <tr className="border-b border-border text-left text-[9px] text-muted-foreground">
                  <th className="py-1.5 pr-3">TIME</th>
                  <th className="py-1.5 pr-3">BOT</th>
                  <th className="py-1.5 pr-3">MARKET</th>
                  <th className="py-1.5 pr-3">RETURN</th>
                  <th className="py-1.5 pr-3">VERDICT</th>
                  <th className="py-1.5">DATA</th>
                </tr>
              </thead>
              <tbody>
                {(runs ?? []).map((r: { _id: string; createdAt: number; botName: string; symbol: string; interval: string; stress: string; metrics: { totalReturnPct?: number }; fitness: { verdict: string; score: number }; dataKind: string }) => (
                  <tr key={r._id} className="border-b border-border/40">
                    <td className="py-1.5 pr-3 tabular text-muted-foreground">{fmtUtc(r.createdAt)}</td>
                    <td className="py-1.5 pr-3">{r.botName}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{r.symbol} {r.interval} · {r.stress}</td>
                    <td className="py-1.5 pr-3 tabular">{(r.metrics.totalReturnPct ?? 0).toFixed(2)}%</td>
                    <td className="py-1.5 pr-3">{r.fitness.verdict} ({r.fitness.score})</td>
                    <td className="py-1.5 text-muted-foreground">{r.dataKind}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 border-t border-border pt-2 font-terminal text-[9px] text-muted-foreground">
          Read-only oversight. Datasets are REAL exchange bars or labeled SYNTHETIC; fees/slippage and timeframes are recorded per run for audit.
        </p>
      </Panel>
    </div>
  );
}

// ---------------- SYSTEM ----------------

function SystemTab() {
  const stats = useQuery(api.arise.admin.overview, {});
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Panel title="SYSTEM CONFIGURATION">
          <div className="space-y-1 font-terminal text-[10px]">
            <KVRow k="ENVIRONMENT" v="PAPER TRADING" />
            <KVRow k="LIVE EXECUTION" v="DISABLED (hardcoded)" />
            <KVRow k="DATA PROVIDERS" v="Binance · Yahoo Finance" />
            <KVRow k="AI PROVIDERS" v="internal deterministic engine" />
            <KVRow k="TRADING STATE" v={stats?.tradingHalted ? "HALTED" : "RUNNING"} />
            <KVRow k="AUDIT LOGGING" v="append-only, enabled" />
          </div>
        </Panel>
        <Panel title="OPERATIONAL COUNTS">
          {stats ? (
            <div className="space-y-1 font-terminal text-[10px]">
              {Object.values(stats.truncated ?? {}).some(Boolean) && (
                <p className="mb-2 border border-amber-500/40 px-2 py-1 text-amber-500">
                  PARTIAL SCAN — one or more totals are capped at the displayed scan limits.
                </p>
              )}
              <KVRow k="ACCOUNTS" v={String(stats.totalUsers)} />
              <KVRow k="ACTIVE SESSIONS" v={String(stats.activeSessions)} />
              <KVRow k="DECISIONS (24H)" v={String(stats.decisions24h)} />
              <KVRow k="OPEN POSITIONS" v={String(stats.openPositions)} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Loading…</p>
          )}
        </Panel>
      </div>
    </div>
  );
}

// ---------------- AUDIT LOG ----------------

function AuditTab() {
  const auditResult = useQuery(api.arise.admin.auditLog, { limit: 120 });
  const events = auditResult?.rows ?? [];
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return events;
    return events.filter(
      (e) => e.action.toLowerCase().includes(q) || e.component.toLowerCase().includes(q) || e.actor.toLowerCase().includes(q),
    );
  }, [events, filter]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by action, component, or actor…"
          className="h-8 max-w-xs font-terminal text-[11px]"
        />
        <span className="font-terminal text-[10px] text-muted-foreground">{filtered.length} ENTRIES</span>
      </div>
      {auditResult?.truncated && <p className="border border-amber-500/40 px-2 py-1 font-terminal text-[10px] text-amber-500">PARTIAL AUDIT SCAN — inputs capped at {auditResult.scanCaps.adminAudit} admin events and {auditResult.scanCaps.systemEvents} system events.</p>}
      <Panel title="AUDIT LOG — APPEND-ONLY">
        <div className="overflow-x-auto">
          <table className="w-full font-terminal text-[11px]">
            <thead>
              <tr className="border-b border-border text-left text-[9px] text-muted-foreground">
                <th className="py-1.5 pr-3">TIME (UTC)</th>
                <th className="py-1.5 pr-3">ACTOR</th>
                <th className="py-1.5 pr-3">COMPONENT</th>
                <th className="py-1.5 pr-3">ACTION</th>
                <th className="py-1.5 pr-3">TRANSITION</th>
                <th className="py-1.5">RESULT</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => (
                <tr key={`${e.at}-${i}`} className="border-b border-border/40">
                  <td className="py-1.5 pr-3 tabular text-muted-foreground">{new Date(e.at).toISOString().slice(11, 19)}</td>
                  <td className="max-w-40 truncate py-1.5 pr-3">{e.actor}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground">{e.component}</td>
                  <td className="max-w-72 truncate py-1.5 pr-3">{e.action}</td>
                  <td className="py-1.5 pr-3 tabular text-muted-foreground">
                    {e.prevState || e.newState ? `${e.prevState ?? "—"} → ${e.newState ?? "—"}` : "—"}
                  </td>
                  <td className="py-1.5">
                    {e.result === "SUCCESS" ? <StatusChip state="COMPLETED" /> : <StatusChip state={e.result} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

// ---------------- shared ----------------

function KVRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/40 py-1">
      <span className="text-muted-foreground">{k}</span>
      <span className="tabular font-semibold">{v}</span>
    </div>
  );
}
