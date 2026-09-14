"use client";

import { useMemo, useState } from "react";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/page-header";
import { Segmented } from "@/components/ui/segmented";
import { OrdersTable } from "@/components/tables/orders-table";
import { useOrders } from "@/hooks/use-app-data";
import { isWorking } from "@/lib/format";

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
      <PageHeader
        title="Orders"
        subtitle="Pending, executed and cancelled orders for your team's book."
        action={
          <Segmented
            label="Order status"
            value={tab}
            onChange={setTab}
            className="max-w-full overflow-x-auto no-scrollbar"
            options={TABS.map((t) => ({ value: t.id, label: t.label, badge: counts[t.id] }))}
          />
        }
      />

      <Panel bodyClassName="overflow-x-auto">
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
