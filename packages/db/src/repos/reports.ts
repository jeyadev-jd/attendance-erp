// Reports repository — PostgREST equivalents of apps/api/src/routes/reports.ts.
//
// Export is the one endpoint in the application that legitimately needs every
// matching attendance row: it writes them into a CSV/XLSX file, so there is nothing
// to aggregate. That makes it the single largest read in the system and the place
// where PostgREST's 1000-row default would do the most damage — a silently truncated
// export looks like a complete file and is impossible to spot downstream. It is
// therefore paged explicitly.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many, normaliseDates, DATE_FIELDS } from "../supabase";
import { cuid } from "../ids";
import { fetchAllPaged } from "./attendance";

export type ExportRow = {
  date: string;
  hourNumber: number;
  status: string;
  markedAt: string;
  student: { rollNo: string; name: string };
  subject: { name: string };
  section: { name: string };
};

/**
 * Every attendance record matching the export filters, ordered by date then hour.
 *
 * Student, subject and section names arrive as embeds in the same request — one
 * lookup per row would be a three-way N+1 across the whole semester.
 */
export async function exportRows(
  db: SupabaseClient,
  filters: { semesterId: string; sectionId?: string; dateFrom?: string; dateTo?: string }
): Promise<ExportRow[]> {
  const rows = await fetchAllPaged<Record<string, unknown>>((from, to) => {
    let q = db
      .from("attendance")
      .select(
        "date,hourNumber,status,markedAt," +
          "students(rollNo,name),subjects(name),sections(name)"
      )
      .eq("semesterId", filters.semesterId);
    if (filters.sectionId) q = q.eq("sectionId", filters.sectionId);
    // Both bounds UTC midnight, matching the route's existing behaviour.
    if (filters.dateFrom) q = q.gte("date", `${filters.dateFrom}T00:00:00.000Z`);
    if (filters.dateTo) q = q.lte("date", `${filters.dateTo}T00:00:00.000Z`);
    // studentId breaks ties within a (date, hour): several students share the same
    // period, so ordering by date+hour alone leaves their relative order to the
    // engine. Two exports of unchanged data would then differ line-for-line, which
    // looks like a data change to anyone diffing them. The extra key does not alter
    // which rows are returned, only their sequence.
    //
    // It also matters for paging: a query whose sort is not total can return the
    // same row twice, or skip one, across page boundaries.
    return q
      .order("date", { ascending: true })
      .order("hourNumber", { ascending: true })
      .order("studentId", { ascending: true })
      // id last so the order is TOTAL: one student can have two rows in the same
      // period across different subjects, so studentId alone still leaves ties.
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
      data: Record<string, unknown>[] | null;
      error: unknown;
    }>;
  }, "reports.exportRows");

  return normaliseDates(
    rows.map((r) => {
      const { students, subjects, sections, ...rest } = r as {
        students?: unknown;
        subjects?: unknown;
        sections?: unknown;
      } & Record<string, unknown>;
      return { ...rest, student: students, subject: subjects, section: sections };
    }),
    DATE_FIELDS
  ) as ExportRow[];
}

/**
 * Roll number -> student id for one section.
 *
 * Read once per import rather than once per CSV row: a 500-row backfill previously
 * issued 500 identical-shaped lookups. No status filter, matching the original.
 */
export async function rosterByRollNo(db: SupabaseClient, sectionId: string) {
  const rows = many<{ id: string; rollNo: string }>(
    await db.from("students").select("id,rollNo").eq("sectionId", sectionId),
    "reports.rosterByRollNo"
  );
  return new Map(rows.map((s) => [s.rollNo, s.id]));
}

export type ImportRow = {
  date: string;
  hourNumber: number;
  studentId: string;
  subjectId: string;
  status: string;
  countsForAttendance: boolean;
};

/**
 * Writes validated import rows in one batched upsert.
 *
 * Replaces a $transaction of N individual upserts — over HTTP that would be one
 * request per row. Existing ids are looked up first and reused: audit_logs
 * references attendance.id, so letting the upsert mint fresh ids would orphan the
 * audit trail for any record this backfill touches.
 */
export async function upsertImported(
  db: SupabaseClient,
  semesterId: string,
  sectionId: string,
  markedById: string,
  rows: ImportRow[]
): Promise<number> {
  if (rows.length === 0) return 0;

  // One lookup covering every (date, hour, student, subject) key in the batch.
  // Filtered by the batch's own bounds so it stays proportional to the import,
  // not to the semester.
  const dates = [...new Set(rows.map((r) => `${r.date}T00:00:00.000Z`))];
  const hours = [...new Set(rows.map((r) => r.hourNumber))];
  const studentIds = [...new Set(rows.map((r) => r.studentId))];

  const existing = await fetchAllPaged<{
    id: string;
    date: string;
    hourNumber: number;
    studentId: string;
    subjectId: string;
  }>(
    (from, to) =>
      db
        .from("attendance")
        .select("id,date,hourNumber,studentId,subjectId")
        .in("date", dates)
        .in("hourNumber", hours)
        .in("studentId", studentIds)
        // Total order for safe paging.
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: {
          id: string;
          date: string;
          hourNumber: number;
          studentId: string;
          subjectId: string;
        }[] | null;
        error: unknown;
      }>,
    "reports.upsertImported (lookup)"
  );

  // Keyed on the parsed instant: Postgres may echo a timestamptz back in a
  // different textual form than it was sent, so string keys would miss rows.
  const idByKey = new Map(
    existing.map((r) => [
      `${new Date(r.date).getTime()}::${r.hourNumber}::${r.studentId}::${r.subjectId}`,
      r.id,
    ])
  );

  const now = new Date().toISOString();
  const payload = rows.map((r) => {
    const iso = `${r.date}T00:00:00.000Z`;
    const key = `${new Date(iso).getTime()}::${r.hourNumber}::${r.studentId}::${r.subjectId}`;
    return {
      id: idByKey.get(key) ?? cuid(),
      date: iso,
      hourNumber: r.hourNumber,
      semesterId,
      subjectId: r.subjectId,
      sectionId,
      studentId: r.studentId,
      status: r.status,
      countsForAttendance: r.countsForAttendance,
      markedById,
      markedAt: now,
    };
  });

  const { error } = await db
    .from("attendance")
    .upsert(payload, { onConflict: "date,hourNumber,studentId,subjectId" });
  if (error) throw new Error(`reports.upsertImported: ${error.message}`);
  return payload.length;
}
