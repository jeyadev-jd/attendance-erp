import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { attendancePct, isPresentStatus, COUNTS_FOR_ATTENDANCE } from "../lib/calculators";
import {
  semesterRequiredQuerySchema,
  leaderboardQuerySchema,
  dailyBunkersQuerySchema,
  dateFilter,
} from "../schemas/analytics";

const analytics = new Hono<AppEnv>();
analytics.use("*", roleGuard("SUPER_ADMIN", "ADMIN", "CLASS_ADMIN"));

async function assertSemesterInOrg(prisma: any, semesterId: string, organizationId: string) {
  const semester = await prisma.semester.findFirst({
    where: { id: semesterId, academicYear: { organizationId } },
  });
  if (!semester) throw new HTTPException(404, { message: "Semester not found" });
  return semester;
}

/** Day (0-6) × hour matrix of attendance % across the whole semester. */
analytics.get("/heatmap", async (c) => {
  const query = semesterRequiredQuerySchema.parse({
    semesterId: c.req.query("semesterId"),
    dateFrom: c.req.query("dateFrom"),
    dateTo: c.req.query("dateTo"),
  });
  const prisma = c.get("prisma");
  const user = c.get("user");
  await assertSemesterInOrg(prisma, query.semesterId, user.organizationId);

  const records = await prisma.attendance.findMany({
    where: { semesterId: query.semesterId, ...COUNTS_FOR_ATTENDANCE, ...dateFilter(query) },
  });

  const buckets = new Map<string, { present: number; total: number }>();
  for (const r of records) {
    const dow = r.date.getUTCDay();
    const key = `${dow}-${r.hourNumber}`;
    const bucket = buckets.get(key) ?? { present: 0, total: 0 };
    bucket.total += 1;
    if (isPresentStatus(r.status)) bucket.present += 1;
    buckets.set(key, bucket);
  }

  const cells = [...buckets.entries()].map(([key, v]) => {
    const [dow, hour] = key.split("-").map(Number);
    return { dayOfWeek: dow, hourNumber: hour, pct: attendancePct(v.present, v.total), total: v.total };
  });

  return c.json({ cells });
});

/** Attendance % per subject, org-wide for the semester. */
analytics.get("/subject-comparison", async (c) => {
  const query = semesterRequiredQuerySchema.parse({
    semesterId: c.req.query("semesterId"),
    dateFrom: c.req.query("dateFrom"),
    dateTo: c.req.query("dateTo"),
  });
  const prisma = c.get("prisma");
  const user = c.get("user");
  await assertSemesterInOrg(prisma, query.semesterId, user.organizationId);

  const records = await prisma.attendance.findMany({
    where: { semesterId: query.semesterId, ...COUNTS_FOR_ATTENDANCE, ...dateFilter(query) },
    include: { subject: true },
  });

  const buckets = new Map<string, { name: string; present: number; total: number }>();
  for (const r of records) {
    const bucket = buckets.get(r.subjectId) ?? { name: r.subject.name, present: 0, total: 0 };
    bucket.total += 1;
    if (isPresentStatus(r.status)) bucket.present += 1;
    buckets.set(r.subjectId, bucket);
  }

  return c.json(
    [...buckets.entries()]
      .map(([subjectId, v]) => ({ subjectId, name: v.name, pct: attendancePct(v.present, v.total), total: v.total }))
      .sort((a, b) => a.pct - b.pct)
  );
});

