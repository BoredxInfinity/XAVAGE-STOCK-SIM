"use client";

import { cn } from "@/lib/format";

export type SegmentedOption<T extends string> = {
  value: T;
  label: React.ReactNode;
  /** Rendered in the muted trailing slot — counts, mostly. */
  badge?: React.ReactNode;
  title?: string;
};

/**
 * The shared segmented control: order status tabs, chart ranges, chart type.
 * Before this each of those rolled its own pill row with slightly different
 * padding and active treatment.
 */
export function Segmented<T extends string>({
  options, value, onChange, className, size = "md", label,
}: {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (next: T) => void;
  className?: string;
  size?: "sm" | "md";
  label?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cn("seg", className)}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={selected}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn("seg-item", size === "sm" && "px-2 py-1 text-[11px]")}
          >
            {o.label}
            {o.badge != null && (
              <span
                className={cn(
                  "num text-[10px] tabular-nums",
                  selected ? "text-[var(--color-neon-bright)]" : "text-[var(--color-text-faint)]",
                )}
              >
                {o.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
