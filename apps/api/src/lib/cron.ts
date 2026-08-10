// Nightly job, running against Supabase over HTTPS.
//
// Supabase counterpart of lib/cron.ts. Every rule, threshold, dedup check and
// notification message is carried over unchanged; only the data access moved.
//
// The job's structure is deliberately preserved: everything the per-student loop
// needs is fetched up front, once per semester, and the loop issues no queries. That
// mattered under D1 and matters more here, where each query is a network round trip.
// The writes now batch — Prisma's sequential health-score upserts become one request.
import {
  attendancePct,
  safeBunkHours,
  recoveryHours,
  projectedEndPct,
  isPresentStatus,
  detectMidClassBunk,
} from "./calculators";
import * as repo from "@attendance/db/repos/cron";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Fixed threshold for the "below 80%" alert — independent of the semester's own
 *  configurable minAttendancePct/CRITICAL cutoff, since 80% was asked for explicitly. */
const LOW_ATTENDANCE_THRESHOLD = 80;

/** Local offset of the campus the cron reports for (IST, +5:30). */
const LOCAL_UTC_OFFSET_MINUTES = 5 * 60 + 30;

/**
 * The academic date the run is reporting on: the local calendar day that has just
 * ended when the job fires.
 *
 * Attendance rows are keyed to UTC midnight of the academic day, so this has to name
 * that day, not the UTC day the Worker happens to wake up on.
 */
