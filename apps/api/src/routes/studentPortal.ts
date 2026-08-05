import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import {
  isPresentStatus,
  attendancePct,
  safeBunkHours,
  recoveryHours,
  bunkSimulator,
  projectedEndPct,
  COUNTS_FOR_ATTENDANCE,
} from "../lib/calculators";
import {
  semesterQuerySchema,
  timelineQuerySchema,
  simulateSchema,
  subjectPlannerQuerySchema,
} from "../schemas/studentPortal";

const studentPortal = new Hono<AppEnv>();
// Open to every role, not just STUDENT: class admins are students in their own batch and
// need to see their own attendance. Every handler resolves the caller's own Student profile
// via getOwnStudent(user.sub), so this exposes nobody else's data; a caller without a
// Student profile (e.g. pure staff) simply gets a 404.
studentPortal.use("*", roleGuard("SUPER_ADMIN", "ADMIN", "CLASS_ADMIN", "FACULTY", "STUDENT"));

/** Resolves the caller's own Student profile — for the requested semester, or their currently ACTIVE one. */
async function getOwnStudent(prisma: any, userId: string, semesterId?: string) {
  const student = await prisma.student.findFirst({
    where: {
      userId,
      section: semesterId ? { semesterId } : { semester: { status: "ACTIVE" } },
    },
    include: { section: { include: { semester: true } } },
  });
  if (!student) throw new HTTPException(404, { message: "No student record found for this semester" });
  return student;
}

/** Estimated remaining teaching hours: (weekly timetable hours for the section) × remaining whole weeks. */
async function estimateRemainingHours(prisma: any, sectionId: string, semesterEndDate: Date) {
  const weeklyCount = await prisma.timetable.count({ where: { sectionId } });
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const weeksRemaining = Math.max(0, Math.ceil((semesterEndDate.getTime() - Date.now()) / msPerWeek));
  return weeklyCount * weeksRemaining;
}

studentPortal.get("/dashboard", async (c) => {
  const query = semesterQuerySchema.parse({ semesterId: c.req.query("semesterId") });
  const prisma = c.get("prisma");
  const user = c.get("user");

  const student = await getOwnStudent(prisma, user.sub, query.semesterId);
  const semester = student.section.semester;
  const minPct = semester.minAttendancePct;

  const records = await prisma.attendance.findMany({
    where: { studentId: student.id, semesterId: semester.id, ...COUNTS_FOR_ATTENDANCE },
    include: { subject: true },
  });

  const total = records.length;
  const present = records.filter((r: any) => isPresentStatus(r.status)).length;
  const overallPct = attendancePct(present, total);
  const lateCount = records.filter((r: any) => r.status === "LATE").length;

  const remainingHours = await estimateRemainingHours(prisma, student.sectionId, semester.endDate);
  const attendRate = total > 0 ? present / total : 1;

  const riskLevel = overallPct >= minPct ? "SAFE" : overallPct >= minPct - 5 ? "WARNING" : "CRITICAL";

  const subjectMap = new Map<string, { name: string; present: number; total: number }>();
  for (const r of records) {
    const entry = subjectMap.get(r.subjectId) ?? { name: r.subject.name, present: 0, total: 0 };
    entry.total += 1;
    if (isPresentStatus(r.status)) entry.present += 1;
    subjectMap.set(r.subjectId, entry);
  }
  const subjectWise = [...subjectMap.entries()].map(([subjectId, v]) => ({
    subjectId,
    name: v.name,
    pct: attendancePct(v.present, v.total),
    present: v.present,
    total: v.total,
  }));

  const todayStr = new Date().toISOString().slice(0, 10);
  const today = await prisma.attendance.findMany({
    where: { studentId: student.id, date: new Date(`${todayStr}T00:00:00.000Z`) },
    include: { subject: true },
    orderBy: { hourNumber: "asc" },
  });

  return c.json({
    overallPct,
    riskLevel,
    safeBunkHours: safeBunkHours(present, total, minPct),
    recoveryHours: recoveryHours(present, total, minPct),
    lateCount,
    projectedEndPct: projectedEndPct(present, total, remainingHours, attendRate),
    subjectWise,
    todayTimeline: today.map((r: any) => ({
      hourNumber: r.hourNumber,
      subject: r.subject.name,
      status: r.status,
    })),
  });
});

