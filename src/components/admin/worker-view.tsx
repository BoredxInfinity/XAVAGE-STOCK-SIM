"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useMarketStatus } from "@/hooks/use-app-data";
import { useNow } from "@/hooks/use-now";
import { WorkerModeSwitch } from "@/components/admin/worker-mode-switch";
import { WorkerTimingChart } from "@/components/admin/worker-timing-chart";
import { WorkerLogsPanel } from "@/components/admin/worker-logs-panel";
import { cn, relative } from "@/lib/format";

/**
 * Everything about the price feed, in one place.
 *
 * These four panels were scattered down the control room, under the standings
 * and the announcement wire -- which is the wrong place for them twice over.
 * On an ordinary day nobody needs them, and on the day the feed misbehaves
 * they are what you want on screen together: is it alive, what gear is it in,
 * how long is it taking, and what did it say.
 */
export function WorkerView() {
  const { data: status } = useMarketStatus();
  // The health line has to age between polls, or a feed that died reads as
  // healthy for the rest of the interval.
  const now = useNow();

  const { data: health } = useQuery({
    queryKey: ["worker-health"],
    refetchInterval: 15_000,
    queryFn: async () => {
      const supabase = createClient();
      const [state, quotes] = await Promise.all([
        supabase.from("system_state").select("*").eq("id", true).maybeSingle(),
        supabase.from("quotes").select("symbol", { count: "exact", head: true }),
      ]);
      return { state: state.data, quoteCount: quotes.count ?? 0 };
    },
  });

  const lastTick = health?.state?.last_tick_at ?? status?.last_tick_at ?? null;
  const tickAgeSec = lastTick ? (now - new Date(lastTick).getTime()) / 1000 : null;
  const feedHealthy = tickAgeSec != null && tickAgeSec < 120;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight">Stock worker</h1>
        <p className="text-xs text-[var(--color-text-dim)]">
          The price feed: whether it is alive, what gear it is in, and what it has been doing.
        </p>
      </div>

      <div className={cn(
        "panel-glow p-4 flex flex-wrap items-center gap-x-8 gap-y-3",
        !feedHealthy && "!border-[color-mix(in_oklab,var(--color-warn)_45%,transparent)]",
      )}>
        <div className="flex items-center gap-2">
          {feedHealthy
            ? <CheckCircle2 size={18} className="text-[var(--color-up)]" />
            : <AlertTriangle size={18} className="text-[var(--color-warn)]" />}
          <div>
            <p className="text-xs font-semibold">
              {feedHealthy ? "Price feed healthy" : "Price feed stale"}
            </p>
            <p className="text-[11px] text-[var(--color-text-faint)]">
              {lastTick ? `last tick ${relative(lastTick, now)}` : "no tick recorded yet"}
              {health?.state?.last_tick_source ? ` · ${health.state.last_tick_source}` : ""}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div>
            <p className="text-xs font-semibold num">{health?.quoteCount ?? "—"}</p>
            <p className="text-[11px] text-[var(--color-text-faint)]">symbols quoting</p>
          </div>
        </div>

        <div className="flex-1" />

        <WorkerModeSwitch />
      </div>

      <WorkerTimingChart />
      <WorkerLogsPanel />
    </div>
  );
}
