/**
 * The synthetic bar that carries the live price ahead of the history the
 * server has written.
 *
 * This used to live inline in the chart, and it is the fiddliest arithmetic in
 * the app: it has to advance on a clock rather than on price changes (a symbol
 * that does not move must still roll into the next bar, or the chart looks
 * stopped), it must never draw behind what is already plotted (lightweight-
 * charts throws "Cannot update oldest data" on a backwards update, which takes
 * the page down rather than dropping one tick), and it must not redraw a bar
 * that has not changed. Pure and on its own, it can be tested.
 */

export interface Bar {
  time: number; open: number; high: number; low: number; close: number; volume: number;
}

export interface WorkingBarInput {
  /** The synthetic bar currently being built, if there is one. */
  bar: Bar | null;
  /** Newest bar the server has actually written for this range. */
  last: Bar;
  /** Live price. */
  price: number;
  /** Now, in milliseconds. */
  nowMs: number;
  /** Bar width for the selected range, in seconds. */
  stepSec: number;
  /** Newest time already written to the series, history included. */
  floor: number | null;
  /** How far past the newest real bar the live price may be projected. */
  maxGapSec: number;
}

/**
 * The bar the live price belongs on, or `null` when this tick must be dropped
 * because it would land behind what is already on the chart.
 */
export function nextWorkingBar({
  bar, last, price, nowMs, stepSec, floor, maxGapSec,
}: WorkingBarInput): Bar | null {
  const bucket = Math.floor(nowMs / 1000 / stepSec) * stepSec;

  // Stop projecting once the history has stopped arriving. The game can be
  // held open after the exchange has closed (worker_mode_override = live),
  // and the last price stays tradable -- but Yahoo writes no bars over a
  // weekend, so the bucket at `now` can be hours or days past the newest real
  // one. The chart plots bars by index, not by time, so that candle lands
  // flush against Friday's close and the axis reads as a jump: 05:04 to 15:34
  // with nothing in between. Better to end the series where the data ends.
  if (bucket - last.time > maxGapSec) return null;

  // Never draw behind the history we were given: if the server's newest bar is
  // ahead of our bucket (clock skew, a slow refresh), sit on that one.
  const time = Math.max(bucket, last.time);

  if (floor !== null && time < floor) return null;

  // A new bucket opens a new bar. Landing on the server's newest bar instead
  // means adopting it, so the live price extends that bar rather than
  // replacing it with a one-tick doji.
  if (!bar || bar.time !== time) {
    const onLast = time === last.time;
    return {
      time,
      open: onLast ? last.open : price,
      high: onLast ? Math.max(last.high, price) : price,
      low: onLast ? Math.min(last.low, price) : price,
      close: price,
      volume: onLast ? last.volume : 0,
    };
  }

  return {
    ...bar,
    high: Math.max(bar.high, price),
    low: Math.min(bar.low, price),
    close: price,
  };
}

/** Whether two bars would draw identically, so an update can be skipped. */
export function sameBar(a: Bar | null, b: Bar): boolean {
  return a !== null && a.time === b.time && a.open === b.open
    && a.high === b.high && a.low === b.low && a.close === b.close;
}
