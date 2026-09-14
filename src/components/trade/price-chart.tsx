"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries, CandlestickSeries, ColorType, HistogramSeries,
  createChart, type IChartApi, type ISeriesApi, type UTCTimestamp,
} from "lightweight-charts";
import { Loader2 } from "lucide-react";
import { useNow } from "@/hooks/use-now";
import { useTheme } from "@/components/theme-provider";
import { chartPalette } from "@/lib/chart-theme";
import { nextWorkingBar, sameBar, type Bar } from "@/lib/working-bar";
import { candleSeries } from "@/lib/candles";
import { istCrosshair, istTickMark } from "@/lib/chart-time";
import { Segmented } from "@/components/ui/segmented";

const RANGES = ["1D", "5D", "1M"] as const;
type Range = (typeof RANGES)[number];

/**
 * Per range: the bar width in seconds, and how often to re-pull history.
 *
 * The refetch exists because bars used to be fetched once, on mount, and never
 * again -- so a chart left open simply stopped growing. The intervals are set
 * against how often the worker actually writes each series: 1m bars land every
 * cycle (~20s), 5m and 1d on the history timer.
 */
//
// `maxGapSec` is how far past the newest real bar the live price may be drawn.
// Generous enough that a slow history refresh never freezes the tape, tight
// enough that a closed exchange does not get a candle: intraday, a few steps;
// daily, three days, so the live price still shows on a Monday morning before
// the day's own daily bar has been written.
const RANGE_SPEC: Record<Range, { stepSec: number; refetchMs: number; maxGapSec: number }> = {
  "1D": { stepSec: 60, refetchMs: 30_000, maxGapSec: 600 },
  "5D": { stepSec: 300, refetchMs: 120_000, maxGapSec: 1_800 },
  "1M": { stepSec: 86_400, refetchMs: 300_000, maxGapSec: 259_200 },
};

