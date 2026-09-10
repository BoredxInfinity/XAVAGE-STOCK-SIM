"use client";

import { useMemo, useState } from "react";
import { Panel } from "@/components/ui/panel";
import { OrdersTable } from "@/components/tables/orders-table";
import { useOrders } from "@/hooks/use-app-data";
import { cn, isWorking } from "@/lib/format";

const TABS = [
  { id: "working", label: "Working" },
  { id: "filled", label: "Filled" },
  { id: "closed", label: "Cancelled & rejected" },
  { id: "all", label: "All" },
] as const;

type Tab = (typeof TABS)[number]["id"];

export function OrdersView() {
  const [tab, setTab] = useState<Tab>("working");
  const { data: orders = [], isLoading } = useOrders({ limit: 400 });

  const counts = useMemo(() => ({
    working: orders.filter((o) => isWorking(o.status)).length,
    filled: orders.filter((o) => o.status === "filled").length,
    closed: orders.filter((o) => ["cancelled", "rejected", "expired"].includes(o.status)).length,
    all: orders.length,
  }), [orders]);

  const visible = useMemo(() => {
    switch (tab) {
      case "working": return orders.filter((o) => isWorking(o.status));
      case "filled": return orders.filter((o) => o.status === "filled");
      case "closed": return orders.filter((o) => ["cancelled", "rejected", "expired"].includes(o.status));
      default: return orders;
    }
  }, [orders, tab]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight">Orders</h1>
        <p className="text-xs text-[var(--color-text-dim)]">
          Pending, executed and cancelled orders for your team&apos;s book.
        </p>
      </div>

      <div className="flex gap-1 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t.id} onClick={() => setTab(t.id)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border",
              tab === t.id
                ? "bg-[color-mix(in_oklab,var(--color-neon)_15%,transparent)] border-[var(--color-neon)] text-[var(--color-neon-bright)]"
                : "border-[var(--color-border)] text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]",
            )}
          >
            {t.label}
            <span className="ml-1.5 num opacity-70">{counts[t.id]}</span>
          </button>
        ))}
      </div>

      <Panel>
        {isLoading
          ? <div className="h-64 skeleton" />
          : <OrdersTable
              orders={visible}
              emptyHint={tab === "working"
                ? "No resting orders. Limit, stop and trailing orders wait here until they trigger."
                : undefined}
            />}
      </Panel>
    </div>
  );
}
