"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  CandlestickChart, ClipboardList, History,
  LayoutDashboard, LogOut, Menu, Shield, X,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { ThemeToggle, ThemeToggleRow } from "@/components/shell/theme-toggle";
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
    <header className="sticky top-0 z-40 border-b border-[var(--color-border-soft)] bg-[color-mix(in_oklab,var(--color-bg)_88%,transparent)] backdrop-blur-xl">
      <div className="max-w-[1600px] mx-auto px-4 lg:px-6 h-13 flex items-center gap-5">
        <Link href="/dashboard" className="flex items-center gap-2.5 shrink-0">
          <Logo size={24} />
          <span className="font-bold tracking-[-0.01em] text-[15px] hidden sm:block">
            <span className="neon-text">XAVAGE</span>
          </span>
        </Link>

        {/* The active item is marked by a gradient underline rather than a
            filled pill: the accent then reads as "you are here" instead of as
            another coloured surface competing with the data below. */}
        <nav className="hidden md:flex items-stretch self-stretch">
          {LINKS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-1.5 px-3.5 text-[13px] font-medium transition-colors",
                  active
                    ? "text-[var(--color-text)]"
                    : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]",
                )}
              >
                <Icon size={14} className={active ? "text-[var(--color-neon-bright)]" : undefined} />
                {label}
                {active && (
                  <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-gradient-to-r from-[var(--color-neon)] to-[var(--color-violet)]" />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="flex-1" />

        <div className="hidden sm:flex flex-col items-end leading-tight">
          <span className="text-[13px] font-semibold">{displayName}</span>
          {teamName && (
            <span className="text-[11px] text-[var(--color-text-faint)]">{teamName}</span>
          )}
        </div>

        {role === "admin" && (
          <Link href="/admin" className="chip chip-violet" title="Admin console">
            <Shield size={11} /> Admin
          </Link>
        )}

        <div className="hidden sm:flex items-center gap-1 pl-1 border-l border-[var(--color-border-soft)] ml-1">
          <ThemeToggle />
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="btn-icon btn-icon-danger"
              aria-label="Sign out"
            >
              <LogOut size={16} />
            </button>
          </form>
        </div>

        <button
          onClick={() => setOpen((v) => !v)}
          className="md:hidden btn-icon"
          aria-label="Toggle navigation" aria-expanded={open}
        >
          {open ? <X size={18} /> : <Menu size={18} />}
        </button>
      </div>

      {open && (
        <nav className="md:hidden border-t border-[var(--color-border-soft)] px-3 py-2 space-y-1 bg-[var(--color-bg-elev)]">
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
          <div className="h-px bg-[var(--color-border-soft)] my-1" />
          <ThemeToggleRow />
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