studentPortal.get("/timeline", async (c) => {
  const query = timelineQuerySchema.parse({
    semesterId: c.req.query("semesterId"),
    from: c.req.query("from"),
    to: c.req.query("to"),
  });
  const prisma = c.get("prisma");
  const user = c.get("user");

  const student = await getOwnStudent(prisma, user.sub, query.semesterId);

  const records = await prisma.attendance.findMany({
    where: {
      studentId: student.id,
      semesterId: student.section.semesterId,
      ...(query.from || query.to
        ? {
            date: {
              ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
              ...(query.to ? { lte: new Date(`${query.to}T00:00:00.000Z`) } : {}),
            },
          }
        : {}),
    },
    include: { subject: true },
    orderBy: [{ date: "asc" }, { hourNumber: "asc" }],
  });

  // The timeline is a history view, so it lists every marked hour — including
  // non-counting slots like mentor-mentee — but dayPct only counts the ones that
  // actually affect the percentage.
  const byDate = new Map<string, any[]>();
  for (const r of records) {
    const key = r.date.toISOString().slice(0, 10);
    const list = byDate.get(key) ?? [];
    list.push({
      hourNumber: r.hourNumber,
      subject: r.subject.name,
      status: r.status,
      countsForAttendance: r.countsForAttendance,
    });
    byDate.set(key, list);
  }

  return c.json(
    [...byDate.entries()].map(([date, hours]) => {
      const counted = hours.filter((h) => h.countsForAttendance);
      return {
        date,
        hours,
        dayPct: attendancePct(counted.filter((h) => isPresentStatus(h.status)).length, counted.length),
      };
    })
  );
});

