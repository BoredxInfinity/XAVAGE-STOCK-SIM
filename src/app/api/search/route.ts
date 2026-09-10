import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isTradableUsListing, type YahooSearchHit } from "@/lib/exchanges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Hit {
  symbol: string;
  name: string;
  exchange: string | null;
  asset_type: string;
  is_tradable: boolean;
  is_halted: boolean;
  source: "local" | "yahoo";
}

/**
 * Two-tier ticker search.
 *   1. The local `instruments` table (indexed, trigram, instant).
 *   2. Yahoo's own search endpoint when the local hits are thin — so a
 *      participant can find any real listed symbol, not just the seeded ones.
 *
 * Anything resolved from Yahoo is inserted into `instruments`, which is what
 * makes the price worker start polling it on its next cycle.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (q.length < 1) return NextResponse.json({ results: [] });

  const term = q.slice(0, 40);

  const { data: local } = await supabase
    .from("instruments")
    .select("symbol, name, exchange, asset_type, is_tradable, is_halted")
    .or(`symbol.ilike.${term}%,name.ilike.%${term}%`)
    .order("is_tradable", { ascending: false })
    .limit(12);

  const results: Hit[] = (local ?? []).map((r) => ({ ...r, source: "local" as const }));

  // Exact-symbol match already found -> no need to reach out to Yahoo.
  const exact = results.some((r) => r.symbol === term.toUpperCase());

  if (!exact && results.length < 8) {
    try {
      const upstream = await fetch(
        `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(term)}&quotesCount=10&newsCount=0`,
        {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; XavageSim/1.0)" },
          signal: AbortSignal.timeout(3500),
          next: { revalidate: 3600 },
        },
      );

      if (upstream.ok) {
        const payload = (await upstream.json()) as { quotes?: YahooSearchHit[] };

        const known = new Set(results.map((r) => r.symbol));
        const fresh = (payload.quotes ?? [])
          // US-listed equities and ETFs only -- no foreign cross-listings
          .filter((h) => isTradableUsListing(h) && !known.has(h.symbol!.toUpperCase()))
          .map((h) => ({
            symbol: h.symbol!.toUpperCase(),
            name: h.longname ?? h.shortname ?? h.symbol!.toUpperCase(),
            exchange: h.exchDisp ?? null,
            asset_type: (h.quoteType ?? "EQUITY").toUpperCase(),
          }));

        if (fresh.length > 0) {
          // Register them so the worker begins quoting them. Requires service
          // role because `instruments` is read-only to clients under RLS.
          const admin = createAdminClient();
          await admin.from("instruments").upsert(
            fresh.map((f) => ({ ...f, is_tradable: true, is_halted: false })),
            { onConflict: "symbol", ignoreDuplicates: true },
          );

          results.push(...fresh.map((f) => ({
            ...f, is_tradable: true, is_halted: false, source: "yahoo" as const,
          })));
        }
      }
    } catch {
      // Yahoo unreachable or slow -- local results are still perfectly usable.
    }
  }

  return NextResponse.json({ results: results.slice(0, 15) });
}
