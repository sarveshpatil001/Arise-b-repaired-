// Targeted unit tests for the admin control-plane logic that changed:
//   - buildAgentRows: per-agent lastRun (was global), ONLINE/DEGRADED status
//   - feedState: LIVE/DELAYED/STALE/OFFLINE classification (incl. no-data and clock skew)
//   - symbolFreshness: newest-per-symbol, ordering, cap
//   - mergeAuditRows: admin+system merge, ordering, INFO filtering, limit
import { describe, expect, it } from "vitest";
import {
  buildAgentRows,
  CLOCK_SKEW_TOLERANCE_SEC,
  feedState,
  mergeAuditRows,
  providerStatus,
  symbolFreshness,
  type DecisionLike,
} from "./adminLogic";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;

function dec(
  at: number,
  agentKeys: string[],
  extra: Partial<DecisionLike> = {},
): DecisionLike {
  const agents: Record<string, { modelVersion?: string }> = {};
  for (const k of agentKeys) agents[k] = { modelVersion: "heuristic-v1" };
  return { dataTimestamp: at, agents, snapshotMeta: { fetchMs: 120 }, ...extra };
}

describe("buildAgentRows", () => {
  it("returns all eight specialist rows", () => {
    const rows = buildAgentRows([], NOW);
    expect(rows.map((r) => r.key)).toEqual([
      "quant", "technical", "regime", "anomaly", "portfolio", "risk", "news", "mind",
    ]);
  });

  it("tracks the news specialist like any other, from its own payload", () => {
    const rows = buildAgentRows([dec(NOW - MIN, ["news"])], NOW);
    const news = rows.find((r) => r.key === "news")!;
    expect(news.label).toBe("NEWS AI");
    expect(news.lastRun).toBe(NOW - MIN);
    expect(news.status).toBe("ONLINE");
  });

  it("reports the news specialist DEGRADED when it has no payload and the feed window is stale", () => {
    const rows = buildAgentRows([dec(NOW - 25 * HOUR, ["quant"])], NOW);
    expect(rows.find((r) => r.key === "news")!.status).toBe("DEGRADED");
  });

  it("gives each agent its own lastRun — not the global most-recent decision time", () => {
    const mindOnly = dec(NOW - 1 * MIN, ["mind"]);
    const earlierAll = dec(NOW - 60 * MIN, ["quant", "technical", "regime", "anomaly", "portfolio", "risk", "mind"]);
    const rows = buildAgentRows([mindOnly, earlierAll], NOW);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.mind.lastRun).toBe(NOW - 1 * MIN);
    expect(byKey.quant.lastRun).toBe(NOW - 60 * MIN);
    expect(byKey.technical.lastRun).toBe(NOW - 60 * MIN);
  });

  it("reports lastRun null for an agent that never ran", () => {
    const rows = buildAgentRows([dec(NOW - MIN, ["quant"])], NOW);
    const anomaly = rows.find((r) => r.key === "anomaly")!;
    expect(anomaly.lastRun).toBeNull();
  });

  it("is ONLINE when the feed is fresh even for agents absent from the newest run", () => {
    const rows = buildAgentRows([dec(NOW - MIN, ["quant"])], NOW);
    const anomaly = rows.find((r) => r.key === "anomaly")!;
    expect(anomaly.status).toBe("ONLINE");
  });

  it("is DEGRADED when the feed window is stale and the agent has no recent payload — payload-bearing agents stay ONLINE", () => {
    // Documented original semantics: payload present in window → ONLINE; otherwise
    // ONLINE only if the feed is fresh (<24h), else DEGRADED.
    const rows = buildAgentRows([dec(NOW - 25 * HOUR, ["quant"])], NOW);
    const quant = rows.find((r) => r.key === "quant")!;
    const anomaly = rows.find((r) => r.key === "anomaly")!;
    expect(quant.status).toBe("ONLINE");
    expect(anomaly.status).toBe("DEGRADED");
  });

  it("takes engine and latency from the recent decisions", () => {
    const rows = buildAgentRows(
      [dec(NOW - MIN, ["quant"], { snapshotMeta: { fetchMs: 321 } })],
      NOW,
    );
    const quant = rows.find((r) => r.key === "quant")!;
    expect(quant.engine).toBe("heuristic-v1");
    expect(quant.latencyMs).toBe(321);
  });

  it("handles null agents payloads without crashing", () => {
    const rows = buildAgentRows([{ dataTimestamp: NOW - MIN, agents: null }], NOW);
    expect(rows).toHaveLength(8);
    expect(rows[0].lastRun).toBeNull();
  });
});

