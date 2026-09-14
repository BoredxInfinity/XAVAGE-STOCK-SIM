/** The title/subtitle/action band every list page opens with. */
export function PageHeader({
  title, subtitle, action,
}: { title: string; subtitle?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
      <div className="min-w-0">
        <h1 className="text-[17px] font-bold tracking-[-0.015em]">{title}</h1>
        {subtitle && (
          <p className="text-[11px] text-[var(--color-text-dim)] mt-0.5">{subtitle}</p>
        )}
      </div>
      {action && <div className="shrink-0 w-full sm:w-auto">{action}</div>}
    </div>
  );
}
