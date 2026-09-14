import { cn } from "@/lib/format";

/**
 * A single figure with its label. `size="lg"` is the one loud number a screen
 * is allowed — everything else stays at the default so hierarchy survives.
 */
export function StatTile({
  label, value, sub, tone = "flat", accent, size = "md", className,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "flat" | "neutral" | "up" | "down";
  accent?: "neon" | "violet";
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const toneText =
    tone === "up" ? "text-[var(--color-up)]"
      : tone === "down" ? "text-[var(--color-down)]"
      : "text-[var(--color-text)]";

  return (
    <div
      className={cn(
        "panel relative overflow-hidden",
        size === "lg" ? "p-4" : size === "sm" ? "px-3 py-2.5" : "px-3.5 py-3",
        className,
      )}
    >
      {/* A hairline along the top edge rather than a bar down the side: it
          reads as a section marker instead of competing with the figure. */}
      {accent && (
        <span
          className={cn(
            "absolute inset-x-0 top-0 h-px",
            accent === "neon"
              ? "bg-gradient-to-r from-[var(--color-neon)] to-transparent"
              : "bg-gradient-to-r from-[var(--color-violet)] to-transparent",
          )}
        />
      )}
      <p className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-text-faint)] truncate">
        {label}
      </p>
      <p
        className={cn(
          "num font-semibold tracking-tight tabular-nums",
          size === "lg" ? "text-3xl mt-2" : size === "sm" ? "text-base mt-1" : "text-lg mt-1",
          toneText,
        )}
      >
        {value}
      </p>
      {sub != null && (
        <div className="text-[11px] text-[var(--color-text-dim)] mt-1 truncate">{sub}</div>
      )}
    </div>
  );
}
