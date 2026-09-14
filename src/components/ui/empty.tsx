export function Empty({
  icon, title, hint,
}: { icon?: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 px-6 text-center">
      {icon && <div className="text-[var(--color-text-faint)] opacity-60 mb-2.5">{icon}</div>}
      <p className="text-[13px] font-medium text-[var(--color-text-dim)]">{title}</p>
      {hint && <p className="text-[11px] text-[var(--color-text-faint)] mt-1 max-w-[34ch] leading-relaxed">{hint}</p>}
    </div>
  );
}
