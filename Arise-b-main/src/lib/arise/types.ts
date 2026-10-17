// ARISE V1 — core domain types.
// All market data is normalized into these structures regardless of provider.

export type AssetClass = "crypto" | "forex";
export type Direction = "LONG" | "SHORT" | "FLAT";

export type DataQuality = "valid" | "degraded" | "stale" | "invalid";

export interface Bar {
  symbol: string;
  assetClass: AssetClass;
  interval: string;
  time: number; // ms epoch UTC — the ONLY clock ARISE uses internally
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
  quality: DataQuality;
}

export interface MarketSnapshot {
  symbol: string;
  assetClass: AssetClass;
  interval: string;
  bars: Bar[];
  latest: Bar;
  quoteAgeSec: number;
  bestBid: number | null;
  bestAsk: number | null;
  spreadPct: number | null;
  source: string;
  quality: DataQuality;
  qualityNotes: string[];
}

export interface QuantFeatures {
  symbol: string;
  interval: string;
  dataQuality: DataQuality;
  barCount: number;
  trend: {
    slopePerBarPct: number;
    ema20: number;
    ema50: number;
    emaStructure: "BULLISH" | "BEARISH" | "FLAT";
    sma20: number;
    distFromSma20Pct: number;
    distFromSma20Sigma: number;
    adx: number;
    trendStrength: "STRONG" | "MODERATE" | "WEAK";
  };
  momentum: {
    roc10Pct: number;
    roc3Pct: number;
    rsi14: number;
    rsiState: "OVERSOLD" | "OVERBOUGHT" | "NEUTRAL";
    macd: number;
    macdSignal: number;
    macdHist: number;
    momentumScore: number; // -1..1
  };
  volatility: {
    realizedVolPct: number;
    atr14: number;
    atrPct: number;
    volPercentile: number;
    volRegime: "LOW" | "NORMAL" | "HIGH" | "EXTREME";
  };
  statistics: {
    zScore20: number;
    rollingMean20: number;
    rollingStd20: number;
    rangePositionPct: number;
    autocorr1: number;
    retStd: number;
  };
  liquidity: {
    volumeZ: number;
    spreadPct: number | null;
    notionalPerBar: number;
    liquidityState: "HIGH" | "MEDIUM" | "LOW";
  };
  confidence: number;
}

// ---------- Agent layer ----------

export type AgentId =
  | "quant_ai"
  | "technical_ai"
  | "regime_ai"
  | "anomaly_ai"
  | "portfolio_ai"
  | "risk_ai"
  | "news_ai";

export type AgentSignal = "LONG" | "SHORT" | "NEUTRAL" | "RISK_FLAG" | "CAUTION";

export type MarketRegime =
  | "TRENDING_UP"
  | "TRENDING_DOWN"
  | "RANGE"
  | "HIGH_VOLATILITY"
  | "LOW_VOLATILITY"
  | "UNCERTAIN";

export type ManipulationLevel = "NORMAL" | "WATCH" | "ELEVATED" | "HIGH_RISK";

export interface AgentAnalysis {
  agent: AgentId;
  signal: AgentSignal;
  regime?: MarketRegime;
  manipulationLevel?: ManipulationLevel;
  confidence: number; // 0..1 — confidence in the analytical conclusion given available evidence
  summary: string;
  evidence: string[];
  risks: string[];
  invalidation: string[];
  dataQuality: DataQuality;
  dataTimestamp: number;
  modelVersion: string; // deterministic heuristics engine "v1" — no external LLM in V1 core loop
}

// ---------- MIND ----------

export interface MindDebatePoint {
  topic: string;
  agents: { agent: AgentId; position: string; confidence: number }[];
  resolution: string;
}

export interface MindDecision {
  direction: Direction;
  confidence: number;
  thesis: string;
  supportingEvidence: string[];
  contradictingEvidence: string[];
  keyRisks: string[];
  invalidationConditions: string[];
  recommendedAction: "TRADE" | "WAIT" | "REDUCE";
  positionSizeRecommendation: number; // 0..1 fraction of max allowed
  agreementPct: number;
  debate: MindDebatePoint[];
  dataTimestamp: number;
  mindVersion: string;
}

export interface TradePlan {
  side: "LONG" | "SHORT";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  positionSize: number;
  positionSizeQuote: number;
  riskPerUnit: number;
  maxLossQuote: number;
  maxLossPct: number;
}

// ---------- Risk engine ----------

export type RiskDecisionKind = "APPROVED" | "REDUCED" | "VETOED" | "NO_TRADE";

export interface RiskCheck {
  rule: string;
  pass: boolean;
  detail: string;
}

export interface RiskDecision {
  decision: RiskDecisionKind;
  reasonCode: string;
  message: string;
  checks: RiskCheck[];
  approvedPositionSize: number;
  timestamp: number;
  engineVersion: string;
}

// ---------- Execution ----------

export type OrderStatus =
  | "CREATED"
  | "VALIDATING"
  | "APPROVED"
  | "SUBMITTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "REJECTED"
  | "CANCELLED"
  | "FAILED";

export interface FillResult {
  filledQty: number;
  fillPrice: number;
  fee: number;
  slippageBps: number;
  status: OrderStatus;
}

export interface ClosedTrade {
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnlQuote: number;
  feesTotal: number;
  openedAt: number;
  closedAt: number;
  exitReason: string;
}
