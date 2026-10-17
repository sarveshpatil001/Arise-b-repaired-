// ARISE client data hooks. Convex is reactive — no duplicate client state.

import { api } from "@/convex/_generated/api";
import { useAction, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useState } from "react";

export interface SymbolMetaClient {
  symbol: string;
  name: string;
  assetClass: "crypto" | "forex";
}

export function useEnsureAccount() {
  const [ensured, setEnsured] = useState(false);
  const create = useMutation(api.arise.trading.createAccount);

  useEffect(() => {
    if (ensured) return;
    create()
      .then(() => setEnsured(true))
      .catch(() => {
        // retry on next mount; account may already exist (race)
        setEnsured(true);
      });
  }, [create, ensured]);

  return ensured;
}

export function useRunDecision() {
  const decide = useAction(api.arise.market.decide);
  return useCallback(
    async (args: { symbol: string; interval: string; execute: boolean }) => {
      return decide(args);
    },
    [decide],
  );
}

export function useAccount() {
  const account = useQuery(api.arise.trading.myAccount, {});
  return account;
}

export function useOpenPositions() {
  return useQuery(api.arise.trading.openPositions, {}) ?? [];
}

export function useClosedPositions() {
  return useQuery(api.arise.trading.closedPositions, { limit: 100 });
}

export function useLatestDecision(symbol?: string) {
  return useQuery(api.arise.decisions.latest, symbol ? { symbol } : {});
}

export function useDecisionList(limit = 40) {
  return useQuery(api.arise.decisions.list, { limit });
}

export function useSystemEvents(limit = 50) {
  return useQuery(api.arise.system.list, { limit });
}

// ---------------- Analysis section ----------------

export function useAnalysisHistory(limit = 60) {
  return useQuery(api.arise.analysis.history, { limit });
}

export function useLatestAnalysisRecord(symbol?: string) {
  return useQuery(api.arise.analysis.latest, symbol ? { symbol } : {});
}

export function useAnalysisMonitoring(symbol?: string) {
  return useQuery(api.arise.analysis.monitoring, symbol ? { symbol } : {});
}

export function useAnalysisPerformance() {
  return useQuery(api.arise.analysis.performance, {});
}

export function useAnalysisHealth() {
  return useQuery(api.arise.analysis.health, {});
}

export function useSaveAnalysis() {
  return useMutation(api.arise.analysis.save);
}

export function useRunStrategyArena() {
  return useAction(api.arise.analysis.strategyArena);
}

export function useFetchCatalysts() {
  return useAction(api.arise.analysis.catalysts);
}

export function useEntitlements() {
  return useQuery(api.arise.billingFunctions.myEntitlements, {});
}

export function usePlans() {
  return useQuery(api.arise.billingFunctions.listPlans, {});
}

export function useSymbols(): SymbolMetaClient[] {
  // Mirrors listSymbols() from lib/arise/providers — kept client-side to avoid
  // an extra action round-trip; the backend remains the validator of symbols.
  return [
    { symbol: "BTCUSDT", name: "Bitcoin", assetClass: "crypto" },
    { symbol: "ETHUSDT", name: "Ethereum", assetClass: "crypto" },
    { symbol: "SOLUSDT", name: "Solana", assetClass: "crypto" },
    { symbol: "BNBUSDT", name: "BNB", assetClass: "crypto" },
    { symbol: "XRPUSDT", name: "XRP", assetClass: "crypto" },
    { symbol: "EURUSD", name: "Euro / US Dollar", assetClass: "forex" },
    { symbol: "GBPUSD", name: "Pound / US Dollar", assetClass: "forex" },
    { symbol: "USDJPY", name: "Dollar / Yen", assetClass: "forex" },
    { symbol: "AUDUSD", name: "Aussie / US Dollar", assetClass: "forex" },
  ];
}
