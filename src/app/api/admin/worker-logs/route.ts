import { NextResponse } from "next/server";
import { requireAdmin, writeAudit } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Empty the worker log.
 *
 * A route rather than an `admin_*` RPC because `worker_logs` is not game
 * state -- no position, fill or cash is involved -- and the table is written
 * by the service role, not by the engine. Nothing here can touch the book.
 *
 * Useful before a rehearsal or a fresh event, so the control room shows this
 * run rather than the last one. The worker prunes to 48 hours on its own
 * timer; this is the manual version.
 */
export async function DELETE() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { count: before } = await guard.ctx.admin
    .from("worker_logs").select("id", { count: "exact", head: true });

  // PostgREST refuses an unfiltered delete, which is the behaviour you want
  // everywhere else. Every id is positive, so this matches the whole table
  // without pretending to be selective about it.
  const { error } = await guard.ctx.admin.from("worker_logs").delete().gt("id", 0);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await writeAudit(guard.ctx, "worker_logs.clear", "worker_logs", null, {
    removed: before ?? 0,
  });

  return NextResponse.json({ ok: true, removed: before ?? 0 });
}
