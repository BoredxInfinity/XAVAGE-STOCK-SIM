"use client";

import { useEffect, useRef, useState } from "react";
import {
  AreaSeries, CandlestickSeries, ColorType, HistogramSeries,
  createChart, type IChartApi, type ISeriesApi, type UTCTimestamp,
} from "lightweight-charts";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/format";

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
const RANGE_SPEC: Record<Range, { stepSec: number; refetchMs: number }> = {
  "1D": { stepSec: 60, refetchMs: 30_000 },
  "5D": { stepSec: 300, refetchMs: 120_000 },
  "1M": { stepSec: 86_400, refetchMs: 300_000 },
};

interface Bar {
  time: number; open: number; high: number; low: number; close: number; volume: number;
}

export function PriceChart({
  symbol, livePrice, height = 380,
}: { symbol: string; livePrice?: number; height?: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<"Area"> | ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const [range, setRange] = useState<Range>("1D");
  const [mode, setMode] = useState<"area" | "candles">("area");
  const [bars, setBars] = useState<Bar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* ---- build the chart once ---- */
  useEffect(() => {
    if (!holder.current) return;

    const chart = createChart(holder.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9a9ab8",
        fontFamily: "var(--font-mono), monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(35,35,61,.45)" },
        horzLines: { color: "rgba(35,35,61,.45)" },
      },
      rightPriceScale: { borderColor: "#23233d", scaleMargins: { top: 0.12, bottom: 0.28 } },
      timeScale: { borderColor: "#23233d", timeVisible: true, secondsVisible: false },
      crosshair: {
        mode: 1,
        vertLine: { color: "#4d8dff", width: 1, style: 2, labelBackgroundColor: "#1e5cf0" },
        horzLine: { color: "#4d8dff", width: 1, style: 2, labelBackgroundColor: "#1e5cf0" },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
      autoSize: true,
    });

    chartRef.current = chart;

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      color: "rgba(77,141,255,.32)",
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volRef.current = volume;

    return () => {
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

    mainRef.current =
      mode === "candles"
        ? chart.addSeries(CandlestickSeries, {
            upColor: "#00e19b", downColor: "#ff3d6e",
            wickUpColor: "#00e19b", wickDownColor: "#ff3d6e",
            borderVisible: false,
          })
        : chart.addSeries(AreaSeries, {
            lineColor: "#4d8dff",
            topColor: "rgba(77,141,255,.34)",
            bottomColor: "rgba(168,85,247,.02)",
            lineWidth: 2,
            priceLineVisible: true,
            priceLineColor: "#a855f7",
          });

    if (bars.length > 0) applyBars(bars);
    // applyBars is stable for this effect's purposes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, bars]);

  function applyBars(list: Bar[]) {
    const series = mainRef.current;
    if (!series) return;

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
        color: b.close >= b.open ? "rgba(0,225,155,.28)" : "rgba(255,61,110,.28)",
      })),
    );

    chartRef.current?.timeScale().fitContent();
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
          setBars(json.bars ?? []);
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

  useEffect(() => { working.current = null; }, [symbol, range]);

  useEffect(() => {
    if (!livePrice || bars.length === 0 || !mainRef.current) return;

    const { stepSec } = RANGE_SPEC[range];
    const last = bars[bars.length - 1];
    const bucket = Math.floor(Date.now() / 1000 / stepSec) * stepSec;

    // Never draw behind the history we were given: if the server's newest bar
    // is ahead of our bucket (clock skew, a slow refresh), sit on that one.
    const time = Math.max(bucket, last.time);

    let bar = working.current;
    if (!bar || bar.time !== time) {
      const open = time === last.time ? last.open : livePrice;
      bar = {
        time,
        open,
        high: time === last.time ? Math.max(last.high, livePrice) : livePrice,
        low: time === last.time ? Math.min(last.low, livePrice) : livePrice,
        close: livePrice,
        volume: time === last.time ? last.volume : 0,
      };
    } else {
      bar = { ...bar, high: Math.max(bar.high, livePrice), low: Math.min(bar.low, livePrice), close: livePrice };
    }
    working.current = bar;

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
  }, [livePrice, bars, mode, range]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <div className="flex gap-0.5">
          {RANGES.map((r) => (
            <button
              key={r} onClick={() => setRange(r)}
              className={cn(
                "px-2 py-1 rounded-md text-[11px] font-semibold transition-colors",
                range === r
                  ? "bg-[color-mix(in_oklab,var(--color-neon)_18%,transparent)] text-[var(--color-neon-bright)]"
                  : "text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]",
              )}
            >
              {r}
            </button>
          ))}
        </div>

        <div className="flex gap-0.5">
          {(["area", "candles"] as const).map((m) => (
            <button
              key={m} onClick={() => setMode(m)}
              className={cn(
                "px-2 py-1 rounded-md text-[11px] font-semibold capitalize transition-colors",
                mode === m
                  ? "bg-[color-mix(in_oklab,var(--color-violet)_18%,transparent)] text-[var(--color-violet)]"
                  : "text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]",
              )}
            >
              {m}
            </button>
          ))}
        </div>
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
