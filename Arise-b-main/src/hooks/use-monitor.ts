// Client hook for the background position monitor status.
// Trades surfaces the public (active-user) view; the platform-wide run history on
// monitor.adminStatus is administrator-only.
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export interface MonitorStatus {
  state: string; // HEALTHY | DEGRADED | OFFLINE
  detail: string;
  lastTickAt: number | null;
  lastRun: { at: number; evaluated: number; closed: number; skipped: number; ok: boolean; details?: string } | null;
  recentTicks: { at: number; evaluated: number; closed: number; skipped: number; ok: boolean }[];
  runningNow: boolean;
  openPositions: number | null;
  schedule: string;
}

export function useMonitorStatus() {
  return useQuery(api.arise.monitor.publicStatus, {}) as MonitorStatus | undefined;
}
