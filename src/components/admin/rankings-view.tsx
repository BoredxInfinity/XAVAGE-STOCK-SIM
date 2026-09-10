"use client";

import { useMemo, useState } from "react";
import { Download, EyeOff, Medal, RefreshCw } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { StatTile } from "@/components/ui/stat-tile";
import { EquityChart } from "@/components/trade/equity-chart";
import { useEquityCurve, useLeaderboard, useMarketStatus } from "@/hooks/use-app-data";
import { cn, money, pct, qtyText, signedMoney, stamp, toneClass } from "@/lib/format";

export function RankingsView() {
  const { data: teams = [], isLoading, refetch, isFetching } = useLeaderboard();
  const { data: status } = useMarketStatus();
  const [selected, setSelected] = useState<string | null>(null);
  const { data: curve = [] } = useEquityCurve(selected ?? undefined);

  const stats = useMemo(() => {
    if (teams.length === 0) return null;
    const returns = teams.map((t) => t.return_pct);
    const equity = teams.reduce((s, t) => s + t.equity, 0);
    return {
      best: teams[0],
      worst: teams[teams.length - 1],
      avgReturn: returns.reduce((a, b) => a + b, 0) / returns.length,
      totalEquity: equity,
      totalTrades: teams.reduce((s, t) => s + t.trade_count, 0),
    };
  }, [teams]);

  function exportCsv() {
    const header = ["rank", "team", "equity", "initial_capital", "total_pnl", "return_pct",
                    "realized_pnl", "unrealized_pnl", "cash", "open_positions", "trades", "members"];
    const rows = teams.map((t, i) => [
      i + 1, t.team_name, t.equity, t.initial_capital, t.total_pnl, t.return_pct,
      t.realized_pnl, t.unrealized_pnl, t.cash, t.open_positions, t.trade_count,
      (t.members ?? []).join(" | "),
    ]);
    const csv = [header, ...rows]
      .map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `xavage-rankings-${new Date().toISOString().slice(0, 16).replace(":", "")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const medal = (i: number) =>
    i === 0 ? "text-[#ffd35c]" : i === 1 ? "text-[#c9d1e0]" : i === 2 ? "text-[#d08b52]" : "";

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Rankings</h1>
          <p className="text-xs text-[var(--color-text-dim)] flex items-center gap-1.5">
            <EyeOff size={11} />
            {status?.settings.leaderboard_visible_to_participants
              ? "Currently VISIBLE to participants — change this in Game settings."
              : "Hidden from participants. Only admins can see this page."}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => refetch()} className="btn btn-ghost !py-1.5">
            <RefreshCw size={14} className={isFetching ? "animate-spin" : ""} /> Refresh
          </button>
          <button onClick={exportCsv} disabled={teams.length === 0} className="btn btn-primary !py-1.5">
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile accent="violet" label="Leader" value={stats.best.team_name}
                    sub={<span className={toneClass(stats.best.return_pct)}>{pct(stats.best.return_pct)}</span>} />
          <StatTile label="Average return"
                    tone={stats.avgReturn >= 0 ? "up" : "down"} value={pct(stats.avgReturn)} />
          <StatTile label="Combined equity" value={money(stats.totalEquity, true)} />
          <StatTile label="Trades placed" value={qtyText(stats.totalTrades)} />
        </div>
      )}

      <Panel title={`Standings · ${teams.length} team${teams.length === 1 ? "" : "s"}`}>
        {isLoading ? (
          <div className="h-64 skeleton" />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-12">#</th>
                  <th>Team</th>
                  <th className="hidden xl:table-cell">Members</th>
                  <th className="r">Equity</th>
                  <th className="r">Total P&L</th>
                  <th className="r">Return</th>
                  <th className="r hidden lg:table-cell">Realised</th>
                  <th className="r hidden lg:table-cell">Unrealised</th>
                  <th className="r hidden md:table-cell">Cash</th>
                  <th className="r hidden md:table-cell">Pos.</th>
                  <th className="r hidden md:table-cell">Trades</th>
                </tr>
              </thead>
              <tbody>
                {teams.length === 0 && (
                  <tr><td colSpan={11} className="text-center py-10 text-xs text-[var(--color-text-faint)]">
                    No active teams yet. Create them under Teams.
                  </td></tr>
                )}
                {teams.map((t, i) => (
                  <tr
                    key={t.team_id}
                    onClick={() => setSelected(selected === t.team_id ? null : t.team_id)}
                    className={cn("cursor-pointer",
                      selected === t.team_id && "bg-[color-mix(in_oklab,var(--color-violet)_10%,transparent)]")}
                  >
                    <td>
                      <span className={cn("num font-bold flex items-center gap-1", medal(i))}>
                        {i < 3 && <Medal size={12} />}{i + 1}
                      </span>
                    </td>
                    <td>
                      <span className="text-xs font-semibold">{t.team_name}</span>
                      {t.is_frozen && <span className="ml-1.5 chip chip-warn">Frozen</span>}
                    </td>
                    <td className="hidden xl:table-cell text-[11px] text-[var(--color-text-dim)] max-w-[240px] truncate">
                      {(t.members ?? []).join(", ") || "—"}
                    </td>
                    <td className="r num font-semibold">{money(t.equity)}</td>
                    <td className={cn("r num", toneClass(t.total_pnl))}>{signedMoney(t.total_pnl)}</td>
                    <td className={cn("r num font-semibold", toneClass(t.return_pct))}>{pct(t.return_pct)}</td>
                    <td className={cn("r num hidden lg:table-cell", toneClass(t.realized_pnl))}>
                      {signedMoney(t.realized_pnl)}
                    </td>
                    <td className={cn("r num hidden lg:table-cell", toneClass(t.unrealized_pnl))}>
                      {signedMoney(t.unrealized_pnl)}
                    </td>
                    <td className="r num hidden md:table-cell text-[var(--color-text-dim)]">{money(t.cash, true)}</td>
                    <td className="r num hidden md:table-cell text-[var(--color-text-dim)]">{t.open_positions}</td>
                    <td className="r num hidden md:table-cell text-[var(--color-text-dim)]">{t.trade_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {selected && (
        <Panel
          glow
          title={`Equity curve · ${teams.find((t) => t.team_id === selected)?.team_name ?? ""}`}
          action={
            <button onClick={() => setSelected(null)}
                    className="text-[11px] text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
              Close
            </button>
          }
          bodyClassName="p-2"
        >
          <EquityChart
            points={curve as { ts: string; equity: number }[]}
            initialCapital={teams.find((t) => t.team_id === selected)?.initial_capital}
            height={260}
          />
        </Panel>
      )}

      <p className="text-[11px] text-[var(--color-text-faint)] text-center">
        Marked live at {stamp(new Date().toISOString())} · click a team to see its equity curve
      </p>
    </div>
  );
}
