import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets, image files, and Vercel's own
    // endpoints. `_vercel` is load-bearing: Web Analytics beacons post to
    // /_vercel/insights/view, and without the exclusion this middleware
    // answers them with a redirect to /login for every signed-out visitor --
    // so the login page records no traffic at all -- while every beacon from
    // a signed-in one costs a JWT revalidation and a profile lookup.
    "/((?!_next/static|_next/image|_vercel|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
