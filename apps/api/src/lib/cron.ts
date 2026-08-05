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

/**
 * Nightly job: recalculates every active student's cached HealthScore, flags
 * mid-class bunk patterns (BunkFlag), and sends two kinds of notification —
 * a below-80%-attendance alert, and an end-of-day summary of that day's bunk
 * flags. Runs across all organizations — this is a single shared Worker cron,
 * not scoped to one tenant.
 */
export async function runNightlyJob(prisma: any) {
  const activeSemesters = await prisma.semester.findMany({ where: { status: "ACTIVE" } });
  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);

  let studentsProcessed = 0;
  let flagsCreated = 0;
  let notificationsCreated = 0;

  for (const semester of activeSemesters) {
    const students = await prisma.student.findMany({
      where: { status: "ACTIVE", section: { semesterId: semester.id } },
      include: { section: true },
    });

    for (const student of students) {
      const records = await prisma.attendance.findMany({
        where: { studentId: student.id, semesterId: semester.id, ...COUNTS_FOR_ATTENDANCE },
        orderBy: [{ date: "asc" }, { hourNumber: "asc" }],
      });

      const total = records.length;
      const present = records.filter((r: any) => isPresentStatus(r.status)).length;
      const minPct = semester.minAttendancePct;
      const overallPct = attendancePct(present, total);
      const lateCount = records.filter((r: any) => r.status === "LATE").length;

      const weeklyCount = await prisma.timetable.count({ where: { sectionId: student.sectionId } });
      const msPerWeek = 7 * 24 * 60 * 60 * 1000;
      const weeksRemaining = Math.max(0, Math.ceil((semester.endDate.getTime() - Date.now()) / msPerWeek));
      const remainingHours = weeklyCount * weeksRemaining;
      const attendRate = total > 0 ? present / total : 1;

      const riskLevel = overallPct >= minPct ? "SAFE" : overallPct >= minPct - 5 ? "WARNING" : "CRITICAL";

      const previous = await prisma.healthScore.findUnique({
        where: { studentId_semesterId: { studentId: student.id, semesterId: semester.id } },
      });

      await prisma.healthScore.upsert({
        where: { studentId_semesterId: { studentId: student.id, semesterId: semester.id } },
        update: {
          overallPct,
          safeBunkHours: safeBunkHours(present, total, minPct),
          recoveryHours: recoveryHours(present, total, minPct),
          lateCount,
          riskLevel,
          projectedEndPct: projectedEndPct(present, total, remainingHours, attendRate),
        },
        create: {
          studentId: student.id,
          semesterId: semester.id,
          overallPct,
          safeBunkHours: safeBunkHours(present, total, minPct),
          recoveryHours: recoveryHours(present, total, minPct),
          lateCount,
          riskLevel,
          projectedEndPct: projectedEndPct(present, total, remainingHours, attendRate),
        },
      });

      if (riskLevel === "CRITICAL" && previous?.riskLevel !== "CRITICAL") {
        await prisma.notification.create({
          data: {
            userId: student.userId,
            type: "RISK_ALERT",
            title: "Attendance risk: CRITICAL",
            message: `Your attendance has dropped to ${overallPct.toFixed(1)}%, below the safe threshold of ${minPct}%.`,
          },
        });
        notificationsCreated++;
      }

      // Separate, fixed-threshold alert: only fires the day it first crosses below
      // 80% (not every night while it stays there), so it doesn't spam.
      const wasAbove80 = previous ? previous.overallPct >= LOW_ATTENDANCE_THRESHOLD : true;
      if (overallPct < LOW_ATTENDANCE_THRESHOLD && wasAbove80) {
        await prisma.notification.create({
          data: {
            userId: student.userId,
            type: "RISK_ALERT",
            title: "Attendance below 80%",
            message: `Your overall attendance is ${overallPct.toFixed(1)}%, below 80%. Recovery hours needed: ${recoveryHours(present, total, LOW_ATTENDANCE_THRESHOLD)}.`,
          },
        });
        notificationsCreated++;
      }

      // Mid-class bunk detection: scan each day's hourly sequence for this student.
      const byDate = new Map<string, string[]>();
      for (const r of records) {
        const key = r.date.toISOString().slice(0, 10);
        const list = byDate.get(key) ?? [];
        list.push(r.status);
        byDate.set(key, list);
      }

      let todaysFlagCount = 0;
      for (const [dateStr, statuses] of byDate) {
        const flags = detectMidClassBunk(statuses as any);
        if (dateStr === todayKey) todaysFlagCount = flags.length;

        for (const flag of flags) {
          const date = new Date(`${dateStr}T00:00:00.000Z`);
          const existing = await prisma.bunkFlag.findFirst({
            where: { studentId: student.id, date, flagType: flag.flagType },
          });
          if (existing) continue;
          await prisma.bunkFlag.create({
            data: {
              studentId: student.id,
              date,
              flagType: flag.flagType,
              severity: flag.flagType === "MID_CLASS_BUNK" ? "HIGH" : "MEDIUM",
              pattern: statuses.map((s) => (isPresentStatus(s as any) ? "P" : "A")).join("-"),
            },
          });
          flagsCreated++;
        }
      }

      // Personal end-of-day notice: only the student themself, only when today
      // actually produced a flag for them — no notification on a clean day.
      if (todaysFlagCount > 0) {
        await prisma.notification.create({
          data: {
            userId: student.userId,
            type: "BUNK_FLAG",
            title: "Bunk pattern detected today",
            message: `${todaysFlagCount} mid-class bunk pattern${todaysFlagCount === 1 ? "" : "s"} flagged on your attendance today.`,
          },
        });
        notificationsCreated++;
      }

      studentsProcessed++;
    }
  }

  return { studentsProcessed, flagsCreated, notificationsCreated };
}
