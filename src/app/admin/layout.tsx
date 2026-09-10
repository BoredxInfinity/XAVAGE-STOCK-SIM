import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MarketDataProvider } from "@/components/market-data-provider";
import { AdminNav } from "@/components/admin/admin-nav";

export const metadata = { title: { default: "Admin", template: "%s · Xavage Admin" } };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles").select("display_name, role").eq("id", user.id).maybeSingle();

  if (profile?.role !== "admin") redirect("/dashboard");

  return (
    <MarketDataProvider>
      <div className="min-h-dvh flex flex-col">
        <AdminNav displayName={profile.display_name} />
        <main className="flex-1 w-full max-w-[1600px] mx-auto px-4 lg:px-6 py-5">{children}</main>
      </div>
    </MarketDataProvider>
  );
}
