"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check, Copy, Download, Eye, EyeOff, Loader2,
  RefreshCw, ShieldCheck, TriangleAlert, UserPlus, UserX,
} from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { createClient } from "@/lib/supabase/client";
import { cn, relative } from "@/lib/format";
import type { Team } from "@/lib/database.types";

interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  role: "admin" | "participant";
  team_id: string | null;
  is_active: boolean;
  must_change_password: boolean;
  last_login_at: string | null;
  created_at: string;
  /** Organiser-issued credential. Null for accounts created before this existed. */
  issued_password: string | null;
  /** True once the user changed their own password: the stored value no longer works. */
  password_is_stale: boolean;
  password_issued_at: string | null;
}

export function UsersView() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: "", display_name: "", role: "participant", team_id: "" });
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // Passwords stay masked until asked for, so a projector or a shoulder in a
  // crowded hall doesn't expose the whole cohort at once.
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [revealAll, setRevealAll] = useState(false);

  function toggleReveal(id: string) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const { data: users = [], isLoading } = useQuery({
    queryKey: ["admin-users"],
    queryFn: async (): Promise<AdminUser[]> => {
      const res = await fetch("/api/admin/users");
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load accounts");
      return (await res.json()).users;
    },
  });

  const { data: teams = [] } = useQuery({
    queryKey: ["admin-teams"],
    queryFn: async (): Promise<Team[]> => {
      const { data, error } = await createClient().from("teams").select("*").order("name");
      if (error) throw error;
      return (data ?? []) as Team[];
    },
  });

  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? null;
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-users"] });

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setIssued(null);

    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: form.email.trim().toLowerCase(),
        display_name: form.display_name.trim(),
        role: form.role,
        team_id: form.team_id || null,
      }),
    });

    const json = await res.json();
    if (!res.ok) {
      toast.error("Could not create account", { description: json.error });
    } else {
      setIssued({ email: form.email.trim().toLowerCase(), password: json.temporary_password });
      setForm({ email: "", display_name: "", role: "participant", team_id: form.team_id });
      toast.success("Account created");
      refresh();
    }
    setBusy(false);
  }

  async function patch(id: string, body: Record<string, unknown>, label: string) {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) toast.error("Failed", { description: (await res.json()).error });
    else { toast.success(label); refresh(); }
  }

  /** Mint a fresh readable credential server-side and store it against the account. */
  async function regeneratePassword(user: AdminUser) {
    if (!window.confirm(
      `Issue a new password for ${user.display_name}?\n\nTheir current one stops working immediately.`
    )) return;

    const res = await fetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ regenerate: true }),
    });
    const json = await res.json();

    if (!res.ok) {
      toast.error("Failed", { description: json.error });
      return;
    }
    setIssued({ email: user.email, password: json.password });
    setRevealed((prev) => new Set(prev).add(user.id));
    toast.success(`New password issued for ${user.display_name}`);
    refresh();
  }

  /** Credential slips for handing out. */
  function exportCredentials() {
    const rows = users
      .filter((u) => u.role === "participant" && u.issued_password && !u.password_is_stale)
      .map((u) => [u.display_name, u.email, u.issued_password, teamName(u.team_id) ?? "No team"]);

    if (rows.length === 0) { toast.error("No issued credentials to export."); return; }

    const csv = [["Name", "Email", "Password", "Team"], ...rows]
      .map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `xavage-credentials-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rows.length} credential${rows.length === 1 ? "" : "s"}`);
  }

  function copyCredentials() {
    if (!issued) return;
    navigator.clipboard.writeText(`Email: ${issued.email}\nTemporary password: ${issued.password}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Accounts</h1>
          <p className="text-xs text-[var(--color-text-dim)]">
            You issue every credential, so you can read them back here to hand out or recover.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setRevealAll((v) => !v)} className="btn btn-ghost !py-1.5">
            {revealAll ? <EyeOff size={14} /> : <Eye size={14} />}
            {revealAll ? "Hide all" : "Reveal all"}
          </button>
          <button onClick={exportCredentials} className="btn btn-primary !py-1.5">
            <Download size={14} /> Export slips
          </button>
        </div>
      </div>

      {issued && (
        <div className="panel-glow p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-violet)] mb-2">
                Newly issued credentials
              </h2>
              <dl className="space-y-1 text-xs">
                <div className="flex gap-2">
                  <dt className="text-[var(--color-text-faint)] w-20">Email</dt>
                  <dd className="num">{issued.email}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-[var(--color-text-faint)] w-20">Password</dt>
                  <dd className="num font-bold text-[var(--color-neon-bright)]">{issued.password}</dd>
                </div>
              </dl>
              <p className="text-[10.5px] text-[var(--color-text-faint)] mt-2">
                Hand this to the participant. It also stays visible in the table below.
              </p>
            </div>
            <div className="flex flex-col gap-1.5 shrink-0">
              <button onClick={copyCredentials} className="btn btn-ghost !py-1.5 !text-xs">
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
              </button>
              <button onClick={() => setIssued(null)} className="btn btn-ghost !py-1.5 !text-xs">
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      <Panel title="Create an account" bodyClassName="p-4">
        <form onSubmit={createUser} className="grid sm:grid-cols-2 lg:grid-cols-5 gap-2 items-end">
          <div>
            <label className="label" htmlFor="u-name">Display name</label>
            <input id="u-name" className="field" required value={form.display_name}
                   placeholder="Priya Nair"
                   onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="u-email">Email</label>
            <input id="u-email" type="email" className="field" required value={form.email}
                   placeholder="priya@college.edu"
                   onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="u-team">Team</label>
            <select id="u-team" className="field" value={form.team_id}
                    onChange={(e) => setForm({ ...form, team_id: e.target.value })}>
              <option value="">No team</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="u-role">Role</label>
            <select id="u-role" className="field" value={form.role}
                    onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="participant">Participant</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <button type="submit" disabled={busy} className="btn btn-primary">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />} Create
          </button>
        </form>
      </Panel>

      <Panel title={`${users.length} account${users.length === 1 ? "" : "s"}`}>
        {isLoading ? <div className="h-48 skeleton" /> : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th><th>Email</th><th>Team</th><th>Role</th>
                  <th>Password</th>
                  <th className="hidden xl:table-cell">Last sign-in</th>
                  <th>Status</th><th className="r">Controls</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 && (
                  <tr><td colSpan={8} className="text-center py-10 text-xs text-[var(--color-text-faint)]">
                    No accounts yet.
                  </td></tr>
                )}
                {users.map((u) => (
                  <tr key={u.id} className={cn(!u.is_active && "opacity-55")}>
                    <td className="text-xs font-semibold">{u.display_name}</td>
                    <td className="num text-[11px] text-[var(--color-text-dim)]">{u.email}</td>
                    <td>
                      <select
                        className="field !py-1 !text-[11px] !w-36"
                        value={u.team_id ?? ""}
                        onChange={(e) => patch(u.id, { team_id: e.target.value || null },
                                               `${u.display_name} reassigned`)}
                      >
                        <option value="">No team</option>
                        {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <span className={cn("chip", u.role === "admin" ? "chip-violet" : "chip-neutral")}>
                        {u.role === "admin" && <ShieldCheck size={10} />} {u.role}
                      </span>
                    </td>
                    <td>
                      {!u.issued_password ? (
                        <span className="text-[11px] text-[var(--color-text-faint)]">
                          not recorded
                        </span>
                      ) : u.password_is_stale ? (
                        <span className="chip chip-warn" title="This user changed their own password, so the issued one no longer works. Issue a new one to regain access.">
                          <TriangleAlert size={10} /> changed by user
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5">
                          <span className="num text-[11px] font-semibold text-[var(--color-neon-bright)] w-[130px] inline-block">
                            {revealAll || revealed.has(u.id) ? u.issued_password : "•".repeat(14)}
                          </span>
                          <button
                            onClick={() => toggleReveal(u.id)}
                            className="p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
                            aria-label={revealed.has(u.id) ? "Hide password" : "Reveal password"}
                          >
                            {revealAll || revealed.has(u.id) ? <EyeOff size={12} /> : <Eye size={12} />}
                          </button>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(
                                `Email: ${u.email}\nPassword: ${u.issued_password}`);
                              toast.success(`Credentials for ${u.display_name} copied`);
                            }}
                            className="p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
                            aria-label={`Copy credentials for ${u.display_name}`}
                          >
                            <Copy size={12} />
                          </button>
                        </span>
                      )}
                    </td>
                    <td className="hidden xl:table-cell text-[11px] text-[var(--color-text-faint)]">
                      {u.last_login_at ? relative(u.last_login_at) : "never"}
                    </td>
                    <td>
                      {!u.is_active ? <span className="chip chip-down">Disabled</span>
                        : <span className="chip chip-up">Active</span>}
                    </td>
                    <td className="r">
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => regeneratePassword(u)}
                                className="btn btn-ghost !px-2 !py-1 !text-[11px]"
                                title="Issue a new password">
                          <RefreshCw size={12} />
                        </button>
                        <button
                          onClick={() => patch(u.id, { is_active: !u.is_active },
                                               u.is_active ? `${u.display_name} disabled` : `${u.display_name} re-enabled`)}
                          className={cn("btn !px-2 !py-1 !text-[11px]", u.is_active ? "btn-danger" : "btn-ghost")}
                          title={u.is_active ? "Disable account" : "Re-enable account"}
                        >
                          <UserX size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
