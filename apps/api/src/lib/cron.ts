import {
  attendancePct,
  safeBunkHours,
  recoveryHours,
  projectedEndPct,
  isPresentStatus,
  detectMidClassBunk,
  COUNTS_FOR_ATTENDANCE,
} from "./calculators";

/** Fixed threshold for the "below 80%" alert — independent of the semester's own
 *  configurable minAttendancePct/CRITICAL cutoff, since 80% was asked for explicitly. */
const LOW_ATTENDANCE_THRESHOLD = 80;

/** Local offset of the campus the cron reports for (IST, +5:30). */
const LOCAL_UTC_OFFSET_MINUTES = 5 * 60 + 30;

/**
 * The academic date the run is reporting on: the local calendar day that has just
 * ended when the job fires.
 *
 * Attendance rows are keyed to UTC midnight of the academic day, so this has to
 * name that day, not the UTC day the Worker happens to wake up on. The cron runs
 * at 20:00 UTC = 01:30 IST, i.e. after the local day has rolled over but before
 * UTC has — so a bare `toISOString()` gives the right answer only because the
 * schedule sits inside that window. Shifting the cron earlier (before 18:30 UTC)
 * or moving to a different timezone would silently break it.
 *
 * Subtracting the local offset before taking the date makes the intent explicit:
 * step back into local wall-clock time, then take that day.
 */
