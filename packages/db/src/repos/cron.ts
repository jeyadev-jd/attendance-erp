// Nightly-job repository — PostgREST equivalents of the reads and writes in
// apps/api/src/lib/cron.ts.
//
// The job's shape is deliberately preserved: everything the per-student loop needs is
// fetched up front, once per semester, and the loop itself issues no queries. That
// property was the point of the last D1 optimisation and it matters more here, since
// every query is now a network round trip.
//
// The semester attendance scan is the largest read in the application — 2450 rows
// today, growing every marked hour — so it is paged. A silent truncation here would
// understate every student's percentage and suppress the alerts the job exists to
// send, with nothing in the output to indicate it happened.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many, normaliseDates, DATE_FIELDS } from "../supabase";
import { cuid } from "../ids";
import { fetchAllPaged } from "./attendance";

export type ScanRow = {
  studentId: string;
  status: string;
  date: string;
  hourNumber: number;
};

/** Semesters currently ACTIVE, across all organizations — this is a shared cron. */
export async function activeSemesters(db: SupabaseClient) {
  return normaliseDates(
    many<{ id: string; endDate: string; minAttendancePct: number }>(
      await db.from("semesters").select("id,endDate,minAttendancePct").eq("status", "ACTIVE"),
      "cron.activeSemesters"
    ),
    DATE_FIELDS
  );
}

/** Active students in a semester, with the fields the loop needs. */
export async function activeStudents(db: SupabaseClient, semesterId: string) {
  const rows = many<{ id: string; userId: string; sectionId: string }>(
    (await db
      .from("students")
      .select("id,userId,sectionId,sections!inner(semesterId)")
      .eq("status", "ACTIVE")
      .eq("sections.semesterId", semesterId)) as unknown as {
      data: { id: string; userId: string; sectionId: string }[] | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "cron.activeStudents"
  );
  return rows.map((r) => ({ id: r.id, userId: r.userId, sectionId: r.sectionId }));
}

/**
 * One scan of the semester's counting attendance, ordered so each student's slice is
 * contiguous and stays in (date, hour) order — bunk detection walks that sequence, so
 * the ordering is load-bearing, not cosmetic.
 *
 * Only the four columns the job reads are selected; paged so the scan cannot be
 * silently cut at 1000 rows.
 */
export async function semesterScan(db: SupabaseClient, semesterId: string): Promise<ScanRow[]> {
  const rows = await fetchAllPaged<ScanRow>(
    (from, to) =>
      db
        .from("attendance")
        .select("studentId,status,date,hourNumber")
        .eq("semesterId", semesterId)
        .eq("countsForAttendance", true)
        .order("studentId", { ascending: true })
        .order("date", { ascending: true })
        .order("hourNumber", { ascending: true })
        // id last: paging requires a TOTAL order. If rows tie on the sort keys,
        // the engine may place them differently per page request, which can return
        // one row twice and skip another across a page boundary.
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: ScanRow[] | null;
        error: unknown;
      }>,
    "cron.semesterScan"
  );
  return normaliseDates(rows, DATE_FIELDS);
}

/**
 * Weekly timetable hour count per section.
 *
 * Weekly hours are a property of the section, not the student — several students
 * share one — so this is counted once per section rather than recomputed per student.
 * Aggregated in SQL via RPC; the alternative would be fetching every timetable row
 * to count them in the Worker.
 */
export async function weeklyHoursBySection(db: SupabaseClient, sectionIds: string[]) {
  if (sectionIds.length === 0) return new Map<string, number>();
  const rows = many<{ sectionId: string; weeklyHours: number }>(
    await db.rpc("timetable_counts_by_section", { p_section_ids: sectionIds }),
    "cron.weeklyHoursBySection"
  );
  return new Map(rows.map((r) => [r.sectionId, Number(r.weeklyHours)]));
}

/** Previous health scores, for the risk-transition checks. */
export async function previousScores(
  db: SupabaseClient,
  semesterId: string,
  studentIds: string[]
) {
  if (studentIds.length === 0) return new Map<string, { riskLevel: string; overallPct: number }>();
  const rows = many<{ studentId: string; riskLevel: string; overallPct: number }>(
    await db
      .from("health_scores")
      .select("studentId,riskLevel,overallPct")
      .eq("semesterId", semesterId)
      .in("studentId", studentIds),
    "cron.previousScores"
  );
  return new Map(rows.map((r) => [r.studentId, { riskLevel: r.riskLevel, overallPct: r.overallPct }]));
}

