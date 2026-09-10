import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, writeAudit } from "@/lib/admin-guard";
import { generateCredential } from "@/lib/credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchUser = z.object({
  display_name: z.string().min(1).max(60).optional(),
  role: z.enum(["admin", "participant"]).optional(),
  team_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean().optional(),
  // 8 is the floor: these are organiser-issued codes for a four-week game,
  // and a longer minimum just pushes admins toward writing them on paper.
  new_password: z.string().min(8).max(72).optional(),
  // Ask the server to mint a fresh readable credential instead of supplying one.
  regenerate: z.boolean().optional(),
});

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { id } = await ctx.params;
  const parsed = PatchUser.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const { new_password, regenerate, ...fields } = parsed.data;
  const { admin, actorId } = guard.ctx;
  const password = regenerate ? generateCredential() : new_password;

  // An admin must not be able to lock themselves out mid-event.
  if (id === actorId && (fields.is_active === false || fields.role === "participant")) {
    return NextResponse.json(
      { error: "You can't remove your own admin access." },
      { status: 400 },
    );
  }

  let issued: string | null = null;

  if (password) {
    const { error } = await admin.auth.admin.updateUserById(id, { password });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // The issued credential IS the password now -- no forced rotation -- so
    // record it for the organiser and clear any stale flag from a previous
    // self-service change.
    await admin.from("issued_credentials").upsert({
      user_id: id,
      password,
      is_stale: false,
      issued_at: new Date().toISOString(),
      issued_by: actorId,
    });
    await admin.from("profiles").update({ must_change_password: false }).eq("id", id);

    // The password never enters audit_log -- every admin can read that table.
    await writeAudit(guard.ctx, "user.reset_password", "profile", id);
    issued = password;
  }

  if (Object.keys(fields).length > 0) {
    const { error } = await admin.from("profiles").update(fields).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await writeAudit(guard.ctx, "user.update", "profile", id, fields);
  }

  return NextResponse.json({ ok: true, ...(issued ? { password: issued } : {}) });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { id } = await ctx.params;
  if (id === guard.ctx.actorId) {
    return NextResponse.json({ error: "You can't delete your own account." }, { status: 400 });
  }

  const { error } = await guard.ctx.admin.auth.admin.deleteUser(id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await writeAudit(guard.ctx, "user.delete", "profile", id);
  return NextResponse.json({ ok: true });
}
