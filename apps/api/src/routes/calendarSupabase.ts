// Calendar, served from Supabase over HTTPS.
//
// Mounted at /api/v2/calendar alongside the Prisma/D1 router.
// Logic, guards, status codes and response shapes unchanged.
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { requireSupabase } from "../middleware/supabase";
import { assertSemesterInOrg, assertSemesterWritable } from "../lib/semesterGuardSupabase";
import {
  monthQuerySchema,
  setDaySchema,
  bulkSetRangeSchema,
  hourOverrideSchema,
  bulkHourOverrideSchema,
} from "../schemas/calendar";
import * as repo from "@attendance/db/repos/calendar";

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
  const db = requireSupabase(c);
  const user = c.get("user");
  await assertSemesterInOrg(db, query.semesterId, user.organizationId);

  const monthStart = new Date(Date.UTC(query.year, query.month - 1, 1));
  const monthEnd = new Date(Date.UTC(query.year, query.month, 1));

  return c.json(await repo.listMonth(db, query.semesterId, monthStart, monthEnd));
});

/** Sets (creates or updates) a single calendar day's type/label/notes. */
calendar.post("/day", canManage, async (c) => {
  const body = setDaySchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");
  await assertSemesterWritable(db, body.semesterId, user.organizationId);

  // Same shape as GET /month so callers can swap the returned day straight into
  // their state without losing hourOverrides.
  return c.json(
    await repo.upsertDay(db, {
      semesterId: body.semesterId,
      date: toDate(body.date),
      dayType: body.dayType,
      label: body.label,
      notes: body.notes,
    })
  );
});

/**
 * Sets the same day type across a date range in one call (e.g. marking a whole
 * week as HOLIDAY, or every Saturday as WORKING). `daysOfWeek` optionally
 * restricts which weekdays within the range get touched.
 */
calendar.post("/bulk-range", canManage, async (c) => {
  const body = bulkSetRangeSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");
  await assertSemesterWritable(db, body.semesterId, user.organizationId);

  const start = toDate(body.startDate);
  const end = toDate(body.endDate);
  if (end < start) return c.json({ error: "endDate must be on or after startDate" }, 400);

  const dates: Date[] = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (!body.daysOfWeek || body.daysOfWeek.includes(d.getUTCDay())) {
      dates.push(new Date(d));
    }
  }

  // One batched upsert instead of a $transaction of N individual ones.
  const updated = await repo.upsertDays(db, body.semesterId, dates, {
    dayType: body.dayType,
    label: body.label,
    notes: body.notes,
  });
  return c.json({ updated });
});

/** Toggles attendance on/off for one hour on one day — handles partial exam days. */
calendar.put("/hour-override", canManage, async (c) => {
  const body = hourOverrideSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");
  await assertSemesterWritable(db, body.semesterId, user.organizationId);

  const calendarDay = await repo.ensureDay(db, body.semesterId, toDate(body.date));
  return c.json(
    await repo.upsertOverride(db, calendarDay.id, body.hourNumber, body.attendanceEnabled)
  );
});

/** Same as above but for several hours on one date at once (e.g. hours 1-2 exam, 3-6 normal). */
calendar.put("/hour-overrides/bulk", canManage, async (c) => {
  const body = bulkHourOverrideSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");
  await assertSemesterWritable(db, body.semesterId, user.organizationId);

  const calendarDay = await repo.ensureDay(db, body.semesterId, toDate(body.date));
  const updated = await repo.upsertOverrides(db, calendarDay.id, body.overrides);
  return c.json({ updated });
});

export default calendar;
