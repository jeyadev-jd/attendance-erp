import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { getSettings } from "../lib/settings";
import { dayOfWeekOf, resolveMarkContext } from "../lib/attendanceContext";
import {
  markQuerySchema,
  bulkMarkSchema,
  editAttendanceSchema,
  lockAttendanceSchema,
  auditLogQuerySchema,
} from "../schemas/attendance";

const attendance = new Hono<AppEnv>();
const canMark = roleGuard("SUPER_ADMIN", "ADMIN", "CLASS_ADMIN");

attendance.get("/mark", canMark, async (c) => {
  const query = markQuerySchema.parse({
    date: c.req.query("date"),
    sectionId: c.req.query("sectionId"),
    hourNumber: c.req.query("hourNumber"),
  });
  const prisma = c.get("prisma");
  const user = c.get("user");

  const { timetableEntry, date, coveredHours, isOverride, overrideReason, countsForAttendance } =
    await resolveMarkContext(prisma, user.organizationId, query.sectionId, query.date, query.hourNumber);

  const studentList = await prisma.student.findMany({
    where: { sectionId: query.sectionId, status: "ACTIVE" },
    orderBy: { rollNo: "asc" },
  });

  // Read from the block's first hour: every covered hour is written together, so
  // they always agree, and this keeps one row per student in the response.
  const existing = await prisma.attendance.findMany({
    where: {
      date,
      hourNumber: timetableEntry.hourNumber,
      subjectId: timetableEntry.subjectId,
      studentId: { in: studentList.map((s: any) => s.id) },
    },
  });
  const byStudent = new Map(existing.map((a: any) => [a.studentId, a]));

  return c.json({
    subject: timetableEntry.subject,
    faculty: timetableEntry.faculty,
    // Lets the UI say "Hours 3–4 (2 hours), marked once".
    hourNumber: timetableEntry.hourNumber,
    durationHours: timetableEntry.durationHours,
    coveredHours,
    countsForAttendance,
    isOverride,
    overrideReason,
    students: studentList.map((s: any) => {
      const record = byStudent.get(s.id);
      return {
        studentId: s.id,
        rollNo: s.rollNo,
        name: s.name,
        status: record?.status ?? null,
        isLocked: record?.isLocked ?? false,
        attendanceId: record?.id ?? null,
      };
    }),
  });
});

/** Bulk upsert in one transaction. Records for already-locked attendance are skipped, not overwritten. */
attendance.post("/mark", canMark, async (c) => {
  const body = bulkMarkSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");

  const { timetableEntry, date, coveredHours, countsForAttendance } = await resolveMarkContext(
    prisma,
    user.organizationId,
    body.sectionId,
    body.date,
    body.hourNumber
  );

  // A lock on any hour of the block locks the whole block for that student.
  const studentIds = body.records.map((r) => r.studentId);
  const alreadyLocked = await prisma.attendance.findMany({
    where: {
      date,
      hourNumber: { in: coveredHours },
      subjectId: timetableEntry.subjectId,
      studentId: { in: studentIds },
      isLocked: true,
    },
    select: { studentId: true },
  });
  const lockedSet = new Set(alreadyLocked.map((a: any) => a.studentId));

  const toWrite = body.records.filter((r) => !lockedSet.has(r.studentId));
  const skipped = body.records.filter((r) => lockedSet.has(r.studentId)).map((r) => r.studentId);

  // One mark, but a record per hour the block covers — so a 2-hour lab is marked
  // once and still counts as 2 hours toward attendance.
  const ops = toWrite.flatMap((r) =>
    coveredHours.map((hour) =>
      prisma.attendance.upsert({
        where: {
          date_hourNumber_studentId_subjectId: {
            date,
            hourNumber: hour,
            studentId: r.studentId,
            subjectId: timetableEntry.subjectId,
          },
        },
        update: { status: r.status, countsForAttendance, markedById: user.sub, markedAt: new Date() },
        create: {
          date,
          hourNumber: hour,
          semesterId: timetableEntry.semesterId,
          subjectId: timetableEntry.subjectId,
          sectionId: body.sectionId,
          studentId: r.studentId,
          status: r.status,
          countsForAttendance,
          markedById: user.sub,
        },
      })
    )
  );

  const written = ops.length > 0 ? await prisma.$transaction(ops) : [];
  return c.json({
    written: written.length,
    students: toWrite.length,
    hoursPerStudent: coveredHours.length,
    skippedLocked: skipped,
  });
});

/**
 * Edit a single attendance record. Requires a reason, respects the org's edit
 * window (settings.editWindowHours) unless the requester is SUPER_ADMIN, and
 * always writes an audit_log entry with the old/new status — never a silent overwrite.
 */
attendance.put("/:id", canMark, async (c) => {
  const body = editAttendanceSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");
  const id = c.req.param("id");

  const record = await prisma.attendance.findFirst({
    where: { id, section: { semester: { academicYear: { organizationId: user.organizationId } } } },
  });
  if (!record) throw new HTTPException(404, { message: "Attendance record not found" });

  if (record.isLocked && user.role !== "SUPER_ADMIN") {
    throw new HTTPException(403, { message: "Record is locked — only SUPER_ADMIN can override" });
  }

  if (user.role !== "SUPER_ADMIN") {
    const settings = await getSettings(prisma, user.organizationId);
    const windowMs = settings.editWindowHours * 60 * 60 * 1000;
    if (Date.now() - record.markedAt.getTime() > windowMs) {
      throw new HTTPException(403, { message: "Edit window has expired for this record" });
    }
  }

  const [updated] = await prisma.$transaction([
    prisma.attendance.update({ where: { id }, data: { status: body.status } }),
    prisma.auditLog.create({
      data: {
        attendanceId: id,
        oldStatus: record.status,
        newStatus: body.status,
        reason: body.reason,
        changedById: user.sub,
      },
    }),
  ]);

  return c.json(updated);
});

/** Locks attendance for a date+section (optionally a single hour). Locked records become immutable. */
attendance.post("/lock", roleGuard("SUPER_ADMIN", "ADMIN"), async (c) => {
  const body = lockAttendanceSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");

  const section = await prisma.section.findFirst({
    where: { id: body.sectionId, semester: { academicYear: { organizationId: user.organizationId } } },
  });
  if (!section) throw new HTTPException(404, { message: "Section not found" });

  const date = new Date(`${body.date}T00:00:00.000Z`);
  const result = await prisma.attendance.updateMany({
    where: {
      sectionId: body.sectionId,
      date,
      ...(body.hourNumber ? { hourNumber: body.hourNumber } : {}),
    },
    data: { isLocked: true },
  });

  return c.json({ locked: result.count });
});

export default attendance;
