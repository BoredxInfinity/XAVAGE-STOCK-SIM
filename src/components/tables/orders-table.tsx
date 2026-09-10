"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ClipboardList, Loader2, X } from "lucide-react";
import { Empty } from "@/components/ui/empty";
import { createClient } from "@/lib/supabase/client";
import {
  ORDER_TYPE_LABEL, STATUS_LABEL, TIF_LABEL,
  cn, isWorking, money, qtyText, stamp, statusChipClass,
} from "@/lib/format";
import type { Order } from "@/lib/database.types";

function triggerText(order: Order) {
  switch (order.order_type) {
    case "limit": return `Limit ${money(order.limit_price)}`;
    case "stop": return `Stop ${money(order.stop_price)}`;
    case "stop_limit": return `Stop ${money(order.stop_price)} → Limit ${money(order.limit_price)}`;
    case "trailing_stop":
      return order.trail_percent != null
        ? `Trail ${order.trail_percent}%`
        : `Trail ${money(order.trail_amount)}`;
    default: return "Market";
  }
}

export function OrdersTable({
  orders, showCancel = true, emptyHint,
}: { orders: Order[]; showCancel?: boolean; emptyHint?: string }) {
  const qc = useQueryClient();
  const [cancelling, setCancelling] = useState<string | null>(null);

  async function cancel(id: string) {
    setCancelling(id);
    const { data, error } = await createClient().rpc("cancel_order", { p_order_id: id });

    if (error) toast.error("Could not cancel", { description: error.message });
    else toast.success((data as unknown as { message: string }).message);

    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["portfolio"] });
    setCancelling(null);
  }

  if (orders.length === 0) {
    return <Empty icon={<ClipboardList size={26} />} title="No orders" hint={emptyHint} />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>Placed</th>
            <th>Symbol</th>
            <th>Side</th>
            <th>Type</th>
            <th className="r">Qty</th>
            <th className="r hidden md:table-cell">Filled</th>
            <th className="hidden lg:table-cell">Trigger</th>
            <th className="r hidden lg:table-cell">Avg fill</th>
            <th>Status</th>
            {showCancel && <th />}
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td className="num text-[11px] text-[var(--color-text-faint)] whitespace-nowrap">
                {stamp(o.created_at)}
              </td>
              <td>
                <Link href={`/trade/${o.symbol}`}
                      className="num text-xs font-bold text-[var(--color-neon-bright)] hover:underline">
                  {o.symbol}
                </Link>
              </td>
              <td>
                <span className={cn("chip", o.side === "buy" ? "chip-up" : "chip-down")}>
                  {o.side}
                </span>
              </td>
              <td className="text-[11px] text-[var(--color-text-dim)] whitespace-nowrap">
                {ORDER_TYPE_LABEL[o.order_type]}
                <span className="ml-1 text-[10px] text-[var(--color-text-faint)]">
                  {TIF_LABEL[o.tif]}
                </span>
              </td>
              <td className="r num">{qtyText(o.qty)}</td>
              <td className="r num hidden md:table-cell text-[var(--color-text-dim)]">
                {qtyText(o.filled_qty)}
              </td>
              <td className="hidden lg:table-cell num text-[11px] text-[var(--color-text-dim)] whitespace-nowrap">
                {triggerText(o)}
              </td>
              <td className="r num hidden lg:table-cell">
                {o.avg_fill_price ? money(o.avg_fill_price) : "—"}
              </td>
              <td>
                <span className={statusChipClass(o.status)}>{STATUS_LABEL[o.status]}</span>
                {o.reject_reason && !isWorking(o.status) && (
                  <span className="block text-[10px] text-[var(--color-text-faint)] max-w-[180px] truncate"
                        title={o.reject_reason}>
                    {o.reject_reason}
                  </span>
                )}
              </td>
              {showCancel && (
                <td className="r">
                  {isWorking(o.status) && (
                    <button
                      onClick={() => cancel(o.id)} disabled={cancelling === o.id}
                      className="btn btn-danger !px-2 !py-1 !text-[11px]"
                      aria-label={`Cancel ${o.side} order for ${o.symbol}`}
                    >
                      {cancelling === o.id
                        ? <Loader2 size={12} className="animate-spin" />
                        : <X size={12} />}
                      Cancel
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
