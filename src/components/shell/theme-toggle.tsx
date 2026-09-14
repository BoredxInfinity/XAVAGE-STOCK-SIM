"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/format";

/**
 * Icon button in the app header. Renders the theme you would switch *to*,
 * which is the convention every platform with a toggle uses.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const next = theme === "light" ? "dark" : "light";

  return (
    <button
      type="button"
      onClick={toggle}
      className={cn("btn-icon", className)}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
    </button>
  );
}

/** The same control with a label, for the mobile drawer and auth pages. */
export function ThemeToggleRow({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const next = theme === "light" ? "dark" : "light";

  return (
    <button
      type="button"
      onClick={toggle}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)]",
        className,
      )}
    >
      {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
      <span className="capitalize">{next} theme</span>
    </button>
  );
}
