"use client";

import Link from "next/link";
import { History } from "lucide-react";
import { Empty } from "@/components/ui/empty";
import { cn, money, qtyText, signedMoney, stamp, toneClass } from "@/lib/format";
import type { Trade } from "@/lib/database.types";

export function TradesTable({ trades }: { trades: Trade[] }) {
  if (trades.length === 0) {
    return (
      <Empty icon={<History size={26} />} title="No trades yet"
             hint="Every fill your team makes is recorded here." />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>Executed</th>
            <th>Symbol</th>
            <th>Side</th>
            <th className="r">Qty</th>
            <th className="r">Price</th>
            <th className="r hidden md:table-cell">Notional</th>
            <th className="r hidden lg:table-cell">Fees</th>
            <th className="r">Cash</th>
            <th className="r">Realised</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id}>
              <td className="num text-[11px] text-[var(--color-text-faint)] whitespace-nowrap">
                {stamp(t.executed_at)}
              </td>
              <td>
                <Link href={`/trade/${t.symbol}`}
                      className="num text-[12.5px] font-bold tracking-wide text-[var(--color-neon-bright)] hover:underline">
                  {t.symbol}
                </Link>
              </td>
              <td>
                <span className={cn("chip", t.side === "buy" ? "chip-up" : "chip-down")}>
                  {t.side}
                </span>
              </td>
              <td className="r num whitespace-nowrap">{qtyText(t.qty)}</td>
              <td className="r num font-medium whitespace-nowrap">{money(t.price)}</td>
              <td className="r num hidden md:table-cell text-[var(--color-text-dim)] whitespace-nowrap">
                {money(t.gross_amount)}
              </td>
              <td className="r num hidden lg:table-cell text-[var(--color-text-dim)] whitespace-nowrap">
                {money(t.commission)}
              </td>
              <td className={cn("r num whitespace-nowrap", toneClass(t.net_cash_delta))}>
                {signedMoney(t.net_cash_delta)}
              </td>
              <td className={cn("r num font-semibold whitespace-nowrap", toneClass(t.realized_pnl))}>
                {t.realized_pnl !== 0 ? signedMoney(t.realized_pnl) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
