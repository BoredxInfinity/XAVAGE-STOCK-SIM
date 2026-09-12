"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Lock } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useMarketStatus } from "@/hooks/use-app-data";
import { cn } from "@/lib/format";
import type { WorkerMode } from "@/lib/database.types";

/**
 * The rehearsal lever.
 *
 * The exchange decides the session; this exists so an organiser does not have
 * to wait for New York to rehearse one. Outside regular hours it forces the
 * worker into a mode -- and with it the book, since anything but idle accepts
 * orders. During the regular session it is inert: private.session_mode()
 * ignores the override while the market is open, so this control disables
 * itself rather than pretending to an authority it does not have.
 */
const MODES: { key: WorkerMode | "auto"; label: string; hint: string }[] = [
  { key: "auto", label: "Follow market", hint: "Live while the market is open, slow through pre/post, idle when it is shut." },
  { key: "idle", label: "Idle", hint: "No feed requests at all, and the book is closed. What a shut market looks like." },
  { key: "regular", label: "Regular", hint: "Slow poll, book open. What pre-market and after hours look like." },
  { key: "live", label: "Live", hint: "Full 5s cadence and an open book, whatever the exchange is doing." },
];

export function WorkerModeSwitch() {
  const qc = useQueryClient();
  const { data: status } = useMarketStatus();
  const [saving, setSaving] = useState<string | null>(null);

  const locked = status?.worker_mode_locked ?? false;
  const current: WorkerMode | "auto" = status?.worker_mode_override ?? "auto";

  async function choose(key: WorkerMode | "auto") {
    if (locked || key === current) return;
    setSaving(key);
    const { error } = await createClient().rpc("admin_update_settings", {
      p_patch: { worker_mode_override: key === "auto" ? null : key },
    });
    setSaving(null);

    if (error) {
      toast.error("Could not change the worker mode", { description: error.message });
      return;
    }
    toast.success(
      key === "auto" ? "Worker follows the exchange again" : `Worker forced to ${key}`,
      { description: key === "idle" ? "The book is closed while the worker is idle." : undefined },
    );
    qc.invalidateQueries({ queryKey: ["market-status"] });
  }

  return (
    <div className="flex items-center gap-2">
      <div>
        <p className="text-xs font-semibold flex items-center gap-1.5">
          Worker {status?.worker_mode ?? "—"}
          {locked && <Lock size={11} className="text-[var(--color-text-faint)]" />}
        </p>
        <p className="text-[11px] text-[var(--color-text-faint)]">
          {locked
            ? "locked live while the market is open"
            : current === "auto" ? "following the exchange" : `forced · ${current}`}
        </p>
      </div>

      <div
        className={cn(
          "flex rounded overflow-hidden border border-[var(--color-border-soft)]",
          locked && "opacity-50",
        )}
        title={locked
          ? "The market is open. The worker stays live and the override is ignored."
          : undefined}
      >
        {MODES.map((m) => (
          <button
            key={m.key}
            onClick={() => choose(m.key)}
            disabled={locked || saving !== null}
            title={m.hint}
            className={cn(
              "px-2 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed",
              current === m.key
                ? "bg-[var(--color-border-soft)] text-[var(--color-text)]"
                : "text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]",
              saving === m.key && "opacity-60",
            )}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}
