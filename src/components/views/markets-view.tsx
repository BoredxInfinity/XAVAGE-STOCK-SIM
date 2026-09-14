"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/page-header";
import { SymbolSearch } from "@/components/trade/symbol-search";
import { createClient } from "@/lib/supabase/client";
import { useQuotesVersion } from "@/hooks/use-quote";
import { quoteStore } from "@/lib/quote-store";
import { cn, compactNum, num, pct } from "@/lib/format";
import { flashClass } from "@/lib/quote-store";

type SortKey = "symbol" | "price" | "change" | "volume";

export function MarketsView() {
  const version = useQuotesVersion();
  const [sort, setSort] = useState<SortKey>("change");
  const [desc, setDesc] = useState(true);
  const [filter, setFilter] = useState("");

  const { data: instruments = [] } = useQuery({
    queryKey: ["instruments"],
    staleTime: 300_000,
    queryFn: async () => {
      // The capped universe: what the worker is actually quoting. Listing a
      // symbol the worker has truncated away would show a permanently blank
      // price with no explanation.
      const { data, error } = await createClient()
        .from("tradable_instruments")
        .select("symbol, name, sector, asset_type, is_tradable, is_halted")
        .order("symbol")
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  const rows = useMemo(() => {
    const meta = new Map(instruments.map((i) => [i.symbol, i]));
    const term = filter.trim().toUpperCase();

    const list = quoteStore
      .getAll()
      .filter((q) => meta.has(q.symbol))
      .map((q) => {
        const info = meta.get(q.symbol)!;
        const prev = Number(q.prev_close ?? q.price);
        const change = q.price - prev;
        return {
          ...q,
          name: info.name,
          sector: info.sector,
          is_halted: info.is_halted,
          change,
          changePct: prev > 0 ? (change / prev) * 100 : 0,
        };
      })
      .filter((r) => !term || r.symbol.includes(term) || r.name.toUpperCase().includes(term));

    const dir = desc ? -1 : 1;
    list.sort((a, b) => {
      switch (sort) {
        case "symbol": return a.symbol.localeCompare(b.symbol) * dir;
        case "price": return (a.price - b.price) * dir;
        case "volume": return ((a.volume ?? 0) - (b.volume ?? 0)) * dir;
        default: return (a.changePct - b.changePct) * dir;
      }
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instruments, version, sort, desc, filter]);

  function header(key: SortKey, label: string, right = true, className?: string) {
    const active = sort === key;
    return (
      <th className={cn(right && "r", className)}>
        <button
          type="button"
          data-active={active}
          aria-sort={active ? (desc ? "descending" : "ascending") : "none"}
          onClick={() => { if (active) setDesc((d) => !d); else { setSort(key); setDesc(true); } }}
          className="th-sort"
        >
          {label}
          {/* The caret only appears on the active column, so the header row
              stays quiet rather than sprouting four arrows. */}
          {active && (desc ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}
        </button>
      </th>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Markets"
        subtitle={<>{rows.length} live symbol{rows.length === 1 ? "" : "s"} · click any row to trade</>}
        action={
          <div className="w-full sm:w-96">
            <SymbolSearch placeholder="Find any listed ticker…" />
          </div>
        }
      />

      <Panel
        title="Watchlist"
        action={
          <input
            value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            aria-label="Filter the watchlist"
            className="field w-44 py-1 text-[11px]"
          />
        }
        bodyClassName="max-h-[calc(100dvh-250px)] overflow-y-auto overflow-x-auto"
      >
        <table className="tbl">
          <thead>
            <tr>
              {header("symbol", "Symbol", false)}
              <th className="hidden lg:table-cell">Sector</th>
              {header("price", "Last")}
              {header("change", "Change")}
              <th className="r hidden md:table-cell">Day range</th>
              {header("volume", "Volume", true, "hidden sm:table-cell")}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-10 text-xs text-[var(--color-text-faint)]">
                  Waiting for the price feed to populate…
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.symbol}
                  className={flashClass(r)}>
                <td>
                  <Link href={`/trade/${r.symbol}`} className="group flex flex-col">
                    <span className="num text-xs font-bold text-[var(--color-neon-bright)] group-hover:underline">
                      {r.symbol}
                      {r.is_halted && <span className="ml-1.5 chip chip-warn">Halted</span>}
                    </span>
                    <span className="text-[10.5px] text-[var(--color-text-faint)] truncate max-w-[220px]">
                      {r.name}
                    </span>
                  </Link>
                </td>
                <td className="hidden lg:table-cell text-[11px] text-[var(--color-text-dim)]">
                  {r.sector ?? "—"}
                </td>
                <td className="r num font-semibold whitespace-nowrap">{num(r.price)}</td>
                <td className={cn("r num whitespace-nowrap",
                  r.change > 0 ? "text-[var(--color-up)]"
                    : r.change < 0 ? "text-[var(--color-down)]"
                    : "text-[var(--color-text-dim)]")}>
                  <span className="font-medium">{pct(r.changePct)}</span>
                  <span className="block text-[10px] opacity-75">
                    {r.change >= 0 ? "+" : "−"}{num(Math.abs(r.change))}
                  </span>
                </td>
                <td className="hidden md:table-cell">
                  <DayRange low={r.day_low} high={r.day_high} last={r.price} />
                </td>
                <td className="r num text-[11px] text-[var(--color-text-dim)] hidden sm:table-cell">
                  {compactNum(r.volume)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

/**
 * The day's low–high with a marker showing where the last print sits inside
 * it. The numbers are unchanged; the bar just makes "near the high" readable
 * at a glance instead of requiring mental arithmetic per row.
 */
function DayRange({
  low, high, last,
}: { low: number | string | null; high: number | string | null; last: number }) {
  if (low == null || high == null) {
    return <span className="num text-[11px] text-[var(--color-text-dim)] block text-right">—</span>;
  }
  const lo = Number(low), hi = Number(high);
  const span = hi - lo;
  const at = span > 0 ? Math.min(100, Math.max(0, ((last - lo) / span) * 100)) : 50;

  return (
    <div className="min-w-[104px]">
      <div className="flex justify-between num text-[10px] text-[var(--color-text-dim)]">
        <span>{num(lo)}</span><span>{num(hi)}</span>
      </div>
      <div className="relative h-1 mt-1 rounded-full bg-[var(--color-surface-2)]">
        <span
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-1 h-2.5 rounded-full bg-[var(--color-neon)]"
          style={{ left: `${at}%` }}
        />
      </div>
    </div>
  );
}