describe("feedState", () => {
  it("LIVE under 15 minutes", () => {
    expect(feedState(0)).toBe("LIVE");
    expect(feedState(14 * 60)).toBe("LIVE"); // seconds, not ms
  });

  it("DELAYED between 15 minutes and 6 hours", () => {
    expect(feedState(15 * 60)).toBe("DELAYED");
    expect(feedState(5 * 3600)).toBe("DELAYED");
  });

  it("STALE beyond 6 hours", () => {
    expect(feedState(6 * 3600)).toBe("STALE");
    expect(feedState(48 * 3600)).toBe("STALE");
  });

  it("OFFLINE with no data or an unusable age (never assumed fresh)", () => {
    expect(feedState(null)).toBe("OFFLINE");
    expect(feedState(Number.NaN)).toBe("OFFLINE");
    expect(feedState(Number.POSITIVE_INFINITY)).toBe("OFFLINE");
    expect(feedState(Number.NEGATIVE_INFINITY)).toBe("OFFLINE");
  });

  it("treats small negative age (provider clock skew) as LIVE", () => {
    expect(feedState(-30)).toBe("LIVE");
    // Exactly at the tolerance boundary is still inside it (`< -tolerance` is not).
    expect(feedState(-CLOCK_SKEW_TOLERANCE_SEC)).toBe("LIVE");
  });

  it("never reports a future-dated reading as LIVE", () => {
    // One second beyond the tolerated skew: the timestamp cannot be trusted, and saying
    // "live" here would be a fabricated freshness signal.
    const beyond = -(CLOCK_SKEW_TOLERANCE_SEC + 1);
    expect(feedState(beyond)).toBe("INVALID");
    expect(feedState(-3600)).toBe("INVALID");
    expect(feedState(-48 * 3600)).toBe("INVALID");
  });
});

describe("symbolFreshness", () => {
  it("keeps only the newest fetch per symbol", () => {
    const rows = symbolFreshness(
      [
        { symbol: "BTCUSDT", dataTimestamp: NOW - 10 * MIN, dataSource: "binance" },
        { symbol: "BTCUSDT", dataTimestamp: NOW - 2 * HOUR, dataSource: "binance" },
        { symbol: "EURUSD", dataTimestamp: NOW - 30 * MIN, dataSource: "yahoo" },
      ],
      NOW,
    );
    expect(rows).toHaveLength(2);
    const btc = rows.find((r) => r.symbol === "BTCUSDT")!;
    expect(btc.lastAt).toBe(NOW - 10 * MIN);
    expect(btc.ageSec).toBe(10 * 60);
    expect(btc.source).toBe("binance");
  });

  it("orders newest symbol first", () => {
    const rows = symbolFreshness(
      [
        { symbol: "EURUSD", dataTimestamp: NOW - 30 * MIN },
        { symbol: "BTCUSDT", dataTimestamp: NOW - MIN },
      ],
      NOW,
    );
    expect(rows[0].symbol).toBe("BTCUSDT");
    expect(rows[1].symbol).toBe("EURUSD");
  });

  it("caps the number of rows", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      symbol: `SYM${i}`,
      dataTimestamp: NOW - i * MIN,
    }));
    expect(symbolFreshness(many, NOW, 12)).toHaveLength(12);
  });

  it("defaults missing dataSource to an em dash", () => {
    const rows = symbolFreshness([{ symbol: "X", dataTimestamp: NOW - MIN }], NOW);
    expect(rows[0].source).toBe("—");
  });

  it("flags a future-dated fetch instead of reporting it as perfectly fresh", () => {
    // A row stamped a day in the future used to clamp to ageSec 0 — indistinguishable
    // from the freshest possible data. It must be visible as invalid.
    const rows = symbolFreshness([{ symbol: "BTCUSDT", dataTimestamp: NOW + 24 * HOUR }], NOW);
    expect(rows[0].invalid).toBe(true);
    expect(rows[0].ageSec).toBe(0);

    // Inside the clock-skew tolerance is normal and must stay valid.
    const skewed = symbolFreshness([{ symbol: "ETHUSDT", dataTimestamp: NOW + 30_000 }], NOW);
    expect(skewed[0].invalid).toBe(false);
    expect(skewed[0].ageSec).toBe(0);

    // A well-formed row keeps its numeric age and is not flagged.
    const normal = symbolFreshness([{ symbol: "EURUSD", dataTimestamp: NOW - 5 * MIN }], NOW);
    expect(normal[0].invalid).toBe(false);
    expect(normal[0].ageSec).toBe(5 * 60);
  });
});

