import { closePnl } from "./execution";
import { isFresh, type FreshnessPolicy } from "./freshness";

export interface LedgerTrade {
  side: "LONG" | "SHORT";
  entry: number;
  exit: number;
  qty: number;
  entryFee: number;
  exitFee: number;
}

export interface LedgerPosition {
  symbol: string;
  side: string;
  qty: number;
  entryPrice: number;
}

export interface Mark {
  symbol: string;
  price: number;
  time: number;
  interval: string;
  completed: boolean;
}

export interface MarkedEquity {
  equity: number;
  usedFallback: string[];
  complete: boolean;
}

export interface LedgerAccount {
  balance: number;
  dayKey: string;
  dayStartEquity: number;
  equityHighWaterMark: number;
}

export function applyOpen(balance: number, entryFee: number): number {
  return balance - entryFee;
}

export function closeAmounts(trade: LedgerTrade): { gross: number; netPnl: number; balanceDelta: number } {
  const { gross, pnl } = closePnl(
    trade.side,
    trade.entry,
    trade.exit,
    trade.qty,
    trade.entryFee,
    trade.exitFee,
  );
  return { gross, netPnl: pnl, balanceDelta: gross - trade.exitFee };
}

export function unrealizedPnl(side: string, entry: number, mark: number, qty: number): number {
  return (side === "LONG" ? mark - entry : entry - mark) * qty;
}

export function markedEquity(
  balance: number,
  positions: LedgerPosition[],
  marks: Record<string, Mark>,
  options: { now: number; policy: FreshnessPolicy; requiredSymbols?: string[] },
): MarkedEquity {
  const fallbackSymbols = new Set<string>();
  let unrealized = 0;
  for (const position of positions) {
    const mark = marks[position.symbol];
    if (isFresh(mark, options.now, options.policy).fresh) {
      unrealized += unrealizedPnl(position.side, position.entryPrice, mark.price, position.qty);
    } else {
      fallbackSymbols.add(position.symbol);
      unrealized += unrealizedPnl(position.side, position.entryPrice, position.entryPrice, position.qty);
    }
  }
  for (const symbol of options.requiredSymbols ?? []) {
    if (!positions.some((position) => position.symbol === symbol) && !isFresh(marks[symbol], options.now, options.policy).fresh) {
      fallbackSymbols.add(symbol);
    }
  }
  return {
    equity: balance + unrealized,
    usedFallback: [...fallbackSymbols].sort(),
    complete: fallbackSymbols.size === 0,
  };
}

export function rollUtcDay(
  account: Pick<LedgerAccount, "dayKey" | "dayStartEquity">,
  equity: number,
  complete: boolean,
  now: number,
): { dayKey: string; dayStartEquity: number; deferred: boolean } {
  if (!complete) return { ...account, deferred: true };
  const dayKey = new Date(now).toISOString().slice(0, 10);
  return dayKey === account.dayKey
    ? { ...account, deferred: false }
    : { dayKey, dayStartEquity: equity, deferred: false };
}

export function ratchetHwm(hwm: number, equity: number, complete: boolean): number {
  return complete ? Math.max(hwm, equity) : hwm;
}

export function prepareLedgerAccount(
  account: LedgerAccount,
  marked: MarkedEquity,
  now: number,
): LedgerAccount & { deferred: boolean } {
  const day = rollUtcDay(account, marked.equity, marked.complete, now);
  return {
    ...account,
    dayKey: day.dayKey,
    dayStartEquity: day.dayStartEquity,
    equityHighWaterMark: ratchetHwm(account.equityHighWaterMark, marked.equity, marked.complete),
    deferred: day.deferred,
  };
}
