"use client";

import { useCallback, useSyncExternalStore } from "react";
import { quoteStore, type QuoteSnapshot } from "@/lib/quote-store";

/** Live quote for one symbol. Re-renders only when THAT symbol ticks. */
export function useQuote(symbol: string | null | undefined): QuoteSnapshot | undefined {
  const subscribe = useCallback(
    (fn: () => void) => (symbol ? quoteStore.subscribe(symbol, fn) : () => {}),
    [symbol],
  );
  const get = useCallback(() => (symbol ? quoteStore.get(symbol) : undefined), [symbol]);
  return useSyncExternalStore(subscribe, get, () => undefined);
}

/** Store-wide version counter — for components that render many symbols at once. */
export function useQuotesVersion(): number {
  return useSyncExternalStore(
    useCallback((fn: () => void) => quoteStore.subscribeAll(fn), []),
    useCallback(() => quoteStore.getVersion(), []),
    () => 0,
  );
}