export function PriceChart({
  symbol, livePrice, height = 380,
}: { symbol: string; livePrice?: number; height?: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<"Area"> | ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  // The chart takes literal colour strings, so the palette has to be read at
  // option time. A ref keeps the creation effect's dependency list empty --
  // the chart instance must survive a theme flip (see the applyOptions effect
  // below), because re-creating it would drop the viewer's pan/zoom and the
  // live working bar with it.
  const { theme } = useTheme();
  const palette = chartPalette(theme);
  const paletteRef = useRef(palette);
  paletteRef.current = palette;

  const [range, setRange] = useState<Range>("1D");
  // Which range the bars currently in state were fetched for.
  const barsRange = useRef<Range | null>(null);
  // Whether the viewer has taken hold of the time scale themselves. Until they
  // do, every refresh re-frames the chart so the whole range stays in view as
  // it grows. Once they have panned or zoomed it is their view, and re-fitting
  // under them every 30 seconds -- while they are looking at it -- is not on.
  // Hovering for the crosshair is a mousemove, so reading values off the chart
  // does not count as taking hold of it.
  const userMoved = useRef(false);
  const [mode, setMode] = useState<"area" | "candles">("area");
  const [bars, setBars] = useState<Bar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // What actually goes on the chart, and how wide those bars are.
  //
  // Candles get bucketed; the area line keeps every raw bar. Outside the
  // regular session Yahoo's minute rows are last-price snapshots with o=h=l=c,
  // which draw as 1px dashes rather than candles -- and even a full session of
  // them is denser than a candle body can survive. See src/lib/candles.ts.
  //
  // `stepSec` comes back out because the synthetic working bar has to bucket
  // the live price the same way the series it is drawn on does; feeding it the
  // raw step would wedge a minute-wide candle in between the five-minute ones.
  const display = useMemo(
    () => (mode === "candles"
      ? candleSeries(bars, RANGE_SPEC[range].stepSec)
      : { bars, stepSec: RANGE_SPEC[range].stepSec }),
    [bars, mode, range],
  );

  /* ---- build the chart once ---- */
  useEffect(() => {
    if (!holder.current) return;

    const p = paletteRef.current;
    const chart = createChart(holder.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: p.text,
        fontFamily: "var(--font-mono), monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: p.grid },
        horzLines: { color: p.grid },
      },
      rightPriceScale: { borderColor: p.border, scaleMargins: { top: 0.12, bottom: 0.28 } },
      localization: { timeFormatter: istCrosshair },
      timeScale: {
        borderColor: p.border, timeVisible: true, secondsVisible: false,
        tickMarkFormatter: istTickMark,
      },
      crosshair: {
        mode: 1,
        vertLine: { color: p.crosshair, width: 1, style: 2, labelBackgroundColor: p.crosshairLabel },
        horzLine: { color: p.crosshair, width: 1, style: 2, labelBackgroundColor: p.crosshairLabel },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
      autoSize: true,
    });

    chartRef.current = chart;

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      color: paletteRef.current.volume,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volRef.current = volume;

    const el = holder.current;
    const claim = () => { userMoved.current = true; };
    el.addEventListener("mousedown", claim);
    el.addEventListener("wheel", claim, { passive: true });
    el.addEventListener("touchstart", claim, { passive: true });

    return () => {
      el.removeEventListener("mousedown", claim);
      el.removeEventListener("wheel", claim);
      el.removeEventListener("touchstart", claim);
      chart.remove();
      chartRef.current = null;
      mainRef.current = null;
      volRef.current = null;
    };
  }, []);

  /* ---- swap the main series when the display mode changes ---- */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (mainRef.current) {
      chart.removeSeries(mainRef.current);
      mainRef.current = null;
    }

    const p = paletteRef.current;
    mainRef.current =
      mode === "candles"
        ? chart.addSeries(CandlestickSeries, {
            upColor: p.up, downColor: p.down,
            wickUpColor: p.up, wickDownColor: p.down,
            borderVisible: false,
          })
        : chart.addSeries(AreaSeries, {
            lineColor: p.neon,
            topColor: p.areaTop,
            bottomColor: p.areaBottom,
            lineWidth: 2,
            priceLineVisible: true,
            priceLineColor: p.violet,
          });

    // No setData here: the data effect below runs straight after this one on
    // the same render (effects fire in declaration order) and fills the new
    // series. Writing here as well drew every bar twice on a mode flip.
    //
    // The working bar is bucketed for the mode we are leaving, so drop it --
    // otherwise the first tick after the flip extends a candle that is no
    // longer on the series.
    working.current = null;
  }, [mode]);

  /* ---- repaint on a theme flip, without rebuilding anything ---- */
  //
  // applyOptions only. Re-creating the chart or its series here would reset
  // the time scale, drop `userMoved`, and wipe the synthetic working bar --
  // i.e. flipping the theme would visibly break a live chart.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const p = paletteRef.current;

    chart.applyOptions({
      layout: { textColor: p.text },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      rightPriceScale: { borderColor: p.border },
      timeScale: { borderColor: p.border },
      crosshair: {
        vertLine: { color: p.crosshair, labelBackgroundColor: p.crosshairLabel },
        horzLine: { color: p.crosshair, labelBackgroundColor: p.crosshairLabel },
      },
    });

    if (mainRef.current) {
      mainRef.current.applyOptions(
        mode === "candles"
          ? { upColor: p.up, downColor: p.down, wickUpColor: p.up, wickDownColor: p.down }
          : { lineColor: p.neon, topColor: p.areaTop, bottomColor: p.areaBottom, priceLineColor: p.violet },
      );
    }

    // Volume colour is per-point, so applyOptions cannot reach it. Rewrite
    // just that series' data -- the main series and lastWritten/plotted are
    // deliberately left alone so the working bar keeps rolling.
    if (volRef.current && display.bars.length > 0) {
      volRef.current.setData(
        display.bars.map((b) => ({
          time: b.time as UTCTimestamp,
          value: b.volume,
          color: b.close >= b.open ? p.volumeUp : p.volumeDown,
        })),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  /* ---- push new data onto the EXISTING series ---- */
  //
  // Split out of the effect above, which had `bars` in its dependency list.
  // load() calls setBars on every poll, so the array identity changed every
  // 30s even when the bytes were identical -- and the chart tore down and
  // rebuilt its lightweight-charts series that often, re-running setData for
  // up to 1500 bars and resetting lastWritten/plotted each time.
  useEffect(() => {
    if (!mainRef.current) return;
    // An empty payload must NOT be written: it would blank the series while
    // leaving lastWritten pointing at a bar that is no longer on it, and the
    // working-bar effect then bails on every tick.
    if (display.bars.length === 0) return;
    applyBars(display.bars);
    // `mode` is here because this effect now owns the first write to a series
    // the mode effect has just created.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, mode]);

  function applyBars(list: Bar[]) {
    const series = mainRef.current;
    if (!series) return;

    // setData resets the series, so this is the new floor for update()...
    lastWritten.current = list.length ? list[list.length - 1].time : null;
    // ...and the synthetic bar is no longer on it, whatever `working` still says.
    plotted.current = null;

    if (mode === "candles") {
      (series as ISeriesApi<"Candlestick">).setData(
        list.map((b) => ({
          time: b.time as UTCTimestamp,
          open: b.open, high: b.high, low: b.low, close: b.close,
        })),
      );
    } else {
      (series as ISeriesApi<"Area">).setData(
        list.map((b) => ({ time: b.time as UTCTimestamp, value: b.close })),
      );
    }

    volRef.current?.setData(
      list.map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.volume,
        color: b.close >= b.open ? paletteRef.current.volumeUp : paletteRef.current.volumeDown,
      })),
    );

    if (!userMoved.current) chartRef.current?.timeScale().fitContent();
  }

  /* ---- load bars, and keep loading them ---- */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    function load(initial: boolean) {
      fetch(`/api/chart/${encodeURIComponent(symbol)}?range=${range}`)
        .then((r) => r.json())
        .then((json: { bars?: Bar[]; error?: string }) => {
          if (cancelled) return;
          if (json.error) { if (initial) setError(json.error); return; }
          barsRange.current = range;
          const next = json.bars ?? [];
          // Identity, not just equality: a new array on every poll is what
          // made the effect above re-run. Compare the cheap discriminators --
          // length and the last bar -- and keep the old reference otherwise.
          setBars((prev) => {
            if (prev.length === next.length && prev.length > 0) {
              const a = prev[prev.length - 1], b = next[next.length - 1];
              if (a.time === b.time && a.close === b.close && a.high === b.high
                  && a.low === b.low && a.open === b.open) {
                return prev;
              }
            }
            return next;
          });
        })
        // A failed refresh keeps the bars already on screen; only the first
        // load has nothing to fall back to.
        .catch(() => { if (initial && !cancelled) setError("Could not load chart data."); })
        .finally(() => { if (initial && !cancelled) setLoading(false); });
    }

    load(true);
    const timer = setInterval(() => load(false), RANGE_SPEC[range].refetchMs);
    return () => { cancelled = true; clearInterval(timer); };
  }, [symbol, range]);

  /* ---- carry the live price on the bar it actually belongs to ---- */
  //
  // This used to write to `bars[bars.length - 1]` -- the newest bar AT LOAD
  // TIME. Because the bar array never changed, an hour-old candle kept
  // absorbing every subsequent tick instead of new candles appearing. Bucket
  // the clock to the range's step instead, so the working bar rolls over on
  // its own and the chart advances between history refreshes.
  const working = useRef<Bar | null>(null);
  // The newest time actually written to the series -- which includes the
  // synthetic working bar, and so can be AHEAD of the newest bar in `bars`.
  const lastWritten = useRef<number | null>(null);
  // Exactly what was last pushed through update(), so an unchanged bar can be
  // skipped rather than redrawn once a second. Cleared by applyBars, because
  // setData wipes the synthetic bar off the series and it has to be re-drawn
  // even though nothing about it changed.
  const plotted = useRef<Bar | null>(null);

  useEffect(() => {
    working.current = null;
    plotted.current = null;
    userMoved.current = false;
  }, [symbol, range]);

  // The clock is a real input here, not just a repaint trigger. A price that
  // holds steady still has to roll into the next bar when its bucket closes --
  // otherwise a quiet symbol looks like a chart that stopped, and the right
  // edge sits where it was when the last trade happened to print.
  const now = useNow();

  useEffect(() => {
    if (!livePrice || display.bars.length === 0 || !mainRef.current) return;

    // Only overlay onto history that belongs to the range now selected.
    // Between clicking 5D and its bars arriving, `bars` is still the 1D array,
    // and bucketing those to a 5-minute step lands BEHIND what is on screen.
    if (barsRange.current !== range) return;

    const bar = nextWorkingBar({
      bar: working.current,
      // The series as drawn, not the raw feed: in candle mode the newest thing
      // on the chart is a bucket, and the live price has to extend that bucket
      // rather than open a narrow one on top of it.
      last: display.bars[display.bars.length - 1],
      price: livePrice,
      nowMs: now,
      stepSec: display.stepSec,
      // A candle two buckets wide is still a live chart, not a projection
      // across a closed exchange -- so the allowance has to clear the bucket
      // width that bucketing actually chose, which can exceed the raw step.
      maxGapSec: Math.max(RANGE_SPEC[range].maxGapSec, 2 * display.stepSec),
      floor: lastWritten.current,
    });
    if (!bar) return;

    working.current = bar;

    // Nothing to draw: same bucket, same numbers. Without this the clock would
    // repaint the series once a second for no visible change.
    if (sameBar(plotted.current, bar)) return;

    if (mode === "candles") {
      (mainRef.current as ISeriesApi<"Candlestick">).update({
        time: bar.time as UTCTimestamp,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
      });
    } else {
      (mainRef.current as ISeriesApi<"Area">).update({
        time: bar.time as UTCTimestamp, value: bar.close,
      });
    }
    plotted.current = bar;
    lastWritten.current = bar.time;
  }, [livePrice, display, mode, range, now]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--color-border-soft)]">
        <Segmented
          label="Chart range"
          size="sm"
          value={range}
          onChange={setRange}
          options={RANGES.map((r) => ({ value: r, label: r }))}
        />
        <Segmented
          label="Chart type"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "area" as const, label: "Area" },
            { value: "candles" as const, label: "Candles" },
          ]}
        />
      </div>

      <div className="relative" style={{ height }}>
        <div ref={holder} className="absolute inset-0" />

        {loading && (
          <div className="absolute inset-0 grid place-items-center bg-[color-mix(in_oklab,var(--color-bg)_55%,transparent)]">
            <Loader2 size={18} className="animate-spin text-[var(--color-neon)]" />
          </div>
        )}

        {!loading && bars.length === 0 && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="text-center px-6">
              <p className="text-sm text-[var(--color-text-dim)]">No chart history yet for {symbol}</p>
              <p className="text-xs text-[var(--color-text-faint)] mt-1">
                {error ?? "The price worker fills history in on its next cycle."}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
