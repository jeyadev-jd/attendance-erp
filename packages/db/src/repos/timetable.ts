// Timetable repository — PostgREST equivalents of apps/api/src/routes/timetable.ts.
//
// The overlap arithmetic (multi-hour blocks clashing by range, not by start hour)
// stays in the route: it is pure business logic over a handful of rows for one
// section-day, and the candidate set is already narrowed in PostgreSQL by faculty or
// section plus day-of-week. Only the fetching moved.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many, maybeOne, one, isUniqueViolation, normaliseDates, DATE_FIELDS } from "../supabase";
import { cuid } from "../ids";

export type TimetableEntry = {
  id: string;
  sectionId: string;
  dayOfWeek: number;
  hourNumber: number;
  durationHours: number;
  subjectId: string;
  facultyId: string;
  semesterId: string;
};

const COLS = "id,sectionId,dayOfWeek,hourNumber,durationHours,subjectId,facultyId,semesterId";

const ORG_EMBED = "sections!inner(id,semesters!inner(id,academic_years!inner(organizationId)))";
const ORG_PATH = "sections.semesters.academic_years.organizationId";

/**
 * Renames PostgREST's table-named embeds to Prisma's relation names.
 *
 * Prisma returned `subject` / `faculty` / `section` / `createdBy`; PostgREST returns
 * `subjects` / `faculty` / `sections` / `users`. The org-scoping join also adds a
 * nested `semesters` object Prisma never emitted, so it is dropped.
 */
function toPrismaShape(
  row: Record<string, unknown>,
  opts: { keepSection?: boolean } = {}
): Record<string, unknown> {
  const { subjects, sections, users, ...rest } = row as {
    subjects?: unknown;
    sections?: Record<string, unknown>;
    users?: unknown;
  } & Record<string, unknown>;

  const out: Record<string, unknown> = { ...rest };
  if (subjects !== undefined) out.subject = subjects;
  if (users !== undefined) out.createdBy = users;

  // `sections` serves two purposes: it is a displayed relation on the weekly
  // timetable (Prisma's `include: { section }`), but on the overrides query it exists
  // only to carry the org-scoping join. Prisma's override response had no `section`
  // key at all, so keeping it there would add a field the contract never had.
  if (sections && opts.keepSection) {
    const { semesters: _scoping, ...sectionRest } = sections as {
      semesters?: unknown;
    } & Record<string, unknown>;
    out.section = sectionRest;
  }
  return out;
}

// ───────────────────────── weekly entries ─────────────────────────

