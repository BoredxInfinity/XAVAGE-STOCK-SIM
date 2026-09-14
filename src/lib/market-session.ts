import { DISPLAY_TZ } from "@/lib/format";

/**
 * When the US regular session next opens, said in the participants' own clock.
 *
 * "Market closed" answers the wrong half of the question. Everyone playing is
 * in India, the exchange is in New York, and 09:30 ET is 19:00 IST for half
 * the year and 20:00 IST for the other half -- so the one thing a participant
 * cannot work out from a red chip is when to come back. Hardcoding "7pm" would
 * be wrong from the first Sunday in November, which is inside a competition
 * running this autumn, so the offset is computed rather than assumed.
 *
 * Only the REGULAR session is described, because that is the only session the
 * book fills in -- see `private.fills_allowed`. Pre-market shows the same hint:
 * the tape is live but orders queue, and "opens 19:00" is exactly what the
 * participant needs to know.
 */

const NY_TZ = "America/New_York";

const REGULAR_OPEN_HOUR = 9;
const REGULAR_OPEN_MINUTE = 30;

/**
 * NYSE/NASDAQ full-day closures.
 *
 * DUPLICATED, deliberately: `worker/market.py` holds the authoritative copy
 * (HOLIDAYS_2026 / HOLIDAYS_2027) because it decides `market_state`, which is
 * what the engine actually trades on. Keep the two in step when extending to a
 * new year.
 *
 * Early closes are NOT mirrored here -- they move the closing bell, not the
 * opening one, so they cannot change the answer this module computes.
 *
 * If these ever drift, the cost is a wrong date in a hint. The server's
 * market_state still governs whether anything trades, so a stale list here
 * cannot produce a bad fill.
 */
const HOLIDAYS = new Set([
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

const partsFor = (timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });

const nyParts = partsFor(NY_TZ);
const displayParts = partsFor(DISPLAY_TZ);

interface Wall { year: number; month: number; day: number; hour: number; minute: number }

function wallClock(at: Date, fmt: Intl.DateTimeFormat): Wall {
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    // hour12:false yields "24" for midnight in some engines.
    hour: Number(p.hour) % 24, minute: Number(p.minute),
  };
}

/**
 * The instant at which `timeZone` shows this wall clock.
 *
 * Same round-trip the datetime-local helpers in format.ts use: assume the wall
 * clock is UTC, ask the zone what it would actually be showing then, and
 * correct by the difference. The zone database supplies the offset, so DST is
 * handled rather than assumed.
 */
function zonedToUtc(w: Wall, fmt: Intl.DateTimeFormat): Date {
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const shown = wallClock(new Date(asIfUtc), fmt);
  const shownMs = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute);
  return new Date(asIfUtc - (shownMs - asIfUtc));
}

const isoDate = (w: Wall) =>
  `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;

function isTradingDay(w: Wall): boolean {
  if (HOLIDAYS.has(isoDate(w))) return false;
  // Weekday in NY terms. Noon avoids any chance of the UTC date differing.
  const weekday = new Date(Date.UTC(w.year, w.month - 1, w.day, 12)).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

/**
 * The next instant the regular session opens, strictly after `now`.
 *
 * Written as "walk forward day by day" rather than as a set of cases, because
 * the cases collapse: 02:00 on a Tuesday, 06:00 pre-market, Friday evening and
 * Christmas Day all reduce to "the first 09:30 ET on a trading day that has
 * not happened yet". Returns null only if the calendar runs out, which means
 * HOLIDAYS needs extending.
 */
export function nextRegularOpen(now: Date): Date | null {
  const today = wallClock(now, nyParts);

  for (let offset = 0; offset < 10; offset++) {
    const probe = new Date(Date.UTC(today.year, today.month - 1, today.day + offset, 12));
    const day: Wall = {
      year: probe.getUTCFullYear(), month: probe.getUTCMonth() + 1, day: probe.getUTCDate(),
      hour: REGULAR_OPEN_HOUR, minute: REGULAR_OPEN_MINUTE,
    };
    if (!isTradingDay(day)) continue;

    const open = zonedToUtc(day, nyParts);
    if (open.getTime() > now.getTime()) return open;
  }
  return null;
}

/**
 * "Opens 19:00 IST" / "Opens tomorrow 19:00 IST" / "Opens Mon 19:00 IST".
 *
 * The day qualifier is in the READER's timezone, not New York's: 09:30 ET on a
 * Monday is Monday evening in India, and calling that "tomorrow" when it is
 * still Sunday night in Delhi would be the confusion this is meant to remove.
 */
export function nextOpenLabel(now: Date): string | null {
  const open = nextRegularOpen(now);
  if (!open) return null;

  const openLocal = wallClock(open, displayParts);
  const nowLocal = wallClock(now, displayParts);
  const time = `${String(openLocal.hour).padStart(2, "0")}:${String(openLocal.minute).padStart(2, "0")}`;

  const dayDelta = Math.round(
    (Date.UTC(openLocal.year, openLocal.month - 1, openLocal.day) -
      Date.UTC(nowLocal.year, nowLocal.month - 1, nowLocal.day)) / 86_400_000,
  );

  if (dayDelta <= 0) return `Opens ${time} IST`;
  if (dayDelta === 1) return `Opens tomorrow ${time} IST`;

  const weekday = new Date(Date.UTC(openLocal.year, openLocal.month - 1, openLocal.day))
    .toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `Opens ${weekday} ${time} IST`;
}
