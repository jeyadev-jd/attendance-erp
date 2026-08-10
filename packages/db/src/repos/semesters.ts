// Semesters repository — PostgREST equivalents of apps/api/src/routes/semesters.ts.
//
// Org scoping walks semester -> academicYear -> organizationId, expressed as an
// !inner embed filtered on the joined column.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many, maybeOne, one, normaliseDates, DATE_FIELDS } from "../supabase";
import { cuid } from "../ids";

export type Semester = {
  id: string;
  academicYearId: string;
  name: string;
  startDate: string;
  endDate: string;
  minAttendancePct: number;
  status: string;
  clonedFromId: string | null;
  createdAt: string;
};

const COLS =
  "id,academicYearId,name,startDate,endDate,minAttendancePct,status,clonedFromId,createdAt";

const ORG_EMBED = "academic_years!inner(organizationId)";
const ORG_PATH = "academic_years.organizationId";

/** Drops the `academic_years` key the !inner embed adds. */
function strip<T extends Record<string, unknown>>(row: T): Omit<T, "academic_years"> {
  const { academic_years: _embed, ...rest } = row as T & { academic_years?: unknown };
  return rest;
}

/** Semesters in an organization, optionally narrowed to one academic year. */
export async function listByOrg(
  db: SupabaseClient,
  organizationId: string,
  academicYearId?: string
): Promise<Semester[]> {
  let q = db
    .from("semesters")
    .select(`${COLS},${ORG_EMBED}`)
    .eq(ORG_PATH, organizationId);
  if (academicYearId) q = q.eq("academicYearId", academicYearId);

  const rows = many<Semester & { academic_years?: unknown }>(
    await q.order("startDate", { ascending: false }),
    "semesters.listByOrg"
  );
  return normaliseDates(rows.map(strip) as Semester[], DATE_FIELDS);
}

/** One semester, org-scoped. Replaces the findFirst guard. */
export async function findInOrg(
  db: SupabaseClient,
  id: string,
  organizationId: string
): Promise<Semester | null> {
  const row = maybeOne<Semester & { academic_years?: unknown }>(
    await db
      .from("semesters")
      .select(`${COLS},${ORG_EMBED}`)
      .eq("id", id)
      .eq(ORG_PATH, organizationId)
      .maybeSingle(),
    "semesters.findInOrg"
  );
  return row ? normaliseDates(strip(row) as Semester, DATE_FIELDS) : null;
}

/** One semester with its sections. Replaces findFirst with `include: { sections }`. */
export async function findWithSections(
  db: SupabaseClient,
  id: string,
  organizationId: string
) {
  const row = maybeOne<Record<string, unknown>>(
    await db
      .from("semesters")
      .select(`${COLS},${ORG_EMBED},sections(id,semesterId,departmentId,name)`)
      .eq("id", id)
      .eq(ORG_PATH, organizationId)
      .maybeSingle(),
    "semesters.findWithSections"
  );
  return row ? normaliseDates(strip(row), DATE_FIELDS) : null;
}

/**
 * Source semester for a clone: its sections, hour configs and timetable entries.
 *
 * One request rather than four. The clone only needs the columns it copies, so the
 * embeds name them explicitly instead of selecting whole rows.
 */
export async function findCloneSource(
  db: SupabaseClient,
  id: string,
  organizationId: string
) {
  const row = maybeOne<
    Semester & {
      academic_years?: unknown;
      sections: { id: string; departmentId: string; name: string }[];
      hour_configs: {
        dayOfWeek: number;
        hourNumber: number;
        startTime: string;
        endTime: string;
      }[];
      timetables: {
        sectionId: string;
        dayOfWeek: number;
        hourNumber: number;
        durationHours: number;
        subjectId: string;
        facultyId: string;
      }[];
    }
  >(
    await db
      .from("semesters")
      .select(
        `${COLS},${ORG_EMBED},` +
          "sections(id,departmentId,name)," +
          "hour_configs(dayOfWeek,hourNumber,startTime,endTime)," +
          "timetables(sectionId,dayOfWeek,hourNumber,durationHours,subjectId,facultyId)"
      )
      .eq("id", id)
      .eq(ORG_PATH, organizationId)
      .maybeSingle(),
    "semesters.findCloneSource"
  );
  return row ? normaliseDates(strip(row) as typeof row, DATE_FIELDS) : null;
}

