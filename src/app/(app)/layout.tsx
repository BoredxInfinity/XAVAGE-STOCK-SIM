import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MarketDataProvider } from "@/components/market-data-provider";
import { AppNav } from "@/components/shell/app-nav";
import { MarketBar } from "@/components/shell/market-bar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, role, team_id, teams(name)")
    .eq("id", user.id)
    .maybeSingle();

  const team = (profile as { teams?: { name: string } | null } | null)?.teams ?? null;

  return (
    <MarketDataProvider>
      <div className="min-h-dvh flex flex-col">
        <AppNav
          displayName={profile?.display_name ?? "Trader"}
          teamName={team?.name ?? null}
          role={profile?.role ?? "participant"}
        />
        <MarketBar />
        <main className="flex-1 w-full max-w-[1600px] mx-auto px-4 lg:px-6 py-5">
          {!profile?.team_id && profile?.role !== "admin" ? (
            <div className="panel-glow p-8 text-center max-w-lg mx-auto mt-10">
              <h2 className="text-lg font-semibold mb-2">You&apos;re not on a team yet</h2>
              <p className="text-sm text-[var(--color-text-dim)]">
                An organiser needs to add you to a team before you can trade.
                Your account is active — check back shortly.
              </p>
            </div>
          ) : (
            children
          )}
        </main>
      </div>
    </MarketDataProvider>
  );
}