/** Timetable entries for an org, optionally filtered by section and/or semester. */
export async function listByOrg(
  db: SupabaseClient,
  organizationId: string,
  filters: { sectionId?: string; semesterId?: string } = {}
) {
  let q = db
    .from("timetables")
    .select(
      `${COLS},subjects(id,departmentId,code,name,totalHours,countsForAttendance),` +
        "faculty(id,userId,departmentId,employeeId,name)," +
        "sections!inner(id,semesterId,departmentId,name," +
        "semesters!inner(id,academic_years!inner(organizationId)))"
    )
    .eq(ORG_PATH, organizationId);
  if (filters.sectionId) q = q.eq("sectionId", filters.sectionId);
  if (filters.semesterId) q = q.eq("semesterId", filters.semesterId);

  const rows = many<Record<string, unknown>>(
    (await q
      .order("dayOfWeek", { ascending: true })
      .order("hourNumber", { ascending: true })) as unknown as {
      data: Record<string, unknown>[] | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "timetable.listByOrg"
  );
  return rows.map((r) => toPrismaShape(r, { keepSection: true }));
}

/** One faculty member's weekly schedule across the org. */
export async function listByFaculty(
  db: SupabaseClient,
  facultyId: string,
  organizationId: string
) {
  const rows = many<Record<string, unknown>>(
    (await db
      .from("timetables")
      .select(
        `${COLS},subjects(id,departmentId,code,name,totalHours,countsForAttendance),` +
          "sections!inner(id,semesterId,departmentId,name," +
          "semesters!inner(id,academic_years!inner(organizationId)))"
      )
      .eq("facultyId", facultyId)
      .eq(ORG_PATH, organizationId)
      .order("dayOfWeek", { ascending: true })
      .order("hourNumber", { ascending: true })) as unknown as {
      data: Record<string, unknown>[] | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "timetable.listByFaculty"
  );
  return rows.map((r) => toPrismaShape(r, { keepSection: true }));
}

/** One entry, org-scoped. Replaces the findFirst guard before update/delete. */
export async function findInOrg(
  db: SupabaseClient,
  id: string,
  organizationId: string
): Promise<TimetableEntry | null> {
  const row = maybeOne<TimetableEntry & { sections?: unknown }>(
    await db
      .from("timetables")
      .select(`${COLS},${ORG_EMBED}`)
      .eq("id", id)
      .eq(ORG_PATH, organizationId)
      .maybeSingle(),
    "timetable.findInOrg"
  );
  if (!row) return null;
  const { sections: _embed, ...rest } = row as TimetableEntry & { sections?: unknown };
  return rest as TimetableEntry;
}

/** Entry occupying a specific (section, day, hour), if any. Used by swap. */
export async function findSlot(
  db: SupabaseClient,
  sectionId: string,
  dayOfWeek: number,
  hourNumber: number
) {
  return maybeOne<TimetableEntry>(
    await db
      .from("timetables")
      .select(COLS)
      .eq("sectionId", sectionId)
      .eq("dayOfWeek", dayOfWeek)
      .eq("hourNumber", hourNumber)
      .maybeSingle(),
    "timetable.findSlot"
  );
}

/**
 * Candidate rows for a same-section overlap check: everything that section teaches
 * on that weekday.
 *
 * The route compares hour ranges in JavaScript because a multi-hour block clashes by
 * span rather than by start hour, which no index expresses. The candidate set is one
 * section-day — a handful of rows — so the filtering that matters still happens in
 * PostgreSQL.
 */
export async function sectionDayEntries(
  db: SupabaseClient,
  sectionId: string,
  dayOfWeek: number,
  excludeId?: string
) {
  let q = db
    .from("timetables")
    .select(`${COLS},subjects(id,code,name)`)
    .eq("sectionId", sectionId)
    .eq("dayOfWeek", dayOfWeek);
  if (excludeId) q = q.neq("id", excludeId);

  const rows = many<Record<string, unknown>>(
    (await q) as unknown as {
      data: Record<string, unknown>[] | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "timetable.sectionDayEntries"
  );
  return rows.map((r) => toPrismaShape(r, { keepSection: true }));
}

/**
 * Candidate rows for a faculty conflict check: everything that faculty teaches on
 * that weekday for OTHER sections.
 */
export async function facultyDayEntries(
  db: SupabaseClient,
  facultyId: string,
  dayOfWeek: number,
  excludeSectionId: string,
  excludeId?: string
) {
  let q = db
    .from("timetables")
    .select(`${COLS},subjects(id,code,name),sections(id,name)`)
    .eq("facultyId", facultyId)
    .eq("dayOfWeek", dayOfWeek)
    .neq("sectionId", excludeSectionId);
  if (excludeId) q = q.neq("id", excludeId);

  const rows = many<Record<string, unknown>>(
    (await q) as unknown as {
      data: Record<string, unknown>[] | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "timetable.facultyDayEntries"
  );
  return rows.map((r) => toPrismaShape(r, { keepSection: true }));
}

/**
 * All entries for a set of (faculty, day) and (section, day) pairs, in one request.
 *
 * The bulk endpoints validated each entry with its own two conflict queries, which
 * over HTTP would be 2N round trips. Fetching every relevant day once lets the route
 * run the same overlap arithmetic against an in-memory set.
 */
export async function entriesForDays(
  db: SupabaseClient,
  facultyIds: string[],
  sectionIds: string[],
  daysOfWeek: number[]
) {
  if (daysOfWeek.length === 0) return [];
  const ids = [...new Set([...facultyIds])];
  const secs = [...new Set([...sectionIds])];

  // `or` keeps this to one request: rows that matter are those taught by one of the
  // faculty, or belonging to one of the sections, on one of the days.
  const rows = many<Record<string, unknown>>(
    (await db
      .from("timetables")
      .select(`${COLS},subjects(id,code,name),sections(id,name)`)
      .in("dayOfWeek", [...new Set(daysOfWeek)])
      .or(
        `facultyId.in.(${ids.join(",")}),sectionId.in.(${secs.join(",")})`
      )) as unknown as {
      data: Record<string, unknown>[] | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "timetable.entriesForDays"
  );
  return rows.map((r) => toPrismaShape(r, { keepSection: true }));
}

/** Creates one entry. Returns null on unique violation so the route raises its 409. */
export async function create(
  db: SupabaseClient,
  data: {
    semesterId: string;
    sectionId: string;
    dayOfWeek: number;
    hourNumber: number;
    durationHours?: number;
    subjectId: string;
    facultyId: string;
  }
): Promise<TimetableEntry | null> {
  const result = await db
    .from("timetables")
    .insert({ id: cuid(), durationHours: data.durationHours ?? 1, ...data })
    .select(COLS)
    .single();
  if (isUniqueViolation(result.error)) return null;
  return one<TimetableEntry>(result, "timetable.create");
}

/** Creates many entries in one batched insert. Replaces a $transaction of N creates. */
export async function createMany(
  db: SupabaseClient,
  entries: {
    semesterId: string;
    sectionId: string;
    dayOfWeek: number;
    hourNumber: number;
    durationHours?: number;
    subjectId: string;
    facultyId: string;
  }[]
): Promise<number> {
  if (entries.length === 0) return 0;
  const { error } = await db.from("timetables").insert(
    entries.map((e) => ({ id: cuid(), durationHours: e.durationHours ?? 1, ...e }))
  );
  if (error) throw new Error(`timetable.createMany: ${error.message}`);
  return entries.length;
}

/** Updates one entry. Returns null on unique violation so the route raises its 409. */
export async function update(
  db: SupabaseClient,
  id: string,
  data: Partial<Omit<TimetableEntry, "id">>
): Promise<TimetableEntry | null> {
  const result = await db.from("timetables").update(data).eq("id", id).select(COLS).single();
  if (isUniqueViolation(result.error)) return null;
  return one<TimetableEntry>(result, "timetable.update");
}

/** Moves an entry to a different slot. Used by swap. */
export async function moveTo(
  db: SupabaseClient,
  id: string,
  dayOfWeek: number,
  hourNumber: number
) {
  const { error } = await db.from("timetables").update({ dayOfWeek, hourNumber }).eq("id", id);
  if (error) throw new Error(`timetable.moveTo: ${error.message}`);
}

/** Deletes one entry. */
export async function remove(db: SupabaseClient, id: string) {
  const { error } = await db.from("timetables").delete().eq("id", id);
  if (error) throw new Error(`timetable.remove: ${error.message}`);
}

/** Deletes several entries in one request. Used by bulk-assign overwrite. */
export async function removeMany(db: SupabaseClient, ids: string[]) {
  if (ids.length === 0) return;
  const { error } = await db.from("timetables").delete().in("id", ids);
  if (error) throw new Error(`timetable.removeMany: ${error.message}`);
}

// ───────────────────────── date-specific overrides ─────────────────────────

export type TimetableOverride = {
  id: string;
  sectionId: string;
  semesterId: string;
  date: string;
  hourNumber: number;
  durationHours: number;
  subjectId: string | null;
  facultyId: string | null;
  countsForAttendance: boolean | null;
  reason: string | null;
  createdById: string;
  createdAt: string;
};

const OVERRIDE_COLS =
  "id,sectionId,semesterId,date,hourNumber,durationHours,subjectId,facultyId," +
  "countsForAttendance,reason,createdById,createdAt";

/** Overrides for a section, optionally within a date range. */
export async function listOverrides(
  db: SupabaseClient,
  sectionId: string,
  organizationId: string,
  range: { dateFrom?: string; dateTo?: string }
) {
  let q = db
    .from("timetable_overrides")
    .select(
      `${OVERRIDE_COLS},subjects(id,departmentId,code,name,totalHours,countsForAttendance),` +
        "faculty(id,userId,departmentId,employeeId,name)," +
        "users(name)," +
        "sections!inner(id,semesters!inner(id,academic_years!inner(organizationId)))"
    )
    .eq("sectionId", sectionId)
    .eq(ORG_PATH, organizationId);

  // Both bounds are UTC midnight, matching the route's existing behaviour.
  if (range.dateFrom) q = q.gte("date", `${range.dateFrom}T00:00:00.000Z`);
  if (range.dateTo) q = q.lte("date", `${range.dateTo}T00:00:00.000Z`);

  const rows = many<Record<string, unknown>>(
    (await q
      .order("date", { ascending: true })
      .order("hourNumber", { ascending: true })) as unknown as {
      data: Record<string, unknown>[] | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "timetable.listOverrides"
  );
  // No keepSection: Prisma's override response had no `section` key — the embed here
  // exists only to carry the org-scoping join. Wrapped in an arrow rather than passed
  // by reference so Array.map's index argument cannot land in the options parameter.
  return normaliseDates(
    rows.map((r) => toPrismaShape(r)),
    DATE_FIELDS
  );
}

/** Existing override for a (section, date, hour), or null. */
export async function findOverride(
  db: SupabaseClient,
  sectionId: string,
  date: Date,
  hourNumber: number
) {
  return maybeOne<TimetableOverride>(
    await db
      .from("timetable_overrides")
      .select(OVERRIDE_COLS)
      .eq("sectionId", sectionId)
      .eq("date", date.toISOString())
      .eq("hourNumber", hourNumber)
      .maybeSingle(),
    "timetable.findOverride"
  );
}

/**
 * Inserts or updates one date-specific override.
 *
 * The existing id is reused — see the primary-key note in repos/calendar.ts.
 * `createdAt` is only set on insert: Prisma's `@default(now())` fired once, and
 * rewriting it on every edit would misreport when the override was first made.
 */
export async function upsertOverride(
  db: SupabaseClient,
  data: {
    semesterId: string;
    sectionId: string;
    date: Date;
    hourNumber: number;
    durationHours: number;
    subjectId: string | null;
    facultyId: string | null;
    countsForAttendance: boolean | null;
    reason?: string | null;
    createdById: string;
  }
) {
  const existing = await findOverride(db, data.sectionId, data.date, data.hourNumber);

  const row = one<Record<string, unknown>>(
    (await db
      .from("timetable_overrides")
      .upsert(
        {
          id: existing?.id ?? cuid(),
          semesterId: data.semesterId,
          sectionId: data.sectionId,
          date: data.date.toISOString(),
          hourNumber: data.hourNumber,
          durationHours: data.durationHours,
          subjectId: data.subjectId,
          facultyId: data.facultyId,
          countsForAttendance: data.countsForAttendance,
          reason: data.reason ?? null,
          createdById: data.createdById,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
        },
        { onConflict: "sectionId,date,hourNumber" }
      )
      .select(
        `${OVERRIDE_COLS},subjects(id,departmentId,code,name,totalHours,countsForAttendance),` +
          "faculty(id,userId,departmentId,employeeId,name)"
      )
      .single()) as unknown as {
      data: Record<string, unknown> | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "timetable.upsertOverride"
  );
  return normaliseDates(toPrismaShape(row), DATE_FIELDS);
}

/** One override, org-scoped. Replaces the findFirst guard before delete. */
export async function findOverrideInOrg(
  db: SupabaseClient,
  id: string,
  organizationId: string
) {
  return maybeOne<{ id: string }>(
    (await db
      .from("timetable_overrides")
      .select("id,sections!inner(id,semesters!inner(id,academic_years!inner(organizationId)))")
      .eq("id", id)
      .eq(ORG_PATH, organizationId)
      .maybeSingle()) as unknown as {
      data: { id: string } | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "timetable.findOverrideInOrg"
  );
}

/** Deletes one override so the date falls back to the weekly pattern. */
export async function removeOverride(db: SupabaseClient, id: string) {
  const { error } = await db.from("timetable_overrides").delete().eq("id", id);
  if (error) throw new Error(`timetable.removeOverride: ${error.message}`);
}
