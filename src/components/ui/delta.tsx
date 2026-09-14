import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn, money, pct, toneClass, toneOf } from "@/lib/format";

/**
 * The recurring "▲ +1.24 (+0.83%)" pair. Every view was rendering this by
 * hand with slightly different sign handling; there is one of it now.
 *
 * `abs` and `percent` are independent — pass either or both.
 */
export function Delta({
  abs, percent, size = "md", icon = true, compact = false, className,
}: {
  abs?: number | null;
  percent?: number | null;
  size?: "sm" | "md" | "lg";
  icon?: boolean;
  compact?: boolean;
  className?: string;
}) {
  // The percentage drives the tone when present: on a position the notional
  // and the percentage always share a sign, and percent is the figure people
  // read first.
  const driver = percent ?? abs ?? null;
  const tone = toneOf(driver);
  const Icon = tone === "up" ? ArrowUpRight : tone === "down" ? ArrowDownRight : Minus;

  const text =
    size === "lg" ? "text-base" : size === "sm" ? "text-[11px]" : "text-xs";

  return (
    <span className={cn("num inline-flex items-center gap-1 font-medium", text, toneClass(driver), className)}>
      {icon && <Icon size={size === "lg" ? 15 : 12} className="shrink-0" strokeWidth={2.5} />}
      {abs != null && <span>{signed(abs, compact)}</span>}
      {percent != null && (
        <span className={cn(abs != null && "text-[0.92em] opacity-80")}>
          {abs != null ? `(${pct(percent)})` : pct(percent)}
        </span>
      )}
    </span>
  );
}

function signed(value: number, compact: boolean) {
  if (Number.isNaN(value)) return "—";
  return `${value >= 0 ? "+" : "−"}${money(Math.abs(value), compact)}`;
}
