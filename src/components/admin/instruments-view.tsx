"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Ban, CheckCircle2, Loader2, PauseOctagon, Plus } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { createClient } from "@/lib/supabase/client";
import { useQuotesVersion } from "@/hooks/use-quote";
import { quoteStore } from "@/lib/quote-store";
import { cn, num, relative } from "@/lib/format";
import type { Instrument } from "@/lib/database.types";
import { useNow } from "@/hooks/use-now";

export function InstrumentsView() {
  // Shared 1s clock -- relative() is computed during render, so without this
  // the ages freeze between data changes and a live page reads as a dead one.
  const now = useNow();
  const qc = useQueryClient();
  const version = useQuotesVersion();
  const [symbol, setSymbol] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const { data: instruments = [], isLoading } = useQuery({
    queryKey: ["admin-instruments"],
    queryFn: async (): Promise<Instrument[]> => {
      const { data, error } = await createClient()
        .from("instruments").select("*").order("symbol").limit(1000);
      if (error) throw error;
      return (data ?? []) as Instrument[];
    },
  });

  const rows = useMemo(() => {
    const term = filter.trim().toUpperCase();
    return instruments
      .filter((i) => !term || i.symbol.includes(term) || i.name.toUpperCase().includes(term))
      .map((i) => ({ ...i, quote: quoteStore.get(i.symbol) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instruments, filter, version]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-instruments"] });

  async function addSymbol(e: React.FormEvent) {
    e.preventDefault();
    const upper = symbol.trim().toUpperCase();
    if (!upper) return;
    setBusy("add");

    const res = await fetch("/api/admin/instruments", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: upper }),
    });
    const json = await res.json();

    if (!res.ok) toast.error("Could not add", { description: json.error });
    else { toast.success(`${json.symbol} added`, { description: json.name }); setSymbol(""); refresh(); }
    setBusy(null);
  }

  async function toggleTradable(inst: Instrument) {
    setBusy(inst.symbol);
    const res = await fetch("/api/admin/instruments", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: inst.symbol, is_tradable: !inst.is_tradable }),
    });
    if (!res.ok) toast.error("Failed", { description: (await res.json()).error });
    else { toast.success(`${inst.symbol} ${inst.is_tradable ? "disabled" : "enabled"}`); refresh(); }
    setBusy(null);
  }

  async function toggleHalt(inst: Instrument) {
    let reason: string | null = null;
    if (!inst.is_halted) {
      reason = window.prompt(`Why is ${inst.symbol} being halted? (shown to participants)`, "Pending news");
      if (reason == null) return;
    }
    setBusy(inst.symbol);
    const { error } = await createClient().rpc("admin_set_symbol_halt", {
      p_symbol: inst.symbol, p_halted: !inst.is_halted, p_reason: reason ?? undefined,
    });
    if (error) toast.error("Failed", { description: error.message });
    else { toast.success(`${inst.symbol} ${inst.is_halted ? "resumed" : "halted"}`); refresh(); }
    setBusy(null);
  }

  const tradable = instruments.filter((i) => i.is_tradable).length;
  const halted = instruments.filter((i) => i.is_halted).length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight">Instruments</h1>
        <p className="text-xs text-[var(--color-text-dim)]">
          {instruments.length} symbols · {tradable} tradable · {halted} halted.
          Participants can also pull in any listed ticker through search.
        </p>
      </div>

      <Panel title="Add a symbol" bodyClassName="p-4">
        <form onSubmit={addSymbol} className="flex gap-2 items-end">
          <div className="flex-1 max-w-xs">
            <label className="label" htmlFor="add-sym">Ticker</label>
            <input id="add-sym" className="field num uppercase" value={symbol}
                   placeholder="NVDA" onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
          </div>
          <button type="submit" disabled={!symbol.trim() || busy === "add"} className="btn btn-primary">
            {busy === "add" ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Add
          </button>
          <p className="text-[10.5px] text-[var(--color-text-faint)] pb-2 hidden md:block">
            Verified against Yahoo before it&apos;s added; the worker starts quoting it next cycle.
          </p>
        </form>
      </Panel>

      <Panel
        title="Universe"
        action={<input value={filter} onChange={(e) => setFilter(e.target.value)}
                       placeholder="Filter…" className="field !py-1 !text-xs !w-40" />}
        bodyClassName="max-h-[calc(100dvh-330px)] overflow-y-auto"
      >
        {isLoading ? <div className="h-48 skeleton" /> : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Symbol</th><th className="hidden lg:table-cell">Sector</th>
                <th className="r">Last</th><th className="hidden md:table-cell">Feed</th>
                <th>Status</th><th className="r">Controls</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.symbol} className={cn(!i.is_tradable && "opacity-55")}>
                  <td>
                    <span className="num text-xs font-bold text-[var(--color-neon-bright)]">{i.symbol}</span>
                    <span className="block text-[10.5px] text-[var(--color-text-faint)] truncate max-w-[220px]">
                      {i.name}
                    </span>
                  </td>
                  <td className="hidden lg:table-cell text-[11px] text-[var(--color-text-dim)]">
                    {i.sector ?? "—"}
                  </td>
                  <td className="r num">{i.quote ? num(i.quote.price) : "—"}</td>
                  <td className="hidden md:table-cell text-[11px] text-[var(--color-text-faint)]">
                    {i.quote ? relative(i.quote.quote_time, now) : "no quote"}
                  </td>
                  <td>
                    {!i.is_tradable ? <span className="chip chip-neutral">Disabled</span>
                      : i.is_halted ? <span className="chip chip-warn" title={i.halt_reason ?? ""}>Halted</span>
                      : <span className="chip chip-up">Live</span>}
                  </td>
                  <td className="r">
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => toggleHalt(i)} disabled={busy != null || !i.is_tradable}
                              className="btn btn-ghost !px-2 !py-1 !text-[11px]"
                              title={i.is_halted ? "Resume trading" : "Halt trading"}>
                        {i.is_halted ? <CheckCircle2 size={12} /> : <PauseOctagon size={12} />}
                      </button>
                      <button onClick={() => toggleTradable(i)} disabled={busy != null}
                              className={cn("btn !px-2 !py-1 !text-[11px]", i.is_tradable ? "btn-danger" : "btn-ghost")}
                              title={i.is_tradable ? "Remove from universe" : "Add back to universe"}>
                        <Ban size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
