"use client";

import { useMemo } from "react";
import Link from "next/link";
import { AlertTriangle, Radio } from "lucide-react";
import { useMarketStatus } from "@/hooks/use-app-data";
import { useQuotesVersion } from "@/hooks/use-quote";
import { useNow } from "@/hooks/use-now";
import { quoteStore } from "@/lib/quote-store";
import { cn, num, pct, relative } from "@/lib/format";

/** Symbols pinned to the front of the tape; the rest follow alphabetically. */
const PINNED = ["SPY", "QQQ", "DIA", "IWM", "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "META", "GOOGL"];

export function MarketBar() {
  const { data: status } = useMarketStatus();
  const version = useQuotesVersion();
  const now = useNow();

  const tape = useMemo(() => {
    const all = quoteStore.getAll();
    const rank = (s: string) => {
      const i = PINNED.indexOf(s);
      return i === -1 ? PINNED.length : i;
    };
    return all
      .sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol))
      .slice(0, 30);
    // version is the store's change counter -- it is the real dependency here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const halted = status && !status.trading_enabled;
  const open = status?.is_open;

  return (
    <div className="border-b border-[var(--color-border-soft)] bg-[var(--color-bg-elev)]">
      <div className="max-w-[1600px] mx-auto px-4 lg:px-6 h-9 flex items-center gap-4">
        <div className="flex items-center gap-2 shrink-0">
          {halted ? (
            <span className="chip chip-warn">
              <AlertTriangle size={11} /> Halted
            </span>
          ) : (
            <span className={cn("chip", open ? "chip-up" : "chip-neutral")}>
              <Radio size={11} className={open ? "live-dot" : ""} />
              {open ? "Market open" : status?.market_state === "pre" ? "Pre-market"
                : status?.market_state === "post" ? "After hours" : "Market closed"}
            </span>
          )}
          <span className="hidden lg:inline text-[11px] text-[var(--color-text-faint)] num">
            {status?.last_tick_at ? `tick ${relative(status.last_tick_at, now)}` : "awaiting feed"}
          </span>
        </div>

        <div className="h-4 w-px bg-[var(--color-border)] shrink-0 hidden sm:block" />

        {/* Tape. Overflows horizontally rather than wrapping or clipping. */}
        <div className="flex-1 overflow-x-auto no-scrollbar">
          <div className="flex items-center gap-4 w-max">
            {tape.length === 0 && (
              <span className="text-[11px] text-[var(--color-text-faint)]">
                Waiting for the price feed…
              </span>
            )}
            {tape.map((q) => {
              const change = q.prev_close ? q.price - Number(q.prev_close) : 0;
              const changePct = q.prev_close ? (change / Number(q.prev_close)) * 100 : 0;
              return (
                <Link
                  key={q.symbol} href={`/trade/${q.symbol}`}
                  className={cn(
                    "flex items-center gap-1.5 text-[11px] rounded px-1 -mx-1 shrink-0",
                    q.tick === "up" ? "flash-up" : q.tick === "down" ? "flash-down" : "",
                  )}
                >
                  <span className="font-semibold text-[var(--color-text-dim)]">{q.symbol}</span>
                  <span className="num text-[var(--color-text)]">{num(q.price)}</span>
                  <span className={cn(
                    "num",
                    change > 0 ? "text-[var(--color-up)]"
                      : change < 0 ? "text-[var(--color-down)]"
                      : "text-[var(--color-text-faint)]",
                  )}>
                    {pct(changePct)}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      {halted && status?.halt_reason && (
        <div className="bg-[color-mix(in_oklab,var(--color-warn)_12%,transparent)] border-t border-[color-mix(in_oklab,var(--color-warn)_30%,transparent)] px-4 lg:px-6 py-1.5">
          <p className="max-w-[1600px] mx-auto text-[11px] text-[var(--color-warn)]">
            Trading is halted by the organisers — {status.halt_reason}
          </p>
        </div>
      )}
    </div>
  );
}
