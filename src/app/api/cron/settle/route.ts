import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

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
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const admin = createAdminClient();

  const [expired, accrued, snapshots] = await Promise.all([
    admin.rpc("expire_day_orders"),
    admin.rpc("accrue_daily_interest"),
    admin.rpc("take_snapshots"),
  ]);

  const errors = [expired.error, accrued.error, snapshots.error].filter(Boolean);
  if (errors.length > 0) {
    return NextResponse.json(
      { ok: false, errors: errors.map((e) => e!.message) },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    expired: expired.data,
    accrued: accrued.data,
    snapshots: snapshots.data,
  });
}
