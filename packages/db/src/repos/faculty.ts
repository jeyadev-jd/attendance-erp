// Faculty repository — PostgREST equivalent of apps/api/src/routes/faculty.ts.
//
// Read-only directory, org-scoped through department. The route flattens the joined
// user email into the top-level shape, so this repo returns the flattened form
// directly rather than making the route reshape an embed.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many } from "../supabase";

/** Response shape of GET /api/faculty — flattened, matching the Prisma route. */
export type FacultyDirectoryEntry = {
  id: string;
  employeeId: string;
  departmentId: string;
  name: string;
  email: string;
};

type FacultyRow = {
  id: string;
  employeeId: string;
  departmentId: string;
  name: string;
  /**
   * The embedded user.
   *
   * faculty.userId is UNIQUE, so this is a to-one relation and PostgREST returns a
   * single object at runtime (verified against the live schema). supabase-js types
   * embeds as arrays because it cannot see that constraint, so the union covers both
   * and `pickEmail` below normalises them — accepting the array form costs nothing
   * and avoids a cast that would hide a genuine shape change.
   */
  users: { email: string } | { email: string }[] | null;
  departments?: unknown;
};

/** Reads the email from either embed shape. */
function pickEmail(users: FacultyRow["users"]): string {
  if (!users) return "";
  return (Array.isArray(users) ? users[0]?.email : users.email) ?? "";
}

/**
 * Faculty in an organization, optionally narrowed to one department.
 *
 * Two embeds, one request: `users` supplies the email the directory displays, and
 * `departments!inner` performs the org scoping in PostgreSQL. Fetching faculty and
 * then looking up each email separately would be an N+1.
 */
export async function listByOrg(
  db: SupabaseClient,
  organizationId: string,
  departmentId?: string
): Promise<FacultyDirectoryEntry[]> {
  let q = db
    .from("faculty")
    .select("id,employeeId,departmentId,name,users(email),departments!inner(organizationId)")
    .eq("departments.organizationId", organizationId);
  if (departmentId) q = q.eq("departmentId", departmentId);

  const rows = many<FacultyRow>(
    (await q.order("name", { ascending: true })) as unknown as {
      data: FacultyRow[] | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "faculty.listByOrg"
  );

  return rows.map((f) => ({
    id: f.id,
    employeeId: f.employeeId,
    departmentId: f.departmentId,
    name: f.name,
    // Empty string rather than null when the user row is missing — matches the
    // route's `f.user?.email ?? ""`, which the frontend renders directly.
    email: pickEmail(f.users),
  }));
}
