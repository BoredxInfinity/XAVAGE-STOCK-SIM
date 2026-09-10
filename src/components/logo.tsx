export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="xvg-a" x1="0" y1="0" x2="48" y2="48">
          <stop offset="0%" stopColor="#4d8dff" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="45" height="45" rx="12"
            stroke="url(#xvg-a)" strokeWidth="2" fill="#0b0b14" />
      {/* an upward-breaking price path -- the X of Xavage read as a chart */}
      <path d="M12 32 L20 22 L27 27 L36 14" stroke="url(#xvg-a)" strokeWidth="3"
            strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="36" cy="14" r="3.2" fill="#a855f7" />
    </svg>
  );
}
