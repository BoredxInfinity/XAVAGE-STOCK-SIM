import type { Quote } from "@/lib/database.types";

type Listener = () => void;

export interface QuoteSnapshot extends Quote {
  /** Direction of the most recent price change — drives the row flash. */
  tick: "up" | "down" | "flat";
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

  upsert(next: Quote) {
    const prev = this.quotes.get(next.symbol);
    const price = Number(next.price);

    if (prev && Number(prev.price) === price && prev.quote_time === next.quote_time) return;

    const tick: QuoteSnapshot["tick"] =
      !prev || Number(prev.price) === price ? "flat" : price > Number(prev.price) ? "up" : "down";

    this.quotes.set(next.symbol, { ...next, price, tick });
    this.version++;
    this.perSymbol.get(next.symbol)?.forEach((fn) => fn());
    this.global.forEach((fn) => fn());
  }

  upsertMany(list: Quote[]) {
    let changed = false;
    for (const q of list) {
      const prev = this.quotes.get(q.symbol);
      const price = Number(q.price);
      if (prev && Number(prev.price) === price && prev.quote_time === q.quote_time) continue;

      const tick: QuoteSnapshot["tick"] =
        !prev || Number(prev.price) === price ? "flat" : price > Number(prev.price) ? "up" : "down";

      this.quotes.set(q.symbol, { ...q, price, tick });
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
