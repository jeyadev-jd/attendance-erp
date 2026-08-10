import { HTTPException } from "hono/http-exception";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findSemesterInOrg } from "@attendance/db/queries";

/**
 * Supabase counterparts of lib/semesterGuard.ts, with identical messages and status
 * codes. Kept as a separate file so the Prisma helpers stay untouched while both
 * paths run in parallel; at cutover this replaces semesterGuard.ts.
 */

/** Confirms the semester belongs to the caller's org and (for writes) isn't archived. */
export async function assertSemesterWritable(
  db: SupabaseClient,
  semesterId: string,
  organizationId: string
) {
  const semester = await findSemesterInOrg(db, semesterId, organizationId);
  if (!semester) throw new HTTPException(404, { message: "Semester not found" });
  if ((semester as { status?: string }).status === "ARCHIVED") {
    throw new HTTPException(403, { message: "Semester is archived and read-only" });
  }
  return semester;
}

export async function assertSemesterInOrg(
  db: SupabaseClient,
  semesterId: string,
  organizationId: string
) {
  const semester = await findSemesterInOrg(db, semesterId, organizationId);
  if (!semester) throw new HTTPException(404, { message: "Semester not found" });
  return semester;
}
