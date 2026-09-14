import { cn } from "@/lib/format";

/**
 * The one container in the app. `glow` is reserved for the primary panel of a
 * page (the equity curve, the order ticket) — if everything glows, nothing does.
 */
export function Panel({
  title, action, children, className, bodyClassName, glow,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  glow?: boolean;
}) {
  return (
    <section className={cn(glow ? "panel-glow" : "panel", "overflow-hidden flex flex-col", className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 px-3.5 h-10 border-b border-[var(--color-border-soft)] shrink-0">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-faint)]">
            {title}
          </h2>
          {action && <div className="flex items-center gap-2 shrink-0">{action}</div>}
        </header>
      )}
      <div className={cn("flex-1 min-h-0", bodyClassName)}>{children}</div>
    </section>
  );
}
