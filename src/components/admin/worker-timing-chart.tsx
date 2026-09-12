"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { createClient } from "@/lib/supabase/client";
import { useNow } from "@/hooks/use-now";
import { cn, duration } from "@/lib/format";
import type { WorkerLog, WorkerLogLevel } from "@/lib/database.types";

/**
 * How long the worker is taking, stage by stage, as it happens.
 *
 * `worker_logs` already carries a `duration_ms` on every timed stage; until
 * now the only way to read it was one row at a time in the log table, where a
 * cycle drifting from 1.2s to 4s over ten minutes is invisible. Plotted, it is
 * the first thing you see -- and it is the number that matters, because the
 * poller's whole budget is the 5s cadence.
 *
 * The window slides off `useNow()` rather than off the poll, so the trace
 * walks left every second and a feed that has stopped writing shows as a
 * widening empty margin on the right instead of a line that simply stops
 * updating -- the same reason the health strip ages between polls.
 */

const WINDOWS = [
  { minutes: 5, label: "5m" },
  { minutes: 15, label: "15m" },
  { minutes: 60, label: "1h" },
] as const;

/** Where the worker itself starts calling a stage slow (logbook.SLOW_MS). */
const SLOW_MS = 5_000;

const H = 180;
const PAD = { top: 10, right: 10, bottom: 18, left: 46 };

// Stable colours for the stages that exist today; anything new the worker
// starts timing picks up a spare rather than colliding with `cycle`.
const EVENT_COLOR: Record<string, string> = {
  cycle: "var(--color-neon)",
  market_data: "var(--color-cyan)",
  history: "var(--color-violet)",
  prev_closes: "var(--color-up)",
  snapshot: "var(--color-warn)",
  profiles: "var(--color-neon-bright)",
};
const SPARE = [
  "var(--color-down)",
  "var(--color-violet-deep)",
  "var(--color-neon-deep)",
  "var(--color-up-dim)",
];

type Timing = Pick<WorkerLog, "id" | "ts" | "event" | "level" | "duration_ms" | "message">;
type Point = { id: number; t: number; ms: number; event: string; level: WorkerLogLevel; message: string };
type Series = { event: string; color: string; points: Point[]; last: Point; p95: number };

/** Smallest round ceiling above the peak, so the trace is not stranded at the floor. */
function niceMax(v: number) {
  if (!(v > 0)) return 1_000;
  const mag = 10 ** Math.floor(Math.log10(v));
  const f = v / mag;
  const step = f <= 1 ? 1 : f <= 1.5 ? 1.5 : f <= 2 ? 2 : f <= 2.5 ? 2.5
    : f <= 3 ? 3 : f <= 4 ? 4 : f <= 5 ? 5 : f <= 6 ? 6 : f <= 8 ? 8 : 10;
  return step * mag;
}

function quantile(sorted: number[], q: number) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[i];
}

function axisTime(t: number, seconds: boolean) {
  return new Date(t).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false,
  });
}

