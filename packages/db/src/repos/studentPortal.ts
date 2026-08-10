// Student portal repository — PostgREST equivalents of
// apps/api/src/routes/studentPortal.ts.
//
// Every handler here resolves the CALLER'S OWN student profile from the JWT subject.
// No endpoint takes a studentId from the request, so a caller can only ever read
// their own attendance; that property is preserved exactly.
//
// Aggregation split:
//   * dashboard / simulate / subject-planner need counts per subject or per status —
//     done in SQL via student_subject_totals, so 2450 rows never cross the wire.
//   * timeline / analytics are ORDER-DEPENDENT (streaks, day-by-day history) and
//     genuinely need the rows. Those are paged, because a semester of eight hours a
//     day passes PostgREST's 1000-row cap within a single term.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many, maybeOne, count, normaliseDates, DATE_FIELDS } from "../supabase";
import { fetchAllPaged } from "./attendance";

/** The caller's own student profile, with section and semester. */
export async function findOwnStudent(
  db: SupabaseClient,
  userId: string,
  semesterId?: string
) {
  // Scoped by semester when given, else by the org's currently ACTIVE semester —
  // matching the Prisma route's relation filter.
  let q = db
    .from("students")
    .select(
      "id,userId,sectionId,rollNo,name,status," +
        "sections!inner(id,semesterId,departmentId,name," +
        "semesters!inner(id,academicYearId,name,startDate,endDate,minAttendancePct,status))"
    )
    .eq("userId", userId);

  q = semesterId
    ? q.eq("sections.semesterId", semesterId)
    : q.eq("sections.semesters.status", "ACTIVE");

  const row = maybeOne<Record<string, unknown>>(
    (await q.maybeSingle()) as unknown as {
      data: Record<string, unknown> | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "studentPortal.findOwnStudent"
  );
  if (!row) return null;

  // Rename to the relation names the route reads (section / semester).
  const { sections, ...rest } = row as { sections?: Record<string, unknown> } & Record<
    string,
    unknown
  >;
  if (!sections) return null;
  const { semesters, ...sectionRest } = sections as {
    semesters?: unknown;
  } & Record<string, unknown>;

  return normaliseDates(
    { ...rest, section: { ...sectionRest, semester: semesters } },
    DATE_FIELDS
  ) as {
    id: string;
    userId: string;
    sectionId: string;
    rollNo: string;
    name: string;
    section: {
      id: string;
      semesterId: string;
      semester: {
        id: string;
        endDate: string;
        minAttendancePct: number;
        status: string;
      };
    };
  };
}

export type SubjectTotals = {
  subjectId: string;
  present: number;
  total: number;
  lateCount: number;
};

/**
 * Per-subject present/total/late counts for one student.
 *
 * Replaces prisma.attendance.groupBy({ by: ["subjectId", "status"] }). Aggregated in
 * PostgreSQL: the dashboard and planner need counts, never the rows, and fetching
 * the rows would both cross the 1000-row cap and put the fold in the Worker.
 *
 * `countsForAttendance` is read from the attendance row itself, never joined from
 * subjects — a later change to a subject's default must not retroactively rewrite
 * the meaning of already-marked days.
 */
export async function subjectTotals(
  db: SupabaseClient,
  studentId: string,
  semesterId: string,
  subjectId?: string
): Promise<SubjectTotals[]> {
  const rows = many<SubjectTotals>(
    await db.rpc("student_subject_totals", {
      p_student_id: studentId,
      p_semester_id: semesterId,
      p_subject_id: subjectId ?? null,
    }),
    "studentPortal.subjectTotals"
  );
  return rows.map((r) => ({
    subjectId: r.subjectId,
    present: Number(r.present),
    total: Number(r.total),
    lateCount: Number(r.lateCount),
  }));
}

/** Subject names for a set of ids. One small lookup rather than a per-row join. */
export async function subjectNames(db: SupabaseClient, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = many<{ id: string; name: string }>(
    await db.from("subjects").select("id,name").in("id", ids),
    "studentPortal.subjectNames"
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

export type TimelineRow = {
  date: string;
  hourNumber: number;
  status: string;
  countsForAttendance: boolean;
  subject: { name: string };
};

/**
 * A student's marked hours over a date range, ordered.
 *
 * ORDER-DEPENDENT and genuinely row-level: the timeline is a history view listing
 * every marked hour. Paged rather than aggregated, and paged rather than a bare
 * select, because one student's semester exceeds 1000 rows.
 */
export async function timeline(
  db: SupabaseClient,
  studentId: string,
  semesterId: string,
  range: { from?: string; to?: string }
): Promise<TimelineRow[]> {
  const rows = await fetchAllPaged<Record<string, unknown>>((from, to) => {
    let q = db
      .from("attendance")
      .select("date,hourNumber,status,countsForAttendance,subjects(name)")
      .eq("studentId", studentId)
      .eq("semesterId", semesterId);
    // Both bounds UTC midnight, matching the route's existing behaviour.
    if (range.from) q = q.gte("date", `${range.from}T00:00:00.000Z`);
    if (range.to) q = q.lte("date", `${range.to}T00:00:00.000Z`);
    // id last: paging requires a TOTAL order. Rows tying on (date, hour) — several
    // subjects can share a period — may otherwise be placed differently per page
    // request, returning one row twice and skipping another across a boundary.
    return q
      .order("date", { ascending: true })
      .order("hourNumber", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
      data: Record<string, unknown>[] | null;
      error: unknown;
    }>;
  }, "studentPortal.timeline");

  return normaliseDates(
    rows.map((r) => {
      const { subjects, ...rest } = r as { subjects?: unknown } & Record<string, unknown>;
      return { ...rest, subject: subjects };
    }),
    DATE_FIELDS
  ) as TimelineRow[];
}

export type AnalyticsRow = { date: string; hourNumber: number; status: string };

/**
 * A student's counting records, ordered by date then hour.
 *
 * ORDER-DEPENDENT: streaks are computed by walking this sequence, so the rows
 * themselves are needed and the ordering is load-bearing. Only three columns are
 * selected, and the result is paged.
 */
export async function analyticsRecords(
  db: SupabaseClient,
  studentId: string,
  semesterId: string
): Promise<AnalyticsRow[]> {
  const rows = await fetchAllPaged<AnalyticsRow>(
    (from, to) =>
      db
        .from("attendance")
        .select("date,hourNumber,status")
        .eq("studentId", studentId)
        .eq("semesterId", semesterId)
        .eq("countsForAttendance", true)
        .order("date", { ascending: true })
        .order("hourNumber", { ascending: true })
        // Total order for safe paging — streaks walk this sequence, so a duplicated
        // or skipped row at a page boundary would corrupt the streak count.
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: AnalyticsRow[] | null;
        error: unknown;
      }>,
    "studentPortal.analyticsRecords"
  );
  return normaliseDates(rows, DATE_FIELDS);
}

/** One student's records for a single date, with subject names. Bounded by a day. */
export async function todayRecords(db: SupabaseClient, studentId: string, date: Date) {
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
    "studentPortal.todayRecords"
  );
  return rows.map((r) => {
    const { subjects, ...rest } = r as { subjects?: unknown } & Record<string, unknown>;
    return { ...rest, subject: subjects };
  });
}

/** Weekly timetable hour count for a section. Feeds the remaining-hours estimate. */
export async function weeklyHourCount(db: SupabaseClient, sectionId: string) {
  return count(
    await db
      .from("timetables")
      .select("*", { count: "exact", head: true })
      .eq("sectionId", sectionId),
    "studentPortal.weeklyHourCount"
  );
}

/** Timetable slots for the planner, with each subject's display fields. */
export async function plannerSlots(db: SupabaseClient, sectionId: string) {
  const rows = many<Record<string, unknown>>(
    (await db
      .from("timetables")
      .select("subjectId,dayOfWeek,durationHours,subjects(id,code,name,countsForAttendance)")
      .eq("sectionId", sectionId)) as unknown as {
      data: Record<string, unknown>[] | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "studentPortal.plannerSlots"
  );
  return rows.map((r) => {
    const { subjects, ...rest } = r as { subjects?: unknown } & Record<string, unknown>;
    return { ...rest, subject: subjects };
  }) as {
    subjectId: string;
    dayOfWeek: number;
    durationHours: number;
    subject: { id: string; code: string; name: string; countsForAttendance: boolean };
  }[];
}

/** Dates in a semester that are NOT working days — skipped when projecting forward. */
export async function nonWorkingDates(db: SupabaseClient, semesterId: string) {
  const rows = many<{ date: string }>(
    await db
      .from("calendar_days")
      .select("date")
      .eq("semesterId", semesterId)
      .neq("dayType", "WORKING"),
    "studentPortal.nonWorkingDates"
  );
  return new Set(rows.map((r) => new Date(r.date).toISOString().slice(0, 10)));
}
