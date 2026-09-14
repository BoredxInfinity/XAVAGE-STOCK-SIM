"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  ArrowUpRight, Megaphone, PieChart, Receipt, TrendingUp, Wallet,
} from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { StatTile } from "@/components/ui/stat-tile";
import { Delta } from "@/components/ui/delta";
import { EquityChart } from "@/components/trade/equity-chart";
import { SymbolSearch } from "@/components/trade/symbol-search";
import { PositionsTable } from "@/components/tables/positions-table";
import { OrdersTable } from "@/components/tables/orders-table";
import { createClient } from "@/lib/supabase/client";
import {
  useAnnouncements, useEquityCurve, useMarketStatus, useOrders, usePortfolio,
} from "@/hooks/use-app-data";
import {
  cn, money, pct, relative, signedMoney, stamp, toneClass, toneOf,
} from "@/lib/format";
import type { CashLedgerRow } from "@/lib/database.types";
import { useNow } from "@/hooks/use-now";

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

export function DashboardView() {
  // Shared 1s clock -- relative() is computed during render, so without this
  // the ages freeze between data changes and a live page reads as a dead one.
  const now = useNow();
  const { data: portfolio, isLoading } = usePortfolio();
  const { data: working = [] } = useOrders({ working: true, limit: 12 });
  const { data: curve = [] } = useEquityCurve();
  const { data: news = [] } = useAnnouncements();
  const { data: status } = useMarketStatus();

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

  const dayChange = positions.reduce((sum, p) => sum + p.day_change, 0);
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

  if (isLoading && !portfolio) {
    return (
      <div className="space-y-4">
        <div className="h-[116px] skeleton rounded-xl" />
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-[74px] skeleton rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ---- hero band: one loud number, and the way in to a trade ---- */}
      <section className="panel-glow px-4 py-4 sm:px-5">
        <div className="flex flex-col lg:flex-row lg:items-end gap-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold tracking-tight truncate">
                {portfolio?.team?.name ?? "Your desk"}
              </h1>
              <span className={cn("chip", status?.is_open ? "chip-up" : "chip-neutral")}>
                {status?.is_open ? "Open" : "Closed"}
              </span>
            </div>
            <p className="text-[11px] text-[var(--color-text-dim)] mt-0.5">
              {status?.is_open ? "Market is open — orders fill live." : "Market closed — orders queue for the next session."}
            </p>

            <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-1">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-text-faint)]">
                  Total equity
                </p>
                <p className="num text-[2.25rem] leading-none font-semibold tracking-tight mt-1.5">
                  {money(m?.equity)}
                </p>
              </div>
              <div className="flex flex-col gap-1 pb-1">
                <Delta abs={m?.total_pnl ?? null} percent={m?.total_return_pct ?? null} size="lg" />
                <span className="text-[11px] text-[var(--color-text-dim)]">
                  Started at {money(portfolio?.team?.initial_capital)}
                </span>
              </div>
            </div>
          </div>

          <div className="lg:ml-auto w-full lg:w-80 shrink-0">
            <SymbolSearch placeholder="Search a ticker to trade…" />
          </div>
        </div>
      </section>

      {/* ---- the supporting figures, deliberately subordinate ---- */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
        <StatTile
          size="sm" label="Total P&L" tone={toneOf(m?.total_pnl)}
          value={signedMoney(m?.total_pnl)}
          sub={<span className={cn(toneOf(m?.total_return_pct) === "up"
            ? "text-[var(--color-up)]" : toneOf(m?.total_return_pct) === "down"
            ? "text-[var(--color-down)]" : "")}>{pct(m?.total_return_pct)} since start</span>}
        />
        <StatTile
          size="sm" label="Today" tone={toneOf(dayChange)}
          value={signedMoney(dayChange)}
          sub={`${positions.length} open position${positions.length === 1 ? "" : "s"}`}
        />
        <StatTile
          size="sm" accent="violet" label="Buying power"
          value={money(m?.buying_power)}
          sub={m && m.reserved_cash > 0
            ? `${money(m.reserved_cash)} committed to resting orders`
            : `${money(m?.cash)} cash`}
        />
        <StatTile
          size="sm" label="Unrealised" tone={toneOf(unrealized)}
          value={signedMoney(unrealized)}
          sub={`${money(m?.positions_value)} at market`}
        />
        <StatTile
          size="sm" label="Realised" tone={toneOf(realized)}
          value={signedMoney(realized)}
          sub={`${money(m?.cash)} cash on hand`}
        />
      </div>

      {/* ---- the desk: wide working column, narrow context rail ---- */}
      <div className="grid xl:grid-cols-3 gap-4 items-start">
        <div className="xl:col-span-2 space-y-4 min-w-0">
          <Panel
            glow
            title="Equity curve"
            action={
              <span className="text-[11px] num text-[var(--color-text-faint)]">
                {curve.length} point{curve.length === 1 ? "" : "s"}
              </span>
            }
            bodyClassName="p-2"
          >
            <EquityChart
              points={curve as { ts: string; equity: number }[]}
              initialCapital={portfolio?.team?.initial_capital}
              height={240}
            />
          </Panel>

          <Panel
            title={<span className="flex items-center gap-1.5"><Wallet size={12} /> Open positions</span>}
            action={
              <span className="text-[11px] num text-[var(--color-text-faint)]">
                {positions.length}
              </span>
            }
            bodyClassName="overflow-x-auto"
          >
            <PositionsTable positions={positions} />
          </Panel>

          <Panel
            title={<span className="flex items-center gap-1.5"><Receipt size={12} /> Cash ledger</span>}
            action={<span className="text-[11px] text-[var(--color-text-faint)]">every movement, newest first</span>}
          >
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
                      <td className="text-[11px] whitespace-nowrap">{LEDGER_LABEL[row.entry_type] ?? row.entry_type}</td>
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
        </div>

        <div className="space-y-4 min-w-0">
          <Panel
            title={<span className="flex items-center gap-1.5"><Megaphone size={12} /> Announcements</span>}
            bodyClassName="divide-y divide-[var(--color-border-soft)] max-h-[320px] overflow-y-auto"
          >
            {news.length === 0 ? (
              <p className="p-4 text-xs text-[var(--color-text-faint)]">
                No announcements yet. Organisers will post market events here.
              </p>
            ) : (
              news.map((n) => (
                <article key={n.id} className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-xs font-semibold">{n.title}</h3>
                    <span className={cn("chip shrink-0",
                      n.severity === "critical" ? "chip-down"
                        : n.severity === "warning" ? "chip-warn"
                        : n.severity === "success" ? "chip-up" : "chip-neon")}>
                      {n.severity}
                    </span>
                  </div>
                  {n.body && (
                    <p className="mt-1 text-[11px] text-[var(--color-text-dim)] leading-relaxed whitespace-pre-line">
                      {n.body}
                    </p>
                  )}
                  <p className="mt-1.5 text-[10px] text-[var(--color-text-faint)]">{relative(n.created_at, now)}</p>
                </article>
              ))
            )}
          </Panel>

          <Panel
            title={<span className="flex items-center gap-1.5"><PieChart size={12} /> Allocation</span>}
            bodyClassName="p-3.5 space-y-2.5 max-h-[296px] overflow-y-auto"
          >
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

          <Panel
            title={<span className="flex items-center gap-1.5"><TrendingUp size={12} /> Working orders</span>}
            action={
              <Link href="/orders" className="text-[11px] text-[var(--color-neon-bright)] hover:underline flex items-center gap-0.5">
                All orders <ArrowUpRight size={11} />
              </Link>
            }
            bodyClassName="overflow-x-auto"
          >
            <OrdersTable
              orders={working}
              emptyHint="Limit, stop and trailing orders waiting to trigger show up here."
            />
          </Panel>
        </div>
      </div>

      {m && (
        <p className="text-[11px] text-[var(--color-text-faint)] text-center pt-1">
          Total return {pct(m.total_return_pct)} · {signedMoney(m.total_pnl)} against a{" "}
          {money(portfolio?.team?.initial_capital)} starting book
        </p>
      )}
    </div>
  );
}
