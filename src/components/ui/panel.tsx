import { cn } from "@/lib/format";

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
        <header className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[var(--color-border-soft)] shrink-0">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-dim)]">
            {title}
          </h2>
          {action}
        </header>
      )}
      <div className={cn("flex-1 min-h-0", bodyClassName)}>{children}</div>
    </section>
  );
}
