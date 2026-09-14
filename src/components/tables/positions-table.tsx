"use client";

import Link from "next/link";
import { Briefcase } from "lucide-react";
import { Empty } from "@/components/ui/empty";
import { useQuote } from "@/hooks/use-quote";
import { cn, money, pct, qtyText, signedMoney, toneClass } from "@/lib/format";
import type { PortfolioPosition } from "@/lib/database.types";
import { flashClass } from "@/lib/quote-store";

function PositionRow({ position }: { position: PortfolioPosition }) {
  // Prefer the live store price over the snapshot baked into the RPC payload.
  const live = useQuote(position.symbol);
  const price = live?.price ?? position.price;
  const isShort = position.qty < 0;

  const marketValue = position.qty * price;
  const costBasis = position.qty * position.avg_cost;
  const unrealized = (price - position.avg_cost) * position.qty;
  const unrealizedPct = position.avg_cost > 0
    ? ((price - position.avg_cost) / position.avg_cost) * 100 * Math.sign(position.qty)
    : 0;

  return (
    <tr className={flashClass(live)}>
      <td>
        <Link href={`/trade/${position.symbol}`} className="group flex flex-col">
          <span className="num text-xs font-bold text-[var(--color-neon-bright)] group-hover:underline">
            {position.symbol}
          </span>
          <span className="text-[10.5px] text-[var(--color-text-faint)] truncate max-w-[150px]">
            {position.name}
          </span>
        </Link>
      </td>
      <td className="r num">
        <span className={isShort ? "text-[var(--color-down)]" : ""}>{qtyText(position.qty)}</span>
        {isShort && <span className="ml-1 chip chip-down">Short</span>}
        {position.reserved_qty > 0 && (
          <span className="block text-[10px] text-[var(--color-text-faint)]">
            {qtyText(position.reserved_qty)} committed
          </span>
        )}
      </td>
      <td className="r num text-[var(--color-text-dim)]">{money(position.avg_cost)}</td>
      <td className="r num">{money(price)}</td>
      <td className="r num">{money(marketValue)}</td>
      <td className="r num text-[var(--color-text-dim)] hidden lg:table-cell">{money(costBasis)}</td>
      <td className={cn("r num font-semibold", toneClass(unrealized))}>
        {signedMoney(unrealized)}
        <span className="block text-[10px] font-normal">{pct(unrealizedPct)}</span>
      </td>
      <td className={cn("r num hidden md:table-cell", toneClass(position.realized_pnl))}>
        {position.realized_pnl !== 0 ? signedMoney(position.realized_pnl) : "—"}
      </td>
    </tr>
  );
}

export function PositionsTable({ positions }: { positions: PortfolioPosition[] }) {
  if (positions.length === 0) {
    return (
      <Empty
        icon={<Briefcase size={26} />}
        title="No open positions"
        hint="Search for a ticker and place your first trade to get started."
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>Symbol</th>
            <th className="r">Qty</th>
            <th className="r">Avg cost</th>
            <th className="r">Last</th>
            <th className="r">Value</th>
            <th className="r hidden lg:table-cell">Cost basis</th>
            <th className="r">Unrealised</th>
            <th className="r hidden md:table-cell">Realised</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => <PositionRow key={p.symbol} position={p} />)}
        </tbody>
      </table>
    </div>
  );
}
