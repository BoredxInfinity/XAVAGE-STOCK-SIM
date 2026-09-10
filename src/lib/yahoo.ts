/**
 * Minimal Yahoo Finance reader for the Vercel cron fallback.
 * The Python worker (yfinance) is the primary feed; this exists so the game
 * keeps moving if that worker dies mid-competition.
 *
 * Uses the /v8/finance/chart endpoint, which needs no crumb/cookie.
 */

export type MarketState = "pre" | "regular" | "post" | "closed";

export interface YahooQuote {
  symbol: string;
  price: number;
  prev_close: number | null;
  day_open: number | null;
  day_high: number | null;
  day_low: number | null;
  volume: number | null;
  market_state: MarketState;
  quote_time: string;
}

const UA = "Mozilla/5.0 (compatible; XavageSim/1.0)";

function normaliseState(raw: string | undefined): MarketState {
  switch ((raw ?? "").toUpperCase()) {
    case "REGULAR": return "regular";
    case "PRE": return "pre";
    case "POST":
    case "POSTPOST": return "post";
    default: return "closed";
  }
}

export async function fetchQuote(symbol: string, timeoutMs = 4000): Promise<YahooQuote | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" },
    );
    if (!res.ok) return null;

    const json = (await res.json()) as {
      chart?: { result?: Array<{ meta?: Record<string, unknown> }> };
    };
    const meta = json.chart?.result?.[0]?.meta;
    if (!meta) return null;

    const price = Number(meta.regularMarketPrice);
    if (!Number.isFinite(price) || price <= 0) return null;

    const asNum = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    return {
      symbol: symbol.toUpperCase(),
      price,
      prev_close: asNum(meta.chartPreviousClose ?? meta.previousClose),
      day_open: asNum(meta.regularMarketDayOpen ?? meta.open),
      day_high: asNum(meta.regularMarketDayHigh),
      day_low: asNum(meta.regularMarketDayLow),
      volume: asNum(meta.regularMarketVolume),
      market_state: normaliseState(meta.marketState as string | undefined),
      quote_time: new Date(
        Number(meta.regularMarketTime) > 0 ? Number(meta.regularMarketTime) * 1000 : Date.now(),
      ).toISOString(),
    };
  } catch {
    return null;
  }
}

/** Bounded-concurrency fetch so we neither hammer Yahoo nor blow the cron's time budget. */
export async function fetchQuotes(
  symbols: string[],
  opts: { concurrency?: number; deadlineMs?: number } = {},
): Promise<YahooQuote[]> {
  const { concurrency = 8, deadlineMs = 20_000 } = opts;
  const started = Date.now();
  const out: YahooQuote[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < symbols.length && Date.now() - started < deadlineMs) {
      const symbol = symbols[cursor++];
      const quote = await fetchQuote(symbol);
      if (quote) out.push(quote);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));
  return out;
}
