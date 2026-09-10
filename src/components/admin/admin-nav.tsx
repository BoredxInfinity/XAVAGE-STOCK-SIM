"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity, CandlestickChart, LayoutDashboard, ListOrdered,
  LogOut, Settings2, Shield, Trophy, Users,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/format";

const LINKS = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/admin/rankings", label: "Rankings", icon: Trophy },
  { href: "/admin/teams", label: "Teams", icon: Users },
  { href: "/admin/users", label: "Accounts", icon: Shield },
  { href: "/admin/settings", label: "Game settings", icon: Settings2 },
  { href: "/admin/instruments", label: "Instruments", icon: ListOrdered },
  { href: "/admin/activity", label: "Activity", icon: Activity },
];

export function AdminNav({ displayName }: { displayName: string }) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-border-soft)] bg-[color-mix(in_oklab,var(--color-bg)_88%,transparent)] backdrop-blur-xl">
      <div className="max-w-[1600px] mx-auto px-4 lg:px-6 h-14 flex items-center gap-3">
        <Link href="/admin" className="flex items-center gap-2.5 shrink-0">
          <Logo size={26} />
          <span className="hidden sm:flex items-center gap-1.5 text-sm font-bold tracking-tight">
            <span className="neon-text">XAVAGE</span>
            <span className="chip chip-violet">Admin</span>
          </span>
        </Link>

        <nav className="flex items-center gap-0.5 overflow-x-auto no-scrollbar ml-1">
          {LINKS.map(({ href, label, icon: Icon, exact }) => {
            const active = exact ? pathname === href : pathname.startsWith(href);
            return (
              <Link
                key={href} href={href}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[13px] font-medium whitespace-nowrap transition-colors",
                  active
                    ? "bg-[color-mix(in_oklab,var(--color-violet)_16%,transparent)] text-[var(--color-violet)]"
                    : "text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]",
                )}
              >
                <Icon size={14} />
                <span className="hidden lg:inline">{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="flex-1" />

        <Link href="/dashboard" className="btn btn-ghost !py-1.5 !text-xs">
          <CandlestickChart size={13} /> <span className="hidden sm:inline">Trading floor</span>
        </Link>

        <span className="hidden md:block text-xs text-[var(--color-text-dim)]">{displayName}</span>

        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="p-2 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-down)] hover:bg-[var(--color-surface-2)]"
            aria-label="Sign out"
          >
            <LogOut size={16} />
          </button>
        </form>
      </div>
    </header>
  );
}
