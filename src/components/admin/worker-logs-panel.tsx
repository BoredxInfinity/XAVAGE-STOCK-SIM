"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronRight, ScrollText } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { createClient } from "@/lib/supabase/client";
import { useNow } from "@/hooks/use-now";
import { cn, relative } from "@/lib/format";
import type { WorkerLog, WorkerLogLevel } from "@/lib/database.types";

/** Only two filters matter in practice: "what happened" and "what went wrong". */
const FILTERS = [
  { key: "all", label: "Everything" },
  { key: "problems", label: "Problems only" },
] as const;

const LEVEL_STYLE: Record<WorkerLogLevel, string> = {
  DEBUG: "text-[var(--color-text-faint)]",
  INFO: "text-[var(--color-text-dim)]",
  WARNING: "text-[var(--color-warn)]",
  ERROR: "text-[var(--color-down)]",
  CRITICAL: "text-[var(--color-down)] font-bold",
};

function duration(ms: number | null) {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

export function WorkerLogsPanel() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [open, setOpen] = useState<number | null>(null);
  const now = useNow();

  const { data: logs = [], isLoading } = useQuery<WorkerLog[]>({
    queryKey: ["worker-logs", filter],
    refetchInterval: 20_000,
    queryFn: async () => {
      const supabase = createClient();
      let q = supabase
        .from("worker_logs")
        .select("id, ts, level, event, message, cycle, duration_ms, rss_mb, detail")
        .order("ts", { ascending: false })
        .limit(120);
      if (filter === "problems") q = q.in("level", ["WARNING", "ERROR", "CRITICAL"]);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as WorkerLog[];
    },
  });

  const problems = logs.filter((l) => l.level !== "INFO" && l.level !== "DEBUG").length;
  // The worker records its own resident memory on every cycle line, so the
  // most recent one is the cheapest possible answer to "is it drifting?".
  const latestRss = logs.find((l) => l.rss_mb != null)?.rss_mb ?? null;

  return (
    <Panel
      title={<span className="flex items-center gap-1.5"><ScrollText size={12} /> Worker log</span>}
      action={
        <div className="flex items-center gap-2">
          {latestRss != null && (
            <span className="text-[11px] text-[var(--color-text-faint)] num">{latestRss} MB</span>
          )}
          {problems > 0 && (
            <span className="text-[11px] text-[var(--color-warn)] flex items-center gap-1">
              <AlertTriangle size={11} /> {problems}
            </span>
          )}
          <div className="flex rounded overflow-hidden border border-[var(--color-border-soft)]">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  "px-2 py-0.5 text-[11px] transition-colors",
                  filter === f.key
                    ? "bg-[var(--color-border-soft)] text-[var(--color-text)]"
                    : "text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      }
      bodyClassName="max-h-[26rem] overflow-y-auto"
    >
      {isLoading && (
        <p className="text-center py-8 text-xs text-[var(--color-text-faint)]">Loading…</p>
      )}

      {!isLoading && logs.length === 0 && (
        <div className="text-center py-8 px-4">
          <p className="text-xs text-[var(--color-text-faint)]">
            {filter === "problems"
              ? "Nothing has gone wrong in the last 48 hours."
              : "No worker output yet. The worker writes here on every cycle once it is running."}
          </p>
        </div>
      )}

      <ul className="divide-y divide-[var(--color-border-soft)]">
        {logs.map((l) => {
          const expandable = l.detail && Object.keys(l.detail).length > 0;
          const isOpen = open === l.id;
          return (
            <li key={l.id} className="px-3 py-1.5 text-[11px] leading-relaxed">
              <button
                type="button"
                disabled={!expandable}
                onClick={() => setOpen(isOpen ? null : l.id)}
                className={cn(
                  "w-full flex items-baseline gap-2 text-left",
                  expandable && "cursor-pointer hover:opacity-80",
                )}
              >
                <span className="num text-[var(--color-text-faint)] shrink-0 tabular-nums">
                  {new Date(l.ts).toLocaleTimeString([], { hour12: false })}
                </span>
                <span className={cn("shrink-0 font-mono uppercase w-14", LEVEL_STYLE[l.level])}>
                  {l.level === "CRITICAL" ? "CRIT" : l.level}
                </span>
                <span className="shrink-0 text-[var(--color-neon-bright)] font-mono">{l.event}</span>
                <span className="flex-1 min-w-0 truncate text-[var(--color-text-dim)]">
                  {l.message}
                </span>
                {l.duration_ms != null && (
                  <span className="num shrink-0 text-[var(--color-text-faint)] tabular-nums">
                    {duration(l.duration_ms)}
                  </span>
                )}
                {expandable && (
                  isOpen
                    ? <ChevronDown size={11} className="shrink-0 text-[var(--color-text-faint)]" />
                    : <ChevronRight size={11} className="shrink-0 text-[var(--color-text-faint)]" />
                )}
              </button>

              {isOpen && expandable && (
                <div className="mt-1 ml-[4.5rem] flex flex-wrap gap-x-4 gap-y-0.5">
                  {Object.entries(l.detail as Record<string, unknown>).map(([k, v]) => (
                    <span key={k} className="text-[10px] text-[var(--color-text-faint)]">
                      <span className="text-[var(--color-text-dim)]">{k}</span>{" "}
                      <span className="num">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                    </span>
                  ))}
                  {l.rss_mb != null && (
                    <span className="text-[10px] text-[var(--color-text-faint)]">
                      <span className="text-[var(--color-text-dim)]">rss</span>{" "}
                      <span className="num">{l.rss_mb} MB</span>
                    </span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {logs.length > 0 && (
        <p className="px-3 py-2 text-[10px] text-[var(--color-text-faint)] border-t border-[var(--color-border-soft)]">
          Newest first · kept 48 hours · every cycle plus anything slow, memory-hungry or failed.
          {logs[0] && ` Last entry ${relative(logs[0].ts, now)}.`}
        </p>
      )}
    </Panel>
  );
}
