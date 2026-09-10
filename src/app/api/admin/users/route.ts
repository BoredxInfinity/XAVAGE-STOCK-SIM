import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, writeAudit } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateUser = z.object({
  email: z.string().email().max(120),
  display_name: z.string().min(1).max(60),
  role: z.enum(["admin", "participant"]).default("participant"),
  team_id: z.string().uuid().nullable().optional(),
  password: z.string().min(10).max(72).optional(),
});

/** Readable temporary password an organiser can dictate over the noise of a hall. */
function tempPassword() {
  const words = ["Alpha", "Bravo", "Delta", "Echo", "Falcon", "Gamma", "Hawk", "Indigo",
                 "Juno", "Kilo", "Lima", "Nova", "Orion", "Quartz", "Rally", "Sierra"];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  const digits = String(Math.floor(1000 + Math.random() * 9000));
  return `${pick()}-${pick()}-${digits}`;
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { data, error } = await guard.ctx.admin
    .from("profiles")
    .select("id, email, display_name, role, team_id, is_active, must_change_password, last_login_at, created_at")
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ users: data ?? [] });
}

export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const parsed = CreateUser.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const { email, display_name, role, team_id } = parsed.data;
  const password = parsed.data.password ?? tempPassword();
  const { admin } = guard.ctx;

  const { data: created, error } = await admin.auth.admin.createUser({
    email: email.toLowerCase(),
    password,
    email_confirm: true, // organiser-provisioned: no confirmation email round-trip
    // display_name only. `role` deliberately does NOT go in user_metadata:
    // that field is user-editable, so nothing authorization-related belongs in
    // it. The real role is set by the service-role UPDATE below.
    user_metadata: { display_name },
  });

  if (error || !created.user) {
    const duplicate = (error?.message ?? "").toLowerCase().includes("already");
    return NextResponse.json(
      { error: duplicate ? "That email already has an account." : error?.message ?? "Could not create user" },
      { status: duplicate ? 409 : 500 },
    );
  }

  // The auth trigger creates the profile; set the fields it can't know about.
  const { error: profileError } = await admin
    .from("profiles")
    .update({ display_name, role, team_id: team_id ?? null, must_change_password: true, is_active: true })
    .eq("id", created.user.id);

  if (profileError) {
    // Don't leave an orphaned auth user behind.
    await admin.auth.admin.deleteUser(created.user.id);
    return NextResponse.json({ error: profileError.message }, { status: 500 });
  }

  await writeAudit(guard.ctx, "user.create", "profile", created.user.id, { email, role, team_id });

  // The password is returned exactly once, for the organiser to hand over.
  return NextResponse.json({
    user: { id: created.user.id, email, display_name, role, team_id: team_id ?? null },
    temporary_password: password,
  }, { status: 201 });
}
