// Hour config repository — PostgREST equivalents of apps/api/src/routes/hourConfig.ts.
//
// Per semester, per day-of-week, per hour: the wall-clock start/end times. Different
// days may have different hour counts, which is why the bulk endpoint replaces a
// day wholesale rather than merging.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many, maybeOne, one } from "../supabase";
import { cuid } from "../ids";

export type HourConfig = {
  id: string;
  semesterId: string;
  dayOfWeek: number;
  hourNumber: number;
  startTime: string;
  endTime: string;
};

const COLS = "id,semesterId,dayOfWeek,hourNumber,startTime,endTime";

/** All hour configs for a semester, ordered by day then hour. */
export async function listBySemester(db: SupabaseClient, semesterId: string) {
  return many<HourConfig>(
    await db
      .from("hour_configs")
      .select(COLS)
      .eq("semesterId", semesterId)
      .order("dayOfWeek", { ascending: true })
      .order("hourNumber", { ascending: true }),
    "hourConfig.listBySemester"
  );
}

/**
 * Inserts or updates one hour's times.
 *
 * Replaces prisma.hourConfig.upsert on the composite key. `onConflict` names the
 * columns of the UNIQUE index the export carried over
 * (hour_configs_semesterId_dayOfWeek_hourNumber_key), so the database resolves
 * insert-vs-update atomically instead of the Worker doing a read-then-write.
 *
 * The existing row's id is looked up first and reused. An upsert overwrites every
 * column it is given, including the primary key, so passing a fresh cuid would
 * rewrite the id on every save — Prisma's upsert never did that, and a churning
 * primary key breaks anything holding a reference to it.
 */
export async function upsert(
  db: SupabaseClient,
  data: {
    semesterId: string;
    dayOfWeek: number;
    hourNumber: number;
    startTime: string;
    endTime: string;
  }
) {
  const existing = maybeOne<{ id: string }>(
    await db
      .from("hour_configs")
      .select("id")
      .eq("semesterId", data.semesterId)
      .eq("dayOfWeek", data.dayOfWeek)
      .eq("hourNumber", data.hourNumber)
      .maybeSingle(),
    "hourConfig.upsert (lookup)"
  );

  return one<HourConfig>(
    await db
      .from("hour_configs")
      .upsert(
        { id: existing?.id ?? cuid(), ...data },
        { onConflict: "semesterId,dayOfWeek,hourNumber" }
      )
      .select(COLS)
      .single(),
    "hourConfig.upsert"
  );
}

/**
 * Replaces the entire hour layout for one day of week.
 *
 * Delete-then-insert, matching the Prisma $transaction: a full replace is required
 * because a day's hour count can shrink, and merging would leave stale later hours
 * behind. Two requests rather than N+1 — the insert is batched.
 *
 * Not atomic across the two statements, as PostgREST has no interactive transaction.
 * The exposure is a failed insert leaving the day empty; the same call repeated
 * repairs it, and the endpoint is admin-only and idempotent by construction.
 */
export async function replaceDay(
  db: SupabaseClient,
  semesterId: string,
  dayOfWeek: number,
  hours: { hourNumber: number; startTime: string; endTime: string }[]
): Promise<number> {
  const del = await db
    .from("hour_configs")
    .delete()
    .eq("semesterId", semesterId)
    .eq("dayOfWeek", dayOfWeek);
  if (del.error) throw new Error(`hourConfig.replaceDay (delete): ${del.error.message}`);

  if (hours.length === 0) return 0;

  const { error } = await db.from("hour_configs").insert(
    hours.map((h) => ({
      id: cuid(),
      semesterId,
      dayOfWeek,
      hourNumber: h.hourNumber,
      startTime: h.startTime,
      endTime: h.endTime,
    }))
  );
  if (error) throw new Error(`hourConfig.replaceDay (insert): ${error.message}`);
  return hours.length;
}

/** One hour config, org-scoped through its semester. Replaces the findFirst guard. */
export async function findInOrg(db: SupabaseClient, id: string, organizationId: string) {
  return maybeOne<{ id: string }>(
    (await db
      .from("hour_configs")
      .select("id,semesters!inner(id,academic_years!inner(organizationId))")
      .eq("id", id)
      .eq("semesters.academic_years.organizationId", organizationId)
      .maybeSingle()) as unknown as {
      data: { id: string } | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "hourConfig.findInOrg"
  );
}

/** Deletes one hour config. The route has already proven org membership. */
export async function remove(db: SupabaseClient, id: string) {
  const { error } = await db.from("hour_configs").delete().eq("id", id);
  if (error) throw new Error(`hourConfig.remove: ${error.message}`);
}
