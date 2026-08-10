// Attendance repository — PostgREST equivalents of apps/api/src/routes/attendance.ts.
//
// TWO HAZARDS THIS FILE EXISTS TO CONTAIN:
//
// 1. PostgREST caps an unfiltered select at 1000 rows by DEFAULT, silently — no
//    error, just a short array. attendance holds 2450 rows today and grows every
//    marked hour. Phase 4 already caught this: 2450 matching rows came back as 1000
//    and every derived percentage was understated. Every query here is therefore
//    either narrowly filtered (one date + one hour + one section — tens of rows) or
//    explicitly paged via fetchAllPaged.
//
// 2. Upsert overwrites every column it is given, INCLUDING the primary key. Existing
//    ids are looked up and reused so marking attendance twice does not rewrite the
//    row's id — audit_logs.attendanceId references it.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many, maybeOne, one, count, normaliseDates, DATE_FIELDS } from "../supabase";
import { cuid } from "../ids";

export type AttendanceRow = {
  id: string;
  date: string;
  hourNumber: number;
  semesterId: string;
  subjectId: string;
  sectionId: string;
  studentId: string;
  status: string;
  arrivalTime: string | null;
  lateMinutes: number | null;
  countsForAttendance: boolean;
  markedById: string;
  markedAt: string;
  isLocked: boolean;
};

const COLS =
  "id,date,hourNumber,semesterId,subjectId,sectionId,studentId,status,arrivalTime," +
  "lateMinutes,countsForAttendance,markedById,markedAt,isLocked";

/** PostgREST's default page size. Kept explicit so the paging logic is self-documenting. */
const PAGE = 1000;

/**
 * Fetches every row of a query, in pages.
 *
 * Only for queries whose result is genuinely unbounded and genuinely needed in full.
 * Anything that can be aggregated should be — this is a last resort, not a default,
 * because N pages is N round trips and the whole set lands in Worker memory.
 */
async function fetchAllPaged<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  context: string
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`${context}: ${(error as { message?: string }).message}`);
    const page = data ?? [];
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

// ───────────────────────── marking ─────────────────────────

/**
 * Existing records for one block's first hour, for one section on one date.
 *
 * Bounded by construction: one section-date-hour is at most the class roster, so no
 * paging is needed. Scoped by sectionId rather than an IN list of student ids — same
 * rows, but it lets the (sectionId, date) index do the work.
 */
export async function findForMarkSheet(
  db: SupabaseClient,
  date: Date,
  hourNumber: number,
  subjectId: string,
  sectionId: string
) {
  return many<{ id: string; studentId: string; status: string; isLocked: boolean }>(
    await db
      .from("attendance")
      .select("id,studentId,status,isLocked")
      .eq("date", date.toISOString())
      .eq("hourNumber", hourNumber)
      .eq("subjectId", subjectId)
      .eq("sectionId", sectionId),
    "attendance.findForMarkSheet"
  );
}

/**
 * Student ids already locked on any hour of a block.
 *
 * A lock on any covered hour locks the whole block for that student.
 */
export async function findLockedStudents(
  db: SupabaseClient,
  date: Date,
  coveredHours: number[],
  subjectId: string,
  studentIds: string[]
): Promise<Set<string>> {
  if (studentIds.length === 0) return new Set();
  const rows = many<{ studentId: string }>(
    await db
      .from("attendance")
      .select("studentId")
      .eq("date", date.toISOString())
      .in("hourNumber", coveredHours)
      .eq("subjectId", subjectId)
      .in("studentId", studentIds)
      .eq("isLocked", true),
    "attendance.findLockedStudents"
  );
  return new Set(rows.map((r) => r.studentId));
}

export type MarkRecord = { studentId: string; status: string };

/**
 * Writes one attendance row per (student, covered hour) in a single batched upsert.
 *
 * Prisma issued one upsert per row inside a $transaction; over HTTP that would be
 * one request per student per hour — a 49-student 2-hour lab would be 98 round
 * trips. This is one.
 *
 * Existing ids are fetched first and reused: audit_logs.attendanceId points at these
 * rows, so letting the upsert mint new ids would orphan the audit trail.
 *
 * `markedAt` is refreshed on every write, matching the Prisma `update` clause, but
 * `createdAt`-style fields are not — there are none on this table.
 */
