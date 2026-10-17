// Pure decision logic extracted from the ARISE admin control plane so it can be
// unit-tested without a Convex runtime. NO Convex imports — handlers pass plain data in.

// ---------------- agent monitor ----------------

export interface DecisionLike {
  dataTimestamp: number;
  agents?: Record<string, { modelVersion?: string }> | null;
  snapshotMeta?: { fetchMs?: number } | null;
}

export interface AgentRow {
  key: string;
  label: string;
  role: string;
  status: "ONLINE" | "DEGRADED";
  lastRun: number | null;
  latencyMs: number | null;
  errorRatePct: number;
  engine: string;
  version: string;
}

const AGENTS = [
  { key: "quant", label: "QUANT AI", role: "Statistical evidence" },
  { key: "technical", label: "TECHNICAL AI", role: "Market structure" },
  { key: "regime", label: "REGIME AI", role: "Condition classification" },
  { key: "anomaly", label: "ANOMALY AI", role: "Abnormal behavior" },
  { key: "portfolio", label: "PORTFOLIO AI", role: "Exposure & correlation" },
  { key: "risk", label: "RISK AI", role: "Advisory only" },
  { key: "news", label: "NEWS AI", role: "Headline flow (real feeds)" },
  { key: "mind", label: "MIND AI", role: "Synthesis & challenge" },
] as const;

/**
 * Build the Agent Monitor table. Each agent's lastRun is the most recent decision
 * that carried that agent's payload — not the global most-recent decision time.
 * An agent is ONLINE if its payload appears anywhere in the recent window;
 * DEGRADED only when the whole recent feed is older than 24h.
 */
export function buildAgentRows(recentDecisions: DecisionLike[], now: number): AgentRow[] {
  const all = [...recentDecisions].sort((a, b) => b.dataTimestamp - a.dataTimestamp).slice(0, 50);
  const feedFresh = all.some((d) => now - d.dataTimestamp < 24 * 3600 * 1000);
  const globalLatency = (all[0]?.snapshotMeta as { fetchMs?: number } | undefined)?.fetchMs ?? null;
  return AGENTS.map((a) => {
    const carrying = all.filter((d) => d.agents?.[a.key]);
    const lastRun = carrying[0]?.dataTimestamp ?? null;
    return {
      key: a.key,
      label: a.label,
      role: a.role,
      status: carrying.length > 0 || feedFresh ? "ONLINE" : "DEGRADED",
      lastRun,
      latencyMs: globalLatency,
      errorRatePct: 0, // structured agent errors surface as system events
      engine: carrying[0]?.agents?.[a.key]?.modelVersion ?? "heuristic-v1",
      version: "1.0.0",
    };
  });
}

// ---------------- market-data feed state ----------------

export type FeedState = "LIVE" | "DELAYED" | "STALE" | "OFFLINE" | "INVALID";

export const FEED_LIVE_SEC = 15 * 60; // under 15 minutes, i.e. seconds (not ms)
export const FEED_DELAYED_SEC = 6 * 3600; // under 6 hours

/**
 * How far a provider timestamp may run ahead of our own clock and still be treated as
 * "now". Providers stamp bars on their own clocks, so a small positive skew is normal
 * and unavoidable; anything further ahead is not live data.
 */
export const CLOCK_SKEW_TOLERANCE_SEC = 120;

/**
 * Classify feed freshness from seconds since the last successful fetch.
 *
 * A NEGATIVE age means the timestamp is in the future relative to our clock. Small
 * negative ages inside `CLOCK_SKEW_TOLERANCE_SEC` are ordinary clock skew and count as
 * LIVE; beyond that the timestamp cannot be trusted, so it is reported as INVALID —
 * never as LIVE. Claiming "live" for a future-dated reading is exactly the kind of
 * false freshness signal this must not produce, and a NaN/absent age stays OFFLINE
 * (unhealthy) rather than being assumed fresh.
 */
export function feedState(ageSec: number | null): FeedState {
  if (ageSec === null || !Number.isFinite(ageSec)) return "OFFLINE";
  if (ageSec < -CLOCK_SKEW_TOLERANCE_SEC) return "INVALID"; // future-dated beyond skew
  if (ageSec < FEED_LIVE_SEC) return "LIVE"; // includes skew inside the tolerance
  if (ageSec < FEED_DELAYED_SEC) return "DELAYED";
  return "STALE";
}

export interface SymbolFreshness {
  symbol: string;
  lastAt: number;
  ageSec: number;
  /**
   * True when the row's timestamp cannot be trusted as a recent fetch (future-dated
   * beyond `CLOCK_SKEW_TOLERANCE_SEC`, or not a number). `ageSec` is then clamped to 0
   * for display, so it must NEVER be read as "perfectly fresh" — check this flag.
   */
  invalid: boolean;
  source: string;
}

