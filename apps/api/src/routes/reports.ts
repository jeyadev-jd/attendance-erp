// Reports, served from Supabase over HTTPS.
//
// Mounted at /api/v2/reports alongside the Prisma/D1 router.
// Logic, guards, status codes and response shapes unchanged.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { requireSupabase } from "../middleware/supabase";
import { assertSemesterInOrg } from "../lib/semesterGuard";
import { resolveMarkContext } from "../lib/attendanceContext";
import { buildXlsx, rowsToCsv } from "../lib/xlsx";
import { parseCsvWithHeader } from "../lib/csv";
import { exportQuerySchema, importRowSchema } from "../schemas/reports";
import * as repo from "@attendance/db/repos/reports";

const reports = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN", "CLASS_ADMIN");

const HEADER = ["date", "hourNumber", "rollNo", "studentName", "section", "subject", "status", "markedAt"];

/**
 * Exports attendance records (optionally scoped to one section, optionally a
 * date range) as CSV or XLSX, streamed straight back to the caller.
 *
 * The read is paged: this is the one endpoint that legitimately needs every matching
 * row, so PostgREST's 1000-row default would silently produce a short file that looks
 * complete.
 */
reports.get("/export", canManage, async (c) => {
  const query = exportQuerySchema.parse({
    semesterId: c.req.query("semesterId"),
    sectionId: c.req.query("sectionId"),
    format: c.req.query("format"),
    dateFrom: c.req.query("dateFrom"),
    dateTo: c.req.query("dateTo"),
  });
  const db = requireSupabase(c);
  const user = c.get("user");
  await assertSemesterInOrg(db, query.semesterId, user.organizationId);

  const records = await repo.exportRows(db, query);

  const rows = records.map((r) => [
    new Date(r.date).toISOString().slice(0, 10),
    r.hourNumber,
    r.student.rollNo,
    r.student.name,
    r.section.name,
    r.subject.name,
    r.status,
    new Date(r.markedAt).toISOString(),
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

/**
 * Bulk historical attendance import from CSV: date,hourNumber,rollNo,status.
 * Every row is validated (student exists in the section, the date/hour is a valid,
 * non-holiday scheduled class per the timetable) before anything is written; any
 * failure aborts the whole batch with row-level errors.
 */
reports.post("/import", canManage, async (c) => {
  const semesterId = c.req.query("semesterId");
  const sectionId = c.req.query("sectionId");
  if (!semesterId || !sectionId) {
    throw new HTTPException(400, { message: "semesterId and sectionId query params are required" });
  }

  const db = requireSupabase(c);
  const user = c.get("user");
  await assertSemesterInOrg(db, semesterId, user.organizationId);

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
  // once rather than once per CSV row.
  const studentIdByRollNo = await repo.rosterByRollNo(db, sectionId);

  for (let i = 0; i < rawRows.length; i++) {
    const rowNum = i + 2;
    const parsed = importRowSchema.safeParse(rawRows[i]);
    if (!parsed.success) {
      errors.push({ row: rowNum, message: parsed.error.issues.map((iss) => iss.message).join("; ") });
      continue;
    }
    const { date, hourNumber, rollNo, status } = parsed.data;
    const hour = Number(hourNumber);

    // Cached per distinct date+hour: a backfill covering one week of one section
    // resolves a handful of contexts, not one per row.
    const cacheKey = `${date}::${hour}`;
    let ctx = contextCache.get(cacheKey);
    if (ctx === undefined) {
      try {
        ctx = await resolveMarkContext(db, user.organizationId, sectionId, date, hour);
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

  // All-or-nothing: a single bad row writes nothing, as before.
  if (errors.length > 0) {
    return c.json({ imported: false, totalRows: rawRows.length, errors }, 422);
  }

  const count = await repo.upsertImported(db, semesterId, sectionId, user.sub, validRows);
  return c.json({ imported: true, count });
});

export default reports;