export async function upsertMarks(
  db: SupabaseClient,
  params: {
    date: Date;
    coveredHours: number[];
    semesterId: string;
    subjectId: string;
    sectionId: string;
    countsForAttendance: boolean;
    markedById: string;
    records: MarkRecord[];
  }
): Promise<number> {
  const { date, coveredHours, subjectId, records } = params;
  if (records.length === 0 || coveredHours.length === 0) return 0;

  const studentIds = records.map((r) => r.studentId);

  // One lookup covering every (student, hour) pair this write touches. Bounded by
  // roster x block length, so well under the row cap.
  const existing = many<{ id: string; studentId: string; hourNumber: number }>(
    await db
      .from("attendance")
      .select("id,studentId,hourNumber")
      .eq("date", date.toISOString())
      .in("hourNumber", coveredHours)
      .eq("subjectId", subjectId)
      .in("studentId", studentIds),
    "attendance.upsertMarks (lookup)"
  );
  const idByKey = new Map(existing.map((r) => [`${r.studentId}::${r.hourNumber}`, r.id]));

  const now = new Date().toISOString();
  const rows = records.flatMap((r) =>
    coveredHours.map((hour) => ({
      id: idByKey.get(`${r.studentId}::${hour}`) ?? cuid(),
      date: date.toISOString(),
      hourNumber: hour,
      semesterId: params.semesterId,
      subjectId,
      sectionId: params.sectionId,
      studentId: r.studentId,
      status: r.status,
      countsForAttendance: params.countsForAttendance,
      markedById: params.markedById,
      markedAt: now,
    }))
  );

  const { error } = await db
    .from("attendance")
    .upsert(rows, { onConflict: "date,hourNumber,studentId,subjectId" });
  if (error) throw new Error(`attendance.upsertMarks: ${error.message}`);
  return rows.length;
}

// ───────────────────────── edit / lock ─────────────────────────

/** One attendance record, org-scoped through its section. */
export async function findInOrg(db: SupabaseClient, id: string, organizationId: string) {
  const row = maybeOne<AttendanceRow & { sections?: unknown }>(
    (await db
      .from("attendance")
      .select(`${COLS},sections!inner(id,semesters!inner(id,academic_years!inner(organizationId)))`)
      .eq("id", id)
      .eq("sections.semesters.academic_years.organizationId", organizationId)
      .maybeSingle()) as unknown as {
      data: (AttendanceRow & { sections?: unknown }) | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "attendance.findInOrg"
  );
  if (!row) return null;
  const { sections: _embed, ...rest } = row;
  return normaliseDates(rest as AttendanceRow, DATE_FIELDS);
}

/**
 * Updates a record's status and writes the audit log.
 *
 * Prisma ran both in a $transaction. PostgREST has no interactive transaction, so
 * the audit log is written FIRST: if the status update then fails, the trail records
 * an edit that did not land, which is recoverable and visible. The reverse order
 * risks a silent overwrite with no audit entry — the one outcome this endpoint
 * exists to prevent.
 */
export async function updateWithAudit(
  db: SupabaseClient,
  id: string,
  params: { oldStatus: string; newStatus: string; reason: string; changedById: string }
) {
  const auditResult = await db.from("audit_logs").insert({
    id: cuid(),
    attendanceId: id,
    oldStatus: params.oldStatus,
    newStatus: params.newStatus,
    reason: params.reason,
    changedById: params.changedById,
    changedAt: new Date().toISOString(),
  });
  if (auditResult.error) {
    throw new Error(`attendance.updateWithAudit (audit): ${auditResult.error.message}`);
  }

  return normaliseDates(
    one<AttendanceRow>(
      await db
        .from("attendance")
        .update({ status: params.newStatus })
        .eq("id", id)
        .select(COLS)
        .single(),
      "attendance.updateWithAudit (update)"
    ),
    DATE_FIELDS
  );
}

/**
 * Locks attendance for a date+section, optionally one hour, returning how many rows
 * changed.
 *
 * Replaces updateMany, whose `result.count` the route echoes back. PostgREST reports
 * no affected-row count, so the ids are selected first and the update filtered to
 * exactly those — the length is the count, and the update cannot touch rows the
 * select did not see.
 *
 * Paged: a section-date could exceed 1000 rows across many hours once a semester
 * fills up, and a short read here would under-report the lock.
 */
export async function lockRecords(
  db: SupabaseClient,
  sectionId: string,
  date: Date,
  hourNumber?: number
): Promise<number> {
  const ids = await fetchAllPaged<{ id: string }>((from, to) => {
    let q = db
      .from("attendance")
      .select("id")
      .eq("sectionId", sectionId)
      .eq("date", date.toISOString());
    if (hourNumber !== undefined) q = q.eq("hourNumber", hourNumber);
    // Ordered by id so the paged select is totally ordered (see note above).
    return q.order("id", { ascending: true }).range(from, to) as unknown as PromiseLike<{ data: { id: string }[] | null; error: unknown }>;
  }, "attendance.lockRecords (select)");

  if (ids.length === 0) return 0;

  // Chunked: a URL carrying thousands of ids would exceed request-line limits.
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await db
      .from("attendance")
      .update({ isLocked: true })
      .in(
        "id",
        ids.slice(i, i + 200).map((r) => r.id)
      );
    if (error) throw new Error(`attendance.lockRecords: ${error.message}`);
  }
  return ids.length;
}

