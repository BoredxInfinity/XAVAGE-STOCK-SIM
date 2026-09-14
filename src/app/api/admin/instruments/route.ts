import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, writeAudit } from "@/lib/admin-guard";
import { isUsSymbolFormat } from "@/lib/exchanges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Patch = z.object({
  symbol: z.string().min(1).max(15),
  is_tradable: z.boolean().optional(),
  is_halted: z.boolean().optional(),
  halt_reason: z.string().max(200).nullable().optional(),
});

const Add = z.object({ symbol: z.string().min(1).max(15) });

/** Toggle a symbol in or out of the tradable universe. */
export async function PATCH(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const { symbol, ...fields } = parsed.data;
  const upper = symbol.toUpperCase();

  const { error } = await guard.ctx.admin.from("instruments").update(fields).eq("symbol", upper);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await writeAudit(guard.ctx, "instrument.update", "instrument", upper, fields);
  return NextResponse.json({ ok: true });
}

/** Add a symbol to the universe by resolving it against Yahoo. */
export async function POST(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const parsed = Add.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const upper = parsed.data.symbol.toUpperCase().trim();
  if (!isUsSymbolFormat(upper)) {
    return NextResponse.json(
      { error: `"${upper}" isn't a US ticker. Use the NYSE/NASDAQ symbol (e.g. LMT, not LMT.VI).` },
      { status: 400 },
    );
  }

  let name = upper;
  let exchange: string | null = null;
  let assetType = "EQUITY";

  try {
    const res = await fetch(
      `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(upper)}&quotesCount=5&newsCount=0`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; XavageSim/1.0)" },
        signal: AbortSignal.timeout(4000) },
    );
    if (res.ok) {
      const json = (await res.json()) as {
        quotes?: Array<{ symbol?: string; shortname?: string; longname?: string;
                         exchDisp?: string; quoteType?: string }>;
      };
      const hit = json.quotes?.find((h) => h.symbol?.toUpperCase() === upper);
      if (!hit) {
        return NextResponse.json(
          { error: `Yahoo doesn't list "${upper}". Check the ticker.` },
          { status: 404 },
        );
      }
      name = hit.longname ?? hit.shortname ?? upper;
      exchange = hit.exchDisp ?? null;
      assetType = (hit.quoteType ?? "EQUITY").toUpperCase();
    }
  } catch {
    // Yahoo unreachable — still add it; the worker will fill in the name.
  }

  // The cap is what the worker quotes, so adding past it produces a symbol
  // that is listed and ordered but never priced. Refuse, and say which lever
  // to pull -- an organiser adding a symbol deliberately is exactly who should
  // decide whether to raise the cap or drop something else.
  const [{ data: settings }, { count: tradable }] = await Promise.all([
    guard.ctx.admin.from("game_settings").select("worker_max_symbols").eq("id", true).single(),
    guard.ctx.admin.from("instruments").select("symbol", { count: "exact", head: true })
      .eq("is_tradable", true),
  ]);
  const cap = settings?.worker_max_symbols ?? null;

  const { data: existing } = await guard.ctx.admin
    .from("instruments").select("symbol, is_tradable").eq("symbol", upper).maybeSingle();

  // Re-enabling something already in the table is still a new slot unless it
  // is already tradable.
  if (cap != null && !existing?.is_tradable && (tradable ?? 0) >= cap) {
    return NextResponse.json(
      { error: `The universe is full at ${cap} symbols, and the worker only quotes that many. `
             + `Raise the cap in Admin → Stock worker, or stop trading a symbol to make room.` },
      { status: 409 },
    );
  }

  const { error } = await guard.ctx.admin.from("instruments").upsert(
    { symbol: upper, name, exchange, asset_type: assetType, is_tradable: true, is_halted: false },
    { onConflict: "symbol" },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await writeAudit(guard.ctx, "instrument.add", "instrument", upper, { name });
  return NextResponse.json({ ok: true, symbol: upper, name }, { status: 201 });
}