/** Creates a semester. `createdAt` is supplied for the same reason as the id. */
export async function create(
  db: SupabaseClient,
  data: {
    academicYearId: string;
    name: string;
    startDate: string;
    endDate: string;
    minAttendancePct: number;
    status: string;
    clonedFromId?: string;
  }
) {
  return normaliseDates(
    one<Semester>(
      await db
        .from("semesters")
        .insert({ id: cuid(), createdAt: new Date().toISOString(), ...data })
        .select(COLS)
        .single(),
      "semesters.create"
    ),
    DATE_FIELDS
  );
}

/** Updates a semester. Caller has already proven org membership. */
export async function update(
  db: SupabaseClient,
  id: string,
  data: Partial<{
    name: string;
    startDate: string;
    endDate: string;
    minAttendancePct: number;
    status: string;
  }>
) {
  return normaliseDates(
    one<Semester>(
      await db.from("semesters").update(data).eq("id", id).select(COLS).single(),
      "semesters.update"
    ),
    DATE_FIELDS
  );
}

/** Deletes a semester. Cascades remove everything beneath it, as in the schema. */
export async function remove(db: SupabaseClient, id: string) {
  const { error } = await db.from("semesters").delete().eq("id", id);
  if (error) throw new Error(`semesters.remove: ${error.message}`);
}

// ───────────────────────── clone helpers ─────────────────────────
//
// Each stage is a single batched insert rather than one insert per row. Prisma ran
// these as $transaction arrays of individual creates; PostgREST takes an array in one
// request, which is both atomic and one round trip instead of N.

/** Copies sections into the new semester, returning old id -> new id. */
export async function cloneSections(
  db: SupabaseClient,
  newSemesterId: string,
  sections: { id: string; departmentId: string; name: string }[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (sections.length === 0) return map;

  const rows = sections.map((s) => {
    const id = cuid();
    map.set(s.id, id);
    return { id, semesterId: newSemesterId, departmentId: s.departmentId, name: s.name };
  });

  const { error } = await db.from("sections").insert(rows);
  if (error) throw new Error(`semesters.cloneSections: ${error.message}`);
  return map;
}

/** Copies hour configs into the new semester. */
export async function cloneHourConfigs(
  db: SupabaseClient,
  newSemesterId: string,
  configs: { dayOfWeek: number; hourNumber: number; startTime: string; endTime: string }[]
) {
  if (configs.length === 0) return 0;
  const rows = configs.map((hc) => ({ id: cuid(), semesterId: newSemesterId, ...hc }));
  const { error } = await db.from("hour_configs").insert(rows);
  if (error) throw new Error(`semesters.cloneHourConfigs: ${error.message}`);
  return rows.length;
}

/**
 * Copies timetable entries, remapping section ids through the clone map.
 *
 * Entries whose section was not copied are skipped, exactly as the Prisma version's
 * `.filter(tt => sectionIdMap.has(tt.sectionId))` did.
 */
export async function cloneTimetables(
  db: SupabaseClient,
  newSemesterId: string,
  timetables: {
    sectionId: string;
    dayOfWeek: number;
    hourNumber: number;
    durationHours: number;
    subjectId: string;
    facultyId: string;
  }[],
  sectionIdMap: Map<string, string>
) {
  const rows = timetables
    .filter((tt) => sectionIdMap.has(tt.sectionId))
    .map((tt) => ({
      id: cuid(),
      semesterId: newSemesterId,
      sectionId: sectionIdMap.get(tt.sectionId)!,
      dayOfWeek: tt.dayOfWeek,
      hourNumber: tt.hourNumber,
      durationHours: tt.durationHours,
      subjectId: tt.subjectId,
      facultyId: tt.facultyId,
    }));
  if (rows.length === 0) return 0;

  const { error } = await db.from("timetables").insert(rows);
  if (error) throw new Error(`semesters.cloneTimetables: ${error.message}`);
  return rows.length;
}
