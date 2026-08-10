// Calendar repository — PostgREST equivalents of apps/api/src/routes/calendar.ts.
//
// PRIMARY-KEY PRESERVATION: every upsert here looks up the existing row's id first
// and reuses it. PostgREST's upsert overwrites every column it is given, including
// the primary key, so passing a fresh cuid would silently rewrite the id of an
// existing row on each save. Prisma's upsert never did that, and hour_overrides
// reference calendar_days.id, so a churning key would strand those children.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many, maybeOne, one, normaliseDates, DATE_FIELDS } from "../supabase";
import { cuid } from "../ids";

export type CalendarDay = {
  id: string;
  semesterId: string;
  date: string;
  dayType: string;
  label: string | null;
  notes: string | null;
};

export type HourOverride = {
  id: string;
  calendarDayId: string;
  hourNumber: number;
  attendanceEnabled: boolean;
};

const DAY_COLS = "id,semesterId,date,dayType,label,notes";
const OVERRIDE_COLS = "id,calendarDayId,hourNumber,attendanceEnabled";

/** Renames the hour_overrides embed to Prisma's relation name. */
function toPrismaShape(row: Record<string, unknown>): Record<string, unknown> {
  const { hour_overrides, ...rest } = row as { hour_overrides?: unknown } & Record<
    string,
    unknown
  >;
  return hour_overrides === undefined ? rest : { ...rest, hourOverrides: hour_overrides };
}

/**
 * Calendar days in a month, with their hour overrides.
 *
 * Replaces prisma.calendarDay.findMany with `include: { hourOverrides }`. The
 * overrides arrive as an embed in the same request — fetching them per day would be
 * an N+1 across the month.
 */
