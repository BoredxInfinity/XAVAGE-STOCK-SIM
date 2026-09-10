"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { SymbolSearch } from "@/components/trade/symbol-search";
import { createClient } from "@/lib/supabase/client";
import { useQuotesVersion } from "@/hooks/use-quote";
import { quoteStore } from "@/lib/quote-store";
import { cn, compactNum, num, pct } from "@/lib/format";

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
      const { data, error } = await createClient()
        .from("instruments")
        .select("symbol, name, sector, asset_type, is_tradable, is_halted")
        .eq("is_tradable", true)
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

  function header(key: SortKey, label: string, right = true) {
    const active = sort === key;
    return (
      <th className={right ? "r" : ""}>
        <button
          onClick={() => { if (active) setDesc((d) => !d); else { setSort(key); setDesc(true); } }}
          className={cn(
            "inline-flex items-center gap-1 hover:text-[var(--color-text)] transition-colors",
            active && "text-[var(--color-neon-bright)]",
          )}
        >
          {label}
          {active && (desc ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}
        </button>
      </th>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center justify-between">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Markets</h1>
          <p className="text-xs text-[var(--color-text-dim)]">
            {rows.length} live symbol{rows.length === 1 ? "" : "s"} · click any row to trade
          </p>
        </div>
        <div className="w-full sm:w-80">
          <SymbolSearch placeholder="Find any listed ticker…" />
        </div>
      </div>

      <Panel
        title="Watchlist"
        action={
          <input
            value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="field !py-1 !text-xs !w-40"
          />
        }
        bodyClassName="max-h-[calc(100dvh-260px)] overflow-y-auto"
      >
        <table className="tbl">
          <thead>
            <tr>
              {header("symbol", "Symbol", false)}
              <th className="hidden lg:table-cell">Sector</th>
              {header("price", "Last")}
              {header("change", "Change")}
              <th className="r hidden md:table-cell">Day range</th>
              {header("volume", "Volume")}
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
                  className={cn(r.tick === "up" && "flash-up", r.tick === "down" && "flash-down")}>
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
                <td className="r num font-medium">{num(r.price)}</td>
                <td className={cn("r num",
                  r.change > 0 ? "text-[var(--color-up)]"
                    : r.change < 0 ? "text-[var(--color-down)]"
                    : "text-[var(--color-text-dim)]")}>
                  {pct(r.changePct)}
                  <span className="block text-[10px]">
                    {r.change >= 0 ? "+" : "−"}{num(Math.abs(r.change))}
                  </span>
                </td>
                <td className="r num hidden md:table-cell text-[11px] text-[var(--color-text-dim)]">
                  {r.day_low != null && r.day_high != null
                    ? `${num(Number(r.day_low))} – ${num(Number(r.day_high))}` : "—"}
                </td>
                <td className="r num text-[11px] text-[var(--color-text-dim)]">
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
