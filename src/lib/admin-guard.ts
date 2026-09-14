import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export interface AdminContext {
  actorId: string;
  admin: ReturnType<typeof createAdminClient>;
}

/**
 * Verifies the caller is an active admin before handing back a service-role
 * client. Every admin API route must go through this — the service-role key
 * bypasses RLS entirely, so the check here IS the security boundary.
 */
export async function requireAdmin(request?: Request): Promise<
  { ok: true; ctx: AdminContext } | { ok: false; response: NextResponse }
> {
  if (request && !sameOrigin(request)) {
    return { ok: false, response: NextResponse.json({ error: "Bad origin" }, { status: 403 }) };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }) };
  }

  const { data: profile } = await supabase
    .from("profiles").select("role, is_active").eq("id", user.id).maybeSingle();

  if (profile?.role !== "admin" || !profile.is_active) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return { ok: true, ctx: { actorId: user.id, admin: createAdminClient() } };
}

/**
 * Reject a state-changing admin request that came from another site.
 *
 * These routes are cookie-authenticated and create, modify and delete
 * accounts. Today the only thing stopping a cross-site POST is Supabase SSR
 * cookies defaulting to SameSite=Lax -- a default, in a dependency, that we do
 * not control. Note also that `request.json()` does not check Content-Type, so
 * a `<form enctype="text/plain">` submission would parse fine if that default
 * ever moved.
 *
 * A browser always sends Origin on a cross-origin mutating request, so
 * "present and mismatched" is the CSRF signal. Absent means a non-browser
 * caller (curl, an ops script), which cannot be a CSRF vector -- so that is
 * allowed through and the session check below still applies.
 */
function sameOrigin(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;

  const origin = request.headers.get("origin");
  if (!origin) return true;

  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

export async function writeAudit(
  ctx: AdminContext,
  action: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown> = {},
) {
  await ctx.admin.from("audit_log").insert({
    actor_id: ctx.actorId,
    action, entity_type: entityType, entity_id: entityId, details,
  });
}
