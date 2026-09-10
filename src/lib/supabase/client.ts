"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";

let cached: ReturnType<typeof createBrowserClient<Database>> | null = null;

/** Browser Supabase client. Memoised so realtime channels aren't duplicated. */
export function createClient() {
  if (cached) return cached;
  cached = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { realtime: { params: { eventsPerSecond: 20 } } },
  );
  return cached;
}
