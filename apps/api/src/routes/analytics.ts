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

  // Grouped in SQL rather than scanning every row: the output is at most
  // 7 days x 7 hours x statuses, instead of the semester's entire attendance table.
  // dayOfWeek still has to be derived in JS — it isn't a stored column.
  const grouped = await prisma.attendance.groupBy({
    by: ["date", "hourNumber", "status"],
    where: { semesterId: query.semesterId, ...COUNTS_FOR_ATTENDANCE, ...dateFilter(query) },
    _count: { _all: true },
  });

  const buckets = new Map<string, { present: number; total: number }>();
  for (const g of grouped) {
    const dow = g.date.getUTCDay();
    const key = `${dow}-${g.hourNumber}`;
    const bucket = buckets.get(key) ?? { present: 0, total: 0 };
    bucket.total += g._count._all;
    if (isPresentStatus(g.status)) bucket.present += g._count._all;
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

  // Counts come back pre-aggregated (subjects x statuses rows), so the whole
  // semester's attendance never crosses the wire. Names are a second small lookup
  // rather than a join repeated on every row.
  const grouped = await prisma.attendance.groupBy({
    by: ["subjectId", "status"],
    where: { semesterId: query.semesterId, ...COUNTS_FOR_ATTENDANCE, ...dateFilter(query) },
    _count: { _all: true },
  });

  const subjects = await prisma.subject.findMany({
    where: { id: { in: [...new Set(grouped.map((g: any) => g.subjectId))] } },
    select: { id: true, name: true },
  });
  const nameById = new Map<string, string>(subjects.map((s: any) => [s.id, s.name]));

  const buckets = new Map<string, { present: number; total: number }>();
  for (const g of grouped) {
    const bucket = buckets.get(g.subjectId) ?? { present: 0, total: 0 };
    bucket.total += g._count._all;
    if (isPresentStatus(g.status)) bucket.present += g._count._all;
    buckets.set(g.subjectId, bucket);
  }

  return c.json(
    [...buckets.entries()]
      .map(([subjectId, v]) => ({
        subjectId,
        name: nameById.get(subjectId) ?? "",
        pct: attendancePct(v.present, v.total),
        total: v.total,
      }))
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

  // Rank on aggregated flag counts first. Students with no flags never enter the
  // result at all, and only the surviving `limit` rows are fetched for their names —
  // previously every student in the semester was loaded with all their flags to
  // return five rows.
  // BunkFlag carries its own date, so the range narrows the flags rather than the students.
  const grouped = await prisma.bunkFlag.groupBy({
    by: ["studentId", "flagType"],
    where: { ...dateFilter(query), student: { section: { semesterId: query.semesterId } } },
    _count: { _all: true },
  });

  const counts = new Map<string, { total: number; single: number; mid: number }>();
  for (const g of grouped) {
    const entry = counts.get(g.studentId) ?? { total: 0, single: 0, mid: 0 };
    entry.total += g._count._all;
    if (g.flagType === "SINGLE_HOUR_SKIP") entry.single += g._count._all;
    if (g.flagType === "MID_CLASS_BUNK") entry.mid += g._count._all;
    counts.set(g.studentId, entry);
  }

  const top = [...counts.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, query.limit);
  if (top.length === 0) return c.json([]);

  const students = await prisma.student.findMany({
    where: { id: { in: top.map(([id]) => id) } },
    select: { id: true, rollNo: true, name: true },
  });
  const byId = new Map<string, any>(students.map((s: any) => [s.id, s]));

  return c.json(
    top.map(([studentId, v]) => ({
      studentId,
      rollNo: byId.get(studentId)?.rollNo ?? "",
      name: byId.get(studentId)?.name ?? "",
      bunkFlagCount: v.total,
      singleHourSkips: v.single,
      midClassBunks: v.mid,
    }))
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
    select: {
      studentId: true,
      hourNumber: true,
      student: { select: { rollNo: true, name: true } },
      subject: { select: { name: true } },
    },
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

  // Two independent aggregations over the same filter, both grouped in SQL.
  // The student join is deferred until after ranking, so only the top 10 are read.
  const lateWhere = { semesterId: query.semesterId, status: "LATE", ...dateFilter(query) };

  const [byStudentGroups, byDayHourGroups] = await Promise.all([
    prisma.attendance.groupBy({ by: ["studentId"], where: lateWhere, _count: { _all: true } }),
    prisma.attendance.groupBy({ by: ["date", "hourNumber"], where: lateWhere, _count: { _all: true } }),
  ]);

  const byDay = new Map<number, number>();
  const byHour = new Map<number, number>();
  let totalLateMarks = 0;
  for (const g of byDayHourGroups) {
    const n = g._count._all;
    totalLateMarks += n;
    const dow = g.date.getUTCDay();
    byDay.set(dow, (byDay.get(dow) ?? 0) + n);
    byHour.set(g.hourNumber, (byHour.get(g.hourNumber) ?? 0) + n);
  }

  const topLate = [...byStudentGroups]
    .sort((a: any, b: any) => b._count._all - a._count._all)
    .slice(0, 10);
  const lateStudents = topLate.length
    ? await prisma.student.findMany({
        where: { id: { in: topLate.map((g: any) => g.studentId) } },
        select: { id: true, rollNo: true, name: true },
      })
    : [];
  const studentById = new Map<string, any>(lateStudents.map((s: any) => [s.id, s]));

  const mostLateStudents = topLate.map((g: any) => ({
    rollNo: studentById.get(g.studentId)?.rollNo ?? "",
    name: studentById.get(g.studentId)?.name ?? "",
    count: g._count._all,
  }));
  const mostLateDay = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const mostLateHour = [...byHour.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return c.json({
    totalLateMarks,
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

  const subjectIds = [...buckets.keys()];

  // One pass over all subjects instead of two queries per subject. Grouping by
  // (subject, date, hour, status) collapses the per-student rows while still
  // preserving the distinct date+hour pairs that "marked hours" counts.
  const grouped = await prisma.attendance.groupBy({
    by: ["subjectId", "date", "hourNumber", "status"],
    where: { semesterId: query.semesterId, subjectId: { in: subjectIds }, ...dateFilter(query) },
    _count: { _all: true },
  });

  const stats = new Map<string, { present: number; total: number; hours: Set<string> }>();
  for (const g of grouped) {
    const s = stats.get(g.subjectId) ?? { present: 0, total: 0, hours: new Set<string>() };
    s.total += g._count._all;
    if (isPresentStatus(g.status)) s.present += g._count._all;
    s.hours.add(`${g.date.toISOString().slice(0, 10)}-${g.hourNumber}`);
    stats.set(g.subjectId, s);
  }

  // Corrections for every subject in one grouped query. The relation filter is
  // unchanged, so the same audit rows are counted as before.
  const correctionGroups = await prisma.auditLog.groupBy({
    by: ["attendanceId"],
    where: {
      attendance: { semesterId: query.semesterId, subjectId: { in: subjectIds }, ...dateFilter(query) },
    },
    _count: { _all: true },
  });
  const correctedAttendanceIds = correctionGroups.map((g: any) => g.attendanceId);
  const correctedRows = correctedAttendanceIds.length
    ? await prisma.attendance.findMany({
        where: { id: { in: correctedAttendanceIds } },
        select: { id: true, subjectId: true },
      })
    : [];
  const subjectByAttendanceId = new Map<string, string>(
    correctedRows.map((r: any) => [r.id, r.subjectId])
  );
  const correctionsBySubject = new Map<string, number>();
  for (const g of correctionGroups) {
    const subjectId = subjectByAttendanceId.get(g.attendanceId);
    if (!subjectId) continue;
    correctionsBySubject.set(subjectId, (correctionsBySubject.get(subjectId) ?? 0) + g._count._all);
  }

  const report = [];
  for (const b of buckets.values()) {
    const s = stats.get(b.subjectId) ?? { present: 0, total: 0, hours: new Set<string>() };

    // Distinct date+hour pairs = hours actually marked, independent of class size.
    const markedHours = s.hours.size;
    const scheduledHours = b.weeklyHours * elapsedWeeks;
    const present = s.present;
    const corrections = correctionsBySubject.get(b.subjectId) ?? 0;

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
      attendancePct: attendancePct(present, s.total),
      studentCount,
      corrections,
    });
  }

  report.sort((a, b) => a.coveragePct - b.coveragePct);
  return c.json(report);
});

export default analytics;
