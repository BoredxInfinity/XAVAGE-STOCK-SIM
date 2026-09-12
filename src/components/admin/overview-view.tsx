"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Activity, AlertTriangle, Loader2, Megaphone, Radio, Send, Trash2, Trophy,
} from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { StatTile } from "@/components/ui/stat-tile";
import { createClient } from "@/lib/supabase/client";
import { useAnnouncements, useLeaderboard, useMarketStatus } from "@/hooks/use-app-data";
import { useNow } from "@/hooks/use-now";
import { cn, money, pct, stamp } from "@/lib/format";
import type { MarketState } from "@/lib/database.types";

const SESSION_LABEL: Record<MarketState, string> = {
  regular: "Market open",
  pre: "Pre-market",
  post: "After hours",
  closed: "Market closed",
};

export function OverviewView() {
  const qc = useQueryClient();
  const { data: status } = useMarketStatus();
  const { data: teams = [] } = useLeaderboard();
  const { data: news = [] } = useAnnouncements();
  // The health strip has to age between polls. Recomputing the tick age only
  // when the 15s query returns means a dead feed can read "healthy" for a
  // quarter of a minute after it stopped, and the age jumps in 15s steps
  // rather than counting -- which is the difference between a status line an
  // organiser trusts and one they reload to check.
  const now = useNow();

  const [draft, setDraft] = useState({ title: "", body: "", severity: "info" });
  const [posting, setPosting] = useState(false);

  const { data: health } = useQuery({
    queryKey: ["system-health"],
    refetchInterval: 15_000,
    queryFn: async () => {
      const supabase = createClient();
      const [state, quotes, working, accounts] = await Promise.all([
        supabase.from("system_state").select("*").eq("id", true).maybeSingle(),
        supabase.from("quotes").select("symbol", { count: "exact", head: true }),
        supabase.from("orders").select("id", { count: "exact", head: true })
          .in("status", ["open", "partially_filled"]),
        supabase.from("profiles").select("id", { count: "exact", head: true }).eq("is_active", true),
      ]);
      return {
        state: state.data,
        quoteCount: quotes.count ?? 0,
        workingOrders: working.count ?? 0,
        activeAccounts: accounts.count ?? 0,
      };
    },
  });

  const state: MarketState = status?.market_state ?? "closed";
  const lastTick = health?.state?.last_tick_at ?? status?.last_tick_at ?? null;
  const tickAgeSec = lastTick ? (now - new Date(lastTick).getTime()) / 1000 : null;
  const feedHealthy = tickAgeSec != null && tickAgeSec < 120;

  async function post(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.title.trim()) return;
    setPosting(true);

    const res = await fetch("/api/admin/announcements", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });

    if (!res.ok) toast.error("Could not post", { description: (await res.json()).error });
    else {
      toast.success("Announcement published to every participant");
      setDraft({ title: "", body: "", severity: "info" });
      qc.invalidateQueries({ queryKey: ["announcements"] });
    }
    setPosting(false);
  }

  async function remove(id: string) {
    const res = await fetch(`/api/admin/announcements?id=${id}`, { method: "DELETE" });
    if (!res.ok) toast.error("Could not delete");
    else { toast.success("Removed"); qc.invalidateQueries({ queryKey: ["announcements"] }); }
  }

  const leader = teams[0];
  const totalEquity = teams.reduce((s, t) => s + t.equity, 0);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight">Control room</h1>
        <p className="text-xs text-[var(--color-text-dim)]">
          System health, live standings and the announcement wire.
        </p>
      </div>

      {/* health strip */}
      <div className={cn(
        "panel-glow p-4 flex flex-wrap items-center gap-x-8 gap-y-3",
        !feedHealthy && "!border-[color-mix(in_oklab,var(--color-warn)_45%,transparent)]",
      )}>
        {/* The exchange's session, in the same four states participants see. */}
        <div className="flex items-center gap-2">
          <Radio size={16} className={cn(
            state === "regular" ? "text-[var(--color-up)] live-dot"
              : state === "pre" || state === "post" ? "text-[var(--color-warn)] live-dot"
              : "text-[var(--color-down)]",
          )} />
          <div>
            <p className="text-xs font-semibold">{SESSION_LABEL[state]}</p>
            <p className="text-[11px] text-[var(--color-text-faint)]">
              {status?.is_open ? "book open" : "book closed"} · {state}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Activity size={16} className={status?.trading_enabled ? "text-[var(--color-up)]" : "text-[var(--color-down)]"} />
          <div>
            <p className="text-xs font-semibold">
              {status?.trading_enabled ? "Trading enabled" : "Trading halted"}
            </p>
            <p className="text-[11px] text-[var(--color-text-faint)]">
              {status?.halt_reason ?? `${health?.workingOrders ?? 0} orders working`}
            </p>
          </div>
        </div>

        <div className="flex-1" />

        {!feedHealthy && (
          <Link href="/admin/worker" className="chip chip-warn hover:opacity-80">
            <AlertTriangle size={11} /> Price feed stale
          </Link>
        )}

        <Link href="/admin/settings" className="btn btn-ghost !py-1.5 !text-xs">
          Adjust the game
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatTile accent="violet" label="Teams" value={teams.length} />
        <StatTile label="Active accounts" value={health?.activeAccounts ?? "—"} />
        <StatTile label="Symbols quoting" value={health?.quoteCount ?? "—"} />
        <StatTile label="Working orders" value={health?.workingOrders ?? "—"} />
        <StatTile label="Combined equity" value={money(totalEquity, true)} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        <Panel
          title={<span className="flex items-center gap-1.5"><Trophy size={12} /> Standings</span>}
          action={<Link href="/admin/rankings" className="text-[11px] text-[var(--color-neon-bright)] hover:underline">
            Full rankings
          </Link>}
        >
          <table className="tbl">
            <thead>
              <tr><th className="w-10">#</th><th>Team</th><th className="r">Equity</th><th className="r">Return</th></tr>
            </thead>
            <tbody>
              {teams.length === 0 && (
                <tr><td colSpan={4} className="text-center py-8 text-xs text-[var(--color-text-faint)]">
                  No teams yet — <Link href="/admin/teams" className="text-[var(--color-neon-bright)] hover:underline">create one</Link>.
                </td></tr>
              )}
              {teams.slice(0, 8).map((t, i) => (
                <tr key={t.team_id}>
                  <td className="num font-bold">{i + 1}</td>
                  <td className="text-xs font-medium">{t.team_name}</td>
                  <td className="r num">{money(t.equity)}</td>
                  <td className={cn("r num font-semibold",
                    t.return_pct > 0 ? "text-[var(--color-up)]"
                      : t.return_pct < 0 ? "text-[var(--color-down)]" : "")}>
                    {pct(t.return_pct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {leader && (
            <p className="px-4 py-2.5 text-[11px] text-[var(--color-text-faint)] border-t border-[var(--color-border-soft)]">
              {leader.team_name} leads with {pct(leader.return_pct)}.
              Rankings are {status?.settings.leaderboard_visible_to_participants ? "visible to" : "hidden from"} participants.
            </p>
          )}
        </Panel>

        <Panel title={<span className="flex items-center gap-1.5"><Megaphone size={12} /> Announcements</span>}
               bodyClassName="p-4 space-y-3">
          <form onSubmit={post} className="space-y-2">
            <input
              className="field" placeholder="Headline — e.g. Interest rates cut to 2%"
              value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
            <textarea
              className="field min-h-[70px] resize-y" placeholder="Detail (optional)"
              value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
            <div className="flex gap-2">
              <select className="field !w-36" value={draft.severity}
                      onChange={(e) => setDraft({ ...draft, severity: e.target.value })}>
                <option value="info">Info</option>
                <option value="success">Good news</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select>
              <button type="submit" disabled={!draft.title.trim() || posting} className="btn btn-primary flex-1">
                {posting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Publish
              </button>
            </div>
          </form>

          <div className="divide-y divide-[var(--color-border-soft)] max-h-64 overflow-y-auto -mx-1">
            {news.map((n) => (
              <div key={n.id} className="py-2 px-1 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold truncate">{n.title}</p>
                  <p className="text-[10px] text-[var(--color-text-faint)]">{stamp(n.created_at)}</p>
                </div>
                <button onClick={() => remove(n.id)}
                        className="p-1 text-[var(--color-text-faint)] hover:text-[var(--color-down)]"
                        aria-label={`Delete ${n.title}`}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </Panel>
      </div>

    </div>
  );
}
