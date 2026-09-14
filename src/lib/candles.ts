/**
 * Bucketing raw bars into candles wide enough to actually be candles.
 *
 * Two things conspire to make a raw series unreadable in candle mode:
 *
 *  * **Outside the regular session Yahoo's 1m rows carry no range.** They are
 *    last-price snapshots -- o=h=l=c, v=0 -- so every candle is a body of zero
 *    height with no wick, and lightweight-charts draws it as a 1px dash. A
 *    pre-market 1D chart was several hundred of those and nothing else. The
 *    movement is real, it just lives *between* the bars rather than inside
 *    them, and bucketing is what recovers it.
 *  * **Even a full regular session is too dense.** 390 one-minute bars across
 *    ~900px is roughly 2px per candle; 1440 (the 1D window is a rolling 24h)
 *    is under one. Bodies and wicks need a handful of pixels to read.
 *
 * The area series has neither problem -- a line is a line at any density --
 * so this is deliberately applied to candle mode only, and the live tape keeps
 * its full one-minute resolution there.
 */
import type { Bar } from "./working-bar";

/**
 * Candle widths to choose from, smallest first. Clock-aligned values only:
 * bucketing floors to a multiple of the step, so 7m candles would start on
 * boundaries that mean nothing to anyone reading the time axis.
 */
const LADDER = [60, 120, 300, 600, 900, 1_800, 3_600, 7_200, 14_400, 86_400];

/**
 * Roughly how many candles fit before they stop being legible. The chart runs
 * ~600-1100px wide, so this leaves each candle 5-8px -- enough for a body and
 * a wick either side.
 */
const TARGET = 130;

export interface CandleSeries {
  /** What to draw. */
  bars: Bar[];
  /** The width of those bars, which the working bar has to bucket to as well. */
  stepSec: number;
}

/** How many buckets `bars` would collapse into at this step. */
export function bucketCount(bars: Bar[], stepSec: number): number {
  let count = 0;
  let prev = Number.NaN;
  for (const bar of bars) {
    const t = Math.floor(bar.time / stepSec) * stepSec;
    if (t !== prev) { count++; prev = t; }
  }
  return count;
}

/**
 * The narrowest ladder step that gets the count down to something readable.
 *
 * Counting real buckets rather than dividing the span by TARGET is what makes
 * this survive gaps: a 24h window holding one pre-market session has 258 bars
 * spread over 4 hours of a 24-hour span, and a span-based estimate would
 * flatten it to hourly candles.
 */
export function candleStep(bars: Bar[], rawStepSec: number): number {
  if (bars.length <= TARGET) return rawStepSec;
  for (const step of LADDER) {
    if (step <= rawStepSec) continue;
    if (bucketCount(bars, step) <= TARGET) return step;
  }
  return Math.max(LADDER[LADDER.length - 1], rawStepSec);
}

/**
 * Collapse `bars` onto `stepSec` boundaries: first open, extreme high and low,
 * last close, summed volume. `bars` must be ascending by time, which is what
 * /api/chart orders by.
 */
export function aggregate(bars: Bar[], stepSec: number): Bar[] {
  const out: Bar[] = [];
  for (const bar of bars) {
    const time = Math.floor(bar.time / stepSec) * stepSec;
    const open = out[out.length - 1];
    if (open && open.time === time) {
      open.high = Math.max(open.high, bar.high);
      open.low = Math.min(open.low, bar.low);
      open.close = bar.close;
      open.volume += bar.volume;
    } else {
      out.push({ ...bar, time });
    }
  }
  return out;
}

/**
 * What the candle series should draw, and at what width.
 *
 * Returns the input array untouched when no bucketing is needed, so the
 * chart's data effect can keep comparing by identity and skip a setData of
 * up to 1500 bars on every poll.
 */
export function candleSeries(bars: Bar[], rawStepSec: number): CandleSeries {
  const stepSec = candleStep(bars, rawStepSec);
  if (stepSec === rawStepSec) return { bars, stepSec };
  return { bars: aggregate(bars, stepSec), stepSec };
}