/** Most recent fetch per symbol, newest first, capped at `limit`. */
export function symbolFreshness(
  decisions: { symbol: string; dataTimestamp: number; dataSource?: string }[],
  now: number,
  limit = 12,
): SymbolFreshness[] {
  const bySymbol = new Map<string, SymbolFreshness>();
  for (const d of [...decisions].sort((a, b) => b.dataTimestamp - a.dataTimestamp)) {
    if (bySymbol.has(d.symbol)) continue;
    const rawAgeSec = (now - d.dataTimestamp) / 1000;
    // Previously this clamped with Math.max(0, ...), which turned a future-dated row
    // into a reported age of 0 — i.e. it looked like the freshest possible data. The
    // clamp is kept for display, but the row is now flagged invalid instead of hidden.
    const invalid =
      !Number.isFinite(rawAgeSec) || rawAgeSec < -CLOCK_SKEW_TOLERANCE_SEC;
    bySymbol.set(d.symbol, {
      symbol: d.symbol,
      lastAt: d.dataTimestamp,
      ageSec: invalid ? 0 : Math.max(0, Math.round(rawAgeSec)),
      invalid,
      source: d.dataSource ?? "—",
    });
  }
  return [...bySymbol.values()].slice(0, limit);
}

export interface ProviderStatusRow {
  name: string;
  markets: string;
  state: FeedState;
  lastFetch: number | null;
  failures: number;
}

/**
 * Per-provider health from the decisions that actually carry that provider's data.
 *
 * The admin page previously rendered two provider rows that both used the newest
 * decision's age and the same global failure count. A Binance decision therefore made
 * Yahoo look LIVE, and a Yahoo decision made Binance look LIVE. Only rows with the
 * matching `dataSource` may establish that provider's last fetch; no evidence means
 * OFFLINE, never a fabricated LIVE.
 */
export function providerStatus(args: {
  name: string;
  markets: string;
  source: string;
  symbols: string[];
  decisions: { dataTimestamp: number; dataSource?: string }[];
  events: { code: string; message: string }[];
  now: number;
}): ProviderStatusRow {
  const owned = [...args.decisions]
    .filter((d) => d.dataSource === args.source)
    .sort((a, b) => b.dataTimestamp - a.dataTimestamp);
  const lastFetch = owned[0]?.dataTimestamp ?? null;
  const ageSec = lastFetch === null ? null : Math.round((args.now - lastFetch) / 1000);
  const failures = args.events.filter(
    (e) =>
      e.code === "PROVIDER_FAILURE" &&
      args.symbols.some((symbol) => e.message.startsWith(`${symbol}:`)),
  ).length;
  return {
    name: args.name,
    markets: args.markets,
    state: feedState(ageSec),
    lastFetch,
    failures,
  };
}

// ---------------- audit log merge ----------------

export interface AuditEntry {
  kind: "ADMIN" | "SYSTEM";
  at: number;
  actor: string;
  action: string;
  component: string;
  prevState?: string;
  newState?: string;
  result: string;
}

export interface AdminAuditRow {
  at: number;
  actorEmail?: string;
  action: string;
  component: string;
  prevState?: string;
  newState?: string;
  result: string;
}

export interface SystemEventRow {
  level: string;
  area: string;
  code: string;
  message: string;
  at: number;
}

/**
 * Merge admin actions and system events into one newest-first audit feed.
 * System rows include ERROR/WARN always; INFO only from SYSTEM or BILLING areas
 * (operational halts, resume, billing transitions) — routine INFO stays out.
 */
export function mergeAuditRows(admin: AdminAuditRow[], events: SystemEventRow[], limit = 120): AuditEntry[] {
  const adminRows: AuditEntry[] = admin.map((a) => ({
    kind: "ADMIN" as const,
    at: a.at,
    actor: a.actorEmail ?? "admin",
    action: a.action,
    component: a.component,
    prevState: a.prevState,
    newState: a.newState,
    result: a.result,
  }));
  const sysRows: AuditEntry[] = events
    .filter((e) => e.level !== "INFO" || e.area === "SYSTEM" || e.area === "BILLING")
    .map((e) => ({
      kind: "SYSTEM" as const,
      at: e.at,
      actor: e.area,
      action: `${e.code}: ${e.message}`,
      component: e.area,
      prevState: undefined,
      newState: undefined,
      result: e.level,
    }));
  return [...adminRows, ...sysRows].sort((a, b) => b.at - a.at).slice(0, limit);
}