/** Students ranked by bunk-flag count (mid-class bunk pattern detections), worst first. */
analytics.get("/bunk-leaderboard", async (c) => {
  const query = leaderboardQuerySchema.parse({
    semesterId: c.req.query("semesterId"),
    limit: c.req.query("limit"),
    dateFrom: c.req.query("dateFrom"),
    dateTo: c.req.query("dateTo"),
  });
  const prisma = c.get("prisma");
  const user = c.get("user");
  await assertSemesterInOrg(prisma, query.semesterId, user.organizationId);

  const students = await prisma.student.findMany({
    where: { section: { semesterId: query.semesterId } },
    // BunkFlag carries its own date, so the range narrows the flags rather than the students.
    include: { bunkFlags: { where: dateFilter(query) } },
  });

  return c.json(
    students
      .map((s: any) => ({
        studentId: s.id,
        rollNo: s.rollNo,
        name: s.name,
        bunkFlagCount: s.bunkFlags.length,
        singleHourSkips: s.bunkFlags.filter((f: any) => f.flagType === "SINGLE_HOUR_SKIP").length,
        midClassBunks: s.bunkFlags.filter((f: any) => f.flagType === "MID_CLASS_BUNK").length,
      }))
      .filter((s: any) => s.bunkFlagCount > 0)
      .sort((a: any, b: any) => b.bunkFlagCount - a.bunkFlagCount)
      .slice(0, query.limit)
  );
});

/**
 * Everyone who was absent from at least one class on a given date, with exactly
 * which hours (and which subjects) they missed that day — the "who bunked today
 * and when" view. Distinct from bunk-leaderboard, which ranks by the mid-class
 * P->A pattern over a range; this is a flat per-day roll call.
 */
analytics.get("/daily-bunkers", async (c) => {
  const query = dailyBunkersQuerySchema.parse({
    semesterId: c.req.query("semesterId"),
    date: c.req.query("date"),
    sectionId: c.req.query("sectionId"),
  });
  const prisma = c.get("prisma");
  const user = c.get("user");
  await assertSemesterInOrg(prisma, query.semesterId, user.organizationId);

  const date = new Date(`${query.date}T00:00:00.000Z`);
  const records = await prisma.attendance.findMany({
    where: {
      semesterId: query.semesterId,
      date,
      status: "ABSENT",
      ...(query.sectionId ? { sectionId: query.sectionId } : {}),
      ...COUNTS_FOR_ATTENDANCE,
    },
    include: { student: true, subject: true },
    orderBy: [{ studentId: "asc" }, { hourNumber: "asc" }],
  });

  const byStudent = new Map<
    string,
    { studentId: string; rollNo: string; name: string; absences: { hourNumber: number; subject: string }[] }
  >();
  for (const r of records) {
    const entry = byStudent.get(r.studentId) ?? {
      studentId: r.studentId,
      rollNo: r.student.rollNo,
      name: r.student.name,
      absences: [],
    };
    entry.absences.push({ hourNumber: r.hourNumber, subject: r.subject.name });
    byStudent.set(r.studentId, entry);
  }

  return c.json(
    [...byStudent.values()].sort((a, b) => b.absences.length - a.absences.length)
  );
});

