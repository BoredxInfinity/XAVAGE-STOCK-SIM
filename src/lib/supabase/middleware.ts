import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Refreshes the auth cookie and gates routes by session + role. */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // getUser() revalidates the JWT against Supabase -- do not swap for getSession().
  const { data: { user } } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;

  // No /api here: src/middleware.ts excludes `api/` from the matcher entirely,
  // so every route under it authenticates itself and never reaches this file.
  const isPublic = path === "/login" || path.startsWith("/auth");

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role, is_active, must_change_password, team_id")
      .eq("id", user.id)
      .maybeSingle();

    // Deactivated mid-competition -> terminate the session immediately.
    if (profile && !profile.is_active) {
      await supabase.auth.signOut();
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("error", "inactive");
      return NextResponse.redirect(url);
    }

    // Admin-issued temporary password must be rotated before anything else --
    // but only by someone who CAN rotate it.
    //
    // /change-password renders a form for admins and, for participants, only a
    // "passwords are issued by the organisers" note with a link back to
    // /dashboard. So for a participant this redirect was a closed loop: bounced
    // to a page with no form, whose only button bounces them back. One stray
    // `update profiles set must_change_password = true` and that account is
    // locked out of the competition with no self-service exit and no admin
    // control to clear it either.
    //
    // Participants get their credentials reissued by an organiser instead, and
    // that path (PATCH /api/admin/users/[id]) clears the flag.
    if (profile?.must_change_password
        && profile.role === "admin"
        && path !== "/change-password") {
      const url = request.nextUrl.clone();
      url.pathname = "/change-password";
      return NextResponse.redirect(url);
    }

    if (path.startsWith("/admin") && profile?.role !== "admin") {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      return NextResponse.redirect(url);
    }

    if (path === "/login") {
      const url = request.nextUrl.clone();
      url.pathname = profile?.role === "admin" ? "/admin" : "/dashboard";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  return response;
}
