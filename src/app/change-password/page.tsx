import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { Logo } from "@/components/logo";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export const metadata = { title: "Set your password" };

export default async function ChangePasswordPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles").select("display_name, must_change_password, role")
    .eq("id", user.id).maybeSingle();

  return (
    <main className="min-h-dvh grid place-items-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <div className="flex flex-col items-center gap-3 mb-8">
          <Logo size={40} />
          <div className="text-center">
            <h1 className="text-xl font-bold">
              {profile?.must_change_password ? "Choose your password" : "Change your password"}
            </h1>
            <p className="text-sm text-[var(--color-text-dim)] mt-1">
              {profile?.must_change_password
                ? `Welcome, ${profile.display_name}. Replace the temporary password before you start trading.`
                : "Pick something you haven't used elsewhere."}
            </p>
          </div>
        </div>

        <div className="panel-glow p-6">
          <ChangePasswordForm
            forced={!!profile?.must_change_password}
            role={profile?.role ?? "participant"}
          />
        </div>
      </div>
    </main>
  );
}
