// Academic years repository — PostgREST equivalents of
// apps/api/src/routes/academicYears.ts.
//
// Academic years are the root of the structural chain
// (academic_year -> semester -> section -> attendance), so scoping is a plain
// organizationId column here rather than a relation walk.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many, maybeOne, one, count, normaliseDates, DATE_FIELDS } from "../supabase";
import { cuid } from "../ids";

export type AcademicYear = {
  id: string;
  organizationId: string;
  label: string;
  startDate: string;
  endDate: string;
  createdAt: string;
};

const COLS = "id,organizationId,label,startDate,endDate,createdAt";

/** Academic years for an organization, newest first. Replaces findMany. */
export async function listByOrg(db: SupabaseClient, organizationId: string) {
  return normaliseDates(
    many<AcademicYear>(
      await db
        .from("academic_years")
        .select(COLS)
        .eq("organizationId", organizationId)
        .order("startDate", { ascending: false }),
      "academicYears.listByOrg"
    ),
    DATE_FIELDS
  );
}

/** One academic year, org-scoped. Replaces the findFirst guard. */
export async function findInOrg(db: SupabaseClient, id: string, organizationId: string) {
  return normaliseDates(
    maybeOne<AcademicYear>(
      await db
        .from("academic_years")
        .select(COLS)
        .eq("id", id)
        .eq("organizationId", organizationId)
        .maybeSingle(),
      "academicYears.findInOrg"
    ),
    DATE_FIELDS
  );
}

/**
 * How many semesters hang off this academic year.
 *
 * Replaces `include: { _count: { select: { semesters: true } } }`, which the delete
 * guard uses to refuse removing a year that still has semesters — cascading would
 * wipe attendance history.
 *
 * `head: true` returns the count in a header and transfers no rows, so this stays
 * cheap regardless of how many semesters exist.
 */
export async function countSemesters(db: SupabaseClient, academicYearId: string) {
  return count(
    await db
      .from("semesters")
      .select("*", { count: "exact", head: true })
      .eq("academicYearId", academicYearId),
    "academicYears.countSemesters"
  );
}

/**
 * Creates an academic year.
 *
 * `createdAt` is supplied explicitly: Prisma's `@default(now())` is a client-side
 * default and the Postgres column has none, so an insert through PostgREST must
 * carry it. Same reason the id is generated here — see packages/db/src/ids.ts.
 */
export async function create(
  db: SupabaseClient,
  data: { organizationId: string; label: string; startDate: string; endDate: string }
) {
  return normaliseDates(
    one<AcademicYear>(
      await db
        .from("academic_years")
        .insert({ id: cuid(), createdAt: new Date().toISOString(), ...data })
        .select(COLS)
        .single(),
      "academicYears.create"
    ),
    DATE_FIELDS
  );
}

/** Updates an academic year. Caller has already proven org membership. */
export async function update(
  db: SupabaseClient,
  id: string,
  data: Partial<{ label: string; startDate: string; endDate: string }>
) {
  return normaliseDates(
    one<AcademicYear>(
      await db.from("academic_years").update(data).eq("id", id).select(COLS).single(),
      "academicYears.update"
    ),
    DATE_FIELDS
  );
}

/** Deletes an academic year. The route has already checked it has no semesters. */
export async function remove(db: SupabaseClient, id: string) {
  const { error } = await db.from("academic_years").delete().eq("id", id);
  if (error) throw new Error(`academicYears.remove: ${error.message}`);
}
