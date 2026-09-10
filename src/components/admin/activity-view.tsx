"use client";

import { useQuery } from "@tanstack/react-query";
import { Panel } from "@/components/ui/panel";
import { createClient } from "@/lib/supabase/client";
import { stamp } from "@/lib/format";

export function ActivityView() {
  const { data: audit = [] } = useQuery({
    queryKey: ["audit-log"],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from("audit_log").select("*").order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: history = [] } = useQuery({
    queryKey: ["settings-history"],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from("settings_history").select("*").order("changed_at", { ascending: false }).limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: recentTrades = [] } = useQuery({
    queryKey: ["all-trades"],
    refetchInterval: 15_000,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from("trades").select("*").order("executed_at", { ascending: false }).limit(60);
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight">Activity</h1>
        <p className="text-xs text-[var(--color-text-dim)]">
          Full audit trail. Every admin action and settings change is recorded and cannot be edited from the app.
        </p>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        <Panel title="Settings changes" bodyClassName="max-h-[440px] overflow-y-auto">
          <table className="tbl">
            <thead>
              <tr><th>When</th><th>Field</th><th>From</th><th>To</th></tr>
            </thead>
            <tbody>
              {history.length === 0 && (
                <tr><td colSpan={4} className="text-center py-8 text-xs text-[var(--color-text-faint)]">
                  No settings have been changed yet.
                </td></tr>
              )}
              {history.map((h) => (
                <tr key={h.id}>
                  <td className="num text-[11px] text-[var(--color-text-faint)] whitespace-nowrap">
                    {stamp(h.changed_at)}
                  </td>
                  <td className="text-[11px] font-medium">{h.field}</td>
                  <td className="num text-[11px] text-[var(--color-down)]">{h.old_value ?? "—"}</td>
                  <td className="num text-[11px] text-[var(--color-up)]">{h.new_value ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Admin actions" bodyClassName="max-h-[440px] overflow-y-auto">
          <table className="tbl">
            <thead>
              <tr><th>When</th><th>Action</th><th>Target</th></tr>
            </thead>
            <tbody>
              {audit.length === 0 && (
                <tr><td colSpan={3} className="text-center py-8 text-xs text-[var(--color-text-faint)]">
                  Nothing logged yet.
                </td></tr>
              )}
              {audit.map((a) => (
                <tr key={a.id}>
                  <td className="num text-[11px] text-[var(--color-text-faint)] whitespace-nowrap">
                    {stamp(a.created_at)}
                  </td>
                  <td className="text-[11px] font-medium">{a.action}</td>
                  <td className="text-[11px] text-[var(--color-text-dim)] max-w-[240px] truncate"
                      title={JSON.stringify(a.details)}>
                    {a.entity_type}
                    {a.details && Object.keys(a.details).length > 0 && (
                      <span className="text-[var(--color-text-faint)]"> · {JSON.stringify(a.details)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel title="Live trade tape · all teams" bodyClassName="max-h-[400px] overflow-y-auto">
        <table className="tbl">
          <thead>
            <tr><th>When</th><th>Symbol</th><th>Side</th><th className="r">Qty</th>
                <th className="r">Price</th><th className="r">Realised</th></tr>
          </thead>
          <tbody>
            {recentTrades.length === 0 && (
              <tr><td colSpan={6} className="text-center py-8 text-xs text-[var(--color-text-faint)]">
                No trades yet.
              </td></tr>
            )}
            {recentTrades.map((t) => (
              <tr key={t.id}>
                <td className="num text-[11px] text-[var(--color-text-faint)] whitespace-nowrap">
                  {stamp(t.executed_at)}
                </td>
                <td className="num text-xs font-bold text-[var(--color-neon-bright)]">{t.symbol}</td>
                <td>
                  <span className={t.side === "buy" ? "chip chip-up" : "chip chip-down"}>{t.side}</span>
                </td>
                <td className="r num">{t.qty}</td>
                <td className="r num">{t.price}</td>
                <td className="r num">{t.realized_pnl !== 0 ? t.realized_pnl : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