/**
 * Existing bunk flags, read once.
 *
 * Replaces a findFirst fired per detected flag per day per student — the worst N+1 in
 * the job. Paged: flags accumulate across a semester.
 */
export async function existingFlagKeys(db: SupabaseClient, studentIds: string[]) {
  if (studentIds.length === 0) return new Set<string>();
  const rows = await fetchAllPaged<{ studentId: string; date: string; flagType: string }>(
    (from, to) =>
      db
        .from("bunk_flags")
        .select("studentId,date,flagType")
        .in("studentId", studentIds)
        // Total order for safe paging (see cron.semesterScan).
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: { studentId: string; date: string; flagType: string }[] | null;
        error: unknown;
      }>,
    "cron.existingFlagKeys"
  );
  return new Set(
    rows.map((f) => `${f.studentId}|${new Date(f.date).toISOString().slice(0, 10)}|${f.flagType}`)
  );
}

/** Inserts new bunk flags in one batched request. Pure inserts, so they batch safely. */
export async function insertFlags(
  db: SupabaseClient,
  flags: { studentId: string; date: string; flagType: string; severity: string; pattern: string }[]
) {
  if (flags.length === 0) return 0;
  const now = new Date().toISOString();
  const { error } = await db.from("bunk_flags").insert(
    flags.map((f) => ({
      id: cuid(),
      studentId: f.studentId,
      date: `${f.date}T00:00:00.000Z`,
      flagType: f.flagType,
      severity: f.severity,
      pattern: f.pattern,
      createdAt: now,
    }))
  );
  if (error) throw new Error(`cron.insertFlags: ${error.message}`);
  return flags.length;
}

/** Inserts notifications in one batched request. */
export async function insertNotifications(
  db: SupabaseClient,
  notifications: { userId: string; type: string; title: string; message: string }[]
) {
  if (notifications.length === 0) return 0;
  const now = new Date().toISOString();
  const { error } = await db.from("notifications").insert(
    notifications.map((n) => ({
      id: cuid(),
      userId: n.userId,
      type: n.type,
      title: n.title,
      message: n.message,
      isRead: false,
      createdAt: now,
    }))
  );
  if (error) throw new Error(`cron.insertNotifications: ${error.message}`);
  return notifications.length;
}

export type HealthScoreInput = {
  studentId: string;
  overallPct: number;
  safeBunkHours: number;
  recoveryHours: number;
  lateCount: number;
  riskLevel: string;
  projectedEndPct: number;
};

/**
 * Upserts every student's cached health score in one batched request.
 *
 * The D1 version ran these sequentially because a batch had a statement limit and an
 * upsert is two statements; PostgREST takes the whole array in one request, so the
 * per-student round trip disappears.
 *
 * Existing ids are looked up and reused — an upsert overwrites every column it is
 * given, including the primary key, so a fresh cuid would rewrite each row's id every
 * night.
 */
export async function upsertHealthScores(
  db: SupabaseClient,
  semesterId: string,
  scores: HealthScoreInput[]
): Promise<number> {
  if (scores.length === 0) return 0;

  const existing = many<{ id: string; studentId: string }>(
    await db
      .from("health_scores")
      .select("id,studentId")
      .eq("semesterId", semesterId)
      .in(
        "studentId",
        scores.map((s) => s.studentId)
      ),
    "cron.upsertHealthScores (lookup)"
  );
  const idByStudent = new Map(existing.map((r) => [r.studentId, r.id]));

  const now = new Date().toISOString();
  const { error } = await db.from("health_scores").upsert(
    scores.map((s) => ({
      id: idByStudent.get(s.studentId) ?? cuid(),
      studentId: s.studentId,
      semesterId,
      overallPct: s.overallPct,
      safeBunkHours: s.safeBunkHours,
      recoveryHours: s.recoveryHours,
      lateCount: s.lateCount,
      riskLevel: s.riskLevel,
      projectedEndPct: s.projectedEndPct,
      updatedAt: now,
    })),
    { onConflict: "studentId,semesterId" }
  );
  if (error) throw new Error(`cron.upsertHealthScores: ${error.message}`);
  return scores.length;
}
