"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Check, Loader2, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

/** Deliberately simple, explainable rules — participants must not get stuck here. */
const RULES = [
  { id: "len", label: "At least 10 characters", test: (p: string) => p.length >= 10 },
  { id: "case", label: "Upper and lower case", test: (p: string) => /[a-z]/.test(p) && /[A-Z]/.test(p) },
  { id: "digit", label: "A number", test: (p: string) => /\d/.test(p) },
];

export function ChangePasswordForm({ forced, role }: { forced: boolean; role: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const results = useMemo(() => RULES.map((r) => ({ ...r, ok: r.test(password) })), [password]);
  const strong = results.every((r) => r.ok);
  const matches = password.length > 0 && password === confirm;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!strong || !matches) return;
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });

    if (updateError) {
      setError(
        updateError.message.includes("different from the old")
          ? "Choose a password different from your current one."
          : updateError.message,
      );
      setBusy(false);
      return;
    }

    await supabase.rpc("mark_password_changed");
    router.replace(role === "admin" ? "/admin" : "/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label className="label" htmlFor="pw">New password</label>
        <input
          id="pw" type="password" required autoFocus autoComplete="new-password"
          className="field" value={password} onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      <div>
        <label className="label" htmlFor="pw2">Confirm password</label>
        <input
          id="pw2" type="password" required autoComplete="new-password"
          className="field" value={confirm} onChange={(e) => setConfirm(e.target.value)}
        />
        {confirm.length > 0 && !matches && (
          <p className="mt-1.5 text-xs text-[var(--color-down)]">Passwords don&apos;t match.</p>
        )}
      </div>

      <ul className="space-y-1.5 rounded-lg bg-[var(--color-bg-elev)] border border-[var(--color-border-soft)] p-3">
        {results.map((r) => (
          <li key={r.id} className="flex items-center gap-2 text-xs">
            <span className={`grid place-items-center w-4 h-4 rounded-full border ${
              r.ok
                ? "border-[var(--color-up)] bg-[color-mix(in_oklab,var(--color-up)_20%,transparent)] text-[var(--color-up)]"
                : "border-[var(--color-border)] text-transparent"
            }`}>
              <Check size={10} strokeWidth={3} />
            </span>
            <span className={r.ok ? "text-[var(--color-text-dim)]" : "text-[var(--color-text-faint)]"}>
              {r.label}
            </span>
          </li>
        ))}
      </ul>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-[color-mix(in_oklab,var(--color-down)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-down)_11%,transparent)] px-3 py-2.5 text-xs text-[var(--color-down)]">
          <AlertCircle size={14} className="mt-px shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <button type="submit" disabled={busy || !strong || !matches} className="btn btn-primary w-full">
        {busy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
        {busy ? "Saving…" : forced ? "Set password and start" : "Update password"}
      </button>

      {!forced && (
        <a href="/dashboard" className="block text-center text-xs text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]">
          Cancel
        </a>
      )}
    </form>
  );
}