describe("providerStatus", () => {
  const decisions = [
    { dataTimestamp: NOW - 2 * MIN, dataSource: "binance" },
    { dataTimestamp: NOW - 60 * MIN, dataSource: "yahoo" },
    { dataTimestamp: NOW - 3 * HOUR, dataSource: "delta" },
  ];

  it("uses only decisions that carry the provider's data", () => {
    const binance = providerStatus({
      name: "BINANCE", markets: "Crypto", source: "binance", symbols: ["BTCUSDT"],
      decisions, events: [], now: NOW,
    });
    const yahoo = providerStatus({
      name: "YAHOO FINANCE", markets: "Forex", source: "yahoo", symbols: ["EURUSD"],
      decisions, events: [], now: NOW,
    });
    expect(binance.lastFetch).toBe(NOW - 2 * MIN);
    expect(binance.state).toBe("LIVE");
    expect(yahoo.lastFetch).toBe(NOW - 60 * MIN);
    expect(yahoo.state).toBe("DELAYED");
  });

  it("reports OFFLINE rather than borrowing another provider's freshness", () => {
    const yahoo = providerStatus({
      name: "YAHOO FINANCE", markets: "Forex", source: "yahoo", symbols: ["EURUSD"],
      decisions: [{ dataTimestamp: NOW - MIN, dataSource: "binance" }], events: [], now: NOW,
    });
    expect(yahoo.lastFetch).toBeNull();
    expect(yahoo.state).toBe("OFFLINE");
  });

  it("counts only provider failures naming that provider's symbols", () => {
    const binance = providerStatus({
      name: "BINANCE", markets: "Crypto", source: "binance", symbols: ["BTCUSDT"],
      decisions,
      events: [
        { code: "PROVIDER_FAILURE", message: "BTCUSDT: timeout" },
        { code: "PROVIDER_FAILURE", message: "EURUSD: timeout" },
        { code: "NEWS_FETCH_FAILED", message: "BTCUSDT: feed" },
      ],
      now: NOW,
    });
    expect(binance.failures).toBe(1);
  });
});

describe("mergeAuditRows", () => {
  const adminRow = {
    at: NOW - MIN,
    actorEmail: "ops@arise.systems",
    action: "Trading halted platform-wide",
    component: "RISK CONTROL",
    prevState: "RUNNING",
    newState: "HALTED",
    result: "SUCCESS",
  };

  it("merges admin and system rows, newest first", () => {
    const out = mergeAuditRows(
      [adminRow],
      [{ level: "ERROR", area: "DATA", code: "PROVIDER_FAILURE", message: "binance timeout", at: NOW }],
    );
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe("SYSTEM");
    expect(out[0].at).toBe(NOW);
    expect(out[1].kind).toBe("ADMIN");
    expect(out[1].actor).toBe("ops@arise.systems");
  });

  it("filters routine INFO events but keeps SYSTEM/BILLING INFO (halt/resume)", () => {
    const out = mergeAuditRows(
      [],
      [
        { level: "INFO", area: "DATA", code: "SNAPSHOT_OK", message: "routine", at: NOW - MIN },
        { level: "INFO", area: "SYSTEM", code: "PLATFORM_HALT", message: "halted", at: NOW },
        { level: "WARN", area: "BILLING", code: "UNKNOWN_CUSTOMER", message: "x", at: NOW - 2 * MIN },
      ],
    );
    expect(out.map((e) => e.action)).toEqual([
      "PLATFORM_HALT: halted",
      "UNKNOWN_CUSTOMER: x",
    ]);
  });

  it("falls back to 'admin' when actorEmail is missing", () => {
    const out = mergeAuditRows([{ ...adminRow, actorEmail: undefined }], []);
    expect(out[0].actor).toBe("admin");
  });

  it("respects the limit after sorting", () => {
    const admins = Array.from({ length: 10 }, (_, i) => ({ ...adminRow, at: NOW - i * MIN }));
    const events = Array.from({ length: 10 }, (_, i) => ({
      level: "ERROR",
      area: "DATA",
      code: "E",
      message: `${i}`,
      at: NOW - 100 * MIN + i * MIN,
    }));
    expect(mergeAuditRows(admins, events, 5)).toHaveLength(5);
    const out = mergeAuditRows(admins, events, 5);
    for (let i = 1; i < out.length; i++) expect(out[i - 1].at).toBeGreaterThanOrEqual(out[i].at);
  });
});