/** Most-late students + which day/hour sees the most LATE marks. */
analytics.get("/late-analytics", async (c) => {
  const query = semesterRequiredQuerySchema.parse({
    semesterId: c.req.query("semesterId"),
    dateFrom: c.req.query("dateFrom"),
    dateTo: c.req.query("dateTo"),
  });
  const prisma = c.get("prisma");
  const user = c.get("user");
  await assertSemesterInOrg(prisma, query.semesterId, user.organizationId);

  const lateRecords = await prisma.attendance.findMany({
    where: { semesterId: query.semesterId, status: "LATE", ...dateFilter(query) },
    include: { student: true },
  });

  const byStudent = new Map<string, { rollNo: string; name: string; count: number }>();
  const byDay = new Map<number, number>();
  const byHour = new Map<number, number>();

  for (const r of lateRecords) {
    const s = byStudent.get(r.studentId) ?? { rollNo: r.student.rollNo, name: r.student.name, count: 0 };
    s.count += 1;
    byStudent.set(r.studentId, s);

    const dow = r.date.getUTCDay();
    byDay.set(dow, (byDay.get(dow) ?? 0) + 1);
    byHour.set(r.hourNumber, (byHour.get(r.hourNumber) ?? 0) + 1);
  }

  const mostLateStudents = [...byStudent.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  const mostLateDay = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const mostLateHour = [...byHour.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return c.json({
    totalLateMarks: lateRecords.length,
    mostLateStudents,
    mostLateDayOfWeek: mostLateDay,
    mostLateHour,
  });
});

/**
 * Per subject: how many scheduled hours have actually been marked ("coverage"),
 * the attendance % across them, and how many records were later corrected.
 *
 * Reported per subject rather than per faculty because one faculty member often
 * teaches both a theory paper and its lab (e.g. Data Mining + Data Mining Lab),
 * and merging those hides that a lab is being skipped while the theory is not.
 * Lab and theory are separate subjects, so they stay separate rows.
 */
analytics.get("/subject-report", async (c) => {
  const query = semesterRequiredQuerySchema.parse({
    semesterId: c.req.query("semesterId"),
    dateFrom: c.req.query("dateFrom"),
    dateTo: c.req.query("dateTo"),
  });
  const prisma = c.get("prisma");
  const user = c.get("user");
  const semester = await assertSemesterInOrg(prisma, query.semesterId, user.organizationId);

  const timetables = await prisma.timetable.findMany({
    where: { semesterId: query.semesterId, section: { semester: { academicYear: { organizationId: user.organizationId } } } },
    include: { subject: true, faculty: true },
  });
  if (timetables.length === 0) return c.json([]);

  const studentCount = await prisma.student.count({
    where: { status: "ACTIVE", section: { semesterId: query.semesterId } },
  });

  // Scheduled hours are estimated over the window actually being reported on:
  // the filter dates when given, otherwise semester start -> today.
  const windowStart = query.dateFrom ? new Date(`${query.dateFrom}T00:00:00.000Z`) : semester.startDate;
  const windowEnd = query.dateTo ? new Date(`${query.dateTo}T00:00:00.000Z`) : new Date();
  const elapsedMs = Math.max(0, windowEnd.getTime() - windowStart.getTime());
  const elapsedWeeks = Math.max(1, Math.ceil(elapsedMs / (7 * 24 * 60 * 60 * 1000)));

  // Weekly scheduled hours per subject — a multi-hour lab contributes its full span.
  type Bucket = {
    subjectId: string;
    code: string;
    name: string;
    countsForAttendance: boolean;
    weeklyHours: number;
    faculty: Set<string>;
  };
  const buckets = new Map<string, Bucket>();
  for (const t of timetables) {
    const b = buckets.get(t.subjectId) ?? {
      subjectId: t.subjectId,
      code: t.subject.code,
      name: t.subject.name,
      countsForAttendance: t.subject.countsForAttendance,
      weeklyHours: 0,
      faculty: new Set<string>(),
    };
    b.weeklyHours += t.durationHours;
    b.faculty.add(t.faculty.name);
    buckets.set(t.subjectId, b);
  }

  const report = [];
  for (const b of buckets.values()) {
    const records = await prisma.attendance.findMany({
      where: { semesterId: query.semesterId, subjectId: b.subjectId, ...dateFilter(query) },
      select: { status: true, date: true, hourNumber: true },
    });

    // Distinct date+hour pairs = hours actually marked, independent of class size.
    const markedHours = new Set(records.map((r: any) => `${r.date.toISOString().slice(0, 10)}-${r.hourNumber}`)).size;
    const scheduledHours = b.weeklyHours * elapsedWeeks;
    const present = records.filter((r: any) => isPresentStatus(r.status)).length;

    const corrections = await prisma.auditLog.count({
      where: { attendance: { semesterId: query.semesterId, subjectId: b.subjectId, ...dateFilter(query) } },
    });

    report.push({
      subjectId: b.subjectId,
      code: b.code,
      name: b.name,
      faculty: [...b.faculty].join(", "),
      countsForAttendance: b.countsForAttendance,
      weeklyHours: b.weeklyHours,
      scheduledHours,
      markedHours,
      // Capped: a rescheduled or extra class can push marked past the estimate.
      coveragePct: scheduledHours > 0 ? Math.min(100, (markedHours / scheduledHours) * 100) : 0,
      attendancePct: attendancePct(present, records.length),
      studentCount,
      corrections,
    });
  }

  report.sort((a, b) => a.coveragePct - b.coveragePct);
  return c.json(report);
});

export default analytics;
