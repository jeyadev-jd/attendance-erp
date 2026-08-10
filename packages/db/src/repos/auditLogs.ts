// Audit logs repository — PostgREST equivalent of apps/api/src/routes/auditLogs.ts.
//
// Every filter here (org scoping, student, section, subject, date range) applies to
// the JOINED attendance row, not to the audit log itself. PostgREST expresses that as
// an !inner embed with dotted-path filters, so all of it runs in PostgreSQL — the
// Worker never receives a log it would have to discard.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many, normaliseDates, DATE_FIELDS } from "../supabase";

/**
 * Reshapes a PostgREST row into the shape Prisma returned.
 *
 * Prisma names embeds by relation (`attendance`, `student`, `subject`, `section`,
 * `changedBy`); PostgREST names them by table (`attendance`, `students`, `subjects`,
 * `sections`, `users`). The API contract follows Prisma, and the org-scoping join
 * also introduces nested objects Prisma never returned, so both are corrected here.
 */
function toPrismaShape(row: Record<string, unknown>): Record<string, unknown> {
  const { attendance, users, ...rest } = row as {
    attendance?: Record<string, unknown>;
    users?: unknown;
  } & Record<string, unknown>;

  const out: Record<string, unknown> = { ...rest };
  if (users !== undefined) out.changedBy = users;

  if (attendance) {
    const { students, subjects, sections, ...attRest } = attendance as {
      students?: unknown;
      subjects?: unknown;
      sections?: Record<string, unknown>;
    } & Record<string, unknown>;

    const att: Record<string, unknown> = { ...attRest };
    if (students !== undefined) att.student = students;
    if (subjects !== undefined) att.subject = subjects;
    if (sections) {
      // Drop the scoping-only `semesters` chain; keep the section's own columns.
      const { semesters: _scoping, ...sectionRest } = sections as {
        semesters?: unknown;
      } & Record<string, unknown>;
      att.section = sectionRest;
    }
    out.attendance = att;
  }

  return out;
}

export type AuditLogFilters = {
  studentId?: string;
  sectionId?: string;
  subjectId?: string;
  dateFrom?: string;
  dateTo?: string;
};

/**
 * Audit logs for an organization, newest first.
 *
 * Replaces prisma.auditLog.findMany with nested includes. Attendance plus its
 * student, subject and section, and the changing user, all arrive in one request.
 *
 * Date bounds are both UTC midnight, matching the route's existing behaviour —
 * `dateTo` is midnight rather than end-of-day, which is only harmless because
 * attendance dates are stored at UTC midnight. Changing it here would silently alter
 * which logs the page shows.
 */
export async function listByOrg(
  db: SupabaseClient,
  organizationId: string,
  filters: AuditLogFilters
) {
  let q = db
    .from("audit_logs")
    .select(
      "id,attendanceId,oldStatus,newStatus,reason,changedById,changedAt," +
        "attendance!inner(id,date,hourNumber,semesterId,subjectId,sectionId,studentId," +
        "status,arrivalTime,lateMinutes,countsForAttendance,markedById,markedAt,isLocked," +
        "students(id,userId,sectionId,rollNo,name,status)," +
        "subjects(id,departmentId,code,name,totalHours,countsForAttendance)," +
        "sections!inner(id,semesterId,departmentId,name," +
        "semesters!inner(id,academic_years!inner(organizationId))))," +
        "users(name,email)"
    )
    .eq("attendance.sections.semesters.academic_years.organizationId", organizationId);

  if (filters.studentId) q = q.eq("attendance.studentId", filters.studentId);
  if (filters.sectionId) q = q.eq("attendance.sectionId", filters.sectionId);
  if (filters.subjectId) q = q.eq("attendance.subjectId", filters.subjectId);
  if (filters.dateFrom) q = q.gte("attendance.date", `${filters.dateFrom}T00:00:00.000Z`);
  if (filters.dateTo) q = q.lte("attendance.date", `${filters.dateTo}T00:00:00.000Z`);

  const rows = many<Record<string, unknown>>(
    (await q.order("changedAt", { ascending: false })) as unknown as {
      data: Record<string, unknown>[] | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "auditLogs.listByOrg"
  );

  return normaliseDates(rows.map(toPrismaShape), DATE_FIELDS);
}
