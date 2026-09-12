"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Pause, Play, RotateCcw, Save, TriangleAlert } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { createClient } from "@/lib/supabase/client";
import { cn, stamp } from "@/lib/format";
import type { GameSettings } from "@/lib/database.types";

type Field = {
  key: keyof GameSettings;
  label: string;
  hint: string;
  kind: "number" | "boolean" | "text" | "select" | "datetime";
  step?: string;
  suffix?: string;
  options?: { value: string; label: string }[];
};

const GROUPS: { title: string; blurb: string; fields: Field[] }[] = [
  {
    title: "Session control",
    blurb: "Start, stop and gate the competition.",
    fields: [
      { key: "trading_enabled", label: "Trading enabled", kind: "boolean",
        hint: "Master switch. Turning this off halts every team instantly." },
      { key: "halt_reason", label: "Halt reason", kind: "text",
        hint: "Shown to participants on the ticker bar while trading is halted." },
      { key: "competition_start_at", label: "Competition starts", kind: "datetime",
        hint: "Orders are refused before this moment. Leave blank for no gate." },
      { key: "competition_end_at", label: "Competition ends", kind: "datetime",
        hint: "Orders are refused after this moment." },
      { key: "leaderboard_visible_to_participants", label: "Show rankings to participants", kind: "boolean",
        hint: "Off by default — rankings stay admin-only until you flip this." },
      { key: "price_staleness_seconds", label: "Max price age", kind: "number", suffix: "s",
        hint: "Orders are refused if the last quote is older than this. Protects against a dead feed." },
    ],
  },
  {
    title: "Interest rates",
    blurb: "The macro levers. Applied once per day to every team's book.",
    fields: [
      { key: "cash_interest_apr", label: "Cash interest", kind: "number", step: "0.1", suffix: "% APR",
        hint: "Paid daily on positive cash. Raise it to reward sitting out; cut it to force teams into the market." },
      { key: "margin_interest_apr", label: "Margin interest", kind: "number", step: "0.1", suffix: "% APR",
        hint: "Charged daily on negative cash when margin is enabled." },
      { key: "short_borrow_apr", label: "Short borrow fee", kind: "number", step: "0.1", suffix: "% APR",
        hint: "Charged daily on the market value of short positions." },
      { key: "capital_gains_tax_pct", label: "Capital gains tax", kind: "number", step: "0.5", suffix: "%",
        hint: "Taken from each profitable closing trade at the moment it realises." },
    ],
  },
  {
    title: "Trading costs",
    blurb: "Friction. Small numbers here change behaviour a lot.",
    fields: [
      { key: "commission_per_trade", label: "Flat commission", kind: "number", step: "0.01", suffix: "$",
        hint: "Charged on every fill regardless of size." },
      { key: "commission_bps", label: "Commission", kind: "number", step: "0.5", suffix: "bps",
        hint: "Basis points of notional. 10 bps = 0.10%." },
      { key: "min_commission", label: "Minimum commission", kind: "number", step: "0.01", suffix: "$",
        hint: "Floor applied after the flat + bps calculation." },
      { key: "slippage_bps", label: "Slippage", kind: "number", step: "0.5", suffix: "bps",
        hint: "Spread cost paid by market and triggered stop orders. Limit fills never pay it." },
    ],
  },
  {
    title: "Leverage & shorting",
    blurb: "Decide how much rope each team gets.",
    fields: [
      { key: "allow_shorting", label: "Allow short selling", kind: "boolean",
        hint: "Off by default. When off, a team can never sell more than it holds." },
      { key: "allow_margin", label: "Allow margin", kind: "boolean",
        hint: "When off, cash can never go negative." },
      { key: "max_leverage", label: "Max leverage", kind: "number", step: "0.1", suffix: "×",
        hint: "Gross exposure ceiling as a multiple of equity. 1.0 = cash only." },
      { key: "maintenance_margin_pct", label: "Maintenance margin", kind: "number", step: "1", suffix: "%",
        hint: "Reference level for margin monitoring." },
    ],
  },
  {
    title: "Risk limits",
    blurb: "Guardrails that stop one lucky bet from deciding the competition.",
    fields: [
      { key: "max_position_pct_of_equity", label: "Max single position", kind: "number", step: "1", suffix: "%",
        hint: "Forces diversification. 25% means no name may exceed a quarter of the book." },
      { key: "max_order_notional", label: "Max order size", kind: "number", step: "1000", suffix: "$",
        hint: "Per-order ceiling. Blank means unlimited." },
      { key: "min_order_notional", label: "Min order size", kind: "number", step: "10", suffix: "$",
        hint: "Blocks spam-sized orders. 0 disables the check." },
      { key: "allow_fractional_shares", label: "Allow fractional shares", kind: "boolean",
        hint: "Off keeps quantities as whole numbers, which is easier to explain." },
      { key: "starting_capital", label: "Starting capital", kind: "number", step: "1000", suffix: "$",
        hint: "Default for NEW teams. Existing teams keep the capital they were created with." },
    ],
  },
];

