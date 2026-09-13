"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  CandlestickChart, ClipboardList, History,
  LayoutDashboard, LogOut, Menu, Shield, X,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/format";

const LINKS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/trade", label: "Trade", icon: CandlestickChart },
  { href: "/orders", label: "Orders", icon: ClipboardList },
  { href: "/history", label: "History", icon: History },
];

export function AppNav({
  displayName, teamName, role,
}: { displayName: string; teamName: string | null; role: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-border-soft)] bg-[color-mix(in_oklab,var(--color-bg)_86%,transparent)] backdrop-blur-xl">
      <div className="max-w-[1600px] mx-auto px-4 lg:px-6 h-14 flex items-center gap-4">
        <Link href="/dashboard" className="flex items-center gap-2.5 shrink-0">
          <Logo size={26} />
          <span className="font-bold tracking-tight text-sm hidden sm:block">
            <span className="neon-text">XAVAGE</span>
          </span>
        </Link>

        <nav className="hidden md:flex items-center gap-1 ml-2">
          {LINKS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href} href={href}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                  active
                    ? "bg-[color-mix(in_oklab,var(--color-neon)_14%,transparent)] text-[var(--color-neon-bright)]"
                    : "text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]",
                )}
              >
                <Icon size={15} />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="flex-1" />

        <div className="hidden sm:flex flex-col items-end leading-tight">
          <span className="text-xs font-semibold">{displayName}</span>
          {teamName && (
            <span className="text-[11px] text-[var(--color-text-faint)]">{teamName}</span>
          )}
        </div>

        {role === "admin" && (
          <Link href="/admin" className="chip chip-violet" title="Admin console">
            <Shield size={11} /> Admin
          </Link>
        )}

        <form action="/auth/signout" method="post" className="hidden sm:block">
          <button
            type="submit"
            className="p-2 rounded-lg text-[var(--color-text-faint)] hover:text-[var(--color-down)] hover:bg-[var(--color-surface-2)] transition-colors"
            aria-label="Sign out"
          >
            <LogOut size={16} />
          </button>
        </form>

        <button
          onClick={() => setOpen((v) => !v)}
          className="md:hidden p-2 rounded-lg text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)]"
          aria-label="Toggle navigation" aria-expanded={open}
        >
          {open ? <X size={18} /> : <Menu size={18} />}
        </button>
      </div>

      {open && (
        <nav className="md:hidden border-t border-[var(--color-border-soft)] px-3 py-2 space-y-1">
          {LINKS.map(({ href, label, icon: Icon }) => (
            <Link
              key={href} href={href} onClick={() => setOpen(false)}
              className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-lg text-sm",
                pathname.startsWith(href)
                  ? "bg-[color-mix(in_oklab,var(--color-neon)_14%,transparent)] text-[var(--color-neon-bright)]"
                  : "text-[var(--color-text-dim)]",
              )}
            >
              <Icon size={15} /> {label}
            </Link>
          ))}
          <form action="/auth/signout" method="post">
            <button type="submit" className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-[var(--color-down)]">
              <LogOut size={15} /> Sign out
            </button>
          </form>
        </nav>
      )}
    </header>
  );
}
