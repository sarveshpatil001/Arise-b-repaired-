// ARISE V1 — validated configuration. Nothing important is hardcoded inline in logic.
// All limits have PRD-aligned safe defaults; every value is clamped to a sane range.

export interface AriseConfig {
  // Capital protection
  startingBalance: number; // paper account starting balance
  riskPerTradePct: number; // % of equity risked per trade
  maxPositionPct: number; // % of equity in a single position
  maxGrossExposurePct: number; // % of equity across positions
  maxDailyLossPct: number; // % of day-start equity
  maxDrawdownPct: number; // % from high-water mark
  maxLeverage: number;
  maxSpreadPct: number; // veto threshold, % between best bid/ask
  /** Documented conservative spread (%) used ONLY where the provider has no quote
   *  book (forex). Reported as estimated, never as observed. */
  estimatedForexSpreadPct: number;
  minLiquidityNotional: number; // min USD notional per bar
  minBars: number; // minimum validated bars to analyze
  staleDataSec: number; // quote age beyond this → stale
  barStaleMultiplier: number; // bar age > multiplier × interval → stale
  aiTimeoutMs: number;
  maxAnomalyLevelForTrade: "NORMAL" | "WATCH";
  defaultSymbol: string;
  defaultInterval: string;
}

export const CONFIG_LIMITS = {
  startingBalance: { min: 100, max: 10_000_000 },
  riskPerTradePct: { min: 0.25, max: 2 },
  maxPositionPct: { min: 1, max: 50 },
  maxGrossExposurePct: { min: 10, max: 200 },
  maxDailyLossPct: { min: 1, max: 20 },
  maxDrawdownPct: { min: 5, max: 50 },
  maxLeverage: { min: 1, max: 10 },
  maxSpreadPct: { min: 0.02, max: 2 },
  estimatedForexSpreadPct: { min: 0.01, max: 0.5 },
  maxLiquidityNotional: { min: 0, max: 50_000_000 },
  minBars: { min: 60, max: 400 },
  staleDataSec: { min: 30, max: 900 },
} as const;

export const DEFAULT_CONFIG: AriseConfig = {
  startingBalance: 10_000,
  riskPerTradePct: 0.5,
  maxPositionPct: 15,
  maxGrossExposurePct: 60,
  maxDailyLossPct: 3,
  maxDrawdownPct: 10,
  maxLeverage: 1,
  maxSpreadPct: 0.15,
  // Conservative: a major FX pair typically quotes tighter than this, so the
  // estimate never flatters the simulated cost.
  estimatedForexSpreadPct: 0.05,
  minLiquidityNotional: 0,
  minBars: 120,
  staleDataSec: 180,
  barStaleMultiplier: 3,
  aiTimeoutMs: 15_000,
  maxAnomalyLevelForTrade: "WATCH",
  defaultSymbol: "BTCUSDT",
  defaultInterval: "1h",
};
