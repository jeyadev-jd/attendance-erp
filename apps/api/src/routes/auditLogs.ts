import { Hono } from "hono";
import type { AppEnv } from "../types";
import { auditLogQuerySchema } from "../schemas/attendance";

const auditLogs = new Hono<AppEnv>();

auditLogs.get("/", async (c) => {
  const query = auditLogQuerySchema.parse({
    studentId: c.req.query("studentId"),
    sectionId: c.req.query("sectionId"),
    subjectId: c.req.query("subjectId"),
    dateFrom: c.req.query("dateFrom"),
    dateTo: c.req.query("dateTo"),
  });
  const prisma = c.get("prisma");
  const user = c.get("user");

  const logs = await prisma.auditLog.findMany({
    where: {
      attendance: {
        section: { semester: { academicYear: { organizationId: user.organizationId } } },
        ...(query.studentId ? { studentId: query.studentId } : {}),
        ...(query.sectionId ? { sectionId: query.sectionId } : {}),
        ...(query.subjectId ? { subjectId: query.subjectId } : {}),
        ...(query.dateFrom || query.dateTo
          ? {
              date: {
                ...(query.dateFrom ? { gte: new Date(`${query.dateFrom}T00:00:00.000Z`) } : {}),
                ...(query.dateTo ? { lte: new Date(`${query.dateTo}T00:00:00.000Z`) } : {}),
              },
            }
          : {}),
      },
    },
    include: {
      attendance: { include: { student: true, subject: true, section: true } },
      changedBy: { select: { name: true, email: true } },
    },
    orderBy: { changedAt: "desc" },
  });

  return c.json(logs);
});

export default auditLogs;
