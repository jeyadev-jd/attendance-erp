// Supabase counterpart of lib/attendanceContext.ts.
//
// Resolves + validates the marking context for a date+section+hour: section belongs
// to org, calendar day isn't a holiday, the hour isn't disabled by a partial-day
// override, and a timetable entry exists. Throws HTTPException on any violation.
//
// Every rule, message and status code is carried over unchanged — this is the
// gatekeeper for all attendance writes, so a difference here is a correctness bug,
// not a migration detail. Kept as a separate file so the Prisma helper stays
// untouched while both paths run in parallel; at cutover this replaces it.
import { HTTPException } from "hono/http-exception";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findSectionInOrg } from "@attendance/db/queries";

export function dayOfWeekOf(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

type TimetableLike = {
  hourNumber: number;
  durationHours: number;
  subjectId: string | null;
  facultyId: string | null;
  semesterId: string;
  subject: { countsForAttendance: boolean } & Record<string, unknown>;
  faculty: Record<string, unknown> | null;
  reason?: string | null;
  countsForAttendance?: boolean | null;
};

export async function resolveMarkContext(
  db: SupabaseClient,
  organizationId: string,
  sectionId: string,
  dateStr: string,
  hourNumber: number
) {
  const section = (await findSectionInOrg(db, sectionId, organizationId)) as
    | ({ id: string; semesterId: string } & Record<string, unknown>)
    | null;
  if (!section) throw new HTTPException(404, { message: "Section not found" });

  const date = new Date(`${dateStr}T00:00:00.000Z`);

  // The calendar day and its hour overrides in one request.
  const { data: calendarDay, error: calErr } = await db
    .from("calendar_days")
    .select("id,dayType,hour_overrides(hourNumber,attendanceEnabled)")
    .eq("semesterId", section.semesterId)
    .eq("date", date.toISOString())
    .maybeSingle();
  if (calErr) throw new Error(`resolveMarkContext (calendar): ${calErr.message}`);

  const hourOverrides =
    (calendarDay?.hour_overrides as { hourNumber: number; attendanceEnabled: boolean }[]) ?? [];

  if (calendarDay?.dayType === "HOLIDAY") {
    throw new HTTPException(400, { message: "Cannot mark attendance on a holiday" });
  }

  const override = hourOverrides.find((o) => o.hourNumber === hourNumber);
  if (override && !override.attendanceEnabled) {
    throw new HTTPException(400, {
      message: `Attendance is disabled for hour ${hourNumber} on this date`,
    });
  }

  const dayOfWeek = dayOfWeekOf(dateStr);

  // Both lookups depend only on sectionId + date/dayOfWeek, which are known here, so
  // they run together rather than serially. This function is on the hot path for
  // every mark read, mark write, and each distinct date+hour during import.
  const SUBJECT_COLS = "id,departmentId,code,name,totalHours,countsForAttendance";
  const FACULTY_COLS = "id,userId,departmentId,employeeId,name";

  const [overrideRes, weeklyRes] = await Promise.all([
    db
      .from("timetable_overrides")
      .select(
        `hourNumber,durationHours,subjectId,facultyId,semesterId,reason,countsForAttendance,` +
          `subjects(${SUBJECT_COLS}),faculty(${FACULTY_COLS})`
      )
      .eq("sectionId", sectionId)
      .eq("date", date.toISOString()),
    db
      .from("timetables")
      .select(
        `hourNumber,durationHours,subjectId,facultyId,semesterId,` +
          `subjects(${SUBJECT_COLS}),faculty(${FACULTY_COLS})`
      )
      .eq("sectionId", sectionId)
      .eq("dayOfWeek", dayOfWeek),
  ]);
  if (overrideRes.error) throw new Error(`resolveMarkContext (overrides): ${overrideRes.error.message}`);
  if (weeklyRes.error) throw new Error(`resolveMarkContext (timetable): ${weeklyRes.error.message}`);

  /** Renames PostgREST's table-named embeds to the relation names the route reads. */
  const reshape = (r: Record<string, unknown>): TimetableLike => {
    const { subjects, faculty, ...rest } = r as {
      subjects?: unknown;
      faculty?: unknown;
    } & Record<string, unknown>;
    return { ...rest, subject: subjects, faculty: faculty ?? null } as TimetableLike;
  };

  // Casts: supabase-js cannot infer these nested select strings and falls back to
  // GenericStringError. The queries are valid against the live schema.
  const dayOverrides = ((overrideRes.data ?? []) as unknown as Record<string, unknown>[]).map(reshape);
  const dayEntries = ((weeklyRes.data ?? []) as unknown as Record<string, unknown>[]).map(reshape);

  // A one-off override for this exact date wins over the recurring weekly pattern.
  //
  // A multi-hour lab is stored as ONE row at its first period, so the requested hour
  // may fall inside a block rather than starting one — find the entry that covers it.
  const overrideEntry = dayOverrides.find(
    (o) => hourNumber >= o.hourNumber && hourNumber < o.hourNumber + o.durationHours
  );

  if (overrideEntry && !overrideEntry.subjectId) {
    throw new HTTPException(400, {
      message: `Hour ${hourNumber} is cancelled on this date${
        overrideEntry.reason ? ` (${overrideEntry.reason})` : ""
      }`,
    });
  }

  const weeklyEntry = dayEntries.find(
    (e) => hourNumber >= e.hourNumber && hourNumber < e.hourNumber + e.durationHours
  );

  const timetableEntry = overrideEntry ?? weeklyEntry;
  if (!timetableEntry) {
    throw new HTTPException(404, { message: "No class scheduled for this section/day/hour" });
  }

  // Hours this block spans — attendance is marked once but recorded for each of them,
  // so a 2-hour lab counts as 2 hours toward the percentage.
  const coveredHours: number[] = Array.from(
    { length: timetableEntry.durationHours },
    (_, i) => timetableEntry.hourNumber + i
  );

  // Any covered hour disabled by a partial-day override (e.g. an exam) blocks the block.
  for (const h of coveredHours) {
    const o = hourOverrides.find((x) => x.hourNumber === h);
    if (o && !o.attendanceEnabled) {
      throw new HTTPException(400, {
        message: `Attendance is disabled for hour ${h} on this date`,
      });
    }
  }

  // The override can opt a one-off date in/out of counting independent of the
  // subject's own default; falls back to the subject's setting when unset.
  const countsForAttendance: boolean =
    overrideEntry?.countsForAttendance ?? timetableEntry.subject.countsForAttendance;

  return {
    section,
    calendarDay,
    dayOfWeek,
    timetableEntry,
    date,
    coveredHours,
    countsForAttendance,
    // True when this date's schedule was changed one-off rather than following the weekly pattern.
    isOverride: !!overrideEntry,
    overrideReason: overrideEntry?.reason ?? null,
  };
}
