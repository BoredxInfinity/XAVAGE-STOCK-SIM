import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchQuotes } from "@/lib/yahoo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Vercel cron sends `Authorization: Bearer $CRON_SECRET`. */
function authorised(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

/**
 * Fallback price tick + matching pass, once a minute.
 *
 * The Python worker is the primary feed (5s cadence). This route exists so the
 * competition degrades to "one-minute prices" rather than "frozen market" if
 * that worker stops. It is idempotent: match_orders() takes an advisory lock,
 * so overlapping runs are a no-op rather than a double-fill.
 */
export async function GET(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const admin = createAdminClient();

  // If the worker ticked recently, don't duplicate its work -- just match.
  const { data: state } = await admin
    .from("system_state").select("last_tick_at, last_tick_source").eq("id", true).maybeSingle();

  const workerFresh =
    state?.last_tick_at != null &&
    state.last_tick_source === "worker" &&
    Date.now() - new Date(state.last_tick_at).getTime() < 45_000;

  let refreshed = 0;

  if (!workerFresh) {
    const { data: instruments } = await admin
      .from("instruments").select("symbol").eq("is_tradable", true).limit(250);

    const symbols = (instruments ?? []).map((i) => i.symbol);

    if (symbols.length > 0) {
      const quotes = await fetchQuotes(symbols, { concurrency: 10, deadlineMs: 25_000 });

      if (quotes.length > 0) {
        const { error } = await admin.from("quotes").upsert(
          quotes.map((q) => ({ ...q, updated_at: new Date().toISOString() })),
          { onConflict: "symbol" },
        );
        if (!error) refreshed = quotes.length;
      }
    }

    await admin.from("system_state")
      .update({ last_tick_at: new Date().toISOString(), last_tick_source: "vercel-cron" })
      .eq("id", true);
  }

  const { data: matched, error: matchError } = await admin.rpc("match_orders");
  if (matchError) {
    return NextResponse.json(
      { ok: false, refreshed, error: matchError.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    source: workerFresh ? "worker-fresh (matched only)" : "vercel-cron",
    refreshed,
    matched,
  });
}
