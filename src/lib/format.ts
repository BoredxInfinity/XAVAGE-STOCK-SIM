export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD",
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2,
});

export function money(value: number | null | undefined, compact = false) {
  if (value == null || Number.isNaN(value)) return "—";
  return compact && Math.abs(value) >= 100_000 ? usdCompact.format(value) : usd.format(value);
}

/** Signed currency, e.g. "+$1,204.30" — used for every P&L readout. */
export function signedMoney(value: number | null | undefined, compact = false) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value >= 0 ? "+" : "−"}${money(Math.abs(value), compact)}`;
}

export function pct(value: number | null | undefined, digits = 2) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}%`;
}

export function num(value: number | null | undefined, digits = 2) {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Drops trailing zeros so 10 shares reads "10", not "10.000000". */
export function qtyText(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "—";
  return Number.isInteger(value) ? value.toLocaleString("en-US") : String(parseFloat(value.toFixed(6)));
}

export function compactNum(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

export function toneOf(value: number | null | undefined) {
  if (value == null || value === 0 || Number.isNaN(value)) return "flat" as const;
  return value > 0 ? ("up" as const) : ("down" as const);
}

export function toneClass(value: number | null | undefined) {
  const t = toneOf(value);
  return t === "up" ? "text-[var(--color-up)]" : t === "down" ? "text-[var(--color-down)]" : "text-[var(--color-text-dim)]";
}

const time = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const dateTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

export function clockTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return time.format(new Date(iso));
}

export function stamp(iso: string | null | undefined) {
  if (!iso) return "—";
  return dateTime.format(new Date(iso));
}

export function relative(iso: string | null | undefined) {
  if (!iso) return "—";
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export const ORDER_TYPE_LABEL: Record<string, string> = {
  market: "Market",
  limit: "Limit",
  stop: "Stop",
  stop_limit: "Stop Limit",
  trailing_stop: "Trailing Stop",
};

export const TIF_LABEL: Record<string, string> = {
  day: "Day",
  gtc: "GTC",
  ioc: "IOC",
  fok: "FOK",
};

export const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  open: "Working",
  partially_filled: "Partial",
  filled: "Filled",
  cancelled: "Cancelled",
  rejected: "Rejected",
  expired: "Expired",
};

export function statusChipClass(status: string) {
  switch (status) {
    case "filled": return "chip chip-up";
    case "open":
    case "pending": return "chip chip-neon";
    case "partially_filled": return "chip chip-violet";
    case "rejected": return "chip chip-down";
    case "cancelled":
    case "expired": return "chip chip-neutral";
    default: return "chip chip-neutral";
  }
}

/** True while an order can still fill or be cancelled. */
export function isWorking(status: string) {
  return status === "open" || status === "partially_filled" || status === "pending";
}
