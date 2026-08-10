// Subjects repository — PostgREST equivalents of apps/api/src/routes/subjects.ts.
//
// Org scoping goes through department: `where: { department: { organizationId } }` in
// Prisma becomes a `departments!inner(...)` embed filtered on the joined column. The
// join runs in PostgreSQL — one request, no extra round trip.
//
// The embed adds a `departments` key to each row, which the D1 responses do not have.
// Every read here strips it before returning, so the JSON the route emits is
// byte-identical to the Prisma version and the frontend contract is preserved.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many, maybeOne, one, isUniqueViolation } from "../supabase";
import { cuid } from "../ids";

export type Subject = {
  id: string;
  departmentId: string;
  code: string;
  name: string;
  totalHours: number;
  countsForAttendance: boolean;
};

/** Columns of `subjects`, in the order Prisma returns them. */
const COLS = "id,departmentId,code,name,totalHours,countsForAttendance";

/** Drops the `departments` key the !inner embed adds, leaving the plain row. */
function strip<T extends Record<string, unknown>>(row: T): Omit<T, "departments"> {
  const { departments: _embed, ...rest } = row as T & { departments?: unknown };
  return rest;
}

/**
 * Subjects in an organization, optionally narrowed to one department.
 *
 * Replaces prisma.subject.findMany with the department relation filter.
 *
 * ORDERING DIFFERS FROM D1, deliberately unpatched. SQLite's default BINARY collation
 * sorts by byte value, so "NLP Lab" precedes "Natural Language Processing" ('L' 0x4C
 * < 'a' 0x61). Postgres uses a locale-aware collation and sorts them the other way.
 * Same rows, same count — only the position of mixed-case names differs.
 *
 * Postgres's order is the one a human expects, so forcing SQLite's byte order here
 * (via COLLATE "C") would carry a quirk forward for no benefit. Flagged rather than
 * silently reconciled: the subject list visibly reorders at cutover.
 */
export async function listByOrg(
  db: SupabaseClient,
  organizationId: string,
  departmentId?: string
): Promise<Subject[]> {
  let q = db
    .from("subjects")
    .select(`${COLS},departments!inner(organizationId)`)
    .eq("departments.organizationId", organizationId);
  if (departmentId) q = q.eq("departmentId", departmentId);

  const rows = many<Subject & { departments?: unknown }>(
    await q.order("name", { ascending: true }),
    "subjects.listByOrg"
  );
  return rows.map(strip) as Subject[];
}

/** One subject, scoped to the org through its department. Replaces findFirst. */
export async function findInOrg(
  db: SupabaseClient,
  id: string,
  organizationId: string
): Promise<Subject | null> {
  const row = maybeOne<Subject & { departments?: unknown }>(
    await db
      .from("subjects")
      .select(`${COLS},departments!inner(organizationId)`)
      .eq("id", id)
      .eq("departments.organizationId", organizationId)
      .maybeSingle(),
    "subjects.findInOrg"
  );
  return row ? (strip(row) as Subject) : null;
}

/** Looks up by the (departmentId, code) unique key. Replaces findUnique. */
export async function findByCode(db: SupabaseClient, departmentId: string, code: string) {
  return maybeOne<Subject>(
    await db
      .from("subjects")
      .select(COLS)
      .eq("departmentId", departmentId)
      .eq("code", code)
      .maybeSingle(),
    "subjects.findByCode"
  );
}

/**
 * Creates a subject. Returns null on unique violation so the route raises its 409.
 *
 * The id is generated here: `@default(cuid())` was a Prisma client-side default and
 * the Postgres column has no DEFAULT. See packages/db/src/ids.ts.
 */
export async function create(
  db: SupabaseClient,
  data: {
    departmentId: string;
    code: string;
    name: string;
    totalHours?: number;
    countsForAttendance?: boolean;
  }
): Promise<Subject | null> {
  const result = await db
    .from("subjects")
    .insert({ id: cuid(), ...data })
    .select(COLS)
    .single();
  if (isUniqueViolation(result.error)) return null;
  return one<Subject>(result, "subjects.create");
}

/** Updates a subject. Caller has already proven org membership. */
export async function update(
  db: SupabaseClient,
  id: string,
  data: Partial<{
    code: string;
    name: string;
    totalHours: number;
    countsForAttendance: boolean;
    departmentId: string;
  }>
) {
  return one<Subject>(
    await db.from("subjects").update(data).eq("id", id).select(COLS).single(),
    "subjects.update"
  );
}

/** Deletes a subject. FK cascades match the schema's onDelete: Cascade. */
export async function remove(db: SupabaseClient, id: string) {
  const { error } = await db.from("subjects").delete().eq("id", id);
  if (error) throw new Error(`subjects.remove: ${error.message}`);
}
