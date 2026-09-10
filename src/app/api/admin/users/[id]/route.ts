import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, writeAudit } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchUser = z.object({
  display_name: z.string().min(1).max(60).optional(),
  role: z.enum(["admin", "participant"]).optional(),
  team_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean().optional(),
  new_password: z.string().min(10).max(72).optional(),
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

  const { new_password, ...fields } = parsed.data;
  const { admin, actorId } = guard.ctx;

  // An admin must not be able to lock themselves out mid-event.
  if (id === actorId && (fields.is_active === false || fields.role === "participant")) {
    return NextResponse.json(
      { error: "You can't remove your own admin access." },
      { status: 400 },
    );
  }

  if (new_password) {
    const { error } = await admin.auth.admin.updateUserById(id, { password: new_password });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    // Force a rotation so the organiser's chosen password is temporary.
    await admin.from("profiles").update({ must_change_password: true }).eq("id", id);
    await writeAudit(guard.ctx, "user.reset_password", "profile", id);
  }

  if (Object.keys(fields).length > 0) {
    const { error } = await admin.from("profiles").update(fields).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await writeAudit(guard.ctx, "user.update", "profile", id, fields);
  }

  return NextResponse.json({ ok: true });
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
