import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { assertSemesterInOrg } from "../lib/semesterGuard";
import { resolveMarkContext } from "../lib/attendanceContext";
import { buildXlsx, rowsToCsv } from "../lib/xlsx";
import { parseCsvWithHeader } from "../lib/csv";
import { exportQuerySchema, importRowSchema } from "../schemas/reports";

const reports = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN", "CLASS_ADMIN");

const HEADER = ["date", "hourNumber", "rollNo", "studentName", "section", "subject", "status", "markedAt"];

/**
 * Exports attendance records (optionally scoped to one section, optionally a
 * date range) as CSV or XLSX, streamed straight back to the caller.
 *
 * An earlier design staged the file in R2 and returned a download URL, but R2 is
 * not enabled on this account. Generating and returning the bytes in one request
 * removes the dependency entirely — and for a semester of attendance the payload
 * is small enough that a round trip through object storage bought nothing.
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
    select: {
      date: true,
      hourNumber: true,
      status: true,
      markedAt: true,
      student: { select: { rollNo: true, name: true } },
      subject: { select: { name: true } },
      section: { select: { name: true } },
    },
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

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `attendance-${stamp}.${query.format}`;

  const isXlsx = query.format === "xlsx";
  const body = isXlsx ? buildXlsx(HEADER, rows) : rowsToCsv(HEADER, rows);

  return new Response(body as BodyInit, {
    headers: {
      "Content-Type": isXlsx
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Lets the browser client read the row count without parsing the file.
      "X-Row-Count": String(rows.length),
    },
  });
});

// GET /download used to serve files staged in R2. With exports streamed directly
// there is nothing to fetch later, so the route is gone.

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
    countsForAttendance: boolean;
  }[] = [];

  const contextCache = new Map<string, any>(); // "date::hour" -> resolveMarkContext result | Error

  // The section roster is small and constant for the whole request, so it is read
  // once rather than once per CSV row — a 500-row backfill previously issued 500
  // identical-shaped lookups. No status filter, matching the original findUnique.
  const roster = await prisma.student.findMany({
    where: { sectionId },
    select: { id: true, rollNo: true },
  });
  const studentIdByRollNo = new Map<string, string>(roster.map((s: any) => [s.rollNo, s.id]));

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

    const studentId = studentIdByRollNo.get(rollNo);
    if (!studentId) {
      errors.push({ row: rowNum, message: `Roll number ${rollNo} not found in this section` });
      continue;
    }

    validRows.push({
      date,
      hourNumber: hour,
      studentId,
      subjectId: ctx.timetableEntry.subjectId,
      status,
      countsForAttendance: ctx.countsForAttendance,
    });
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
        update: { status: row.status, countsForAttendance: row.countsForAttendance, markedById: user.sub, markedAt: new Date() },
        create: {
          date: new Date(`${row.date}T00:00:00.000Z`),
          hourNumber: row.hourNumber,
          semesterId,
          subjectId: row.subjectId,
          sectionId,
          studentId: row.studentId,
          status: row.status,
          countsForAttendance: row.countsForAttendance,
          markedById: user.sub,
        },
      })
    )
  );

  return c.json({ imported: true, count: written.length });
});

export default reports;
