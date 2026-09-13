import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets, image files, Vercel's own endpoints,
    // and /api.
    //
    // `_vercel` is load-bearing: Web Analytics beacons post to
    // /_vercel/insights/view, and without the exclusion this middleware
    // answers them with a redirect to /login for every signed-out visitor --
    // so the login page records no traffic at all -- while every beacon from
    // a signed-in one costs a JWT revalidation and a profile lookup.
    //
    // `api` is excluded because every route under it already authenticates
    // itself -- getUser() in /api/chart and /api/search, requireAdmin() in
    // /api/admin/*, CRON_SECRET in /api/cron/* -- so running this first only
    // bought a second round-trip to the auth server and a second profiles
    // query for every one of those calls. They were a third of all requests
    // in the 200-user load test, and the duplicated hop is a good part of why
    // /api/chart measured 940ms at p50.
    //
    // It also fixes the semantics: an unauthenticated API call now gets the
    // route's own 401 JSON instead of a 307 to the HTML login page, which is
    // what a fetch() caller can actually do something with.
    "/((?!_next/static|_next/image|_vercel|api/|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
