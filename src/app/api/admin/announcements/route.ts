import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, writeAudit } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Create = z.object({
  title: z.string().min(1).max(120),
  body: z.string().max(2000).default(""),
  severity: z.enum(["info", "success", "warning", "critical"]).default("info"),
});

/** Push a market event / rule change to every participant's dashboard. */
export async function POST(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const parsed = Create.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const { data, error } = await guard.ctx.admin
    .from("announcements")
    .insert({ ...parsed.data, created_by: guard.ctx.actorId, is_published: true })
    .select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await writeAudit(guard.ctx, "announcement.create", "announcement", data.id, {
    title: parsed.data.title, severity: parsed.data.severity,
  });

  return NextResponse.json({ announcement: data }, { status: 201 });
}

export async function DELETE(request: Request) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const { error } = await guard.ctx.admin.from("announcements").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await writeAudit(guard.ctx, "announcement.delete", "announcement", id);
  return NextResponse.json({ ok: true });
}
