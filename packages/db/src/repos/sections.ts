// Sections repository — PostgREST equivalents of apps/api/src/routes/sections.ts.
//
// Org scoping is two levels deep here: section -> semester -> academicYear ->
// organizationId. Prisma expressed that as a nested relation filter; PostgREST
// expresses it as nested !inner embeds, filtered on the dotted path
// "semesters.academic_years.organizationId". Both compile to one SQL join.
//
// As in the subjects repo, the embed adds nested keys that the D1 responses do not
// have, so reads strip them to keep the API contract byte-identical.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many, maybeOne, one, isUniqueViolation } from "../supabase";
import { cuid } from "../ids";

export type Section = {
  id: string;
  semesterId: string;
  departmentId: string;
  name: string;
};

const COLS = "id,semesterId,departmentId,name";

/** The org-scoping embed, and the dotted path used to filter on it. */
const ORG_EMBED = "semesters!inner(id,academic_years!inner(organizationId))";
const ORG_PATH = "semesters.academic_years.organizationId";

/** Drops the `semesters` key the !inner embed adds. */
function strip<T extends Record<string, unknown>>(row: T): Omit<T, "semesters"> {
  const { semesters: _embed, ...rest } = row as T & { semesters?: unknown };
  return rest;
}

/**
 * Sections in an organization, optionally narrowed by semester and/or department.
 *
 * Replaces prisma.section.findMany. Both query filters are applied in PostgreSQL, so
 * the Worker never receives sections it would have to discard.
 */
export async function listByOrg(
  db: SupabaseClient,
  organizationId: string,
  filters: { semesterId?: string; departmentId?: string } = {}
): Promise<Section[]> {
  let q = db
    .from("sections")
    .select(`${COLS},${ORG_EMBED}`)
    .eq(ORG_PATH, organizationId);
  if (filters.semesterId) q = q.eq("semesterId", filters.semesterId);
  if (filters.departmentId) q = q.eq("departmentId", filters.departmentId);

  const rows = many<Section & { semesters?: unknown }>(
    await q.order("name", { ascending: true }),
    "sections.listByOrg"
  );
  return rows.map(strip) as Section[];
}

/** One section, org-scoped. Replaces the findFirst guard before update/delete. */
export async function findInOrg(
  db: SupabaseClient,
  id: string,
  organizationId: string
): Promise<Section | null> {
  const row = maybeOne<Section & { semesters?: unknown }>(
    await db
      .from("sections")
      .select(`${COLS},${ORG_EMBED}`)
      .eq("id", id)
      .eq(ORG_PATH, organizationId)
      .maybeSingle(),
    "sections.findInOrg"
  );
  return row ? (strip(row) as Section) : null;
}

/**
 * One section with its students and timetable entries.
 *
 * Replaces findFirst with `include: { students, timetables }`. The two relations come
 * back in the same request as PostgREST embeds — a JavaScript implementation would
 * have needed two more round trips, or one per section in a list.
 *
 * The org-scoping embed is stripped; `students` and `timetables` are kept, because
 * the Prisma version returned them.
 */
export async function findWithRelations(
  db: SupabaseClient,
  id: string,
  organizationId: string
) {
  const row = maybeOne<Record<string, unknown>>(
    await db
      .from("sections")
      .select(
        `${COLS},${ORG_EMBED},` +
          "students(id,userId,sectionId,rollNo,name,status)," +
          "timetables(id,sectionId,dayOfWeek,hourNumber,durationHours,subjectId,facultyId,semesterId)"
      )
      .eq("id", id)
      .eq(ORG_PATH, organizationId)
      .maybeSingle(),
    "sections.findWithRelations"
  );
  return row ? strip(row) : null;
}

/** Looks up by the (semesterId, departmentId, name) unique key. Replaces findUnique. */
export async function findByKey(
  db: SupabaseClient,
  semesterId: string,
  departmentId: string,
  name: string
) {
  return maybeOne<Section>(
    await db
      .from("sections")
      .select(COLS)
      .eq("semesterId", semesterId)
      .eq("departmentId", departmentId)
      .eq("name", name)
      .maybeSingle(),
    "sections.findByKey"
  );
}

/** Creates a section. Returns null on unique violation so the route raises its 409. */
export async function create(
  db: SupabaseClient,
  data: { semesterId: string; departmentId: string; name: string }
): Promise<Section | null> {
  const result = await db
    .from("sections")
    .insert({ id: cuid(), ...data })
    .select(COLS)
    .single();
  if (isUniqueViolation(result.error)) return null;
  return one<Section>(result, "sections.create");
}

/** Updates a section. Caller has already proven org membership. */
export async function update(
  db: SupabaseClient,
  id: string,
  data: Partial<{ name: string; semesterId: string; departmentId: string }>
) {
  return one<Section>(
    await db.from("sections").update(data).eq("id", id).select(COLS).single(),
    "sections.update"
  );
}

/** Deletes a section. FK cascades match the schema's onDelete: Cascade. */
export async function remove(db: SupabaseClient, id: string) {
  const { error } = await db.from("sections").delete().eq("id", id);
  if (error) throw new Error(`sections.remove: ${error.message}`);
}
