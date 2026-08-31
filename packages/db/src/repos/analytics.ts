// Analytics repository — thin wrappers over the RPC functions in
// backups/phase3-rpc-functions.sql.
//
// Every function here is one HTTP request returning a UI-sized result. No loops, no
// folds, no joins in JavaScript: the aggregation is done by PostgreSQL. The route
// layer's job is to authenticate, authorize, validate, call one of these, and return.
//
// The pure calculators in apps/api/src/lib/calculators.ts stay untouched and still
// own the formulas that operate on already-aggregated numbers (safeBunkHours,
// recoveryHours, projectedEndPct, bunkSimulator). Only the GROUP BY moved.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many, maybeOne } from "../supabase";

export type DateRange = { dateFrom?: string; dateTo?: string };

/**
 * Converts the API's YYYY-MM-DD range to the timestamptz bounds the RPCs expect.
 *
 * Both bounds are UTC midnight, matching schemas/analytics.dateFilter exactly —
 * including `dateTo` being midnight rather than end-of-day. That makes the upper
 * bound effectively exclusive of everything after 00:00:00 on the final day, which
 * is only harmless because attendance dates are stored at UTC midnight. It looks
 * like an off-by-one and is not: it reproduces the existing D1 behaviour, and
 * changing it here would silently alter which rows every analytics endpoint counts.
 */
function rangeArgs(range: DateRange) {
  return {
    p_date_from: range.dateFrom ? `${range.dateFrom}T00:00:00.000Z` : null,
    p_date_to: range.dateTo ? `${range.dateTo}T00:00:00.000Z` : null,
  };
}

export type HeatmapCell = {
  dayOfWeek: number;
  hourNumber: number;
  pct: number;
  total: number;
};

/** Day x hour attendance grid. <= 49 rows. Replaces analytics.ts:38. */
export async function heatmap(
  db: SupabaseClient,
  semesterId: string,
  organizationId: string,
  range: DateRange
): Promise<HeatmapCell[]> {
  return many<HeatmapCell>(
    await db.rpc("analytics_heatmap", {
      p_semester_id: semesterId,
      p_organization_id: organizationId,
      ...rangeArgs(range),
    }),
    "analytics.heatmap"
  );
}

export type SubjectComparisonRow = {
  subjectId: string;
  name: string;
  pct: number;
  total: number;
};

/** Attendance % per subject, worst first. Replaces analytics.ts:76 + name lookup. */
export async function subjectComparison(
  db: SupabaseClient,
  semesterId: string,
  organizationId: string,
  range: DateRange
): Promise<SubjectComparisonRow[]> {
  return many<SubjectComparisonRow>(
    await db.rpc("analytics_subject_comparison", {
      p_semester_id: semesterId,
      p_organization_id: organizationId,
      ...rangeArgs(range),
    }),
    "analytics.subjectComparison"
  );
}

export type BunkLeaderboardRow = {
  studentId: string;
  rollNo: string;
  name: string;
  bunkFlagCount: number;
  singleHourSkips: number;
  midClassBunks: number;
};

/** Top bunkers. Ranked and limited in SQL. Replaces analytics.ts:125 + lookup. */
export async function bunkLeaderboard(
  db: SupabaseClient,
  semesterId: string,
  organizationId: string,
  limit: number,
  range: DateRange
): Promise<BunkLeaderboardRow[]> {
  return many<BunkLeaderboardRow>(
    await db.rpc("analytics_bunk_leaderboard", {
      p_semester_id: semesterId,
      p_organization_id: organizationId,
      p_limit: limit,
      ...rangeArgs(range),
    }),
    "analytics.bunkLeaderboard"
  );
}

export type LateAnalytics = {
  totalLateMarks: number;
  mostLateStudents: { rollNo: string; name: string; count: number }[];
  mostLateDayOfWeek: number | null;
  mostLateHour: number | null;
};

/** Late summary. Returns one JSON object. Replaces analytics.ts:233-234 + lookup. */
export async function lateAnalytics(
  db: SupabaseClient,
  semesterId: string,
  organizationId: string,
  range: DateRange
): Promise<LateAnalytics> {
  const result = maybeOne<LateAnalytics>(
    await db.rpc("analytics_late", {
      p_semester_id: semesterId,
      p_organization_id: organizationId,
      ...rangeArgs(range),
    }),
    "analytics.late"
  );
  return (
    result ?? {
      totalLateMarks: 0,
      mostLateStudents: [],
      mostLateDayOfWeek: null,
      mostLateHour: null,
    }
  );
}

export type SubjectReportRow = {
  subjectId: string;
  code: string;
  name: string;
  faculty: string;
  countsForAttendance: boolean;
  weeklyHours: number;
  scheduledHours: number;
  markedHours: number;
  coveragePct: number;
  attendancePct: number;
  studentCount: number;
  corrections: number;
};

/** Per-subject coverage report. Replaces analytics.ts:340 + :357 + corrected lookup. */
export async function subjectReport(
  db: SupabaseClient,
  semesterId: string,
  organizationId: string,
  range: DateRange
): Promise<SubjectReportRow[]> {
  return many<SubjectReportRow>(
    await db.rpc("analytics_subject_report", {
      p_semester_id: semesterId,
      p_organization_id: organizationId,
      ...rangeArgs(range),
    }),
    "analytics.subjectReport"
  );
}

export type BatchSubjectRow = {
  studentId: string;
  rollNo: string;
  studentName: string;
  subjectId: string;
  subjectCode: string;
  subjectName: string;
  present: number;
  total: number;
  pct: number;
};

/**
 * Every active student in a section, broken down per subject.
 *
 * Returns long rows — one per (student, subject) — which the UI pivots into a grid.
 * Pivoting in SQL would need a fixed column list or dynamic SQL, since the subject
 * set varies per section; emitting long rows keeps the function simple and the
 * payload small (roughly students x subjects short rows).
 *
 * Aggregated in PostgreSQL rather than the Worker: a section's semester runs to
 * thousands of attendance rows, past PostgREST's 1000-row default.
 */
export async function batchBySubject(
  db: SupabaseClient,
  sectionId: string,
  organizationId: string,
  range: DateRange
): Promise<BatchSubjectRow[]> {
  const rows = many<BatchSubjectRow>(
    await db.rpc("batch_attendance_by_subject", {
      p_section_id: sectionId,
      p_organization_id: organizationId,
      ...rangeArgs(range),
    }),
    "analytics.batchBySubject"
  );
  return rows.map((r) => ({
    studentId: r.studentId,
    rollNo: r.rollNo,
    studentName: r.studentName,
    subjectId: r.subjectId,
    subjectCode: r.subjectCode,
    subjectName: r.subjectName,
    present: Number(r.present),
    total: Number(r.total),
    pct: Number(r.pct),
  }));
}
