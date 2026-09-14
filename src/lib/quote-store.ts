import type { LiveQuote } from "@/lib/database.types";

type Listener = () => void;

export interface QuoteSnapshot extends LiveQuote {
  /** Direction of the most recent price change — drives the row flash. */
  tick: "up" | "down" | "flat";
  /**
   * Increments on every accepted update.
   *
   * `tick` alone cannot drive the flash: a symbol ticking up repeatedly keeps
   * tick === "up", so the className never changes, so the browser never
   * restarts a non-infinite CSS animation — a trending stock flashed green
   * exactly once and then looked frozen. `seq` gives `flashClass` something
   * that changes every tick to alternate the animation name on.
   */
  seq: number;
}

/**
 * External store for live quotes.
 *
 * Components subscribe per-symbol via useSyncExternalStore, so a tick in AAPL
 * re-renders only the components watching AAPL — not the entire tree. With ~100
 * symbols updating every few seconds that is the difference between a smooth
 * terminal and a janky one.
 */
class QuoteStore {
  private quotes = new Map<string, QuoteSnapshot>();
  private perSymbol = new Map<string, Set<Listener>>();
  private global = new Set<Listener>();
  private version = 0;

  getVersion = () => this.version;

  get(symbol: string): QuoteSnapshot | undefined {
    return this.quotes.get(symbol);
  }

  getAll(): QuoteSnapshot[] {
    return [...this.quotes.values()];
  }

  upsert(next: LiveQuote) {
    const prev = this.quotes.get(next.symbol);
    const price = Number(next.price);

    if (prev && Number(prev.price) === price && prev.quote_time === next.quote_time) return;

    const tick: QuoteSnapshot["tick"] =
      !prev || Number(prev.price) === price ? "flat" : price > Number(prev.price) ? "up" : "down";

    this.quotes.set(next.symbol, { ...next, price, tick, seq: (prev?.seq ?? 0) + 1 });
    this.version++;
    this.perSymbol.get(next.symbol)?.forEach((fn) => fn());
    this.global.forEach((fn) => fn());
  }

  upsertMany(list: LiveQuote[]) {
    let changed = false;
    for (const q of list) {
      const prev = this.quotes.get(q.symbol);
      const price = Number(q.price);
      if (prev && Number(prev.price) === price && prev.quote_time === q.quote_time) continue;

      const tick: QuoteSnapshot["tick"] =
        !prev || Number(prev.price) === price ? "flat" : price > Number(prev.price) ? "up" : "down";

      this.quotes.set(q.symbol, { ...q, price, tick, seq: (prev?.seq ?? 0) + 1 });
      this.perSymbol.get(q.symbol)?.forEach((fn) => fn());
      changed = true;
    }
    if (changed) {
      this.version++;
      this.global.forEach((fn) => fn());
    }
  }

  subscribe(symbol: string, fn: Listener) {
    let set = this.perSymbol.get(symbol);
    if (!set) {
      set = new Set();
      this.perSymbol.set(symbol, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.perSymbol.delete(symbol);
    };
  }

  subscribeAll(fn: Listener) {
    this.global.add(fn);
    return () => { this.global.delete(fn); };
  }
}

export const quoteStore = new QuoteStore();


/**
 * Row-flash class for a quote.
 *
 * Alternates between two class names that carry the SAME keyframes. CSS only
 * restarts an animation when the animation-name changes, so flipping a/b on
 * each tick is what makes consecutive up-ticks flash repeatedly instead of
 * once. Doing it this way rather than with a React `key` matters: a changing
 * key would remount the row on every tick.
 */
export function flashClass(q: { tick: QuoteSnapshot["tick"]; seq?: number } | null | undefined): string {
  if (!q || q.tick === "flat") return "";
  const phase = (q.seq ?? 0) % 2 === 0 ? "a" : "b";
  return `flash-${q.tick}-${phase}`;
}
