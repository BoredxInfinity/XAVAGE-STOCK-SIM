"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Gauge, Loader2, RotateCcw, Save } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/format";
import type { GameSettings, WorkerLog } from "@/lib/database.types";

/**
 * How often the worker does anything, steerable without an SSH key.
 *
 * These were environment variables on the box, so tightening the live cadence
 * for a busy final hour meant a session on the instance and a restart -- with
 * the feed down for the length of a cold start, during the event. A blank
 * field means "whatever the worker was started with", so an untouched
 * deployment still behaves exactly as its environment says.
 */
type Row = {
  key: keyof GameSettings;
  /** The key the worker reports this under in its own log detail. */
  reported: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  /** Suffix shown in the field. Everything here is seconds except the cap. */
  unit?: string;
};

const ROWS: Row[] = [
  {
    key: "worker_live_interval", reported: "live_interval",
    label: "Live", min: 3, max: 600,
    hint: "Seconds between cycles while the market is open. A cycle takes about four seconds, so below that the worker only ever runs late.",
  },
  {
    key: "worker_regular_interval", reported: "regular_interval",
    label: "Regular", min: 10, max: 3600,
    hint: "Pre-market and after hours. Prints are thin, so a fast cadence spends requests on the same price twenty times over.",
  },
  {
    key: "worker_idle_interval", reported: "idle_interval",
    label: "Idle", min: 15, max: 3600,
    hint: "While the exchange is shut. No prices are fetched either way — this is only how often the worker says it is still alive, and the health line above reads idle rather than stale in this gear.",
  },
  {
    key: "worker_history_interval", reported: "history_interval",
    label: "History", min: 60, max: 86400,
    hint: "Between refreshes of the 5D chart series. The worker's largest single allocation, and it runs inside the same loop as prices.",
  },
  {
    key: "worker_max_symbols", reported: "max_symbols",
    label: "Symbols", min: 1, max: 2000, unit: "",
    hint: "How many instruments the worker quotes, and therefore how many participants can list, search and trade — past this a symbol does not exist to them. Every extra symbol costs time in every cycle and memory on the box.",
  },
];

