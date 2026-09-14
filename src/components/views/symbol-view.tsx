"use client";

import { AlertTriangle, Ban, Users } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Delta } from "@/components/ui/delta";
import { PriceChart } from "@/components/trade/price-chart";
import { OrderTicket } from "@/components/trade/order-ticket";
import { OrdersTable } from "@/components/tables/orders-table";
import { useOrders, usePortfolio } from "@/hooks/use-app-data";
import { useQuote } from "@/hooks/use-quote";
import { useNow } from "@/hooks/use-now";
import { cn, money, num, pct, qtyText, relative, signedMoney, toneClass } from "@/lib/format";

interface Instrument {
  symbol: string;
  name: string;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  asset_type: string;
  is_tradable: boolean;
  is_halted: boolean;
  halt_reason: string | null;
}

export function SymbolView({ instrument }: { instrument: Instrument }) {
  const { symbol } = instrument;
  const quote = useQuote(symbol);
  // Someone watching one ticker is watching this line as much as the price:
  // a frozen "updated 9s ago" is how a live page looks broken.
  const now = useNow();
  const { data: portfolio } = usePortfolio();
  const { data: orders = [] } = useOrders({ limit: 100 });

  const symbolOrders = orders.filter((o) => o.symbol === symbol);
  const position = portfolio?.positions.find((p) => p.symbol === symbol);

  const price = quote?.price ?? 0;
  const prev = Number(quote?.prev_close ?? 0);
  const change = prev > 0 ? price - prev : 0;
  const changePct = prev > 0 ? (change / prev) * 100 : 0;

  const livePos = position
    ? {
        qty: position.qty,
        value: position.qty * price,
        unrealized: (price - position.avg_cost) * position.qty,
        unrealizedPct: position.avg_cost > 0
          ? ((price - position.avg_cost) / position.avg_cost) * 100 * Math.sign(position.qty)
          : 0,
      }
    : null;

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="panel-glow px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3 justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="num text-xl font-bold tracking-tight">{symbol}</h1>
              {instrument.is_halted && (
                <span className="chip chip-warn"><AlertTriangle size={11} /> Halted</span>
              )}
              {!instrument.is_tradable && (
                <span className="chip chip-neutral"><Ban size={11} /> Not tradable</span>
              )}
              <span className="chip chip-neutral">{instrument.asset_type}</span>
            </div>
            <p className="text-[13px] text-[var(--color-text-dim)] mt-1">{instrument.name}</p>
            <p className="text-[11px] text-[var(--color-text-faint)] mt-0.5">
              {[instrument.exchange, instrument.sector, instrument.industry]
                .filter(Boolean).join(" · ") || "—"}
            </p>
          </div>

          {/* The price is the loud number on this page; the tick tint on it is
              what makes a live quote feel live. */}
          <div className="text-right shrink-0">
            <p className={cn("num text-[2.5rem] leading-none font-semibold tracking-tight transition-colors",
              quote?.tick === "up" ? "text-[var(--color-up)]"
                : quote?.tick === "down" ? "text-[var(--color-down)]" : "")}>
              {price > 0 ? money(price) : "—"}
            </p>
            <div className="flex items-center justify-end gap-1.5 mt-2">
              <Delta abs={prev > 0 ? change : null} percent={prev > 0 ? changePct : null} size="md" />
            </div>
            <p className="text-[10.5px] text-[var(--color-text-faint)] mt-1">
              {quote ? `updated ${relative(quote.quote_time, now)}` : "awaiting feed"}
            </p>
          </div>
        </div>

        {instrument.is_halted && instrument.halt_reason && (
          <p className="mt-3 text-xs text-[var(--color-warn)] border-t border-[var(--color-border-soft)] pt-2.5">
            Trading halted by the organisers — {instrument.halt_reason}
          </p>
        )}

        {/* session stats */}
        <dl className="grid grid-cols-3 sm:grid-cols-5 gap-x-6 gap-y-3 mt-4 pt-3 border-t border-[var(--color-border-soft)]">
          {[
            ["Open", quote?.day_open],
            ["High", quote?.day_high],
            ["Low", quote?.day_low],
            ["Prev close", quote?.prev_close],
          ].map(([label, value]) => (
            <div key={label as string}>
              <dt className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-text-faint)]">{label}</dt>
              <dd className="num text-[13px] font-medium mt-1">{value != null ? num(Number(value)) : "—"}</dd>
            </div>
          ))}
          <div>
            <dt className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-text-faint)]">Volume</dt>
            <dd className="num text-[13px] font-medium mt-1">
              {quote?.volume != null ? Number(quote.volume).toLocaleString("en-US") : "—"}
            </dd>
          </div>
        </dl>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_330px] gap-4 items-start">
        <div className="space-y-4 min-w-0">
          {/* No panel title: the chart's own range/type bar is the header, and
              two stacked headers on the page's biggest panel is one too many. */}
          <Panel glow bodyClassName="pb-2">
            <PriceChart symbol={symbol} livePrice={price || undefined} height={400} />
          </Panel>

          {livePos && (
            <Panel title={`Your ${symbol} position`}>
              <dl className="grid grid-cols-2 sm:grid-cols-5 gap-4 px-3.5 py-3.5">
                {[
                  { label: "Quantity", value: qtyText(livePos.qty), tone: "" },
                  { label: "Avg cost", value: money(position!.avg_cost), tone: "" },
                  { label: "Market value", value: money(livePos.value), tone: "" },
                  {
                    label: "Unrealised",
                    value: signedMoney(livePos.unrealized),
                    tone: toneClass(livePos.unrealized),
                    sub: pct(livePos.unrealizedPct),
                  },
                  {
                    label: "Realised",
                    value: position!.realized_pnl !== 0 ? signedMoney(position!.realized_pnl) : "—",
                    tone: toneClass(position!.realized_pnl),
                  },
                ].map((cell) => (
                  <div key={cell.label}>
                    <dt className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-text-faint)]">
                      {cell.label}
                    </dt>
                    <dd className={cn("num text-[15px] font-semibold mt-1", cell.tone)}>
                      {cell.value}
                      {cell.sub && <span className="block text-[10px] font-normal opacity-80">{cell.sub}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </Panel>
          )}

          <Panel title={`${symbol} orders`} bodyClassName="overflow-x-auto">
            <OrdersTable
              orders={symbolOrders}
              emptyHint={`Orders you place on ${symbol} will appear here.`}
            />
          </Panel>
        </div>

        {/* The ticket stays in view while the chart scrolls: sticky under the
            nav (52px) + tape (36px) + the main padding. */}
        <div className="lg:sticky lg:top-[104px]">
          <Panel glow title="Order ticket" bodyClassName="p-0">
            {/* Admins have no team, so there is no book to trade against --
                show why rather than a form that can only fail. */}
            {portfolio && !portfolio.team ? (
              <div className="p-6 text-center">
                <Users size={22} className="mx-auto text-[var(--color-text-faint)] mb-2" />
                <p className="text-sm font-medium text-[var(--color-text-dim)]">
                  No team assigned
                </p>
                <p className="text-xs text-[var(--color-text-faint)] mt-1">
                  You&apos;re viewing this as an organiser. Trading needs a team book —
                  participants place the orders.
                </p>
              </div>
            ) : instrument.is_tradable && !instrument.is_halted ? (
              <OrderTicket symbol={symbol} />
            ) : (
              <div className="p-6 text-center">
                <Ban size={22} className="mx-auto text-[var(--color-text-faint)] mb-2" />
                <p className="text-sm font-medium text-[var(--color-text-dim)]">
                  {instrument.is_halted ? "Trading halted" : "Not tradable"}
                </p>
                <p className="text-xs text-[var(--color-text-faint)] mt-1">
                  {instrument.halt_reason ?? "The organisers have disabled this symbol."}
                </p>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
