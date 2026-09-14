"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search, TrendingUp } from "lucide-react";
import { cn } from "@/lib/format";

interface Hit {
  symbol: string;
  name: string;
  exchange: string | null;
  asset_type: string;
  is_tradable: boolean;
  is_halted: boolean;
  source: "local" | "yahoo";
}

export function SymbolSearch({
  onPick, placeholder = "Search ticker or company…", autoFocus,
}: {
  onPick?: (symbol: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const boxRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);

  /* debounce so typing "MSFT" is one request, not four */
  useEffect(() => {
    const term = query.trim();
    if (term.length === 0) { setHits([]); setLoading(false); return; }

    setLoading(true);
    // The debounce timer was the only thing being cleaned up, so an in-flight
    // request outlived the keystroke that started it. /api/search reaches
    // Yahoo on a 3.5s timeout for an unknown ticker, so "AA" could easily
    // resolve AFTER "AAPL" and overwrite the right results with stale ones.
    const controller = new AbortController();

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`,
                                { signal: controller.signal });
        const json = (await res.json()) as { results?: Hit[] };
        if (controller.signal.aborted) return;
        setHits(json.results ?? []);
        setCursor(0);
      } catch {
        if (!controller.signal.aborted) setHits([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 220);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  useEffect(() => {
    function onClickAway(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, []);

  function choose(hit: Hit) {
    setOpen(false);
    setQuery("");
    if (onPick) onPick(hit.symbol);
    else router.push(`/trade/${hit.symbol}`);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || hits.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => (c + 1) % hits.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => (c - 1 + hits.length) % hits.length); }
    else if (e.key === "Enter") {
      e.preventDefault();
      // The mouse path is guarded by `disabled={!hit.is_tradable}`; this one
      // was not, so Enter navigated to a symbol the UI had greyed out.
      const hit = hits[cursor];
      if (hit?.is_tradable) choose(hit);
    }
    else if (e.key === "Escape") { setOpen(false); }
  }

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <Search
          size={15}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)] pointer-events-none"
        />
        <input
          type="text" value={query} autoFocus={autoFocus} placeholder={placeholder}
          className="field !pl-9 !pr-9"
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          role="combobox" aria-expanded={open} aria-controls="symbol-results" aria-autocomplete="list"
        />
        {loading && (
          <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-[var(--color-neon)]" />
        )}
      </div>

      {open && query.trim().length > 0 && (
        <ul
          id="symbol-results" role="listbox"
          className="absolute z-50 mt-1.5 w-full max-h-80 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl shadow-black/60"
        >
          {!loading && hits.length === 0 && (
            <li className="px-3 py-4 text-center text-xs text-[var(--color-text-faint)]">
              No matching symbol.
            </li>
          )}

          {hits.map((hit, i) => (
            <li key={hit.symbol} role="option" aria-selected={i === cursor}>
              <button
                onClick={() => choose(hit)}
                onMouseEnter={() => setCursor(i)}
                disabled={!hit.is_tradable}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 text-left transition-colors",
                  i === cursor ? "bg-[color-mix(in_oklab,var(--color-neon)_12%,transparent)]" : "",
                  !hit.is_tradable && "opacity-45 cursor-not-allowed",
                )}
              >
                <span className="num text-xs font-bold text-[var(--color-neon-bright)] w-16 shrink-0">
                  {hit.symbol}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-xs text-[var(--color-text)] truncate">{hit.name}</span>
                  <span className="block text-[10px] text-[var(--color-text-faint)]">
                    {hit.exchange ?? "—"} · {hit.asset_type}
                  </span>
                </span>
                {hit.is_halted && <span className="chip chip-warn shrink-0">Halted</span>}
                {!hit.is_tradable && <span className="chip chip-neutral shrink-0">Disabled</span>}
                {hit.source === "yahoo" && hit.is_tradable && !hit.is_halted && (
                  <TrendingUp size={12} className="text-[var(--color-violet)] shrink-0" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