export function WorkerCadencePanel() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const { data: settings } = useQuery({
    queryKey: ["game-settings"],
    // Without this the panel shows what the settings were when the tab was
    // opened: a cadence changed from another window, or by the reset button
    // in another session, would not appear until a reload.
    refetchInterval: 30_000,
    queryFn: async (): Promise<GameSettings> => {
      const { data, error } = await createClient()
        .from("game_settings").select("*").eq("id", true).single();
      if (error) throw error;
      return data as GameSettings;
    },
  });

  // What the worker itself last said it was running to. The configured value
  // and the one in force are different facts: a worker that is down, or has
  // not reached its next settings refresh, is still on the old cadence.
  const { data: inForce } = useQuery({
    queryKey: ["worker-cadence-in-force"],
    refetchInterval: 20_000,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from("worker_logs")
        .select("ts, event, detail")
        .in("event", ["startup", "cadence"])
        .order("ts", { ascending: false })
        .limit(1);
      if (error) throw error;
      const row = (data ?? [])[0] as Pick<WorkerLog, "ts" | "event" | "detail"> | undefined;
      return row ?? null;
    },
  });

  useEffect(() => { setDraft({}); }, [settings?.updated_at]);

  const dirty = useMemo(
    () => ROWS.filter((r) => r.key in draft
      && draft[r.key] !== (settings?.[r.key] == null ? "" : String(settings[r.key]))),
    [draft, settings],
  );

  function shown(r: Row): string {
    if (r.key in draft) return draft[r.key];
    const v = settings?.[r.key];
    return v == null ? "" : String(v);
  }

  function reported(r: Row): number | null {
    const detail = inForce?.detail as Record<string, unknown> | null | undefined;
    const v = detail?.[r.reported];
    return typeof v === "number" ? v : null;
  }

  async function save(patch: Partial<Record<string, number | null>>) {
    setSaving(true);
    const { error } = await createClient().rpc("admin_update_settings", { p_patch: patch });
    setSaving(false);

    if (error) {
      toast.error("Could not save the cadence", { description: error.message });
      return;
    }
    toast.success("Cadence saved", {
      description: "The worker picks it up on its next settings refresh — within a minute — and logs the change below.",
    });
    setDraft({});
    qc.invalidateQueries({ queryKey: ["game-settings"] });
    qc.invalidateQueries({ queryKey: ["worker-logs"] });
    qc.invalidateQueries({ queryKey: ["worker-cadence-in-force"] });
  }

  function submit() {
    const patch: Record<string, number | null> = {};
    for (const r of dirty) {
      const raw = draft[r.key].trim();
      if (raw === "") { patch[r.key] = null; continue; }

      const n = Number(raw);
      if (!Number.isInteger(n) || n < r.min || n > r.max) {
        const u = r.unit ?? "s";
        toast.error(`${r.label} must be a whole number between ${r.min}${u} and ${r.max}${u}`);
        return;
      }
      patch[r.key] = n;
    }
    void save(patch);
  }

  const anySet = ROWS.some((r) => settings?.[r.key] != null);

  return (
    <Panel
      title={<span className="flex items-center gap-1.5"><Gauge size={12} /> Cadence</span>}
      action={
        <div className="flex items-center gap-2">
          {anySet && (
            <button
              onClick={() => save(Object.fromEntries(ROWS.map((r) => [r.key, null])))}
              disabled={saving}
              className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-[var(--color-border-soft)] text-[var(--color-text-faint)] hover:text-[var(--color-text)] transition-colors"
            >
              <RotateCcw size={11} /> Worker defaults
            </button>
          )}
          <button
            onClick={submit}
            disabled={saving || dirty.length === 0}
            className="btn btn-primary !py-1 !text-[11px] disabled:opacity-40"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            Save{dirty.length > 0 ? ` (${dirty.length})` : ""}
          </button>
        </div>
      }
      bodyClassName="p-4 space-y-3"
    >
      {ROWS.map((r) => {
        const live = reported(r);
        const configured = settings?.[r.key] as number | null | undefined;
        // The worker is running to something other than what is configured:
        // it has not refreshed yet, or it is not running at all.
        const pending = live != null && configured != null && live !== configured;
        return (
          <div key={r.key} className="flex items-start gap-3">
            <div className="w-20 shrink-0 pt-1.5">
              <p className="text-xs font-semibold">{r.label}</p>
              <p className="text-[10px] text-[var(--color-text-faint)] num">
                {live != null ? `${live}${r.unit ?? "s"} in force` : "—"}
              </p>
            </div>

            <div className="shrink-0">
              <div className="relative">
                <input
                  type="number"
                  inputMode="numeric"
                  min={r.min}
                  max={r.max}
                  value={shown(r)}
                  placeholder={live != null ? String(live) : "default"}
                  onChange={(e) => setDraft((d) => ({ ...d, [r.key]: e.target.value }))}
                  className="field !w-28 num pr-6"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[var(--color-text-faint)] pointer-events-none">
                  {r.unit ?? "s"}
                </span>
              </div>
              {pending && (
                <p className="text-[10px] text-[var(--color-warn)] mt-0.5">not picked up yet</p>
              )}
            </div>

            <p className="flex-1 text-[10px] text-[var(--color-text-faint)] leading-relaxed pt-1">
              {r.hint}
            </p>
          </div>
        );
      })}

      <p className="text-[10px] text-[var(--color-text-faint)] border-t border-[var(--color-border-soft)] pt-2.5">
        Leave a field empty to use the value the worker was started with. Changes are read on the
        worker&rsquo;s settings refresh — within a minute, no restart — and it writes a line to the
        log below saying what it is now running to.
      </p>
    </Panel>
  );
}
