import Link from "next/link";
import { redirect } from "next/navigation";
import { KeyRound, ShieldQuestion } from "lucide-react";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Change your password" };

export default async function ChangePasswordPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles").select("display_name, role")
    .eq("id", user.id).maybeSingle();

  const isAdmin = profile?.role === "admin";

  return (
    <main className="min-h-dvh grid place-items-center px-4 py-10">
      <div className="fixed top-4 right-4 z-10">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-[420px]">
        <div className="flex flex-col items-center gap-3 mb-8">
          <Logo size={40} />
          <div className="text-center">
            <h1 className="text-xl font-bold">
              {isAdmin ? "Change your password" : "Credentials are issued to you"}
            </h1>
            <p className="text-sm text-[var(--color-text-dim)] mt-1">
              {isAdmin
                ? "Pick something you haven't used elsewhere."
                : "Your login is managed by the organisers."}
            </p>
          </div>
        </div>

        <div className="panel-glow p-6">
          {isAdmin ? (
            <ChangePasswordForm forced={false} role="admin" />
          ) : (
            /* Participants keep the credential the organisers issued. Changing it
               here would leave the organiser unable to see the working password
               and unable to help if this account is later locked out. */
            <div className="text-center">
              <ShieldQuestion size={26} className="mx-auto text-[var(--color-text-faint)] mb-3" />
              <p className="text-sm text-[var(--color-text-dim)] leading-relaxed">
                Passwords for this competition are set by the organisers, so there&apos;s
                nothing to change here.
              </p>
              <p className="text-xs text-[var(--color-text-faint)] mt-3 leading-relaxed">
                Need a new one — forgotten it, or think someone else has it? Ask an
                organiser and they&apos;ll issue a fresh one on the spot.
              </p>
              <Link href="/dashboard" className="btn btn-primary w-full mt-5">
                <KeyRound size={15} /> Back to trading
              </Link>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
