"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { quoteStore } from "@/lib/quote-store";
import type { LiveQuote, Quote } from "@/lib/database.types";

const PRICE_TOPIC = "xavage:prices";

/** Only what the UI renders -- see the note on LiveQuote. */
const QUOTE_COLUMNS =
  "symbol,price,prev_close,day_open,day_high,day_low,volume,quote_time,updated_at";

/**
 * How often the reconcile poll runs. Broadcast is what actually delivers
 * prices; this is the safety net for a slept tab or a dropped socket, and
 * since it now fetches only rows newer than the last one seen, running it
 * less often costs correctness nothing.
 */
const RECONCILE_MS = 300_000;
const RECONCILE_FALLBACK_MS = 20_000;
const USE_BROADCAST =
  (process.env.NEXT_PUBLIC_QUOTES_TRANSPORT ?? "broadcast") !== "postgres_changes";

/**
 * Opens the single realtime connection for the whole app.
 *
 * Prices arrive over **Broadcast**: the worker sends one batched message per
 * cycle carrying only the symbols that moved. The obvious alternative,
 * Postgres Changes on `quotes`, emits one message PER ROW PER SUBSCRIBER --
 * with 105 symbols on a 5s cadence that is 21 messages/second for every
 * connected client, or ~39M messages across four clients over a competition,
 * against a 5M Pro allowance. Same push latency, ~105x the cost.
 *
 * The order book stays on Postgres Changes, and should: orders, positions and
 * trades are team-scoped, so per-row RLS is doing real work there, and they
 * only fire on actual trades. Prices are safe on a shared channel precisely
 * because they are not team-scoped (`quotes_read` is `using (true)`).
 *
 * Set NEXT_PUBLIC_QUOTES_TRANSPORT=postgres_changes to fall back to the old
 * path without a deploy, if Broadcast ever misbehaves mid-event.
 */
export function MarketDataProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    let fellBack = false;
    let lastTickAt = 0;

    // Private channels authorise with the caller's JWT, so Realtime needs the
    // session token before subscribing. Without this the channel is refused
    // and prices silently never arrive.
    if (USE_BROADCAST) void supabase.realtime.setAuth();

    // The newest `updated_at` already in the store. The reconcile poll asks
    // only for rows past it, so the steady-state poll returns an empty array
    // instead of the whole quotes table.
    //
    // This is the difference between 37 KB and ~0 per client per poll. At four
    // clients that was invisible; at 200 it was ~25 GB of egress over a
    // competition, against a free-tier allowance of 5 GB a month.
    let seenThrough: string | null = null;

    async function seed({ full = false }: { full?: boolean } = {}) {
      if (full) seenThrough = null;

      let query = supabase.from("quotes").select(QUOTE_COLUMNS);
      if (seenThrough) query = query.gt("updated_at", seenThrough);

      const { data, error } = await query;
      if (error || !data || cancelled) return;

      const rows = data as unknown as LiveQuote[];
      if (!rows.length) return;

      quoteStore.upsertMany(rows);

      // Advance the cursor from the server's own timestamps, never the local
      // clock: a client whose clock runs fast would otherwise skip rows.
      for (const row of rows) {
        if (!seenThrough || row.updated_at > seenThrough) seenThrough = row.updated_at;
      }
    }
    seed();

    // The legacy path, kept whole so the fallback is the code that used to
    // work rather than an untested approximation of it.
    function subscribeViaPostgresChanges() {
      return supabase
        .channel(`${PRICE_TOPIC}:pg`)
        .on("postgres_changes", { event: "*", schema: "public", table: "quotes" }, (payload) => {
          const row = payload.new as Quote | null;
          if (row?.symbol) quoteStore.upsert(row);
        })
        .subscribe();
    }

    // Private channel: authorised by RLS on realtime.messages (migration 0013),
    // so the anon key alone cannot subscribe.
    //
    // If that subscription is ever refused -- a policy that does not match, a
    // Realtime config change, an expired token -- prices would simply stop
    // arriving, and on a trading floor that is indistinguishable from a flat
    // market. So failure is self-healing: drop to Postgres Changes, which is
    // costlier but correct, rather than waiting for someone to notice and set
    // an env var.
    function subscribeViaBroadcast() {
      // Hold the channel locally rather than reaching for `priceChannel`: the
      // status callback can in principle fire before that binding is
      // initialised, which would be a TDZ ReferenceError inside a listener.
      const ch = supabase
        .channel(PRICE_TOPIC, { config: { private: true } })
        .on("broadcast", { event: "tick" }, (msg) => {
          const rows = (msg.payload as { quotes?: Quote[] } | undefined)?.quotes;
          if (Array.isArray(rows) && rows.length) quoteStore.upsertMany(rows);
          // Proof the socket is delivering. The reconcile poll below skips a
          // turn on the strength of it.
          lastTickAt = Date.now();
        });

      ch.subscribe((status) => {
        if (cancelled || fellBack) return;
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          fellBack = true;
          console.warn(
            `[xavage] price broadcast unavailable (${status}); falling back to postgres_changes`,
          );
          supabase.removeChannel(ch);
          priceChannel = subscribeViaPostgresChanges();
          seed({ full: true });   // re-sync now: the fallback only carries changes from here on
        }
      });
      return ch;
    }

    let priceChannel = USE_BROADCAST ? subscribeViaBroadcast() : subscribeViaPostgresChanges();

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

    // Reconcile poll. Broadcast is fire-and-forget with no replay, so a client
    // that slept a tab or dropped the socket needs a periodic re-sync against
    // the source of truth. Slower than before because it is now a safety net
    // rather than the thing actually delivering prices.
    // A tick that arrived since the last turn is live proof the socket is
    // healthy, and the worker's broadcast carries every symbol that moved --
    // so there is nothing for a reconcile to find. Skipping the fetch in that
    // case removes the poll almost entirely from market hours, which is
    // exactly when it was most expensive (every client, every symbol that had
    // changed). When the market is shut, or the socket has gone quiet, it runs
    // and costs close to nothing because almost nothing has changed.
    const poll = setInterval(
      () => {
        if (USE_BROADCAST && Date.now() - lastTickAt < RECONCILE_MS) return;
        void seed();
      },
      USE_BROADCAST ? RECONCILE_MS : RECONCILE_FALLBACK_MS,
    );

    // A hidden tab has its timers throttled to about once a minute and may
    // have missed broadcasts while the socket was re-establishing, so the poll
    // above is not enough on its own: someone coming back to the tab would be
    // looking at whatever the prices were when they left, for up to a minute,
    // with no way to tell. Re-sync the moment the page is looked at again.
    function onVisibility() {
      if (document.visibilityState === "visible") seed();   // delta only, so this is nearly free
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisibility);
      supabase.removeChannel(priceChannel);
      supabase.removeChannel(bookChannel);
    };
  }, [qc]);

  return <>{children}</>;
}
