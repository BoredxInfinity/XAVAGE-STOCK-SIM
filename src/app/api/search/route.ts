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

/** At most this many new symbols may be minted by a single search. */
const MAX_REGISTRATIONS_PER_REQUEST = 3;

/**
 * PostgREST's `.or()` takes a RAW filter expression -- supabase-js does not
 * escape it the way it escapes `.eq()`. Interpolating the query string
 * straight in let `?q=x,is_halted.is.true` append a filter clause, let `%`
 * match the entire table, and let an unbalanced paren produce a 500.
 *
 * Dots survive because real tickers contain them (BRK.B); PostgREST splits a
 * filter on its first two dots, so a dot inside the value is harmless.
 */
function sanitiseTerm(raw: string): string {
  return raw.replace(/[^A-Za-z0-9 .&-]/g, "").trim();
}

/**
 * Crude per-user throttle. Each serverless instance keeps its own counters, so
 * this is a speed bump rather than a guarantee -- but this route reaches Yahoo
 * and then writes `instruments` with the service-role key, and an unthrottled
 * keystroke-per-request path to both of those is worth slowing down. The map
 * is bounded by eviction so a long-lived instance cannot grow it without end.
 */
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 20;
const hits = new Map<string, number[]>();

function allowRequest(userId: string): boolean {
  const now = Date.now();
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(userId, recent);

  if (hits.size > 500) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(key);
    }
  }
  return recent.length <= RATE_MAX;
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  // src/middleware.ts deliberately excludes /api, so this route is where an
  // account being switched off actually has to be noticed. Without it a
  // deactivated participant keeps the service-role registration path below for
  // as long as their cookie lives.
  const { data: profile } = await supabase
    .from("profiles").select("is_active").eq("id", user.id).maybeSingle();
  if (!profile?.is_active) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!allowRequest(user.id)) {
    return NextResponse.json({ error: "Too many searches. Slow down." }, { status: 429 });
  }

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (q.length < 1) return NextResponse.json({ results: [] });

  const term = sanitiseTerm(q.slice(0, 40));
  if (!term) return NextResponse.json({ results: [] });

  // tradable_instruments, not instruments: past the symbol cap the worker
  // quotes nothing, so offering the symbol here would be offering a price we
  // do not have. Beyond the cap a symbol simply does not exist to participants.
  const { data: local } = await supabase
    .from("tradable_instruments")
    .select("symbol, name, exchange, asset_type, is_tradable, is_halted")
    .or(`symbol.ilike.${term}%,name.ilike.%${term}%`)   // term is sanitised above
    .order("symbol")
    .limit(12);

  const results: Hit[] = (local ?? []).map((r) => ({ ...r, source: "local" as const }));

  // Exact-symbol match already found -> no need to reach out to Yahoo.
  const exact = results.some((r) => r.symbol === term.toUpperCase());

  // Room left in the universe. Resolving a symbol through Yahoo REGISTERS it,
  // which is what makes the worker start quoting it -- so once the cap is
  // reached, reaching out at all would only mint symbols nobody can be given
  // a price for.
  const capacity = await remainingCapacity();

  if (!exact && results.length < 8 && capacity > 0) {
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

        // Never register more than the universe has room for -- and never more
        // than a handful per request. `capacity` was read before the Yahoo
        // round trip, so concurrent searches each see the same room and can
        // collectively overshoot it; bounding the per-request slice turns a
        // potential overshoot of `capacity x concurrency` into `3 x
        // concurrency`, which the cap check on the next request absorbs.
        fresh.length = Math.min(fresh.length, capacity, MAX_REGISTRATIONS_PER_REQUEST);

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

/**
 * How many more instruments may be registered before the worker stops
 * quoting them. Service role because `game_settings` is not readable by
 * participants and the count must be of the whole table, not the capped view.
 */
async function remainingCapacity(): Promise<number> {
  try {
    const admin = createAdminClient();
    const [{ data: settings }, { count }] = await Promise.all([
      admin.from("game_settings").select("worker_max_symbols").eq("id", true).single(),
      admin.from("instruments").select("symbol", { count: "exact", head: true })
        .eq("is_tradable", true),
    ]);
    const cap = settings?.worker_max_symbols ?? null;
    if (cap == null) return Number.MAX_SAFE_INTEGER;   // no opinion set -> worker's own default governs
    return Math.max(0, cap - (count ?? 0));
  } catch {
    // Treat an unreadable setting as "no room" rather than risk minting
    // symbols the worker will never quote.
    return 0;
  }
}
