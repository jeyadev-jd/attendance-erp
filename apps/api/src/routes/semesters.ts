import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { createSemesterSchema, updateSemesterSchema, cloneSemesterSchema } from "../schemas/semesters";

const semesters = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN");

async function assertAcademicYearInOrg(prisma: any, academicYearId: string, organizationId: string) {
  const year = await prisma.academicYear.findFirst({ where: { id: academicYearId, organizationId } });
  if (!year) throw new HTTPException(404, { message: "Academic year not found" });
  return year;
}

semesters.get("/", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const academicYearId = c.req.query("academicYearId");

  const list = await prisma.semester.findMany({
    where: {
      ...(academicYearId ? { academicYearId } : {}),
      academicYear: { organizationId: user.organizationId },
    },
    orderBy: { startDate: "desc" },
  });
  return c.json(list);
});

semesters.get("/:id", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const semester = await prisma.semester.findFirst({
    where: { id: c.req.param("id"), academicYear: { organizationId: user.organizationId } },
    include: { sections: true },
  });
  if (!semester) throw new HTTPException(404, { message: "Semester not found" });
  return c.json(semester);
});

semesters.post("/", canManage, async (c) => {
  const body = createSemesterSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");

  await assertAcademicYearInOrg(prisma, body.academicYearId, user.organizationId);

  const semester = await prisma.semester.create({
    data: {
      academicYearId: body.academicYearId,
      name: body.name,
      startDate: new Date(`${body.startDate}T00:00:00.000Z`),
      endDate: new Date(`${body.endDate}T00:00:00.000Z`),
      minAttendancePct: body.minAttendancePct,
      status: "UPCOMING",
    },
  });
  return c.json(semester, 201);
});

semesters.put("/:id", canManage, async (c) => {
  const body = updateSemesterSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await prisma.semester.findFirst({
    where: { id, academicYear: { organizationId: user.organizationId } },
  });
  if (!existing) throw new HTTPException(404, { message: "Semester not found" });

  const semester = await prisma.semester.update({
    where: { id },
    data: {
      ...body,
      ...(body.startDate ? { startDate: new Date(`${body.startDate}T00:00:00.000Z`) } : {}),
      ...(body.endDate ? { endDate: new Date(`${body.endDate}T00:00:00.000Z`) } : {}),
    },
  });
  return c.json(semester);
});

/**
 * Archives a semester: all its data (calendar, timetable, attendance, audit logs)
 * remains untouched and read-only — nothing is deleted or mutated except the status flag.
 * Enforcement of "read-only" happens at the route level: attendance/calendar/timetable
 * mutation endpoints should reject writes once semester.status === ARCHIVED (see TODO
 * in attendance/calendar/timetable routes if not yet wired).
 */
semesters.post("/:id/archive", canManage, async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await prisma.semester.findFirst({
    where: { id, academicYear: { organizationId: user.organizationId } },
  });
  if (!existing) throw new HTTPException(404, { message: "Semester not found" });
  if (existing.status === "ARCHIVED") {
    throw new HTTPException(409, { message: "Semester is already archived" });
  }

  const semester = await prisma.semester.update({ where: { id }, data: { status: "ARCHIVED" } });
  return c.json(semester);
});

/**
 * Clones the structural setup of a semester into a brand-new one: sections
 * (per department), hour configs, and timetable entries. Deliberately does
 * NOT copy calendar days, attendance, audit logs, or student enrollment —
 * the new semester starts clean; students/admins re-enroll sections and set
 * up the calendar fresh via their own endpoints.
 */
semesters.post("/:id/clone", canManage, async (c) => {
  const body = cloneSemesterSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");
  const sourceId = c.req.param("id");

  const source = await prisma.semester.findFirst({
    where: { id: sourceId, academicYear: { organizationId: user.organizationId } },
    include: { sections: true, hourConfigs: true, timetables: true },
  });
  if (!source) throw new HTTPException(404, { message: "Source semester not found" });

  const academicYearId = body.academicYearId ?? source.academicYearId;
  await assertAcademicYearInOrg(prisma, academicYearId, user.organizationId);

  // D1 has no interactive transactions, and each stage needs IDs generated by the
  // previous one (semester -> sections -> timetable), so this runs as sequential
  // writes. Deleting the new semester on failure cascades away anything already
  // written, standing in for the rollback a real transaction would have given us.
  const newSemester = await prisma.semester.create({
    data: {
      academicYearId,
      name: body.name,
      startDate: new Date(`${body.startDate}T00:00:00.000Z`),
      endDate: new Date(`${body.endDate}T00:00:00.000Z`),
      minAttendancePct: source.minAttendancePct,
      status: "UPCOMING",
      clonedFromId: source.id,
    },
  });

  try {
    const sectionIdMap = new Map<string, string>();
    for (const section of source.sections) {
      const newSection = await prisma.section.create({
        data: { semesterId: newSemester.id, departmentId: section.departmentId, name: section.name },
      });
      sectionIdMap.set(section.id, newSection.id);
    }

    if (source.hourConfigs.length > 0) {
      await prisma.$transaction(
        source.hourConfigs.map((hc: any) =>
          prisma.hourConfig.create({
            data: {
              semesterId: newSemester.id,
              dayOfWeek: hc.dayOfWeek,
              hourNumber: hc.hourNumber,
              startTime: hc.startTime,
              endTime: hc.endTime,
            },
          })
        )
      );
    }

    const timetableOps = source.timetables
      .filter((tt: any) => sectionIdMap.has(tt.sectionId))
      .map((tt: any) =>
        prisma.timetable.create({
          data: {
            semesterId: newSemester.id,
            sectionId: sectionIdMap.get(tt.sectionId)!,
            dayOfWeek: tt.dayOfWeek,
            hourNumber: tt.hourNumber,
            durationHours: tt.durationHours,
            subjectId: tt.subjectId,
            facultyId: tt.facultyId,
          },
        })
      );
    if (timetableOps.length > 0) await prisma.$transaction(timetableOps);

    return c.json(
      {
        semester: newSemester,
        sectionsCopied: sectionIdMap.size,
        hourConfigsCopied: source.hourConfigs.length,
        timetablesCopied: timetableOps.length,
      },
      201
    );
  } catch (err) {
    await prisma.semester.delete({ where: { id: newSemester.id } }).catch(() => {});
    throw err;
  }
});

export default semesters;