function academicDateKey(now: Date): string {
  return new Date(now.getTime() - LOCAL_UTC_OFFSET_MINUTES * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Nightly job: recalculates every active student's cached HealthScore, flags
 * mid-class bunk patterns (BunkFlag), and sends two kinds of notification —
 * a below-80%-attendance alert, and an end-of-day summary of that day's bunk
 * flags. Runs across all organizations — this is a single shared Worker cron,
 * not scoped to one tenant.
 */
export async function runNightlyJob(db: SupabaseClient) {
  const activeSemesters = await repo.activeSemesters(db);
  const todayKey = academicDateKey(new Date());

  let studentsProcessed = 0;
  let flagsCreated = 0;
  let notificationsCreated = 0;

  for (const semester of activeSemesters) {
    const students = await repo.activeStudents(db, semester.id);
    if (students.length === 0) continue;

    const studentIds = students.map((s) => s.id);
    const sectionIds = [...new Set(students.map((s) => s.sectionId))];

    // Four independent up-front reads; run together rather than serially.
    //
    // The semester scan is paged inside the repository: a silent 1000-row cut would
    // understate every percentage and suppress the alerts this job exists to send.
    const [allRecords, weeklyBySection, prevByStudent, flagKeys] = await Promise.all([
      repo.semesterScan(db, semester.id),
      repo.weeklyHoursBySection(db, sectionIds),
      repo.previousScores(db, semester.id, studentIds),
      repo.existingFlagKeys(db, studentIds),
    ]);

    // Ordered by student, so each student's slice is contiguous and stays in
    // (date, hour) order for bunk detection.
    const recordsByStudent = new Map<string, repo.ScanRow[]>();
    for (const r of allRecords) {
      const list = recordsByStudent.get(r.studentId);
      if (list) list.push(r);
      else recordsByStudent.set(r.studentId, [r]);
    }

    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    const weeksRemaining = Math.max(
      0,
      Math.ceil((new Date(semester.endDate).getTime() - Date.now()) / msPerWeek)
    );
    const minPct = semester.minAttendancePct;

    // Writes accumulate and flush after the loop, as batched requests.
    const newFlags: {
      studentId: string;
      date: string;
      flagType: string;
      severity: string;
      pattern: string;
    }[] = [];
    const newNotifications: {
      userId: string;
      type: string;
      title: string;
      message: string;
    }[] = [];
    const scoreUpserts: repo.HealthScoreInput[] = [];

    for (const student of students) {
      const records = recordsByStudent.get(student.id) ?? [];

      const total = records.length;
      let present = 0;
      let lateCount = 0;
      for (const r of records) {
        if (isPresentStatus(r.status)) present++;
        if (r.status === "LATE") lateCount++;
      }
      const overallPct = attendancePct(present, total);

      const weeklyCount = weeklyBySection.get(student.sectionId) ?? 0;
      const remainingHours = weeklyCount * weeksRemaining;
      const attendRate = total > 0 ? present / total : 1;

      const riskLevel = overallPct >= minPct ? "SAFE" : overallPct >= minPct - 5 ? "WARNING" : "CRITICAL";

      const previous = prevByStudent.get(student.id);

      scoreUpserts.push({
        studentId: student.id,
        overallPct,
        safeBunkHours: safeBunkHours(present, total, minPct),
        recoveryHours: recoveryHours(present, total, minPct),
        lateCount,
        riskLevel,
        projectedEndPct: projectedEndPct(present, total, remainingHours, attendRate),
      });

      if (riskLevel === "CRITICAL" && previous?.riskLevel !== "CRITICAL") {
        newNotifications.push({
          userId: student.userId,
          type: "RISK_ALERT",
          title: "Attendance risk: CRITICAL",
          message: `Your attendance has dropped to ${overallPct.toFixed(1)}%, below the safe threshold of ${minPct}%.`,
        });
        notificationsCreated++;
      }

      // Separate, fixed-threshold alert: only fires the day it first crosses below
      // 80% (not every night while it stays there), so it doesn't spam.
      const wasAbove80 = previous ? previous.overallPct >= LOW_ATTENDANCE_THRESHOLD : true;
      if (overallPct < LOW_ATTENDANCE_THRESHOLD && wasAbove80) {
        newNotifications.push({
          userId: student.userId,
          type: "RISK_ALERT",
          title: "Attendance below 80%",
          message: `Your overall attendance is ${overallPct.toFixed(1)}%, below 80%. Recovery hours needed: ${recoveryHours(present, total, LOW_ATTENDANCE_THRESHOLD)}.`,
        });
        notificationsCreated++;
      }

      // Mid-class bunk detection: scan each day's hourly sequence for this student.
      const byDate = new Map<string, string[]>();
      for (const r of records) {
        const key = new Date(r.date).toISOString().slice(0, 10);
        const list = byDate.get(key);
        if (list) list.push(r.status);
        else byDate.set(key, [r.status]);
      }

      // Counts only flags newly raised by this run, not every flag detected on the
      // day — detectMidClassBunk re-derives the same flags from the same rows every
      // night, so counting its raw output would re-notify for already-reported
      // patterns whenever the job runs more than once for a day.
      let todaysFlagCount = 0;
      for (const [dateStr, statuses] of byDate) {
        const flags = detectMidClassBunk(statuses as any);

        for (const flag of flags) {
          // Deduped against the pre-loaded set rather than a per-flag query. Added
          // to the set as we go so two flags of the same type on one day can't both
          // queue an insert within this run.
          const key = `${student.id}|${dateStr}|${flag.flagType}`;
          if (flagKeys.has(key)) continue;
          flagKeys.add(key);
          if (dateStr === todayKey) todaysFlagCount++;

          newFlags.push({
            studentId: student.id,
            date: dateStr,
            flagType: flag.flagType,
            severity: flag.flagType === "MID_CLASS_BUNK" ? "HIGH" : "MEDIUM",
            pattern: statuses.map((s) => (isPresentStatus(s as any) ? "P" : "A")).join("-"),
          });
          flagsCreated++;
        }
      }

      // Personal end-of-day notice: only the student themself, only when today
      // actually produced a flag for them — no notification on a clean day.
      if (todaysFlagCount > 0) {
        newNotifications.push({
          userId: student.userId,
          type: "BUNK_FLAG",
          title: "Bunk pattern detected today",
          message: `${todaysFlagCount} mid-class bunk pattern${todaysFlagCount === 1 ? "" : "s"} flagged on your attendance today.`,
        });
        notificationsCreated++;
      }

      studentsProcessed++;
    }

    // Three batched writes per semester, regardless of student count. The D1 version
    // upserted health scores one at a time because a batch had a statement limit;
    // PostgREST takes the whole array in one request.
    await repo.upsertHealthScores(db, semester.id, scoreUpserts);
    await repo.insertFlags(db, newFlags);
    await repo.insertNotifications(db, newNotifications);
  }

  return { studentsProcessed, flagsCreated, notificationsCreated };
}
