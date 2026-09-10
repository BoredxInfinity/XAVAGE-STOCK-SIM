export function Empty({
  icon, title, hint,
}: { icon?: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
      {icon && <div className="text-[var(--color-text-faint)] mb-3">{icon}</div>}
      <p className="text-sm font-medium text-[var(--color-text-dim)]">{title}</p>
      {hint && <p className="text-xs text-[var(--color-text-faint)] mt-1 max-w-xs">{hint}</p>}
    </div>
  );
}