// ───────────────────────── reads used by other routes ─────────────────────────

/**
 * Attendance rows for one student in a semester.
 *
 * Bounded by one student's records; paged anyway because a full semester of eight
 * hours a day crosses 1000 rows within a single term.
 */
export async function listForStudent(
  db: SupabaseClient,
  studentId: string,
  semesterId: string
) {
  const rows = await fetchAllPaged<AttendanceRow>(
    (from, to) =>
      db
        .from("attendance")
        .select(COLS)
        .eq("studentId", studentId)
        .eq("semesterId", semesterId)
        .order("date", { ascending: true })
        .order("hourNumber", { ascending: true })
        // id last: paging requires a TOTAL order. If rows tie on the sort keys,
        // the engine may place them differently per page request, which can return
        // one row twice and skip another across a page boundary.
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: AttendanceRow[] | null; error: unknown }>,
    "attendance.listForStudent"
  );
  return normaliseDates(rows, DATE_FIELDS);
}

/** One student's records for a single date, with subject names. Bounded by a day. */
export async function listForStudentDate(db: SupabaseClient, studentId: string, date: Date) {
  const rows = many<Record<string, unknown>>(
    (await db
      .from("attendance")
      .select("hourNumber,status,subjects(name)")
      .eq("studentId", studentId)
      .eq("date", date.toISOString())
      .order("hourNumber", { ascending: true })) as unknown as {
      data: Record<string, unknown>[] | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "attendance.listForStudentDate"
  );
  return rows.map((r) => {
    const { subjects, ...rest } = r as { subjects?: unknown } & Record<string, unknown>;
    return { ...rest, subject: subjects };
  });
}

/** Absent records for a date, with student and subject names. Bounded by one date. */
export async function listAbsentOnDate(
  db: SupabaseClient,
  semesterId: string,
  date: Date,
  sectionId?: string
) {
  let q = db
    .from("attendance")
    .select("studentId,hourNumber,students(rollNo,name),subjects(name)")
    .eq("semesterId", semesterId)
    .eq("date", date.toISOString())
    .eq("status", "ABSENT")
    .eq("countsForAttendance", true);
  if (sectionId) q = q.eq("sectionId", sectionId);

  const rows = many<Record<string, unknown>>(
    (await q
      .order("studentId", { ascending: true })
      .order("hourNumber", { ascending: true })) as unknown as {
      data: Record<string, unknown>[] | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "attendance.listAbsentOnDate"
  );
  return rows.map((r) => {
    const { students, subjects, ...rest } = r as {
      students?: unknown;
      subjects?: unknown;
    } & Record<string, unknown>;
    return { ...rest, student: students, subject: subjects };
  });
}

/** Row count for a filter, counted in PostgreSQL. Transfers no rows. */
export async function countWhere(
  db: SupabaseClient,
  filters: { semesterId?: string; sectionId?: string; studentId?: string }
) {
  let q = db.from("attendance").select("*", { count: "exact", head: true });
  if (filters.semesterId) q = q.eq("semesterId", filters.semesterId);
  if (filters.sectionId) q = q.eq("sectionId", filters.sectionId);
  if (filters.studentId) q = q.eq("studentId", filters.studentId);
  return count(await q, "attendance.countWhere");
}

export { fetchAllPaged };
