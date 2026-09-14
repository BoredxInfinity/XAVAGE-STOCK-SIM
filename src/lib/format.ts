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

/**
 * Milliseconds as a stage duration — the same three bands the worker itself
 * prints (`logbook._human`), so a line in the log table and a point on the
 * timing chart read identically.
 */
export function duration(ms: number | null | undefined) {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
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

/**
 * The competition's clock.
 *
 * Everyone playing is in one place, and the chart axis would otherwise be
 * labelled in UTC (lightweight-charts' default) while the blotter beside it
 * used whatever the laptop was set to. Two different clocks describing the
 * same fill is how people mis-read a chart. Pin the display to one.
 */
export const DISPLAY_TZ = "Asia/Kolkata";

// timeZone is the whole point of DISPLAY_TZ and was missing: without it these
// formatted in whatever zone the laptop was set to, which is exactly the
// two-clocks problem the constant above exists to prevent.
const time = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const dateTime = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TZ, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});

// en-CA renders ISO-ish YYYY-MM-DD, which is what <input type="datetime-local">
// wants. Kept separate from the display formatters above so their shape can
// change without breaking form round-tripping.
const inputParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

function wallClockParts(at: Date) {
  const p = Object.fromEntries(inputParts.formatToParts(at).map((x) => [x.type, x.value]));
  // hour12:false yields "24" for midnight in some engines.
  const hour = String(Number(p.hour) % 24).padStart(2, "0");
  return { year: p.year, month: p.month, day: p.day, hour, minute: p.minute };
}

/**
 * UTC instant -> the value an <input type="datetime-local"> expects.
 *
 * The input reads and writes LOCAL wall-clock time. The admin settings form
 * used `new Date(iso).toISOString().slice(0, 16)`, i.e. it put a UTC wall
 * clock into a local-wall-clock field: on IST that displayed
 * competition_start_at 5h30m adrift from every other panel, and re-saving an
 * untouched field reinterpreted the displayed UTC as IST and shifted the
 * stored value back 5.5 hours -- every single time it was saved. These fields
 * gate order acceptance.
 */
export function toDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const p = wallClockParts(at);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** The inverse: a wall clock typed in DISPLAY_TZ -> the UTC instant it names. */
export function fromDateTimeLocal(value: string): string | null {
  if (!value) return null;
  const asIfUtc = new Date(`${value}:00Z`);
  if (Number.isNaN(asIfUtc.getTime())) return null;

  // How far DISPLAY_TZ sits from UTC at that instant, read back from the
  // formatter so the zone database supplies it rather than a hard-coded +5:30.
  const p = wallClockParts(asIfUtc);
  const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(asIfUtc.getTime() - (shown - asIfUtc.getTime())).toISOString();
}

export function clockTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return time.format(new Date(iso));
}

export function stamp(iso: string | null | undefined) {
  if (!iso) return "—";
  return dateTime.format(new Date(iso));
}

/**
 * Pass `now` (from `useNow()`) to make the string tick along on its own.
 * Without it this is a one-shot reading that freezes until the next render.
 */
export function relative(iso: string | null | undefined, now?: number) {
  if (!iso) return "—";
  const secs = Math.round(((now ?? Date.now()) - new Date(iso).getTime()) / 1000);
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


/**
 * One CSV cell, quoted and de-fanged.
 *
 * Quote-escaping alone is not enough: Excel, Sheets and Numbers all treat a
 * cell beginning with = + - or @ as a FORMULA, so a team called
 * `=HYPERLINK("http://evil","click")` executes when someone opens the export.
 * Team names and display names are free text, and the rankings CSV is the file
 * most likely to be opened by a judge. Prefixing a single quote is the
 * standard neutralisation -- spreadsheets strip it on display.
 */
export function csvCell(value: unknown): string {
  const text = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
