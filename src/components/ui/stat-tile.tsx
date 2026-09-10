import { cn } from "@/lib/format";

export function StatTile({
  label, value, sub, tone = "flat", accent, className,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "flat" | "neutral" | "up" | "down";
  accent?: "neon" | "violet";
  className?: string;
}) {
  return (
    <div className={cn("panel p-4 relative overflow-hidden", className)}>
      {accent && (
        <span
          className={cn(
            "absolute left-0 top-0 h-full w-[2px]",
            accent === "neon" ? "bg-[var(--color-neon)]" : "bg-[var(--color-violet)]",
          )}
        />
      )}
      <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
        {label}
      </p>
      <p
        className={cn(
          "num text-xl font-semibold mt-1.5 tracking-tight",
          tone === "up" ? "text-[var(--color-up)]"
            : tone === "down" ? "text-[var(--color-down)]"
            : "text-[var(--color-text)]",
        )}
      >
        {value}
      </p>
      {sub != null && <p className="text-[11px] text-[var(--color-text-dim)] mt-1">{sub}</p>}
    </div>
  );
}
