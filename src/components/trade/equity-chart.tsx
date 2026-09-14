"use client";

import { useEffect, useRef } from "react";
import { AreaSeries, ColorType, createChart, type UTCTimestamp } from "lightweight-charts";
import { istCrosshair, istTickMark } from "@/lib/chart-time";
import { useTheme } from "@/components/theme-provider";
import { chartPalette } from "@/lib/chart-theme";

interface Point { ts: string; equity: number }

/** Equity curve for the ranking / dashboard views. */
export function EquityChart({
  points, height = 200, initialCapital,
}: { points: Point[]; height?: number; initialCapital?: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();

  useEffect(() => {
    if (!holder.current) return;

    // This chart is cheap and read-only -- no pan, no zoom, no live bar -- so
    // rebuilding it on a theme flip costs nothing and keeps the code simple.
    // (The price chart cannot do this; see its applyOptions effect.)
    const pal = chartPalette(theme);

    const chart = createChart(holder.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: pal.text,
        fontFamily: "var(--font-mono), monospace",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: pal.grid },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.08 } },
      localization: { timeFormatter: istCrosshair },
      timeScale: {
        borderVisible: false, timeVisible: true, secondsVisible: false,
        tickMarkFormatter: istTickMark,
      },
      crosshair: { mode: 1 },
      autoSize: true,
      handleScroll: false,
      handleScale: false,
    });

    const latest = points.at(-1)?.equity ?? 0;
    const up = initialCapital == null || latest >= initialCapital;

    const series = chart.addSeries(AreaSeries, {
      lineColor: up ? pal.up : pal.down,
      topColor: up ? pal.equityUpTop : pal.equityDownTop,
      bottomColor: pal.equityBottom,
      lineWidth: 2,
      priceLineVisible: false,
    });

    series.setData(
      points.map((p) => ({
        time: Math.floor(new Date(p.ts).getTime() / 1000) as UTCTimestamp,
        value: Number(p.equity),
      })),
    );

    // Dashed baseline at starting capital -- the line that decides win or lose.
    if (initialCapital != null && initialCapital > 0) {
      series.createPriceLine({
        price: initialCapital,
        color: pal.baseline,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "start",
      });
    }

    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, initialCapital, theme]);

  if (points.length === 0) {
    return (
      <div style={{ height }} className="grid place-items-center">
        <p className="text-xs text-[var(--color-text-faint)]">
          The equity curve appears once snapshots begin.
        </p>
      </div>
    );
  }

  return <div ref={holder} style={{ height }} />;
}
