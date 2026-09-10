"use client";

import { useQuery } from "@tanstack/react-query";
import { Panel } from "@/components/ui/panel";
import { StatTile } from "@/components/ui/stat-tile";
import { EquityChart } from "@/components/trade/equity-chart";
import { PositionsTable } from "@/components/tables/positions-table";
import { createClient } from "@/lib/supabase/client";
import { useEquityCurve, usePortfolio } from "@/hooks/use-app-data";
import { cn, money, pct, signedMoney, stamp, toneClass, toneOf } from "@/lib/format";
import type { CashLedgerRow } from "@/lib/database.types";

const LEDGER_LABEL: Record<string, string> = {
  initial_capital: "Opening balance",
  trade_buy: "Buy",
  trade_sell: "Sell",
  commission: "Commission",
  cash_interest: "Interest earned",
  margin_interest: "Margin interest",
  borrow_fee: "Short borrow fee",
  dividend: "Dividend",
  tax: "Tax",
  admin_adjustment: "Adjustment",
};

export function PortfolioView() {
  const { data: portfolio } = usePortfolio();
  const { data: curve = [] } = useEquityCurve();

  const { data: ledger = [] } = useQuery({
    queryKey: ["ledger"],
    queryFn: async (): Promise<CashLedgerRow[]> => {
      const { data, error } = await createClient()
        .from("cash_ledger").select("*")
        .order("created_at", { ascending: false }).limit(150);
      if (error) throw error;
      return (data ?? []) as CashLedgerRow[];
    },
  });

  const m = portfolio?.metrics;
  const positions = portfolio?.positions ?? [];

  const unrealized = positions.reduce((s, p) => s + p.unrealized_pnl, 0);
  const realized = positions.reduce((s, p) => s + p.realized_pnl, 0);

  // Concentration by market value — how lopsided is the book?
  const gross = positions.reduce((s, p) => s + Math.abs(p.market_value), 0);
  const weights = positions
    .map((p) => ({
      symbol: p.symbol,
      weight: gross > 0 ? (Math.abs(p.market_value) / gross) * 100 : 0,
      pnl: p.unrealized_pnl,
    }))
    .sort((a, b) => b.weight - a.weight);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight">Portfolio</h1>
        <p className="text-xs text-[var(--color-text-dim)]">
          {portfolio?.team?.name} · shared team book
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatTile accent="neon" label="Equity" value={money(m?.equity)} />
        <StatTile label="Cash" value={money(m?.cash)}
                  sub={m && m.reserved_cash > 0 ? `${money(m.reserved_cash)} committed` : undefined} />
        <StatTile label="Positions value" value={money(m?.positions_value)} />
        <StatTile label="Unrealised" tone={toneOf(unrealized)} value={signedMoney(unrealized)} />
        <StatTile label="Realised" tone={toneOf(realized)} value={signedMoney(realized)} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Panel glow className="lg:col-span-2" title="Equity curve" bodyClassName="p-2">
          <EquityChart
            points={curve as { ts: string; equity: number }[]}
            initialCapital={portfolio?.team?.initial_capital}
            height={240}
          />
        </Panel>

        <Panel title="Allocation" bodyClassName="p-4 space-y-2.5 max-h-[296px] overflow-y-auto">
          {weights.length === 0 ? (
            <p className="text-xs text-[var(--color-text-faint)]">No positions to weight yet.</p>
          ) : (
            weights.map((w) => (
              <div key={w.symbol}>
                <div className="flex justify-between items-baseline text-[11px] mb-1">
                  <span className="num font-semibold">{w.symbol}</span>
                  <span className="num text-[var(--color-text-dim)]">{w.weight.toFixed(1)}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(2, w.weight)}%`,
                      background: w.pnl >= 0
                        ? "linear-gradient(90deg,var(--color-neon),var(--color-up))"
                        : "linear-gradient(90deg,var(--color-violet),var(--color-down))",
                    }}
                  />
                </div>
              </div>
            ))
          )}
        </Panel>
      </div>

      <Panel title="Open positions">
        <PositionsTable positions={positions} />
      </Panel>

      <Panel title="Cash ledger"
             action={<span className="text-[11px] text-[var(--color-text-faint)]">every movement, newest first</span>}>
        <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th><th>Type</th><th>Detail</th>
                <th className="r">Amount</th><th className="r">Balance</th>
              </tr>
            </thead>
            <tbody>
              {ledger.length === 0 && (
                <tr><td colSpan={5} className="text-center py-8 text-xs text-[var(--color-text-faint)]">
                  No cash activity yet.
                </td></tr>
              )}
              {ledger.map((row) => (
                <tr key={row.id}>
                  <td className="num text-[11px] text-[var(--color-text-faint)] whitespace-nowrap">
                    {stamp(row.created_at)}
                  </td>
                  <td className="text-[11px]">{LEDGER_LABEL[row.entry_type] ?? row.entry_type}</td>
                  <td className="text-[11px] text-[var(--color-text-dim)] max-w-[280px] truncate">
                    {row.note ?? "—"}
                  </td>
                  <td className={cn("r num", toneClass(row.amount))}>{signedMoney(row.amount)}</td>
                  <td className="r num text-[var(--color-text-dim)]">{money(row.balance_after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {m && (
        <p className="text-[11px] text-[var(--color-text-faint)] text-center">
          Total return {pct(m.total_return_pct)} · {signedMoney(m.total_pnl)} against a{" "}
          {money(portfolio?.team?.initial_capital)} starting book
        </p>
      )}
    </div>
  );
}
