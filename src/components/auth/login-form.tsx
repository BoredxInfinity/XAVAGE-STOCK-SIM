"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Eye, EyeOff, Loader2, LogIn } from "lucide-react";
import { createClient } from "@/lib/supabase/client";


/**
 * `next` comes from the query string, so it is attacker-controlled.
 * startsWith("/") alone is not enough: "//evil.com" passes it, and
 * router.replace("//evil.com") is a protocol-relative navigation straight off
 * the site -- a clean phishing hand-off the moment someone authenticates.
 */
function isSafeNext(next: string | null): next is string {
  return (
    !!next &&
    next.startsWith("/") &&
    !next.startsWith("//") &&
    !next.startsWith("/\\")
  );
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    params.get("error") === "inactive"
      ? "That account has been deactivated. Please speak to an organiser."
      : null,
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (signInError) {
      // Never disclose whether the address exists -- same message either way.
      setError(
        signInError.message.toLowerCase().includes("rate")
          ? "Too many attempts. Wait a moment and try again."
          : "Incorrect email or password.",
      );
      setBusy(false);
      return;
    }

    const { data, error: rpcError } = await supabase.rpc("touch_login");
    if (rpcError) {
      await supabase.auth.signOut();
      setError("Your account is not active. Please speak to an organiser.");
      setBusy(false);
      return;
    }

    const result = data as { role?: string; must_change_password?: boolean } | null;
    const next = params.get("next");

    if (result?.must_change_password) router.replace("/change-password");
    else if (isSafeNext(next)) router.replace(next);
    else router.replace(result?.role === "admin" ? "/admin" : "/dashboard");

    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label className="label" htmlFor="email">Email</label>
        <input
          id="email" type="email" required autoComplete="username" autoFocus
          className="field" placeholder="you@xavage.event"
          value={email} onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div>
        <label className="label" htmlFor="password">Password</label>
        <div className="relative">
          <input
            id="password" type={reveal ? "text" : "password"} required
            autoComplete="current-password" className="field pr-10"
            placeholder="••••••••"
            value={password} onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button" onClick={() => setReveal((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
            aria-label={reveal ? "Hide password" : "Show password"}
          >
            {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-[color-mix(in_oklab,var(--color-down)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-down)_11%,transparent)] px-3 py-2.5 text-xs text-[var(--color-down)]">
          <AlertCircle size={14} className="mt-px shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <button type="submit" disabled={busy || !email || !password} className="btn btn-primary w-full">
        {busy ? <Loader2 size={15} className="animate-spin" /> : <LogIn size={15} />}
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
