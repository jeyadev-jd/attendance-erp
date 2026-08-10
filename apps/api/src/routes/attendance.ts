// Attendance, served from Supabase over HTTPS.
//
// Mounted at /api/v2/attendance alongside the Prisma/D1 router.
// Logic, guards, status codes and response shapes unchanged.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { requireSupabase } from "../middleware/supabase";
import { resolveMarkContext } from "../lib/attendanceContext";
import {
  markQuerySchema,
  bulkMarkSchema,
  editAttendanceSchema,
  lockAttendanceSchema,
} from "../schemas/attendance";
import * as repo from "@attendance/db/repos/attendance";
import * as settingsRepo from "@attendance/db/repos/settings";
import { findSectionInOrg } from "@attendance/db/queries";
import { many } from "@attendance/db/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

const attendance = new Hono<AppEnv>();
const canMark = roleGuard("SUPER_ADMIN", "ADMIN", "CLASS_ADMIN");

/** Documented defaults when an org has not configured Settings. Mirrors lib/settings.ts. */
const SETTINGS_DEFAULTS = { editWindowHours: 24 };

/** Active roster for a section, ordered by roll number. Bounded by class size. */
async function activeRoster(db: SupabaseClient, sectionId: string) {
  return many<{ id: string; rollNo: string; name: string }>(
    await db
      .from("students")
      .select("id,rollNo,name")
      .eq("sectionId", sectionId)
      .eq("status", "ACTIVE")
      .order("rollNo", { ascending: true }),
    "attendance.activeRoster"
  );
}

attendance.get("/mark", canMark, async (c) => {
  const query = markQuerySchema.parse({
    date: c.req.query("date"),
    sectionId: c.req.query("sectionId"),
    hourNumber: c.req.query("hourNumber"),
  });
  const db = requireSupabase(c);
  const user = c.get("user");

  const { timetableEntry, date, coveredHours, isOverride, overrideReason, countsForAttendance } =
    await resolveMarkContext(db, user.organizationId, query.sectionId, query.date, query.hourNumber);

  // Roster and existing marks are independent, so they run together.
  //
  // Existing marks are read from the block's FIRST hour: every covered hour is
  // written together, so they always agree, and this keeps one row per student.
  const [studentList, existing] = await Promise.all([
    activeRoster(db, query.sectionId),
    repo.findForMarkSheet(
      db,
      date,
      timetableEntry.hourNumber,
      timetableEntry.subjectId as string,
      query.sectionId
    ),
  ]);
  const byStudent = new Map(existing.map((a) => [a.studentId, a]));

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
    students: studentList.map((s) => {
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

/** Bulk upsert. Records for already-locked attendance are skipped, not overwritten. */
attendance.post("/mark", canMark, async (c) => {
  const body = bulkMarkSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");

  const { timetableEntry, date, coveredHours, countsForAttendance } = await resolveMarkContext(
    db,
    user.organizationId,
    body.sectionId,
    body.date,
    body.hourNumber
  );

  // A lock on any hour of the block locks the whole block for that student.
  const lockedSet = await repo.findLockedStudents(
    db,
    date,
    coveredHours,
    timetableEntry.subjectId as string,
    body.records.map((r) => r.studentId)
  );

  const toWrite = body.records.filter((r) => !lockedSet.has(r.studentId));
  const skipped = body.records.filter((r) => lockedSet.has(r.studentId)).map((r) => r.studentId);

  // One mark, but a record per hour the block covers — so a 2-hour lab is marked
  // once and still counts as 2 hours toward attendance. Written as ONE batched
  // upsert rather than one request per (student, hour).
  const written = await repo.upsertMarks(db, {
    date,
    coveredHours,
    semesterId: timetableEntry.semesterId,
    subjectId: timetableEntry.subjectId as string,
    sectionId: body.sectionId,
    countsForAttendance,
    markedById: user.sub,
    records: toWrite,
  });

  return c.json({
    written,
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
  const db = requireSupabase(c);
  const user = c.get("user");
  const id = c.req.param("id");

  const record = await repo.findInOrg(db, id, user.organizationId);
  if (!record) throw new HTTPException(404, { message: "Attendance record not found" });

  if (record.isLocked && user.role !== "SUPER_ADMIN") {
    throw new HTTPException(403, { message: "Record is locked — only SUPER_ADMIN can override" });
  }

  if (user.role !== "SUPER_ADMIN") {
    const settings = await settingsRepo.findByOrg(db, user.organizationId);
    const editWindowHours = settings?.editWindowHours ?? SETTINGS_DEFAULTS.editWindowHours;
    const windowMs = editWindowHours * 60 * 60 * 1000;
    if (Date.now() - new Date(record.markedAt).getTime() > windowMs) {
      throw new HTTPException(403, { message: "Edit window has expired for this record" });
    }
  }

  return c.json(
    await repo.updateWithAudit(db, id, {
      oldStatus: record.status,
      newStatus: body.status,
      reason: body.reason,
      changedById: user.sub,
    })
  );
});

/** Locks attendance for a date+section (optionally a single hour). Locked records become immutable. */
attendance.post("/lock", roleGuard("SUPER_ADMIN", "ADMIN"), async (c) => {
  const body = lockAttendanceSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");

  const section = await findSectionInOrg(db, body.sectionId, user.organizationId);
  if (!section) throw new HTTPException(404, { message: "Section not found" });

  const locked = await repo.lockRecords(
    db,
    body.sectionId,
    new Date(`${body.date}T00:00:00.000Z`),
    body.hourNumber
  );
  return c.json({ locked });
});

export default attendance;
