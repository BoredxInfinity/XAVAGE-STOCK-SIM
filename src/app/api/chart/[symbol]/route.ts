import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Three ranges only. A five-week competition has no use for a 1Y chart, and
// dropping it means the worker no longer maintains a year of daily bars per
// symbol -- which is what makes a fast history refresh affordable.
const RANGES: Record<string, { interval: string; days: number }> = {
  "1D": { interval: "1m", days: 1 },
  "5D": { interval: "5m", days: 5 },
  "1M": { interval: "1d", days: 31 },
};

/** OHLCV bars for the chart, served from the local price_bars table. */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ symbol: string }> },
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { symbol } = await ctx.params;
  const rangeKey = (new URL(request.url).searchParams.get("range") ?? "1D").toUpperCase();
  const range = RANGES[rangeKey] ?? RANGES["1D"];

  const since = new Date(Date.now() - range.days * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from("price_bars")
    .select("ts, o, h, l, c, v")
    .eq("symbol", symbol.toUpperCase())
    .eq("interval", range.interval)
    .gte("ts", since)
    .order("ts", { ascending: true })
    .limit(1500);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    symbol: symbol.toUpperCase(),
    range: rangeKey,
    interval: range.interval,
    bars: (data ?? []).map((b) => ({
      time: Math.floor(new Date(b.ts).getTime() / 1000),
      open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c),
      volume: Number(b.v),
    })),
  });
}
