import { Hono } from "hono";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { assertSemesterInOrg, assertSemesterWritable } from "../lib/semesterGuard";
import {
  monthQuerySchema,
  setDaySchema,
  bulkSetRangeSchema,
  hourOverrideSchema,
  bulkHourOverrideSchema,
} from "../schemas/calendar";

const calendar = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN", "CLASS_ADMIN");

function toDate(dateStr: string) {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

calendar.get("/month", async (c) => {
  const query = monthQuerySchema.parse({
    semesterId: c.req.query("semesterId"),
    year: c.req.query("year"),
    month: c.req.query("month"),
  });
  const prisma = c.get("prisma");
  const user = c.get("user");
  await assertSemesterInOrg(prisma, query.semesterId, user.organizationId);

  const monthStart = new Date(Date.UTC(query.year, query.month - 1, 1));
  const monthEnd = new Date(Date.UTC(query.year, query.month, 1));

  const days = await prisma.calendarDay.findMany({
    where: { semesterId: query.semesterId, date: { gte: monthStart, lt: monthEnd } },
    include: { hourOverrides: true },
    orderBy: { date: "asc" },
  });

  return c.json(days);
});

/** Sets (creates or updates) a single calendar day's type/label/notes. */
calendar.post("/day", canManage, async (c) => {
  const body = setDaySchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");
  await assertSemesterWritable(prisma, body.semesterId, user.organizationId);

  const date = toDate(body.date);
  const day = await prisma.calendarDay.upsert({
    where: { semesterId_date: { semesterId: body.semesterId, date } },
    update: { dayType: body.dayType, label: body.label, notes: body.notes },
    create: { semesterId: body.semesterId, date, dayType: body.dayType, label: body.label, notes: body.notes },
    // Same shape as GET /month so callers can swap the returned day straight into
    // their state without losing hourOverrides.
    include: { hourOverrides: true },
  });
  return c.json(day);
});

/**
 * Sets the same day type across a date range in one call (e.g. marking a whole
 * week as HOLIDAY, or every Saturday as WORKING). `daysOfWeek` optionally
 * restricts which weekdays within the range get touched.
 */
calendar.post("/bulk-range", canManage, async (c) => {
  const body = bulkSetRangeSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");
  await assertSemesterWritable(prisma, body.semesterId, user.organizationId);

  const start = toDate(body.startDate);
  const end = toDate(body.endDate);
  if (end < start) return c.json({ error: "endDate must be on or after startDate" }, 400);

  const dates: Date[] = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (!body.daysOfWeek || body.daysOfWeek.includes(d.getUTCDay())) {
      dates.push(new Date(d));
    }
  }

  const results = await prisma.$transaction(
    dates.map((date) =>
      prisma.calendarDay.upsert({
        where: { semesterId_date: { semesterId: body.semesterId, date } },
        update: { dayType: body.dayType, label: body.label, notes: body.notes },
        create: { semesterId: body.semesterId, date, dayType: body.dayType, label: body.label, notes: body.notes },
      })
    )
  );

  return c.json({ updated: results.length });
});

/** Toggles attendance on/off for one hour on one day — handles partial exam days. */
calendar.put("/hour-override", canManage, async (c) => {
  const body = hourOverrideSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");
  await assertSemesterWritable(prisma, body.semesterId, user.organizationId);

  const date = toDate(body.date);
  const calendarDay = await prisma.calendarDay.upsert({
    where: { semesterId_date: { semesterId: body.semesterId, date } },
    update: {},
    create: { semesterId: body.semesterId, date, dayType: "WORKING" },
  });

  const override = await prisma.hourOverride.upsert({
    where: { calendarDayId_hourNumber: { calendarDayId: calendarDay.id, hourNumber: body.hourNumber } },
    update: { attendanceEnabled: body.attendanceEnabled },
    create: {
      calendarDayId: calendarDay.id,
      hourNumber: body.hourNumber,
      attendanceEnabled: body.attendanceEnabled,
    },
  });

  return c.json(override);
});

/** Same as above but for several hours on one date at once (e.g. hours 1-2 exam, 3-6 normal). */
calendar.put("/hour-overrides/bulk", canManage, async (c) => {
  const body = bulkHourOverrideSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");
  await assertSemesterWritable(prisma, body.semesterId, user.organizationId);

  const date = toDate(body.date);
  const calendarDay = await prisma.calendarDay.upsert({
    where: { semesterId_date: { semesterId: body.semesterId, date } },
    update: {},
    create: { semesterId: body.semesterId, date, dayType: "WORKING" },
  });

  const results = await prisma.$transaction(
    body.overrides.map((o) =>
      prisma.hourOverride.upsert({
        where: { calendarDayId_hourNumber: { calendarDayId: calendarDay.id, hourNumber: o.hourNumber } },
        update: { attendanceEnabled: o.attendanceEnabled },
        create: { calendarDayId: calendarDay.id, hourNumber: o.hourNumber, attendanceEnabled: o.attendanceEnabled },
      })
    )
  );

  return c.json({ updated: results.length });
});

export default calendar;
