"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type {
  Announcement, EquityCurve, EquityPoint, LeaderboardRow, MarketStatus, Order,
  PortfolioResponse, Trade,
} from "@/lib/database.types";

export function useMarketStatus() {
  return useQuery({
    queryKey: ["market-status"],
    queryFn: async (): Promise<MarketStatus> => {
      const { data, error } = await createClient().rpc("get_market_status");
      if (error) throw error;
      return data as unknown as MarketStatus;
    },
    refetchInterval: 30_000,
  });
}

export function usePortfolio(teamId?: string) {
  return useQuery({
    queryKey: ["portfolio", teamId ?? "self"],
    queryFn: async (): Promise<PortfolioResponse> => {
      const { data, error } = await createClient()
        .rpc("get_portfolio", teamId ? { p_team_id: teamId } : {});
      if (error) throw error;
      return data as unknown as PortfolioResponse;
    },
    refetchInterval: 15_000,
  });
}

export function useOrders(opts: { working?: boolean; limit?: number } = {}) {
  const { working, limit = 200 } = opts;
  return useQuery({
    queryKey: ["orders", working ? "working" : "all", limit],
    queryFn: async (): Promise<Order[]> => {
      let q = createClient().from("orders").select("*")
        .order("created_at", { ascending: false }).limit(limit);
      if (working) q = q.in("status", ["open", "partially_filled", "pending"]);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Order[];
    },
  });
}

export function useTrades(limit = 200) {
  return useQuery({
    queryKey: ["trades", limit],
    queryFn: async (): Promise<Trade[]> => {
      const { data, error } = await createClient().from("trades").select("*")
        .order("executed_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return (data ?? []) as Trade[];
    },
  });
}

export function useAnnouncements() {
  return useQuery({
    queryKey: ["announcements"],
    queryFn: async (): Promise<Announcement[]> => {
      const { data, error } = await createClient().from("announcements").select("*")
        .eq("is_published", true).order("created_at", { ascending: false }).limit(20);
      if (error) throw error;
      return (data ?? []) as Announcement[];
    },
    refetchInterval: 60_000,
  });
}

export function useLeaderboard(enabled = true) {
  return useQuery({
    queryKey: ["leaderboard"],
    enabled,
    queryFn: async (): Promise<LeaderboardRow[]> => {
      const { data, error } = await createClient().rpc("get_leaderboard");
      if (error) throw error;
      return ((data as unknown as { teams: LeaderboardRow[] })?.teams ?? []);
    },
    refetchInterval: 20_000,
  });
}

/**
 * Equity curve for the caller's team (or a specific team, for admins).
 *
 * Bucketed server-side by get_equity_curve rather than read from
 * portfolio_snapshots directly. The table read took the oldest 2000 rows,
 * which froze the chart at about day twelve, and cost 54.6 KB a minute per
 * open tab. See the migration for the arithmetic.
 */
export function useEquityCurve(teamId?: string) {
  return useQuery({
    queryKey: ["equity-curve", teamId ?? "self"],
    queryFn: async (): Promise<EquityPoint[]> => {
      const { data, error } = await createClient()
        .rpc("get_equity_curve", teamId ? { p_team_id: teamId } : {});
      if (error) throw error;
      return (data as unknown as EquityCurve)?.points ?? [];
    },
    // Snapshots land about every nine minutes, so the old 60s poll fetched
    // the same curve nine times over.
    refetchInterval: 300_000,
  });
}
