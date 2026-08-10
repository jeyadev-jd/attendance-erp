// Departments repository — PostgREST equivalents of the Prisma calls in
// apps/api/src/routes/departments.ts.
//
// First migrated repository, chosen because it is the simplest org-scoped CRUD in the
// codebase: no analytics, no aggregation, and every query is already filtered by a
// single indexed column.
//
// Column casing: table names are snake_case, columns are quoted camelCase
// ("organizationId"). PostgREST is case-sensitive on these.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many, maybeOne, one, isUniqueViolation } from "../supabase";
import { cuid } from "../ids";

export type Department = {
  id: string;
  organizationId: string;
  code: string;
  name: string;
};

/**
 * All departments in an organization, ordered by name.
 *
 * Replaces prisma.department.findMany. Columns are named explicitly rather than
 * selecting "*": the payload is what crosses the wire from Supabase to the Worker,
 * so it is worth keeping to the four columns the route actually returns.
 */
export async function listByOrg(db: SupabaseClient, organizationId: string) {
  return many<Department>(
    await db
      .from("departments")
      .select("id,organizationId,code,name")
      .eq("organizationId", organizationId)
      .order("name", { ascending: true }),
    "departments.listByOrg"
  );
}

/**
 * One department with its sections, subjects and faculty.
 *
 * Replaces prisma.department.findFirst with `include`. The embedded resources are a
 * PostgREST join executed by PostgreSQL — one HTTP request, not one per relation, so
 * this does not become an N+1 as the Worker would if it fetched each list separately.
 */
export async function findWithRelations(
  db: SupabaseClient,
  id: string,
  organizationId: string
) {
  return maybeOne(
    await db
      .from("departments")
      .select(
        "id,organizationId,code,name," +
          "sections(id,semesterId,departmentId,name)," +
          "subjects(id,departmentId,code,name,totalHours,countsForAttendance)," +
          "faculty(id,userId,departmentId,employeeId,name)"
      )
      .eq("id", id)
      .eq("organizationId", organizationId)
      .maybeSingle(),
    "departments.findWithRelations"
  );
}

/** Org-scoped existence check. Replaces the findFirst guard before update/delete. */
export async function findInOrg(db: SupabaseClient, id: string, organizationId: string) {
  return maybeOne<Department>(
    await db
      .from("departments")
      .select("id,organizationId,code,name")
      .eq("id", id)
      .eq("organizationId", organizationId)
      .maybeSingle(),
    "departments.findInOrg"
  );
}

/** Looks up by the (organizationId, code) unique key. Replaces findUnique. */
export async function findByCode(db: SupabaseClient, organizationId: string, code: string) {
  return maybeOne<Department>(
    await db
      .from("departments")
      .select("id,organizationId,code,name")
      .eq("organizationId", organizationId)
      .eq("code", code)
      .maybeSingle(),
    "departments.findByCode"
  );
}

/**
 * Creates a department.
 *
 * Returns null on a unique violation so the route can raise its existing 409 rather
 * than a 500. The route also checks for a duplicate first; this covers the race
 * between that check and the insert, which the database settles either way.
 */
export async function create(
  db: SupabaseClient,
  data: { organizationId: string; code: string; name: string }
): Promise<Department | null> {
  // The id is generated here because `@default(cuid())` was a Prisma client-side
  // default — the column has no DEFAULT in Postgres, so PostgREST inserts must carry
  // one. See packages/db/src/ids.ts.
  const result = await db
    .from("departments")
    .insert({ id: cuid(), ...data })
    .select("id,organizationId,code,name")
    .single();
  if (isUniqueViolation(result.error)) return null;
  return one<Department>(result, "departments.create");
}

/** Updates a department. The caller has already proven it is in the org. */
export async function update(
  db: SupabaseClient,
  id: string,
  data: Partial<{ code: string; name: string }>
) {
  return one<Department>(
    await db
      .from("departments")
      .update(data)
      .eq("id", id)
      .select("id,organizationId,code,name")
      .single(),
    "departments.update"
  );
}

/** Deletes a department. FK cascades match the Prisma schema's onDelete: Cascade. */
export async function remove(db: SupabaseClient, id: string) {
  const { error } = await db.from("departments").delete().eq("id", id);
  if (error) throw new Error(`departments.remove: ${error.message}`);
}
