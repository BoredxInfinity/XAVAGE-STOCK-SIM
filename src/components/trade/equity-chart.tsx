"use client";

import { useEffect, useRef } from "react";
import { AreaSeries, ColorType, createChart, type UTCTimestamp } from "lightweight-charts";
import { istCrosshair, istTickMark } from "@/lib/chart-time";

interface Point { ts: string; equity: number }

/** Equity curve for the ranking / dashboard views. */
export function EquityChart({
  points, height = 200, initialCapital,
}: { points: Point[]; height?: number; initialCapital?: number }) {
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!holder.current) return;

    const chart = createChart(holder.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9a9ab8",
        fontFamily: "var(--font-mono), monospace",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: "rgba(35,35,61,.4)" },
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
      lineColor: up ? "#00e19b" : "#ff3d6e",
      topColor: up ? "rgba(0,225,155,.28)" : "rgba(255,61,110,.28)",
      bottomColor: "rgba(168,85,247,.02)",
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
        color: "rgba(154,154,184,.55)",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "start",
      });
    }

    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, initialCapital]);

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