function academicDateKey(now: Date): string {
  return new Date(now.getTime() - LOCAL_UTC_OFFSET_MINUTES * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

/** Attendance columns the job actually reads. Selecting only these instead of whole
 *  rows is most of the D1 saving here — the semester scan is by far the biggest read. */
type ScanRow = { studentId: string; status: string; date: Date; hourNumber: number };

/**
 * Nightly job: recalculates every active student's cached HealthScore, flags
 * mid-class bunk patterns (BunkFlag), and sends two kinds of notification —
 * a below-80%-attendance alert, and an end-of-day summary of that day's bunk
 * flags. Runs across all organizations — this is a single shared Worker cron,
 * not scoped to one tenant.
 *
 * Everything the per-student loop needs is fetched up front, once per semester:
 * the loop itself issues no queries. Previously each student cost four round
 * trips plus one more per detected flag, which grew unboundedly as the semester
 * lengthened.
 */
export async function runNightlyJob(prisma: any) {
  const activeSemesters = await prisma.semester.findMany({ where: { status: "ACTIVE" } });
  const todayKey = academicDateKey(new Date());

  let studentsProcessed = 0;
  let flagsCreated = 0;
  let notificationsCreated = 0;

  for (const semester of activeSemesters) {
    const students = await prisma.student.findMany({
      where: { status: "ACTIVE", section: { semesterId: semester.id } },
      select: { id: true, userId: true, sectionId: true },
    });
    if (students.length === 0) continue;

    const studentIds = students.map((s: any) => s.id);

    // One scan of the semester's attendance, grouped in memory, instead of one
    // query per student. Ordered by student so each student's slice is contiguous
    // and stays in (date, hour) order for bunk detection.
    const allRecords: ScanRow[] = await prisma.attendance.findMany({
      where: { semesterId: semester.id, ...COUNTS_FOR_ATTENDANCE },
      select: { studentId: true, status: true, date: true, hourNumber: true },
      orderBy: [{ studentId: "asc" }, { date: "asc" }, { hourNumber: "asc" }],
    });
    const recordsByStudent = new Map<string, ScanRow[]>();
    for (const r of allRecords) {
      const list = recordsByStudent.get(r.studentId);
      if (list) list.push(r);
      else recordsByStudent.set(r.studentId, [r]);
    }

    // Weekly hours are a property of the section, not the student — several
    // students share one, so this was recomputed identically dozens of times.
    const sectionIds = [...new Set(students.map((s: any) => s.sectionId))];
    const ttCounts = await prisma.timetable.groupBy({
      by: ["sectionId"],
      where: { sectionId: { in: sectionIds } },
      _count: { _all: true },
    });
    const weeklyBySection = new Map<string, number>(
      ttCounts.map((t: any) => [t.sectionId, t._count._all])
    );

    const prevScores = await prisma.healthScore.findMany({
      where: { semesterId: semester.id, studentId: { in: studentIds } },
      select: { studentId: true, riskLevel: true, overallPct: true },
    });
    const prevByStudent = new Map<string, any>(prevScores.map((p: any) => [p.studentId, p]));

    // Existing flags, read once. This replaces a findFirst fired per detected
    // flag per day per student — the worst N+1 in the job.
    const existingFlags = await prisma.bunkFlag.findMany({
      where: { studentId: { in: studentIds } },
      select: { studentId: true, date: true, flagType: true },
    });
    const flagKeys = new Set<string>(
      existingFlags.map(
        (f: any) => `${f.studentId}|${f.date.toISOString().slice(0, 10)}|${f.flagType}`
      )
    );

    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    const weeksRemaining = Math.max(0, Math.ceil((semester.endDate.getTime() - Date.now()) / msPerWeek));
    const minPct = semester.minAttendancePct;

    // Writes accumulate and flush after the loop. Flags and notifications are
    // pure inserts so they batch safely; health scores stay sequential (see below).
    const flagOps: any[] = [];
    const notifOps: any[] = [];
    const scoreUpserts: { studentId: string; data: any }[] = [];

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
        data: {
          overallPct,
          safeBunkHours: safeBunkHours(present, total, minPct),
          recoveryHours: recoveryHours(present, total, minPct),
          lateCount,
          riskLevel,
          projectedEndPct: projectedEndPct(present, total, remainingHours, attendRate),
        },
      });

      if (riskLevel === "CRITICAL" && previous?.riskLevel !== "CRITICAL") {
        notifOps.push(
          prisma.notification.create({
            data: {
              userId: student.userId,
              type: "RISK_ALERT",
              title: "Attendance risk: CRITICAL",
              message: `Your attendance has dropped to ${overallPct.toFixed(1)}%, below the safe threshold of ${minPct}%.`,
            },
          })
        );
        notificationsCreated++;
      }

      // Separate, fixed-threshold alert: only fires the day it first crosses below
      // 80% (not every night while it stays there), so it doesn't spam.
      const wasAbove80 = previous ? previous.overallPct >= LOW_ATTENDANCE_THRESHOLD : true;
      if (overallPct < LOW_ATTENDANCE_THRESHOLD && wasAbove80) {
        notifOps.push(
          prisma.notification.create({
            data: {
              userId: student.userId,
              type: "RISK_ALERT",
              title: "Attendance below 80%",
              message: `Your overall attendance is ${overallPct.toFixed(1)}%, below 80%. Recovery hours needed: ${recoveryHours(present, total, LOW_ATTENDANCE_THRESHOLD)}.`,
            },
          })
        );
        notificationsCreated++;
      }

      // Mid-class bunk detection: scan each day's hourly sequence for this student.
      const byDate = new Map<string, string[]>();
      for (const r of records) {
        const key = r.date.toISOString().slice(0, 10);
        const list = byDate.get(key);
        if (list) list.push(r.status);
        else byDate.set(key, [r.status]);
      }

      // Counts only flags newly raised by this run, not every flag detected on the
      // day. detectMidClassBunk re-derives the same flags from the same rows every
      // night, so counting its raw output would re-notify for already-reported
      // patterns whenever the job runs more than once for a day (retry, redeploy,
      // manual trigger). Incremented inside the dedup check below instead.
      let todaysFlagCount = 0;
      for (const [dateStr, statuses] of byDate) {
        const flags = detectMidClassBunk(statuses as any);

        for (const flag of flags) {
          // Deduped against the pre-loaded set rather than a per-flag query.
          // Added to the set as we go so two flags of the same type on one day
          // can't both queue an insert within this run.
          const key = `${student.id}|${dateStr}|${flag.flagType}`;
          if (flagKeys.has(key)) continue;
          flagKeys.add(key);
          if (dateStr === todayKey) todaysFlagCount++;

          flagOps.push(
            prisma.bunkFlag.create({
              data: {
                studentId: student.id,
                date: new Date(`${dateStr}T00:00:00.000Z`),
                flagType: flag.flagType,
                severity: flag.flagType === "MID_CLASS_BUNK" ? "HIGH" : "MEDIUM",
                pattern: statuses.map((s) => (isPresentStatus(s as any) ? "P" : "A")).join("-"),
              },
            })
          );
          flagsCreated++;
        }
      }

      // Personal end-of-day notice: only the student themself, only when today
      // actually produced a flag for them — no notification on a clean day.
      if (todaysFlagCount > 0) {
        notifOps.push(
          prisma.notification.create({
            data: {
              userId: student.userId,
              type: "BUNK_FLAG",
              title: "Bunk pattern detected today",
              message: `${todaysFlagCount} mid-class bunk pattern${todaysFlagCount === 1 ? "" : "s"} flagged on your attendance today.`,
            },
          })
        );
        notificationsCreated++;
      }

      studentsProcessed++;
    }

    // Upserts stay sequential: D1 batches have a statement limit, and an upsert
    // is two statements. Inserts batch fine.
    for (const s of scoreUpserts) {
      await prisma.healthScore.upsert({
        where: { studentId_semesterId: { studentId: s.studentId, semesterId: semester.id } },
        update: s.data,
        create: { studentId: s.studentId, semesterId: semester.id, ...s.data },
      });
    }
    if (flagOps.length > 0) await prisma.$transaction(flagOps);
    if (notifOps.length > 0) await prisma.$transaction(notifOps);
  }

  return { studentsProcessed, flagsCreated, notificationsCreated };
}
