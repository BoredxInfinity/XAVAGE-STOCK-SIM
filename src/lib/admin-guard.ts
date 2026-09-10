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
export async function requireAdmin(): Promise<
  { ok: true; ctx: AdminContext } | { ok: false; response: NextResponse }
> {
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

export async function writeAudit(
  ctx: AdminContext,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown> = {},
) {
  await ctx.admin.from("audit_log").insert({
    actor_id: ctx.actorId,
    action, entity_type: entityType, entity_id: entityId, details,
  });
}
