"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Banknote, Loader2, Lock, Plus, RefreshCcw, ShieldOff, Snowflake, Trash2, Unlock,
} from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { createClient } from "@/lib/supabase/client";
import { useLeaderboard } from "@/hooks/use-app-data";
import { cn, money, pct, signedMoney, toneClass } from "@/lib/format";
import type { Team } from "@/lib/database.types";

export function TeamsView() {
  const qc = useQueryClient();
  const { data: standings = [] } = useLeaderboard();
  const [name, setName] = useState("");
  const [capital, setCapital] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const { data: teams = [], isLoading } = useQuery({
    queryKey: ["admin-teams"],
    queryFn: async (): Promise<Team[]> => {
      const { data, error } = await createClient()
        .from("teams").select("*").order("name");
      if (error) throw error;
      return (data ?? []) as Team[];
    },
  });

  function refresh() {
    qc.invalidateQueries({ queryKey: ["admin-teams"] });
    qc.invalidateQueries({ queryKey: ["leaderboard"] });
  }

  async function call(label: string, fn: () => Promise<{ error: { message: string } | null }>) {
    setBusy(label);
    const { error } = await fn();
    if (error) toast.error("Failed", { description: error.message });
    else { toast.success(label); refresh(); }
    setBusy(null);
  }

  async function createTeam(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await call(`Created ${name.trim()}`, async () =>
      createClient().rpc("admin_create_team", {
        p_name: name.trim(),
        p_capital: capital ? Number(capital) : undefined,
      }));
    setName(""); setCapital("");
  }

  async function adjustCash(team: Team) {
    const raw = window.prompt(
      `Adjust cash for ${team.name}.\nPositive credits the team, negative debits it.`, "");
    if (raw == null) return;
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount === 0) {
      toast.error("Enter a non-zero number."); return;
    }
    const note = window.prompt("Reason for the ledger entry:", "Administrator adjustment") ?? undefined;
    await call(`Adjusted ${team.name} by ${money(amount)}`, async () =>
      createClient().rpc("admin_adjust_cash", { p_team_id: team.id, p_amount: amount, p_note: note }));
  }

  async function toggleFreeze(team: Team) {
    // Clients never write to `teams` directly -- the RPC is the only door in.
    await call(team.is_frozen ? `${team.name} unfrozen` : `${team.name} frozen`, async () =>
      createClient().rpc("admin_set_team_frozen", {
        p_team_id: team.id, p_frozen: !team.is_frozen,
      }));
  }

  async function resetTeam(team: Team) {
    if (!window.confirm(
      `Reset ${team.name}?\n\nThis DELETES all their orders, trades, positions and ledger, and restores ${money(team.initial_capital)}.\n\nThis cannot be undone.`
    )) return;
    await call(`${team.name} reset`, async () =>
      createClient().rpc("admin_reset_team", { p_team_id: team.id }));
  }

  async function liquidate(team: Team) {
    if (!window.confirm(
      `Liquidate every position held by ${team.name} at the live market?\n\nOpen orders are cancelled first. Trades are recorded normally.`
    )) return;
    await call(`${team.name} liquidated`, async () =>
      createClient().rpc("admin_liquidate_team", { p_team_id: team.id }));
  }

  const standing = (id: string) => standings.find((s) => s.team_id === id);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight">Teams</h1>
        <p className="text-xs text-[var(--color-text-dim)]">
          Each team shares one book — one cash balance and one set of positions across all its members.
        </p>
      </div>

      <Panel title="Create a team" bodyClassName="p-4">
        <form onSubmit={createTeam} className="flex flex-col sm:flex-row gap-2 sm:items-end">
          <div className="flex-1">
            <label className="label" htmlFor="team-name">Team name</label>
            <input id="team-name" className="field" value={name} required
                   placeholder="e.g. Bear Necessities"
                   onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="w-full sm:w-52">
            <label className="label" htmlFor="team-capital">Starting capital</label>
            <input id="team-capital" type="number" step="1000" className="field num"
                   placeholder="use default" value={capital}
                   onChange={(e) => setCapital(e.target.value)} />
          </div>
          <button type="submit" disabled={!name.trim() || busy != null} className="btn btn-primary">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Create
          </button>
        </form>
      </Panel>

      <Panel title={`${teams.length} team${teams.length === 1 ? "" : "s"}`}>
        {isLoading ? <div className="h-48 skeleton" /> : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Team</th>
                  <th className="hidden md:table-cell">Code</th>
                  <th className="r">Cash</th>
                  <th className="r hidden lg:table-cell">Committed</th>
                  <th className="r">Equity</th>
                  <th className="r">Return</th>
                  <th>Status</th>
                  <th className="r">Controls</th>
                </tr>
              </thead>
              <tbody>
                {teams.length === 0 && (
                  <tr><td colSpan={8} className="text-center py-10 text-xs text-[var(--color-text-faint)]">
                    No teams yet — create the first one above.
                  </td></tr>
                )}
                {teams.map((t) => {
                  const s = standing(t.id);
                  return (
                    <tr key={t.id}>
                      <td>
                        <span className="text-xs font-semibold">{t.name}</span>
                        <span className="block text-[10px] text-[var(--color-text-faint)]">
                          started {money(t.initial_capital)}
                        </span>
                      </td>
                      <td className="hidden md:table-cell num text-[11px] text-[var(--color-text-dim)]">
                        {t.join_code}
                      </td>
                      <td className="r num">{money(t.cash)}</td>
                      <td className="r num hidden lg:table-cell text-[var(--color-text-dim)]">
                        {t.reserved_cash > 0 ? money(t.reserved_cash) : "—"}
                      </td>
                      <td className="r num font-semibold">{s ? money(s.equity) : "—"}</td>
                      <td className={cn("r num", toneClass(s?.return_pct))}>
                        {s ? pct(s.return_pct) : "—"}
                        {s && <span className="block text-[10px]">{signedMoney(s.total_pnl)}</span>}
                      </td>
                      <td>
                        {t.is_frozen
                          ? <span className="chip chip-warn"><Snowflake size={10} /> Frozen</span>
                          : <span className="chip chip-up">Active</span>}
                      </td>
                      <td className="r">
                        <div className="flex gap-1 justify-end">
                          <button onClick={() => adjustCash(t)} disabled={busy != null}
                                  className="btn btn-ghost !px-2 !py-1 !text-[11px]" title="Adjust cash">
                            <Banknote size={12} />
                          </button>
                          <button onClick={() => toggleFreeze(t)} disabled={busy != null}
                                  className="btn btn-ghost !px-2 !py-1 !text-[11px]"
                                  title={t.is_frozen ? "Unfreeze" : "Freeze trading"}>
                            {t.is_frozen ? <Unlock size={12} /> : <Lock size={12} />}
                          </button>
                          <button onClick={() => liquidate(t)} disabled={busy != null}
                                  className="btn btn-ghost !px-2 !py-1 !text-[11px]" title="Liquidate all positions">
                            <ShieldOff size={12} />
                          </button>
                          <button onClick={() => resetTeam(t)} disabled={busy != null}
                                  className="btn btn-danger !px-2 !py-1 !text-[11px]" title="Reset team (destructive)">
                            <RefreshCcw size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="text-[11px] text-[var(--color-text-faint)] flex items-start gap-1.5">
        <Trash2 size={12} className="mt-px shrink-0" />
        Reset wipes a team&apos;s entire trading record. Use it to clear practice runs before the
        competition starts — never mid-event.
      </p>
    </div>
  );
}
