/**
 * US exchanges we accept into the tradable universe.
 *
 * Yahoo's search happily returns the Vienna, XETRA and São Paulo listings of a
 * US company (LMT, LMT.VI, LOM.DE, LMTB34.SA …). Those are thin, quote in other
 * currencies, and a participant could buy one by accident thinking it was the
 * NYSE line. OTC tiers (OQB/OQX/PNK) are excluded for the same reason —
 * illiquid, and yfinance data for them is unreliable.
 */
const US_EXCHANGE_CODES = new Set([
  "NYQ", // NYSE
  "NMS", // NASDAQ Global Select
  "NGM", // NASDAQ Global Market
  "NCM", // NASDAQ Capital Market
  "ASE", // NYSE American
  "PCX", // NYSE Arca
  "BTS", // Cboe BZX
  "BZX",
]);

/** Plain US ticker: 1–5 letters, optional class suffix (BRK-B, BF-B). */
const US_SYMBOL_RE = /^[A-Z]{1,5}(-[A-Z])?$/;

const TRADABLE_TYPES = new Set(["EQUITY", "ETF"]);

export interface YahooSearchHit {
  symbol?: string;
  shortname?: string;
  longname?: string;
  exchDisp?: string;
  exchange?: string;
  quoteType?: string;
  isYahooFinance?: boolean;
}

/** True when a Yahoo search hit is a US-listed equity or ETF we can trade. */
export function isTradableUsListing(hit: YahooSearchHit): boolean {
  if (!hit.isYahooFinance || !hit.symbol) return false;
  if (!TRADABLE_TYPES.has((hit.quoteType ?? "").toUpperCase())) return false;
  if (!US_SYMBOL_RE.test(hit.symbol.toUpperCase())) return false;
  return US_EXCHANGE_CODES.has((hit.exchange ?? "").toUpperCase());
}

/** Same rule, for a symbol an admin types in by hand. */
export function isUsSymbolFormat(symbol: string): boolean {
  return US_SYMBOL_RE.test(symbol.toUpperCase());
}