export function WorkerTimingChart() {
  const [windowMin, setWindowMin] = useState<number>(15);
  // Log by default: a 20s history refresh and a 1.2s cycle do not share a
  // linear axis, and flattening the cycle line against the floor hides exactly
  // the drift this chart exists to show.
  const [logScale, setLogScale] = useState(true);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [hover, setHover] = useState<{ p: Point; x: number; y: number } | null>(null);
  const now = useNow();

  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A cycle is ~5s, so poll at the cadence the data actually arrives at. The
  // filter rides the (ts desc) index and the window caps the row count.
  const { data: rows = [], isLoading } = useQuery<Timing[]>({
    queryKey: ["worker-timings", windowMin],
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const supabase = createClient();
      const since = new Date(Date.now() - windowMin * 60_000 - 30_000).toISOString();
      const { data, error } = await supabase
        .from("worker_logs")
        .select("id, ts, event, level, duration_ms, message")
        .not("duration_ms", "is", null)
        .gte("ts", since)
        .order("ts", { ascending: false })
        .limit(1200);
      if (error) throw error;
      return (data ?? []) as Timing[];
    },
  });

  const windowMs = windowMin * 60_000;
  const t0 = now - windowMs;

  const all = useMemo<Series[]>(() => {
    const byEvent = new Map<string, Point[]>();
    for (const r of rows) {
      if (r.duration_ms == null) continue;
      const t = new Date(r.ts).getTime();
      if (!Number.isFinite(t)) continue;
      const bucket = byEvent.get(r.event) ?? [];
      bucket.push({ id: r.id, t, ms: r.duration_ms, event: r.event, level: r.level, message: r.message });
      byEvent.set(r.event, bucket);
    }

    let spare = 0;
    return [...byEvent.entries()]
      .map(([event, pts]) => {
        pts.sort((a, b) => a.t - b.t);
        const sorted = pts.map((p) => p.ms).sort((a, b) => a - b);
        return {
          event,
          color: EVENT_COLOR[event] ?? SPARE[spare++ % SPARE.length],
          points: pts,
          last: pts[pts.length - 1],
          p95: quantile(sorted, 0.95),
        };
      })
      .sort((a, b) => b.points.length - a.points.length);
  }, [rows]);

  const shown = all.filter((s) => !hidden.has(s.event));
  const visible = useMemo(
    () => shown.map((s) => ({ ...s, points: s.points.filter((p) => p.t >= t0 - 1_000) })),
    // t0 moves every second; the filter is cheap and keeps the trace honest
    // about what is actually inside the window.
    [shown, t0],
  );

  const plotW = Math.max(40, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;

  const peak = visible.reduce((m, s) => s.points.reduce((n, p) => Math.max(n, p.ms), m), 0);
  const top = niceMax(Math.max(peak, SLOW_MS / 5));

  const x = (t: number) => PAD.left + ((t - t0) / windowMs) * plotW;
  const y = (ms: number) => {
    if (logScale) {
      const lo = Math.log10(10);
      const hi = Math.log10(Math.max(top, 100));
      const v = Math.log10(Math.max(ms, 10));
      return PAD.top + plotH * (1 - (v - lo) / (hi - lo));
    }
    return PAD.top + plotH * (1 - Math.min(ms, top) / top);
  };

  const yTicks = useMemo(() => {
    if (logScale) {
      const out: number[] = [];
      for (let v = 10; v <= Math.max(top, 100); v *= 10) out.push(v);
      return out;
    }
    return [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  }, [logScale, top]);

  // Fewer labels on a narrow panel -- two timestamps colliding read as neither.
  const xTicks = useMemo(() => {
    const count = width < 420 ? 2 : width < 640 ? 3 : 4;
    return Array.from({ length: count + 1 }, (_, i) => t0 + (i * windowMs) / count);
  }, [t0, windowMs, width]);

  /**
   * A stage that runs on every cycle is a trace; one that runs every half hour
   * is a set of events, and joining three of those with a line draws a 30-minute
   * plateau that never happened. So: frequent stages get a line (broken across
   * any gap wide enough to mean the worker stopped), infrequent ones get a
   * stem and a marker.
   */
  function shape(points: Point[]) {
    const gaps = points.slice(1).map((p, i) => p.t - points[i].t).sort((a, b) => a - b);
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : Infinity;
    if (points.length < 3 || median > 45_000) return { trace: false, segments: [] as Point[][] };

    const limit = Math.max(15_000, median * 4);
    const out: Point[][] = [[points[0]]];
    for (let i = 1; i < points.length; i++) {
      if (points[i].t - points[i - 1].t > limit) out.push([points[i]]);
      else out[out.length - 1].push(points[i]);
    }
    return { trace: true, segments: out };
  }

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - box.left;
    const my = e.clientY - box.top;
    let best: { p: Point; x: number; y: number } | null = null;
    let bestD = 18 * 18;
    for (const s of visible) {
      for (const p of s.points) {
        const px = x(p.t);
        const py = y(p.ms);
        const d = (px - mx) ** 2 + (py - my) ** 2;
        if (d < bestD) { bestD = d; best = { p, x: px, y: py }; }
      }
    }
    setHover(best);
  }

  const newest = visible.reduce<Point | null>(
    (m, s) => (s.last && (!m || s.last.t > m.t) ? s.last : m), null,
  );
  const cycles = all.find((s) => s.event === "cycle");
  const empty = !isLoading && all.length === 0;

  return (
    <Panel
      title={<span className="flex items-center gap-1.5"><Gauge size={12} /> Stage timings</span>}
      action={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {cycles && (
            <span className="hidden sm:inline text-[11px] text-[var(--color-text-faint)] num">
              cycle {duration(cycles.last.ms)} · p95 {duration(cycles.p95)}
            </span>
          )}
          <div className="flex rounded overflow-hidden border border-[var(--color-border-soft)]">
            {WINDOWS.map((w) => (
              <button
                key={w.minutes}
                onClick={() => setWindowMin(w.minutes)}
                className={cn(
                  "px-2 py-0.5 text-[11px] transition-colors",
                  windowMin === w.minutes
                    ? "bg-[var(--color-border-soft)] text-[var(--color-text)]"
                    : "text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]",
                )}
              >
                {w.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setLogScale((v) => !v)}
            title="A 25s history refresh and a 1.2s cycle do not share a linear axis comfortably."
            className={cn(
              "px-2 py-0.5 text-[11px] rounded border transition-colors",
              logScale
                ? "border-[var(--color-neon)] text-[var(--color-neon-bright)]"
                : "border-[var(--color-border-soft)] text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]",
            )}
          >
            log
          </button>
        </div>
      }
      bodyClassName="p-3"
    >
      <div ref={wrapRef} className="relative">
        {empty ? (
          <p className="text-center py-14 text-xs text-[var(--color-text-faint)]">
            No timed stages in the last {WINDOWS.find((w) => w.minutes === windowMin)?.label}.
            The worker writes one line per cycle once it is running.
          </p>
        ) : (
          <svg
            width={width}
            height={H}
            className="block touch-none select-none"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            {/* horizontal grid + duration labels */}
            {yTicks.map((v) => (
              <g key={v}>
                <line
                  x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)}
                  stroke="var(--color-border-soft)" strokeWidth={1}
                />
                <text
                  x={PAD.left - 6} y={y(v) + 3} textAnchor="end"
                  className="num" fontSize={9} fill="var(--color-text-faint)"
                >
                  {v === 0 ? "0" : duration(v)}
                </text>
              </g>
            ))}

            {/* the worker's own "this was slow" threshold */}
            {SLOW_MS <= top && (
              <g>
                <line
                  x1={PAD.left} x2={width - PAD.right} y1={y(SLOW_MS)} y2={y(SLOW_MS)}
                  stroke="var(--color-warn)" strokeWidth={1} strokeDasharray="3 4" opacity={0.5}
                />
                <text
                  x={width - PAD.right} y={y(SLOW_MS) - 3} textAnchor="end"
                  fontSize={9} fill="var(--color-warn)" opacity={0.75}
                >
                  slow
                </text>
              </g>
            )}

            {/* time axis */}
            {xTicks.map((t, i) => (
              <text
                key={t}
                x={x(t)} y={H - 5}
                textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
                className="num" fontSize={9} fill="var(--color-text-faint)"
              >
                {axisTime(t, windowMin <= 5 && width >= 520)}
              </text>
            ))}

            {visible.map((s) => {
              const { trace, segments } = shape(s.points);
              const dots = trace && s.points.length <= 140;
              const floor = PAD.top + plotH;
              return (
                <g key={s.event}>
                  {segments.map((seg, i) => (
                    <polyline
                      key={i}
                      fill="none"
                      stroke={s.color}
                      strokeWidth={1.4}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      points={seg.map((p) => `${x(p.t)},${y(p.ms)}`).join(" ")}
                      opacity={0.9}
                    />
                  ))}
                  {s.points.map((p) => {
                    const bad = p.level !== "INFO" && p.level !== "DEBUG";
                    if (trace && !dots && !bad && p !== s.last) return null;
                    const px = x(p.t);
                    const py = y(p.ms);
                    return (
                      <g key={p.id}>
                        {!trace && (
                          <line
                            x1={px} x2={px} y1={py} y2={floor}
                            stroke={s.color} strokeWidth={1} opacity={0.35}
                          />
                        )}
                        <circle
                          cx={px} cy={py} r={bad ? 3 : trace ? 1.8 : 2.6}
                          fill={bad ? "var(--color-down)" : s.color}
                          opacity={bad ? 1 : 0.85}
                        />
                      </g>
                    );
                  })}
                </g>
              );
            })}

            {/* the live head: the most recent timed stage of any kind */}
            {newest && (
              <circle
                cx={x(newest.t)} cy={y(newest.ms)} r={3.5}
                fill="none" stroke="var(--color-neon-bright)" strokeWidth={1.2}
                className="live-dot"
              />
            )}

            {hover && (
              <line
                x1={hover.x} x2={hover.x} y1={PAD.top} y2={PAD.top + plotH}
                stroke="var(--color-border)" strokeWidth={1}
              />
            )}
          </svg>
        )}

        {hover && (
          <div
            className="panel absolute z-10 px-2 py-1.5 pointer-events-none text-[10px] whitespace-nowrap"
            style={{
              left: Math.min(Math.max(hover.x, 60), width - 60),
              top: hover.y,
              transform: "translate(-50%, calc(-100% - 8px))",
            }}
          >
            <p className="font-mono text-[var(--color-neon-bright)]">{hover.p.event}</p>
            <p className="num text-[var(--color-text)]">{duration(hover.p.ms)}</p>
            <p className="num text-[var(--color-text-faint)]">{axisTime(hover.p.t, true)}</p>
            <p className="text-[var(--color-text-dim)] max-w-[22rem] truncate">{hover.p.message}</p>
          </div>
        )}
      </div>

      {all.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pt-2">
          {all.map((s) => {
            const off = hidden.has(s.event);
            return (
              <button
                key={s.event}
                onClick={() => setHidden((prev) => {
                  const next = new Set(prev);
                  if (next.has(s.event)) next.delete(s.event);
                  else next.add(s.event);
                  return next;
                })}
                className={cn(
                  "flex items-center gap-1.5 text-[10px] transition-opacity",
                  off ? "opacity-35" : "hover:opacity-80",
                )}
              >
                <span className="h-[2px] w-3 rounded-full" style={{ background: s.color }} />
                <span className="font-mono text-[var(--color-text-dim)]">{s.event}</span>
                <span className="num text-[var(--color-text-faint)]">{duration(s.last.ms)}</span>
              </button>
            );
          })}
          <span className="ml-auto text-[10px] text-[var(--color-text-faint)]">
            duration_ms per shipped stage · click a stage to hide it
          </span>
        </div>
      )}
    </Panel>
  );
}
