import type { Id } from "../../convex/_generated/dataModel";
import type { MutationCtx } from "../../convex/_generated/server";
import { DEFAULT_CONFIG } from "./config";
import { closeAmounts, markedEquity, prepareLedgerAccount, type Mark, type MarkedEquity } from "./ledger";
import { PAPER_TAKER_FEE_BPS } from "./execution";
import { createFreshnessPolicy } from "./freshness";

export type SettlementMark = Mark;

export interface SettleCloseResult {
  applied: boolean;
  reason?: string;
  exitReason?: string;
  pnl?: number;
  complete?: boolean;
  deferred?: boolean;
  usedFallback?: string[];
  marked?: MarkedEquity;
}

/** One idempotent close implementation shared by all paper-trade exit paths. */
export async function settleClose(
  db: MutationCtx["db"],
  args: {
    positionId: Id<"positions">;
    exitPrice: number;
    reason: string;
    now: number;
    marks?: Record<string, SettlementMark>;
    barStaleMultiplier?: number;
  },
): Promise<SettleCloseResult> {
  const position = await db.get(args.positionId);
  if (!position) return { applied: false, reason: "NOT_FOUND" };
  if (position.status !== "OPEN") return { applied: false, reason: "ALREADY_CLOSED" };
  if (!(args.exitPrice > 0) || !Number.isFinite(args.exitPrice)) {
    throw new Error("Invalid exit price");
  }

  const exitFee = (args.exitPrice * position.qty * PAPER_TAKER_FEE_BPS) / 10_000;
  const amounts = closeAmounts({
    side: position.side as "LONG" | "SHORT",
    entry: position.entryPrice,
    exit: args.exitPrice,
    qty: position.qty,
    entryFee: position.entryFee,
    exitFee,
  });
  const account = await db
    .query("paperAccounts")
    .withIndex("userId", (q) => q.eq("userId", position.userId))
    .first();
  if (!account) throw new Error("Paper account unavailable during settlement");

  await db.patch(position._id, {
    status: "CLOSED",
    closedAt: args.now,
    exitPrice: args.exitPrice,
    exitReason: args.reason,
    pnl: amounts.netPnl,
    exitFee,
  });

  const balance = account.balance + amounts.balanceDelta;
  const remaining = await db
    .query("positions")
    .withIndex("userId_status", (q) => q.eq("userId", position.userId).eq("status", "OPEN"))
    .collect();
  const marks = args.marks ?? {};
  const marked = markedEquity(balance, remaining, marks, {
    now: args.now,
    policy: createFreshnessPolicy(args.barStaleMultiplier ?? DEFAULT_CONFIG.barStaleMultiplier),
  });
  const accountUpdate = prepareLedgerAccount(
    { ...account, balance },
    marked,
    args.now,
  );
  await db.patch(account._id, {
    balance,
    ...(marked.complete
      ? {
          dayKey: accountUpdate.dayKey,
          dayStartEquity: accountUpdate.dayStartEquity,
          equityHighWaterMark: accountUpdate.equityHighWaterMark,
        }
      : {}),
  });

  return {
    applied: true,
    exitReason: args.reason,
    pnl: amounts.netPnl,
    complete: marked.complete,
    deferred: !marked.complete,
    usedFallback: marked.usedFallback,
    marked,
  };
}