studentPortal.get("/analytics", async (c) => {
  const query = semesterQuerySchema.parse({ semesterId: c.req.query("semesterId") });
  const prisma = c.get("prisma");
  const user = c.get("user");

  const student = await getOwnStudent(prisma, user.sub, query.semesterId);

  const records = await prisma.attendance.findMany({
    where: { studentId: student.id, semesterId: student.section.semesterId, ...COUNTS_FOR_ATTENDANCE },
    orderBy: [{ date: "asc" }, { hourNumber: "asc" }],
  });

  // Day-of-week pattern
  const dayBuckets = new Map<number, { present: number; total: number }>();
  // Hour-of-day pattern
  const hourBuckets = new Map<number, { present: number; total: number }>();
  // Weekly trend
  const weekBuckets = new Map<string, { present: number; total: number }>();

  let currentStreak = 0;
  let longestStreak = 0;
  let lateByDay = new Map<number, number>();

  for (const r of records) {
    const dow = r.date.getUTCDay();
    const day = dayBuckets.get(dow) ?? { present: 0, total: 0 };
    day.total += 1;
    if (isPresentStatus(r.status)) day.present += 1;
    dayBuckets.set(dow, day);

    const hour = hourBuckets.get(r.hourNumber) ?? { present: 0, total: 0 };
    hour.total += 1;
    if (isPresentStatus(r.status)) hour.present += 1;
    hourBuckets.set(r.hourNumber, hour);

    const weekKey = isoWeekKey(r.date);
    const week = weekBuckets.get(weekKey) ?? { present: 0, total: 0 };
    week.total += 1;
    if (isPresentStatus(r.status)) week.present += 1;
    weekBuckets.set(weekKey, week);

    if (isPresentStatus(r.status)) {
      currentStreak += 1;
      longestStreak = Math.max(longestStreak, currentStreak);
    } else {
      currentStreak = 0;
    }

    if (r.status === "LATE") lateByDay.set(dow, (lateByDay.get(dow) ?? 0) + 1);
  }

  const lateCount = records.filter((r: any) => r.status === "LATE").length;
  const mostLateDay = [...lateByDay.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return c.json({
    trend: [...weekBuckets.entries()]
      .sort()
      .map(([week, v]) => ({ week, pct: attendancePct(v.present, v.total) })),
    dayWise: [...dayBuckets.entries()].map(([dow, v]) => ({ dayOfWeek: dow, pct: attendancePct(v.present, v.total) })),
    hourWise: [...hourBuckets.entries()].map(([hr, v]) => ({ hourNumber: hr, pct: attendancePct(v.present, v.total) })),
    streaks: { current: currentStreak, longest: longestStreak },
    lateStats: { totalLate: lateCount, mostLateDayOfWeek: mostLateDay },
  });
});

/**
 * Every remaining class date for one section's subject, from `from` up to the semester end.
 * Walks the calendar day by day so real holidays/exam days are skipped rather than assumed,
 * and expands multi-hour blocks (a 2-hour lab yields 2 entries on that date).
 */
function futureClassDates(
  timetables: { dayOfWeek: number; durationHours: number }[],
  nonWorkingDates: Set<string>,
  from: Date,
  until: Date
): string[] {
  const out: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));

  while (cursor <= until) {
    const key = cursor.toISOString().slice(0, 10);
    if (!nonWorkingDates.has(key)) {
      const dow = cursor.getUTCDay();
      for (const t of timetables) {
        if (t.dayOfWeek !== dow) continue;
        for (let i = 0; i < t.durationHours; i++) out.push(key);
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Walks forward through upcoming classes and reports the date the percentage first
 * crosses `targetPct`. `attend` decides the scenario: false = skip everything from
 * here (when do I drop below), true = attend everything (when do I climb back).
 * Returns null when the crossing never happens before the semester ends.
 */
function crossingDate(
  present: number,
  total: number,
  upcoming: string[],
  targetPct: number,
  attend: boolean
): { date: string; afterClasses: number } | null {
  let p = present;
  let t = total;

  for (let i = 0; i < upcoming.length; i++) {
    t += 1;
    if (attend) p += 1;

    const pct = attendancePct(p, t);
    const crossed = attend ? pct >= targetPct : pct < targetPct;
    if (crossed) return { date: upcoming[i], afterClasses: i + 1 };
  }
  return null;
}

function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * What-if simulator. Optionally scoped to one subject, and optionally to a specific
 * set of date+hour picks (whole days or individual periods) rather than a bare count.
 *
 * mode "bunk": skip `hours.length` (or `n`) more classes — what does % become.
 * mode "target": how many more classes (attended, not skipped) are needed to reach targetPct.
 */
studentPortal.post("/simulate", async (c) => {
  const body = simulateSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");

  const student = await getOwnStudent(prisma, user.sub, body.semesterId);

  const records = await prisma.attendance.findMany({
    where: {
      studentId: student.id,
      semesterId: student.section.semesterId,
      ...(body.subjectId ? { subjectId: body.subjectId } : {}),
      ...COUNTS_FOR_ATTENDANCE,
    },
  });
  const total = records.length;
  const present = records.filter((r: any) => isPresentStatus(r.status)).length;
  const currentPct = attendancePct(present, total);

  if (body.mode === "target") {
    const needed = recoveryHours(present, total, body.targetPct!);
    return c.json({
      present,
      total,
      currentPct,
      targetPct: body.targetPct,
      classesNeeded: needed,
      // Denominator grows as those classes are attended, so this is what % looks like once reached.
      projectedPct: needed > 0 ? attendancePct(present + needed, total + needed) : currentPct,
    });
  }

  // "bunk" mode: an explicit hour list simulates skipping exactly those picks (already-marked
  // dates excluded, since you can't retroactively un-attend a class); otherwise fall back to n.
  const skipCount = body.hours?.length ?? body.n ?? 0;

  return c.json({
    present,
    total,
    currentPct,
    simulatedPct: bunkSimulator(present, total, skipCount),
    additionalAbsences: skipCount,
  });
});

/**
 * One row per timetabled subject: current standing, safe-bunk/recovery counts, and the
 * projected dates the student would cross the target — the date they'd fall below if they
 * keep skipping, and the date they'd recover if they attend everything from now on.
 *
 * Subjects come from the section's timetable, so a subject with no attendance yet still
 * appears (with an empty current standing) rather than silently missing from the planner.
 */
studentPortal.get("/subject-planner", async (c) => {
  const query = subjectPlannerQuerySchema.parse({
    semesterId: c.req.query("semesterId"),
    targetPct: c.req.query("targetPct"),
  });
  const prisma = c.get("prisma");
  const user = c.get("user");

  const student = await getOwnStudent(prisma, user.sub, query.semesterId);
  const semester = student.section.semester;
  const targetPct = query.targetPct ?? semester.minAttendancePct;

  const timetables = await prisma.timetable.findMany({
    where: { sectionId: student.sectionId },
    include: { subject: true },
  });

  // Non-working days are skipped when projecting forward, so the dates land on real classes.
  const calendarDays = await prisma.calendarDay.findMany({
    where: { semesterId: semester.id, dayType: { not: "WORKING" } },
    select: { date: true },
  });
  const nonWorkingDates = new Set(
    calendarDays.map((d: any) => d.date.toISOString().slice(0, 10))
  );

  const records = await prisma.attendance.findMany({
    where: { studentId: student.id, semesterId: semester.id, ...COUNTS_FOR_ATTENDANCE },
    select: { subjectId: true, status: true },
  });

  const standing = new Map<string, { present: number; total: number }>();
  for (const r of records) {
    const s = standing.get(r.subjectId) ?? { present: 0, total: 0 };
    s.total += 1;
    if (isPresentStatus(r.status)) s.present += 1;
    standing.set(r.subjectId, s);
  }

  // Project from tomorrow — today's classes may already be marked.
  const from = new Date();
  from.setUTCDate(from.getUTCDate() + 1);
  const until = semester.endDate;

  const bySubject = new Map<string, { subject: any; slots: { dayOfWeek: number; durationHours: number }[] }>();
  for (const t of timetables) {
    if (!t.subject.countsForAttendance) continue;
    const entry = bySubject.get(t.subjectId) ?? { subject: t.subject, slots: [] };
    entry.slots.push({ dayOfWeek: t.dayOfWeek, durationHours: t.durationHours });
    bySubject.set(t.subjectId, entry);
  }

  const rows = [...bySubject.values()].map(({ subject, slots }) => {
    const { present, total } = standing.get(subject.id) ?? { present: 0, total: 0 };
    const currentPct = attendancePct(present, total);
    const upcoming = futureClassDates(slots, nonWorkingDates, from, until);

    return {
      subjectId: subject.id,
      code: subject.code,
      name: subject.name,
      present,
      total,
      currentPct,
      targetPct,
      onTrack: total === 0 ? true : currentPct >= targetPct,
      safeBunkHours: safeBunkHours(present, total, targetPct),
      recoveryHours: recoveryHours(present, total, targetPct),
      remainingClasses: upcoming.length,
      // Only meaningful in the direction that applies: someone already below target
      // cannot "fall below", and someone above it has nothing to recover to.
      fallBelowOn: currentPct >= targetPct ? crossingDate(present, total, upcoming, targetPct, false) : null,
      recoverOn: currentPct < targetPct ? crossingDate(present, total, upcoming, targetPct, true) : null,
    };
  });

  rows.sort((a, b) => a.currentPct - b.currentPct);
  return c.json({ targetPct, semesterEndDate: until.toISOString().slice(0, 10), subjects: rows });
});

export default studentPortal;