export function SettingsView() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Partial<GameSettings>>({});
  const [saving, setSaving] = useState(false);

  const { data: settings, isLoading } = useQuery({
    queryKey: ["game-settings"],
    queryFn: async (): Promise<GameSettings> => {
      const { data, error } = await createClient()
        .from("game_settings").select("*").eq("id", true).single();
      if (error) throw error;
      return data as GameSettings;
    },
  });

  useEffect(() => { setDraft({}); }, [settings?.updated_at]);

  const dirty = useMemo(() => {
    if (!settings) return [];
    return (Object.keys(draft) as (keyof GameSettings)[])
      .filter((k) => String(draft[k] ?? "") !== String(settings[k] ?? ""));
  }, [draft, settings]);

  function set<K extends keyof GameSettings>(key: K, value: GameSettings[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function valueOf<K extends keyof GameSettings>(key: K): GameSettings[K] | undefined {
    return (key in draft ? draft[key] : settings?.[key]) as GameSettings[K] | undefined;
  }

  async function save(patchOverride?: Partial<GameSettings>) {
    const patch = patchOverride ?? Object.fromEntries(dirty.map((k) => [k, draft[k]]));
    if (Object.keys(patch).length === 0) return;

    setSaving(true);
    const { data, error } = await createClient().rpc("admin_update_settings", { p_patch: patch });

    if (error) {
      toast.error("Could not save", { description: error.message });
    } else {
      const changed = (data as unknown as { changed?: unknown[] })?.changed ?? [];
      toast.success(`${changed.length} setting${changed.length === 1 ? "" : "s"} updated`, {
        description: "Applied live — participants see the change immediately.",
      });
      setDraft({});
    }

    qc.invalidateQueries({ queryKey: ["game-settings"] });
    qc.invalidateQueries({ queryKey: ["market-status"] });
    setSaving(false);
  }

  if (isLoading || !settings) return <div className="h-96 skeleton rounded-xl" />;

  const halted = !valueOf("trading_enabled");

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold tracking-tight">Game settings</h1>
          <p className="text-xs text-[var(--color-text-dim)]">
            Every change applies live and is written to the audit trail. Last updated {stamp(settings.updated_at)}.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => save({ trading_enabled: !halted, halt_reason: halted ? null : "Paused by the organisers" })}
            className={cn("btn !py-1.5", halted ? "btn-buy" : "btn-danger")}
          >
            {halted ? <Play size={14} /> : <Pause size={14} />}
            {halted ? "Resume trading" : "Halt trading"}
          </button>
          <button onClick={() => setDraft({})} disabled={dirty.length === 0} className="btn btn-ghost !py-1.5">
            <RotateCcw size={14} /> Discard
          </button>
          <button onClick={() => save()} disabled={dirty.length === 0 || saving} className="btn btn-primary !py-1.5">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save{dirty.length > 0 ? ` (${dirty.length})` : ""}
          </button>
        </div>
      </div>

      {halted && (
        <div className="flex items-center gap-2 rounded-xl border border-[color-mix(in_oklab,var(--color-warn)_35%,transparent)] bg-[color-mix(in_oklab,var(--color-warn)_10%,transparent)] px-4 py-2.5">
          <TriangleAlert size={15} className="text-[var(--color-warn)] shrink-0" />
          <p className="text-xs text-[var(--color-warn)]">
            Trading is halted for every team. No order will fill until you resume.
          </p>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        {GROUPS.map((group) => (
          <Panel key={group.title} title={group.title} bodyClassName="p-4 space-y-4">
            <p className="text-[11px] text-[var(--color-text-faint)] -mt-1">{group.blurb}</p>

            {group.fields.map((field) => {
              const value = valueOf(field.key);
              const changed = dirty.includes(field.key);

              return (
                <div key={String(field.key)} className={cn(
                  "rounded-lg -mx-2 px-2 py-1.5 transition-colors",
                  changed && "bg-[color-mix(in_oklab,var(--color-violet)_10%,transparent)]",
                )}>
                  {field.kind === "boolean" ? (
                    <label className="flex items-start gap-3 cursor-pointer">
                      <button
                        type="button" role="switch" aria-checked={!!value}
                        onClick={() => set(field.key, !value as never)}
                        className={cn(
                          "mt-0.5 relative w-9 h-5 rounded-full shrink-0 transition-colors",
                          value ? "bg-[var(--color-neon-deep)]" : "bg-[var(--color-surface-3)]",
                        )}
                      >
                        {/* left-0 anchors the knob; without a horizontal anchor an
                            absolutely-positioned child falls back to its static
                            position and escapes the 36px track. */}
                        <span className={cn(
                          "absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform",
                          value ? "translate-x-4" : "translate-x-0",
                        )} />
                      </button>
                      <span className="min-w-0">
                        <span className="block text-xs font-semibold">{field.label}</span>
                        <span className="block text-[10.5px] text-[var(--color-text-faint)] leading-snug mt-0.5">
                          {field.hint}
                        </span>
                      </span>
                    </label>
                  ) : (
                    <>
                      <div className="flex items-baseline justify-between gap-2 mb-1">
                        <label className="label mb-0" htmlFor={String(field.key)}>{field.label}</label>
                        {field.suffix && (
                          <span className="text-[10px] text-[var(--color-text-faint)] num">{field.suffix}</span>
                        )}
                      </div>

                      {field.kind === "select" ? (
                        <select
                          id={String(field.key)} className="field"
                          value={String(value ?? "")}
                          onChange={(e) => set(field.key, e.target.value as never)}
                        >
                          {field.options!.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      ) : field.kind === "datetime" ? (
                        <input
                          id={String(field.key)} type="datetime-local" className="field num"
                          value={value ? new Date(String(value)).toISOString().slice(0, 16) : ""}
                          onChange={(e) =>
                            set(field.key, (e.target.value ? new Date(e.target.value).toISOString() : null) as never)}
                        />
                      ) : field.kind === "number" ? (
                        <input
                          id={String(field.key)} type="number" step={field.step ?? "0.01"}
                          className="field num" value={value == null ? "" : String(value)}
                          onChange={(e) =>
                            set(field.key, (e.target.value === "" ? null : Number(e.target.value)) as never)}
                        />
                      ) : (
                        <input
                          id={String(field.key)} type="text" className="field"
                          value={value == null ? "" : String(value)}
                          placeholder="—"
                          onChange={(e) => set(field.key, (e.target.value || null) as never)}
                        />
                      )}

                      <p className="mt-1 text-[10.5px] text-[var(--color-text-faint)] leading-snug">
                        {field.hint}
                      </p>
                    </>
                  )}
                </div>
              );
            })}
          </Panel>
        ))}
      </div>
    </div>
  );
}
