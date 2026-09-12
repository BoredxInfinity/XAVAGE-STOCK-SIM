import { TickMarkType, type Time } from "lightweight-charts";
import { DISPLAY_TZ } from "@/lib/format";

/**
 * Axis and crosshair labels in the competition's timezone.
 *
 * lightweight-charts labels its time axis in UTC and offers no timezone
 * option, so a 09:30 New York open was drawn at 13:30 while the orders table
 * underneath it said 19:00 -- two clocks describing the same fill. The bar
 * timestamps themselves stay true UTC epoch seconds, because the working-bar
 * bucketing depends on that; only the labels are translated.
 */
// en-US, not en-IN: the locale decides the wording ("Sep" vs en-IN's "Sept")
// and the timezone decides the clock. Everything else in the app formats with
// en-US, and the chart should not be the one panel spelling months differently.
const fmt = (opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { timeZone: DISPLAY_TZ, hour12: false, ...opts });

const AXIS_TIME = fmt({ hour: "2-digit", minute: "2-digit" });
const AXIS_DAY = fmt({ month: "short", day: "numeric" });
const AXIS_MONTH = fmt({ month: "short", year: "2-digit" });
const AXIS_YEAR = fmt({ year: "numeric" });
const CROSSHAIR_INTRADAY = fmt({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function asDate(time: Time): Date {
  return new Date((time as number) * 1000);
}

/** Time-axis tick labels. Pass straight to `timeScale.tickMarkFormatter`. */
export function istTickMark(time: Time, type: TickMarkType): string {
  const at = asDate(time);
  switch (type) {
    case TickMarkType.Year: return AXIS_YEAR.format(at);
    case TickMarkType.Month: return AXIS_MONTH.format(at);
    case TickMarkType.DayOfMonth: return AXIS_DAY.format(at);
    default: return AXIS_TIME.format(at);
  }
}

/** Crosshair label for an intraday series. `localization.timeFormatter`. */
export function istCrosshair(time: Time): string {
  return CROSSHAIR_INTRADAY.format(asDate(time));
}
