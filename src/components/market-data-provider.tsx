"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { quoteStore } from "@/lib/quote-store";
import type { Quote } from "@/lib/database.types";

/**
 * Opens the single realtime connection for the whole app:
 *   quotes            -> pushed into the external quote store
 *   orders / positions / trades / teams -> invalidate the affected queries
 *
 * RLS applies to realtime payloads too, so a team only ever receives rows from
 * its own book. Also polls quotes on an interval as a fallback in case the
 * websocket drops on flaky event-day wifi.
 */
export function MarketDataProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    async function seed() {
      const { data } = await supabase.from("quotes").select("*");
      if (data && !cancelled) quoteStore.upsertMany(data as Quote[]);
    }
    seed();

    const priceChannel = supabase
      .channel("xavage:prices")
      .on("postgres_changes", { event: "*", schema: "public", table: "quotes" }, (payload) => {
        const row = payload.new as Quote | null;
        if (row?.symbol) quoteStore.upsert(row);
      })
      .subscribe();

    const bookChannel = supabase
      .channel("xavage:book")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => {
        qc.invalidateQueries({ queryKey: ["orders"] });
        qc.invalidateQueries({ queryKey: ["portfolio"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "positions" }, () => {
        qc.invalidateQueries({ queryKey: ["portfolio"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, () => {
        qc.invalidateQueries({ queryKey: ["trades"] });
        qc.invalidateQueries({ queryKey: ["portfolio"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "teams" }, () => {
        qc.invalidateQueries({ queryKey: ["portfolio"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "announcements" }, () => {
        qc.invalidateQueries({ queryKey: ["announcements"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "game_settings" }, () => {
        qc.invalidateQueries({ queryKey: ["market-status"] });
        qc.invalidateQueries({ queryKey: ["portfolio"] });
      })
      .subscribe();

    // Fallback poll: cheap, and keeps prices moving if realtime silently drops.
    const poll = setInterval(seed, 20_000);

    return () => {
      cancelled = true;
      clearInterval(poll);
      supabase.removeChannel(priceChannel);
      supabase.removeChannel(bookChannel);
    };
  }, [qc]);

  return <>{children}</>;
}
