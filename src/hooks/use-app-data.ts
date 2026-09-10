"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type {
  Announcement, LeaderboardRow, MarketStatus, Order,
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

/** Equity curve for the caller's team (or a specific team, for admins). */
export function useEquityCurve(teamId?: string) {
  return useQuery({
    queryKey: ["equity-curve", teamId ?? "self"],
    queryFn: async () => {
      let q = createClient().from("portfolio_snapshots")
        .select("ts, equity, cash, positions_value, total_return_pct")
        .order("ts", { ascending: true }).limit(2000);
      if (teamId) q = q.eq("team_id", teamId);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 60_000,
  });
}
