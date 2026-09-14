import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { timingSafeEqual } from "node:crypto";

/**
 * Vercel cron sends `Authorization: Bearer $CRON_SECRET`.
 *
 * Fails closed when the variable is unset: an unconfigured deployment must not
 * leave settlement and matching open to the internet. Compared in constant
 * time -- not because a timing oracle over HTTP is practical against a 32-byte
 * secret, but because it costs nothing and this is the only thing standing in
 * front of accrue_daily_interest.
 */
function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}


export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * End-of-day settlement, weekdays shortly after the US close.
 *   1. expire unfilled DAY orders (GTC orders survive)
 *   2. accrue interest / margin / borrow fees -- the economic levers
 *   3. snapshot every team's equity for the ranking curve
 */
export async function GET(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const admin = createAdminClient();

  // Sequential, deliberately. These used to run under Promise.all -- three
  // PostgREST requests, three connections, three concurrent transactions --
  // and accrue_daily_interest locks EVERY team row while expire_day_orders
  // wants team locks of its own. That is a deadlock the settle job inflicted
  // on itself, once per weekday, at the close.
  //
  // Order matters too: expire first so cancelled reservations are released
  // before interest is computed on the resulting cash, then snapshot the
  // settled state.
  const steps = ["expire_day_orders", "accrue_daily_interest", "take_snapshots"] as const;
  const results: Record<string, unknown> = {};

  for (const step of steps) {
    const { data, error } = await admin.rpc(step);
    if (error) {
      // Report which step failed and what had already completed -- a partial
      // settlement needs a human, and "which half" is the first question.
      return NextResponse.json(
        { ok: false, failedAt: step, error: error.message, completed: results },
        { status: 500 },
      );
    }
    results[step] = data;
  }

  return NextResponse.json({
    ok: true,
    expired: results.expire_day_orders,
    accrued: results.accrue_daily_interest,
    snapshots: results.take_snapshots,
  });
}
