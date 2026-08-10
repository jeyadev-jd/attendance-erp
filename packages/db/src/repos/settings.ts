// Settings repository — PostgREST equivalents of apps/api/src/routes/settings.ts.
//
// One row per organization, keyed by a UNIQUE organizationId.
import type { SupabaseClient } from "@supabase/supabase-js";
import { maybeOne, one, normaliseDates, DATE_FIELDS } from "../supabase";
import { cuid } from "../ids";

export type Settings = {
  id: string;
  organizationId: string;
  minAttendancePct: number;
  gracePeriodMinutes: number;
  lateThresholdMinutes: number;
  veryLateThresholdMinutes: number;
  editWindowHours: number;
  autoLockAfterDays: number;
  updatedAt: string;
};

const COLS =
  "id,organizationId,minAttendancePct,gracePeriodMinutes,lateThresholdMinutes," +
  "veryLateThresholdMinutes,editWindowHours,autoLockAfterDays,updatedAt";

/** The org's settings row, or null when none has been saved. Replaces findUnique. */
export async function findByOrg(db: SupabaseClient, organizationId: string) {
  const row = maybeOne<Settings>(
    await db.from("settings").select(COLS).eq("organizationId", organizationId).maybeSingle(),
    "settings.findByOrg"
  );
  return row ? normaliseDates(row, DATE_FIELDS) : null;
}

/**
 * Inserts or updates the org's settings.
 *
 * Replaces prisma.settings.upsert. `onConflict: "organizationId"` is the PostgREST
 * equivalent of Prisma's `where: { organizationId }` — it relies on the UNIQUE index
 * the export carried over (settings_organizationId_key), so the database decides
 * insert-vs-update atomically rather than the Worker doing a read-then-write that
 * could race.
 *
 * `updatedAt` is supplied because Prisma's `@updatedAt` is a client-side default with
 * no Postgres equivalent.
 *
 * `existingId` matters: an upsert overwrites every column it is given, including the
 * primary key, so passing a fresh cuid on the update path would change the row's id
 * on every save. Prisma's upsert never touched the id of an existing row, and other
 * tables could hold references to it, so the current id is reused when there is one
 * and a new one generated only for a genuine insert.
 */
export async function upsert(
  db: SupabaseClient,
  organizationId: string,
  values: {
    minAttendancePct: number;
    gracePeriodMinutes: number;
    lateThresholdMinutes: number;
    veryLateThresholdMinutes: number;
    editWindowHours: number;
    autoLockAfterDays: number;
  },
  existingId?: string
) {
  return normaliseDates(
    one<Settings>(
      await db
        .from("settings")
        .upsert(
          {
            id: existingId ?? cuid(),
            organizationId,
            updatedAt: new Date().toISOString(),
            ...values,
          },
          { onConflict: "organizationId" }
        )
        .select(COLS)
        .single(),
      "settings.upsert"
    ),
    DATE_FIELDS
  );
}
