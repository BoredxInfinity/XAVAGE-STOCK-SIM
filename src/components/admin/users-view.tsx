"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check, Copy, KeyRound, Loader2, ShieldCheck, UserPlus, UserX,
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
}

export function UsersView() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: "", display_name: "", role: "participant", team_id: "" });
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

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

  async function resetPassword(user: AdminUser) {
    const pw = window.prompt(
      `New temporary password for ${user.display_name} (min 10 characters).\nThey'll be forced to change it at next sign-in.`,
      "",
    );
    if (!pw) return;
    if (pw.length < 10) { toast.error("Password must be at least 10 characters."); return; }

    const res = await fetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_password: pw }),
    });
    if (!res.ok) toast.error("Failed", { description: (await res.json()).error });
    else { setIssued({ email: user.email, password: pw }); toast.success("Password reset"); refresh(); }
  }

  function copyCredentials() {
    if (!issued) return;
    navigator.clipboard.writeText(`Email: ${issued.email}\nTemporary password: ${issued.password}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight">Accounts</h1>
        <p className="text-xs text-[var(--color-text-dim)]">
          You provision every account. Each new user gets a one-time password and must change it at first sign-in.
        </p>
      </div>

      {issued && (
        <div className="panel-glow p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-violet)] mb-2">
                Credentials — shown once
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
                Hand this to the participant. It won&apos;t be shown again — you can always reset it below.
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
                  <th className="hidden lg:table-cell">Last sign-in</th>
                  <th>Status</th><th className="r">Controls</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 && (
                  <tr><td colSpan={7} className="text-center py-10 text-xs text-[var(--color-text-faint)]">
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
                    <td className="hidden lg:table-cell text-[11px] text-[var(--color-text-faint)]">
                      {u.last_login_at ? relative(u.last_login_at) : "never"}
                    </td>
                    <td>
                      {!u.is_active ? <span className="chip chip-down">Disabled</span>
                        : u.must_change_password ? <span className="chip chip-warn">Temp password</span>
                        : <span className="chip chip-up">Active</span>}
                    </td>
                    <td className="r">
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => resetPassword(u)}
                                className="btn btn-ghost !px-2 !py-1 !text-[11px]" title="Reset password">
                          <KeyRound size={12} />
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
