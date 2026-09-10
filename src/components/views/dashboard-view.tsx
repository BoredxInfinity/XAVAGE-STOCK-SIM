"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight, Megaphone, TrendingUp, Wallet,
} from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { StatTile } from "@/components/ui/stat-tile";
import { EquityChart } from "@/components/trade/equity-chart";
import { SymbolSearch } from "@/components/trade/symbol-search";
import { PositionsTable } from "@/components/tables/positions-table";
import { OrdersTable } from "@/components/tables/orders-table";
import {
  useAnnouncements, useEquityCurve, useMarketStatus, useOrders, usePortfolio,
} from "@/hooks/use-app-data";
import { cn, money, pct, relative, signedMoney, toneOf } from "@/lib/format";

export function DashboardView() {
  const router = useRouter();
  const { data: portfolio, isLoading } = usePortfolio();
  const { data: working = [] } = useOrders({ working: true, limit: 12 });
  const { data: curve = [] } = useEquityCurve();
  const { data: news = [] } = useAnnouncements();
  const { data: status } = useMarketStatus();

  const m = portfolio?.metrics;
  const positions = portfolio?.positions ?? [];

  const dayChange = positions.reduce((sum, p) => sum + p.day_change, 0);

  if (isLoading && !portfolio) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[92px] skeleton rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <div>
          <h1 className="text-lg font-bold tracking-tight">{portfolio?.team?.name ?? "Your desk"}</h1>
          <p className="text-xs text-[var(--color-text-dim)]">
            {status?.is_open ? "Market is open — orders fill live." : "Market closed — orders queue for the next session."}
          </p>
        </div>
        <div className="w-full sm:w-80">
          <SymbolSearch placeholder="Search a ticker to trade…" />
        </div>
      </div>

      {/* headline metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile
          accent="neon" label="Total equity"
          value={money(m?.equity)}
          sub={<>Started at {money(portfolio?.team?.initial_capital)}</>}
        />
        <StatTile
          label="Total P&L" tone={toneOf(m?.total_pnl)}
          value={signedMoney(m?.total_pnl)}
          sub={<span className={cn(toneOf(m?.total_return_pct) === "up"
            ? "text-[var(--color-up)]" : toneOf(m?.total_return_pct) === "down"
            ? "text-[var(--color-down)]" : "")}>{pct(m?.total_return_pct)} since start</span>}
        />
        <StatTile
          label="Today" tone={toneOf(dayChange)}
          value={signedMoney(dayChange)}
          sub={`${positions.length} open position${positions.length === 1 ? "" : "s"}`}
        />
        <StatTile
          accent="violet" label="Buying power"
          value={money(m?.buying_power)}
          sub={m && m.reserved_cash > 0
            ? `${money(m.reserved_cash)} committed to resting orders`
            : `${money(m?.cash)} cash`}
        />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Panel
          glow className="lg:col-span-2"
          title="Equity curve"
          action={
            <span className="text-[11px] num text-[var(--color-text-faint)]">
              {curve.length} snapshot{curve.length === 1 ? "" : "s"}
            </span>
          }
          bodyClassName="p-2"
        >
          <EquityChart
            points={curve as { ts: string; equity: number }[]}
            initialCapital={portfolio?.team?.initial_capital}
            height={230}
          />
        </Panel>

        <Panel
          title={<span className="flex items-center gap-1.5"><Megaphone size={12} /> Announcements</span>}
          bodyClassName="divide-y divide-[var(--color-border-soft)] max-h-[286px] overflow-y-auto"
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
                <p className="mt-1.5 text-[10px] text-[var(--color-text-faint)]">{relative(n.created_at)}</p>
              </article>
            ))
          )}
        </Panel>
      </div>

      <Panel
        title={<span className="flex items-center gap-1.5"><Wallet size={12} /> Positions</span>}
        action={
          <Link href="/portfolio" className="text-[11px] text-[var(--color-neon-bright)] hover:underline flex items-center gap-0.5">
            Full portfolio <ArrowUpRight size={11} />
          </Link>
        }
      >
        <PositionsTable positions={positions} />
      </Panel>

      <Panel
        title={<span className="flex items-center gap-1.5"><TrendingUp size={12} /> Working orders</span>}
        action={
          <Link href="/orders" className="text-[11px] text-[var(--color-neon-bright)] hover:underline flex items-center gap-0.5">
            All orders <ArrowUpRight size={11} />
          </Link>
        }
      >
        <OrdersTable
          orders={working}
          emptyHint="Limit, stop and trailing orders waiting to trigger show up here."
        />
      </Panel>
    </div>
  );
}
