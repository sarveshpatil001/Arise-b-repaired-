import { useSyncExternalStore } from "react";

const TICK_MS = 15_000;

let nowMs = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function tick() {
  nowMs = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === null) timer = setInterval(tick, TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot() {
  return nowMs;
}

/** Current epoch milliseconds, refreshed on an interval from a shared clock store.
 *  Reads the clock during render, so it is exposed as external state instead of an
 *  impure `Date.now()` call inside a component. */
export function useNowMs(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
