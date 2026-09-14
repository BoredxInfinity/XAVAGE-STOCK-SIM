"use client";

import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { TradesTable } from "@/components/tables/trades-table";
import { useTrades } from "@/hooks/use-app-data";
import { csvCell, money, signedMoney, toneOf } from "@/lib/format";

export function HistoryView() {
  const { data: trades = [], isLoading } = useTrades(500);
  const [filter, setFilter] = useState("");

  const visible = useMemo(() => {
    const term = filter.trim().toUpperCase();
    return term ? trades.filter((t) => t.symbol.includes(term)) : trades;
  }, [trades, filter]);

  const stats = useMemo(() => {
    const realized = trades.reduce((s, t) => s + t.realized_pnl, 0);
    const fees = trades.reduce((s, t) => s + t.commission, 0);
    const volume = trades.reduce((s, t) => s + t.gross_amount, 0);
    const closers = trades.filter((t) => t.realized_pnl !== 0);
    const wins = closers.filter((t) => t.realized_pnl > 0).length;
    return {
      realized, fees, volume,
      winRate: closers.length > 0 ? (wins / closers.length) * 100 : null,
      closers: closers.length,
    };
  }, [trades]);

  /** Client-side CSV so teams can take their blotter away after the event. */
  function exportCsv() {
    const header = [
      "executed_at", "symbol", "side", "qty", "price",
      "gross_amount", "commission", "net_cash_delta", "realized_pnl",
    ];
    const rows = visible.map((t) => [
      t.executed_at, t.symbol, t.side, t.qty, t.price,
      t.gross_amount, t.commission, t.net_cash_delta, t.realized_pnl,
    ]);
    const csv = [header, ...rows]
      .map((r) => r.map(csvCell).join(","))
      .join("\n");

    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `xavage-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Trade history"
        subtitle="Every fill on your team's book, newest first."
      />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {/* `visible`, not `trades`: the tiles sit directly above the filtered
            table, so counting everything made "Fills: 500" head a 12-row list. */}
        <StatTile size="sm" accent="neon" label="Fills" value={visible.length} />
        <StatTile size="sm" label="Realised P&L" tone={toneOf(stats.realized)} value={signedMoney(stats.realized)} />
        <StatTile size="sm" label="Win rate"
                  value={stats.winRate == null ? "—" : `${stats.winRate.toFixed(0)}%`}
                  sub={`${stats.closers} closing trade${stats.closers === 1 ? "" : "s"}`} />
        <StatTile size="sm" label="Fees paid" value={money(stats.fees)} />
        <StatTile size="sm" label="Traded volume" value={money(stats.volume, true)} />
      </div>

      {/* Filter and export belong with the blotter they act on, not floating
          above the summary tiles. */}
      <Panel
        title="Fills"
        action={
          <>
            <input
              value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by symbol…"
              aria-label="Filter fills by symbol"
              className="field w-44 py-1 text-[11px]"
            />
            <button onClick={exportCsv} disabled={visible.length === 0} className="btn btn-ghost py-1 text-[11px]">
              <Download size={13} /> CSV
            </button>
          </>
        }
        bodyClassName="overflow-x-auto"
      >
        {isLoading ? <div className="h-64 skeleton" /> : <TradesTable trades={visible} />}
      </Panel>
    </div>
  );
}