export async function listMonth(
  db: SupabaseClient,
  semesterId: string,
  monthStart: Date,
  monthEnd: Date
) {
  const rows = many<Record<string, unknown>>(
    (await db
      .from("calendar_days")
      .select(`${DAY_COLS},hour_overrides(${OVERRIDE_COLS})`)
      .eq("semesterId", semesterId)
      .gte("date", monthStart.toISOString())
      .lt("date", monthEnd.toISOString())
      .order("date", { ascending: true })) as unknown as {
      data: Record<string, unknown>[] | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "calendar.listMonth"
  );
  return normaliseDates(rows.map(toPrismaShape), DATE_FIELDS);
}

/** Existing calendar day for a (semester, date), or null. */
export async function findDay(db: SupabaseClient, semesterId: string, date: Date) {
  return maybeOne<CalendarDay>(
    await db
      .from("calendar_days")
      .select(DAY_COLS)
      .eq("semesterId", semesterId)
      .eq("date", date.toISOString())
      .maybeSingle(),
    "calendar.findDay"
  );
}

/**
 * Inserts or updates one calendar day, returning it with its hour overrides.
 *
 * The existing id is reused when the row is already there — see the file header.
 */
export async function upsertDay(
  db: SupabaseClient,
  data: {
    semesterId: string;
    date: Date;
    dayType: string;
    label?: string | null;
    notes?: string | null;
  }
) {
  const existing = await findDay(db, data.semesterId, data.date);

  const row = one<Record<string, unknown>>(
    (await db
      .from("calendar_days")
      .upsert(
        {
          id: existing?.id ?? cuid(),
          semesterId: data.semesterId,
          date: data.date.toISOString(),
          dayType: data.dayType,
          label: data.label ?? null,
          notes: data.notes ?? null,
        },
        { onConflict: "semesterId,date" }
      )
      .select(`${DAY_COLS},hour_overrides(${OVERRIDE_COLS})`)
      .single()) as unknown as {
      data: Record<string, unknown> | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "calendar.upsertDay"
  );
  return normaliseDates(toPrismaShape(row), DATE_FIELDS);
}

/**
 * Ensures a calendar day exists for (semester, date), returning it.
 *
 * Replaces the `update: {}` upsert the hour-override endpoints use to guarantee a
 * parent row. When the day already exists nothing is written at all — an upsert with
 * an empty update would still rewrite the row and bump its id.
 */
export async function ensureDay(db: SupabaseClient, semesterId: string, date: Date) {
  const existing = await findDay(db, semesterId, date);
  if (existing) return existing;

  return one<CalendarDay>(
    await db
      .from("calendar_days")
      .upsert(
        {
          id: cuid(),
          semesterId,
          date: date.toISOString(),
          dayType: "WORKING",
          label: null,
          notes: null,
        },
        { onConflict: "semesterId,date" }
      )
      .select(DAY_COLS)
      .single(),
    "calendar.ensureDay"
  );
}

/**
 * Sets the same day type across many dates in one batched upsert.
 *
 * Replaces a $transaction of N individual upserts, which over HTTP would be N
 * requests. Existing ids are fetched in one query and reused so a bulk range does not
 * rewrite the primary key of every day it touches.
 */
export async function upsertDays(
  db: SupabaseClient,
  semesterId: string,
  dates: Date[],
  values: { dayType: string; label?: string | null; notes?: string | null }
): Promise<number> {
  if (dates.length === 0) return 0;

  const iso = dates.map((d) => d.toISOString());
  const existing = many<{ id: string; date: string }>(
    await db
      .from("calendar_days")
      .select("id,date")
      .eq("semesterId", semesterId)
      .in("date", iso),
    "calendar.upsertDays (lookup)"
  );
  // Key on the parsed instant: Postgres may echo a timestamptz back in a different
  // textual form than it was sent, so string keys would miss existing rows.
  const idByTime = new Map(existing.map((r) => [new Date(r.date).getTime(), r.id]));

  const { error } = await db.from("calendar_days").upsert(
    dates.map((date) => ({
      id: idByTime.get(date.getTime()) ?? cuid(),
      semesterId,
      date: date.toISOString(),
      dayType: values.dayType,
      label: values.label ?? null,
      notes: values.notes ?? null,
    })),
    { onConflict: "semesterId,date" }
  );
  if (error) throw new Error(`calendar.upsertDays: ${error.message}`);
  return dates.length;
}

/** Existing hour override for a (day, hour), or null. */
export async function findOverride(
  db: SupabaseClient,
  calendarDayId: string,
  hourNumber: number
) {
  return maybeOne<HourOverride>(
    await db
      .from("hour_overrides")
      .select(OVERRIDE_COLS)
      .eq("calendarDayId", calendarDayId)
      .eq("hourNumber", hourNumber)
      .maybeSingle(),
    "calendar.findOverride"
  );
}

/** Inserts or updates one hour override, preserving an existing row's id. */
export async function upsertOverride(
  db: SupabaseClient,
  calendarDayId: string,
  hourNumber: number,
  attendanceEnabled: boolean
) {
  const existing = await findOverride(db, calendarDayId, hourNumber);

  return one<HourOverride>(
    await db
      .from("hour_overrides")
      .upsert(
        { id: existing?.id ?? cuid(), calendarDayId, hourNumber, attendanceEnabled },
        { onConflict: "calendarDayId,hourNumber" }
      )
      .select(OVERRIDE_COLS)
      .single(),
    "calendar.upsertOverride"
  );
}

/**
 * Inserts or updates several hour overrides for one day in a single batched upsert.
 *
 * Existing ids are fetched once and reused, for the same reason as upsertDays.
 */
export async function upsertOverrides(
  db: SupabaseClient,
  calendarDayId: string,
  overrides: { hourNumber: number; attendanceEnabled: boolean }[]
): Promise<number> {
  if (overrides.length === 0) return 0;

  const existing = many<{ id: string; hourNumber: number }>(
    await db
      .from("hour_overrides")
      .select("id,hourNumber")
      .eq("calendarDayId", calendarDayId)
      .in(
        "hourNumber",
        overrides.map((o) => o.hourNumber)
      ),
    "calendar.upsertOverrides (lookup)"
  );
  const idByHour = new Map(existing.map((r) => [r.hourNumber, r.id]));

  const { error } = await db.from("hour_overrides").upsert(
    overrides.map((o) => ({
      id: idByHour.get(o.hourNumber) ?? cuid(),
      calendarDayId,
      hourNumber: o.hourNumber,
      attendanceEnabled: o.attendanceEnabled,
    })),
    { onConflict: "calendarDayId,hourNumber" }
  );
  if (error) throw new Error(`calendar.upsertOverrides: ${error.message}`);
  return overrides.length;
}
