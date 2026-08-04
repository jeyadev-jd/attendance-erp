import { HTTPException } from "hono/http-exception";

export function dayOfWeekOf(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

/**
 * Resolves + validates the marking context for a date+section+hour:
 * section belongs to org, calendar day isn't a holiday, the hour isn't
 * disabled by a partial-day override, and a timetable entry exists.
 * Throws HTTPException on any violation — shared by mark/import routes.
 */
export async function resolveMarkContext(
  prisma: any,
  organizationId: string,
  sectionId: string,
  dateStr: string,
  hourNumber: number
) {
  const section = await prisma.section.findFirst({
    where: { id: sectionId, semester: { academicYear: { organizationId } } },
    include: { semester: true },
  });
  if (!section) throw new HTTPException(404, { message: "Section not found" });

  const date = new Date(`${dateStr}T00:00:00.000Z`);
  const calendarDay = await prisma.calendarDay.findUnique({
    where: { semesterId_date: { semesterId: section.semesterId, date } },
    include: { hourOverrides: true },
  });

  if (calendarDay?.dayType === "HOLIDAY") {
    throw new HTTPException(400, { message: "Cannot mark attendance on a holiday" });
  }

  const override = calendarDay?.hourOverrides.find((o: any) => o.hourNumber === hourNumber);
  if (override && !override.attendanceEnabled) {
    throw new HTTPException(400, { message: `Attendance is disabled for hour ${hourNumber} on this date` });
  }

  const dayOfWeek = dayOfWeekOf(dateStr);

  // A one-off override for this exact date wins over the recurring weekly pattern.
  const dayOverrides = await prisma.timetableOverride.findMany({
    where: { sectionId, date },
    include: { subject: true, faculty: true },
  });
  const overrideEntry = dayOverrides.find(
    (o: any) => hourNumber >= o.hourNumber && hourNumber < o.hourNumber + o.durationHours
  );

  if (overrideEntry && !overrideEntry.subjectId) {
    throw new HTTPException(400, {
      message: `Hour ${hourNumber} is cancelled on this date${overrideEntry.reason ? ` (${overrideEntry.reason})` : ""}`,
    });
  }

  // A multi-hour lab is stored as ONE row at its first period, so the requested hour
  // may fall inside a block rather than starting one — find the entry that covers it.
  const dayEntries = await prisma.timetable.findMany({
    where: { sectionId, dayOfWeek },
    include: { subject: true, faculty: true },
  });
  const weeklyEntry = dayEntries.find(
    (e: any) => hourNumber >= e.hourNumber && hourNumber < e.hourNumber + e.durationHours
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
    const o = calendarDay?.hourOverrides.find((x: any) => x.hourNumber === h);
    if (o && !o.attendanceEnabled) {
      throw new HTTPException(400, { message: `Attendance is disabled for hour ${h} on this date` });
    }
  }

  return {
    section,
    calendarDay,
    dayOfWeek,
    timetableEntry,
    date,
    coveredHours,
    // True when this date's schedule was changed one-off rather than following the weekly pattern.
    isOverride: !!overrideEntry,
    overrideReason: overrideEntry?.reason ?? null,
  };
}
