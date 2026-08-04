import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { assertSemesterInOrg } from "../lib/semesterGuard";
import { resolveMarkContext } from "../lib/attendanceContext";
import { putReport, getReport, reportKey } from "../lib/r2";
import { buildXlsx, rowsToCsv } from "../lib/xlsx";
import { parseCsvWithHeader } from "../lib/csv";
import { exportQuerySchema, downloadQuerySchema, importRowSchema } from "../schemas/reports";

const reports = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN", "CLASS_ADMIN");

const HEADER = ["date", "hourNumber", "rollNo", "studentName", "section", "subject", "status", "markedAt"];

/**
 * Exports attendance records (optionally scoped to one section, optionally a
 * date range) as CSV or XLSX, uploads the file to R2 under the org's own
 * prefix, and returns a download URL. Nothing is streamed to the client
 * directly — R2 is the source of truth for the generated file, per the
 * original storage design.
 */
reports.get("/export", canManage, async (c) => {
  const query = exportQuerySchema.parse({
    semesterId: c.req.query("semesterId"),
    sectionId: c.req.query("sectionId"),
    format: c.req.query("format"),
    dateFrom: c.req.query("dateFrom"),
    dateTo: c.req.query("dateTo"),
  });
  const prisma = c.get("prisma");
  const user = c.get("user");
  await assertSemesterInOrg(prisma, query.semesterId, user.organizationId);

  const records = await prisma.attendance.findMany({
    where: {
      semesterId: query.semesterId,
      ...(query.sectionId ? { sectionId: query.sectionId } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            date: {
              ...(query.dateFrom ? { gte: new Date(`${query.dateFrom}T00:00:00.000Z`) } : {}),
              ...(query.dateTo ? { lte: new Date(`${query.dateTo}T00:00:00.000Z`) } : {}),
            },
          }
        : {}),
    },
    include: { student: true, subject: true, section: true },
    orderBy: [{ date: "asc" }, { hourNumber: "asc" }],
  });

  const rows = records.map((r: any) => [
    r.date.toISOString().slice(0, 10),
    r.hourNumber,
    r.student.rollNo,
    r.student.name,
    r.section.name,
    r.subject.name,
    r.status,
    r.markedAt.toISOString(),
  ]);

  const filename = `attendance-${query.semesterId}.${query.format}`;
  const key = reportKey(user.organizationId, filename);

  if (query.format === "xlsx") {
    const data = buildXlsx(HEADER, rows);
    await putReport(
      c.env.STORAGE,
      key,
      data,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  } else {
    const data = rowsToCsv(HEADER, rows);
    await putReport(c.env.STORAGE, key, data, "text/csv");
  }

  return c.json({ key, rowCount: rows.length, downloadUrl: `/api/reports/download?key=${encodeURIComponent(key)}` });
});

/** Streams a previously exported report back out of R2. Org-scoped by key prefix. */
reports.get("/download", canManage, async (c) => {
  const query = downloadQuerySchema.parse({ key: c.req.query("key") });
  const user = c.get("user");

  if (!query.key.startsWith(`reports/${user.organizationId}/`)) {
    throw new HTTPException(403, { message: "Not your organization's report" });
  }

  const object = await getReport(c.env.STORAGE, query.key);
  if (!object) throw new HTTPException(404, { message: "Report not found (may have expired)" });

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${query.key.split("/").pop()}"`,
    },
  });
});

/**
 * Bulk historical attendance import from CSV: date,hourNumber,rollNo,status.
 * Same pattern as the student CSV import — every row is validated (student
 * exists in the section, the date/hour is a valid, non-holiday scheduled
 * class per the timetable) before anything is written; any failure aborts
 * the whole batch with row-level errors.
 */
reports.post("/import", canManage, async (c) => {
  const semesterId = c.req.query("semesterId");
  const sectionId = c.req.query("sectionId");
  if (!semesterId || !sectionId) {
    throw new HTTPException(400, { message: "semesterId and sectionId query params are required" });
  }

  const prisma = c.get("prisma");
  const user = c.get("user");
  await assertSemesterInOrg(prisma, semesterId, user.organizationId);

  const csvText = await c.req.text();
  if (!csvText.trim()) throw new HTTPException(400, { message: "Empty CSV body" });

  const rawRows = parseCsvWithHeader(csvText);
  if (rawRows.length === 0) throw new HTTPException(400, { message: "No data rows found" });

  type RowError = { row: number; message: string };
  const errors: RowError[] = [];
  // status is narrowed by importRowSchema above, so keep the enum type rather than widening to string.
  const validRows: {
    date: string;
    hourNumber: number;
    studentId: string;
    subjectId: string;
    status: z.infer<typeof importRowSchema>["status"];
  }[] = [];

  const contextCache = new Map<string, any>(); // "date::hour" -> resolveMarkContext result | Error

  for (let i = 0; i < rawRows.length; i++) {
    const rowNum = i + 2;
    const parsed = importRowSchema.safeParse(rawRows[i]);
    if (!parsed.success) {
      errors.push({ row: rowNum, message: parsed.error.issues.map((iss) => iss.message).join("; ") });
      continue;
    }
    const { date, hourNumber, rollNo, status } = parsed.data;
    const hour = Number(hourNumber);

    const cacheKey = `${date}::${hour}`;
    let ctx = contextCache.get(cacheKey);
    if (ctx === undefined) {
      try {
        ctx = await resolveMarkContext(prisma, user.organizationId, sectionId, date, hour);
      } catch (err: any) {
        ctx = { error: err.message ?? "Invalid date/hour for this section" };
      }
      contextCache.set(cacheKey, ctx);
    }
    if (ctx.error) {
      errors.push({ row: rowNum, message: ctx.error });
      continue;
    }

    const student = await prisma.student.findUnique({ where: { sectionId_rollNo: { sectionId, rollNo } } });
    if (!student) {
      errors.push({ row: rowNum, message: `Roll number ${rollNo} not found in this section` });
      continue;
    }

    validRows.push({ date, hourNumber: hour, studentId: student.id, subjectId: ctx.timetableEntry.subjectId, status });
  }

  if (errors.length > 0) {
    return c.json({ imported: false, totalRows: rawRows.length, errors }, 422);
  }

  const written = await prisma.$transaction(
    validRows.map((row) =>
      prisma.attendance.upsert({
        where: {
          date_hourNumber_studentId_subjectId: {
            date: new Date(`${row.date}T00:00:00.000Z`),
            hourNumber: row.hourNumber,
            studentId: row.studentId,
            subjectId: row.subjectId,
          },
        },
        update: { status: row.status, markedById: user.sub, markedAt: new Date() },
        create: {
          date: new Date(`${row.date}T00:00:00.000Z`),
          hourNumber: row.hourNumber,
          semesterId,
          subjectId: row.subjectId,
          sectionId,
          studentId: row.studentId,
          status: row.status,
          markedById: user.sub,
        },
      })
    )
  );

  return c.json({ imported: true, count: written.length });
});

export default reports;
