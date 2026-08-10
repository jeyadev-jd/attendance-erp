// Shared PostgREST query conventions.
//
// Column casing: tables are snake_case (via Prisma @@map), columns are quoted
// camelCase ("semesterId", "hourNumber", "countsForAttendance"). Verified against
// backups/d1-cutover-postgres.sql and the live Supabase schema. PostgREST is
// case-sensitive on these, so every selector here uses camelCase exactly.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many, maybeOne } from "./supabase";

/**
 * Attendance rows that count toward a percentage.
 *
 * Mirrors COUNTS_FOR_ATTENDANCE in apps/api/src/lib/calculators.ts. Non-academic
 * slots and one-off "tracked but not counted" overrides are still marked so absences
 * are on record and bunk detection applies, but must never move a percentage.
 *
 * Read from the attendance row itself (snapshotted at write time), never via a join
 * to subjects — changing a subject's default must not retroactively rewrite the
 * meaning of already-marked days.
 */
export const COUNTS_COLUMN = "countsForAttendance" as const;

/** Statuses that count as present. Must stay in sync with calculators.PRESENT_STATUSES. */
export const PRESENT_STATUSES = ["PRESENT", "LATE", "VERY_LATE", "MEDICAL", "OD"] as const;

/**
 * Applies an optional inclusive date range to a query on `column`.
 *
 * Matches the semantics of schemas/analytics.dateFilter: bounds are applied only
 * when supplied, and dates are treated as UTC midnight, as they are stored.
 */
export function applyDateRange<T>(
  query: T,
  column: string,
  range: { dateFrom?: string; dateTo?: string }
): T {
  let q = query as any;
  if (range.dateFrom) q = q.gte(column, `${range.dateFrom}T00:00:00.000Z`);
  if (range.dateTo) q = q.lte(column, `${range.dateTo}T23:59:59.999Z`);
  return q as T;
}

// ───────────────────────── org-scoping guards ─────────────────────────
//
// Every route currently proves a record belongs to the caller's organization before
// touching it, by walking a relation chain in a Prisma `where`. PostgREST expresses
// the same walk as an embedded resource with `!inner`, which becomes a real SQL join
// — one request, no extra round trip, and the filter runs in Postgres.
//
// These are authorization checks. They must not be skipped or weakened during
// migration: under C-3 the database enforces nothing per-user, so the Worker's
// scoping is the only tenancy boundary.

/** Semester -> academicYear -> organizationId. Returns null when out of org. */
export async function findSemesterInOrg(
  db: SupabaseClient,
  semesterId: string,
  organizationId: string
) {
  return maybeOne(
    await db
      .from("semesters")
      .select("*, academic_years!inner(organizationId)")
      .eq("id", semesterId)
      .eq("academic_years.organizationId", organizationId)
      .maybeSingle(),
    "findSemesterInOrg"
  );
}

/** Section -> semester -> academicYear -> organizationId. */
export async function findSectionInOrg(
  db: SupabaseClient,
  sectionId: string,
  organizationId: string
) {
  return maybeOne(
    await db
      .from("sections")
      .select("*, semesters!inner(id, academic_years!inner(organizationId))")
      .eq("id", sectionId)
      .eq("semesters.academic_years.organizationId", organizationId)
      .maybeSingle(),
    "findSectionInOrg"
  );
}

/** AcademicYear -> organizationId. */
export async function findAcademicYearInOrg(
  db: SupabaseClient,
  academicYearId: string,
  organizationId: string
) {
  return maybeOne(
    await db
      .from("academic_years")
      .select("*")
      .eq("id", academicYearId)
      .eq("organizationId", organizationId)
      .maybeSingle(),
    "findAcademicYearInOrg"
  );
}

/** Student -> section -> semester -> academicYear -> organizationId. */
export async function findStudentInOrg(
  db: SupabaseClient,
  studentId: string,
  organizationId: string
) {
  return maybeOne(
    await db
      .from("students")
      .select("*, sections!inner(id, semesters!inner(id, academic_years!inner(organizationId)))")
      .eq("id", studentId)
      .eq("sections.semesters.academic_years.organizationId", organizationId)
      .maybeSingle(),
    "findStudentInOrg"
  );
}

/** Subject -> department -> organizationId. */
export async function findSubjectInOrg(
  db: SupabaseClient,
  subjectId: string,
  organizationId: string
) {
  return maybeOne(
    await db
      .from("subjects")
      .select("*, departments!inner(organizationId)")
      .eq("id", subjectId)
      .eq("departments.organizationId", organizationId)
      .maybeSingle(),
    "findSubjectInOrg"
  );
}

/**
 * Section ids for a semester. Several analytics paths need to scope by section set;
 * fetching ids only keeps the payload to one short column.
 */
export async function sectionIdsForSemester(db: SupabaseClient, semesterId: string) {
  const rows = many<{ id: string }>(
    await db.from("sections").select("id").eq("semesterId", semesterId),
    "sectionIdsForSemester"
  );
  return rows.map((r) => r.id);
}
