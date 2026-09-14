import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness for an external uptime monitor.
 *
 * Deliberately unauthenticated and deliberately boring: it exposes no team,
 * user or price data, only whether the machinery is turning. That is what lets
 * a free monitor (UptimeRobot, Betterstack) poll it every minute and page
 * someone -- which is the actual fallback for the price worker dying, because
 * `vercel.json` can only schedule /api/cron/tick once a day on the Hobby plan.
 *
 * The thing being judged is the newest QUOTE, not `system_state.last_tick_at`.
 * The worker heartbeats every cycle whether or not Yahoo answered, so a tick
 * timestamp stays fresh straight through a feed outage; the age of the newest
 * quote is what actually goes stale when prices stop moving.
 *
 * Returns 503 when the market should be open and prices are not advancing, so
 * a monitor's plain "is it 200?" check is enough -- no custom parsing needed.
 *
 * Reads the tables rather than get_market_status() because that RPC is granted
 * to `authenticated`, not `service_role`.
 */
export async function GET() {
  const admin = createAdminClient();

  const [quote, state, settings] = await Promise.all([
    admin.from("quotes")
      .select("quote_time, market_state")
      .order("quote_time", { ascending: false })
      .limit(1).maybeSingle(),
    admin.from("system_state")
      .select("last_tick_at, last_tick_source").eq("id", true).maybeSingle(),
    admin.from("game_settings")
      .select("trading_enabled, price_staleness_seconds, worker_mode_override")
      .eq("id", true).maybeSingle(),
  ]);

  if (quote.error || state.error || settings.error) {
    return NextResponse.json(
      { ok: false, reason: "database unreachable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const now = Date.now();
  const ageSec = (iso: string | null | undefined) =>
    iso == null ? null : Math.round((now - new Date(iso).getTime()) / 1000);

  const quoteAge = ageSec(quote.data?.quote_time);
  const tickAge = ageSec(state.data?.last_tick_at);

  // Same rule the engine uses: fills happen in the regular session, or when an
  // organiser has deliberately opened the book.
  const override = settings.data?.worker_mode_override ?? null;
  const isOpen =
    quote.data?.market_state === "regular" ||
    override === "regular" || override === "live";

  // Only assert freshness when the book is actually open. Out of hours the
  // worker idles on purpose and a quote hours old is correct, not a fault --
  // paging someone at 3am for that is how a monitor gets muted before the
  // morning it matters.
  const budget = Math.max((settings.data?.price_staleness_seconds ?? 60) * 3, 180);
  const stale = isOpen && (quoteAge == null || quoteAge > budget);

  return NextResponse.json(
    {
      ok: !stale,
      market_state: quote.data?.market_state ?? "unknown",
      is_open: isOpen,
      trading_enabled: settings.data?.trading_enabled ?? false,
      quote_age_seconds: quoteAge,
      tick_age_seconds: tickAge,
      tick_source: state.data?.last_tick_source ?? null,
      budget_seconds: budget,
      reason: stale
        ? `market open but newest quote is ${quoteAge ?? "absent"}s old (budget ${budget}s)`
        : null,
    },
    { status: stale ? 503 : 200, headers: { "Cache-Control": "no-store" } },
  );
}
