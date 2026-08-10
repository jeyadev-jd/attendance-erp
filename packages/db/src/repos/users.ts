// Users repository — PostgREST equivalents of apps/api/src/routes/users.ts.
//
// SECURITY: `users` holds passwordHash and otpHash. Prisma's routes used explicit
// `select` clauses so those columns never left the database; every read here names
// its columns for the same reason. There is no "select *" in this file, and there
// must not be: a stray one would put bcrypt hashes into an API response.
//
// The escalation guards (self-demotion, SUPER_ADMIN management) live in the route,
// unchanged — this layer only moves data.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many, maybeOne, one, normaliseDates, DATE_FIELDS } from "../supabase";
import { cuid } from "../ids";

/** Columns safe to return from the list endpoint. Excludes passwordHash/otpHash. */
const LIST_COLS = "id,email,name,role,externalId,isActive,mustChangePassword,createdAt";

/** Columns the create/update endpoints echo back. */
const WRITE_COLS = "id,email,name,role,externalId,isActive";

export type UserListRow = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  externalId: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  hasStudentProfile: boolean;
};

type RawListRow = Omit<UserListRow, "hasStudentProfile"> & {
  // Embedded to-one student. supabase-js types embeds as arrays because it cannot
  // see the UNIQUE constraint on students.userId; at runtime this is an object or
  // null, so both forms are accepted. Same situation as the faculty repo.
  students: { id: string } | { id: string }[] | null;
};

function hasStudent(students: RawListRow["students"]): boolean {
  if (!students) return false;
  return Array.isArray(students) ? students.length > 0 : true;
}

/**
 * Staff users in an organization, ordered by role then name.
 *
 * Replaces prisma.user.findMany. When no role filter is given the Prisma route used
 * `role: { not: "STUDENT" }`, which PostgREST expresses as `.neq`.
 *
 * The `students(id)` embed answers "does this user have a student profile?" in the
 * same request — the route only needs the boolean, so just the id is selected.
 */
export async function listStaff(
  db: SupabaseClient,
  organizationId: string,
  role?: string
): Promise<UserListRow[]> {
  let q = db
    .from("users")
    .select(`${LIST_COLS},students(id)`)
    .eq("organizationId", organizationId);
  q = role ? q.eq("role", role) : q.neq("role", "STUDENT");

  const rows = many<RawListRow>(
    (await q
      .order("role", { ascending: true })
      .order("name", { ascending: true })) as unknown as {
      data: RawListRow[] | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "users.listStaff"
  );

  return rows.map(({ students, ...u }) => ({
    ...normaliseDates(u, DATE_FIELDS),
    hasStudentProfile: hasStudent(students),
  }));
}

/** Looks up by the (organizationId, email) unique key. Replaces findUnique. */
export async function findByEmail(
  db: SupabaseClient,
  organizationId: string,
  email: string
) {
  return maybeOne<{ id: string }>(
    await db
      .from("users")
      .select("id")
      .eq("organizationId", organizationId)
      .eq("email", email)
      .maybeSingle(),
    "users.findByEmail"
  );
}

/**
 * One user in the org, with the fields the authorization guards need.
 *
 * `role` and `isActive` are required by the route's escalation checks, so they are
 * selected deliberately — not passwordHash, which no route needs.
 */
export async function findInOrg(db: SupabaseClient, id: string, organizationId: string) {
  return maybeOne<{ id: string; role: string; isActive: boolean; email: string }>(
    await db
      .from("users")
      .select("id,role,isActive,email")
      .eq("id", id)
      .eq("organizationId", organizationId)
      .maybeSingle(),
    "users.findInOrg"
  );
}

/**
 * Creates a staff user.
 *
 * The caller supplies an already-hashed password: hashing stays in the route, next
 * to the bcrypt import, so this layer never handles a plaintext credential.
 *
 * `updatedAt` is set explicitly because Prisma's `@updatedAt` is a client-side
 * default with no Postgres equivalent — see packages/db/src/ids.ts.
 */
export async function create(
  db: SupabaseClient,
  data: {
    organizationId: string;
    email: string;
    name: string;
    role: string;
    externalId?: string;
    passwordHash: string;
    mustChangePassword: boolean;
  }
) {
  const now = new Date().toISOString();
  return one<{
    id: string;
    email: string;
    name: string | null;
    role: string;
    externalId: string | null;
    isActive: boolean;
  }>(
    await db
      .from("users")
      .insert({ id: cuid(), createdAt: now, updatedAt: now, ...data })
      .select(WRITE_COLS)
      .single(),
    "users.create"
  );
}

/** Updates a user's role/activation. Guards have already run in the route. */
export async function update(
  db: SupabaseClient,
  id: string,
  data: Partial<{ role: string; isActive: boolean; name: string; externalId: string }>
) {
  return one<{
    id: string;
    email: string;
    name: string | null;
    role: string;
    isActive: boolean;
  }>(
    await db
      .from("users")
      .update({ ...data, updatedAt: new Date().toISOString() })
      .eq("id", id)
      .select("id,email,name,role,isActive")
      .single(),
    "users.update"
  );
}

/**
 * Deactivates a user.
 *
 * Never a hard delete: attendance, audit logs and marked-by references point here,
 * so removing the row would either cascade away history or fail on the FK.
 */
export async function deactivate(db: SupabaseClient, id: string) {
  const { error } = await db
    .from("users")
    .update({ isActive: false, updatedAt: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`users.deactivate: ${error.message}`);
}

/** Sets a user's display name. Used when a student's name changes. */
export async function setName(db: SupabaseClient, id: string, name: string) {
  const { error } = await db
    .from("users")
    .update({ name, updatedAt: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`users.setName: ${error.message}`);
}
