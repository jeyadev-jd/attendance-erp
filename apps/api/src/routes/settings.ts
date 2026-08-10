// Settings, served from Supabase over HTTPS.
//
// Mounted at /api/v2/settings alongside the Prisma/D1 router.
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { requireSupabase } from "../middleware/supabase";
import { updateSettingsSchema } from "../schemas/settings";
import * as repo from "@attendance/db/repos/settings";

const settings = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN");

/**
 * The spec's documented defaults, used when an organization has not configured
 * Settings yet. Duplicated from lib/settings.ts rather than imported: that helper
 * takes a Prisma client, and both must stay in sync until cutover retires it.
 */
const DEFAULTS = {
  minAttendancePct: 80,
  gracePeriodMinutes: 5,
  lateThresholdMinutes: 15,
  veryLateThresholdMinutes: 30,
  editWindowHours: 24,
  autoLockAfterDays: 3,
};

/** Returns the org's settings, or the documented defaults if none have been saved yet. */
settings.get("/", async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  const current = await repo.findByOrg(db, user.organizationId);
  return c.json(current ?? { organizationId: user.organizationId, ...DEFAULTS });
});

/** Upserts the org's settings — nothing else in the system hardcodes these values. */
settings.put("/", canManage, async (c) => {
  const body = updateSettingsSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");

  // Prisma's upsert applied `update: body` to an existing row but filled every
  // column from defaults on create. Reading the current row first preserves that:
  // omitted fields keep their saved value rather than resetting to the default.
  const current = await repo.findByOrg(db, user.organizationId);
  const base = current ?? DEFAULTS;

  return c.json(
    await repo.upsert(
      db,
      user.organizationId,
      {
        minAttendancePct: body.minAttendancePct ?? base.minAttendancePct,
        gracePeriodMinutes: body.gracePeriodMinutes ?? base.gracePeriodMinutes,
        lateThresholdMinutes: body.lateThresholdMinutes ?? base.lateThresholdMinutes,
        veryLateThresholdMinutes: body.veryLateThresholdMinutes ?? base.veryLateThresholdMinutes,
        editWindowHours: body.editWindowHours ?? base.editWindowHours,
        autoLockAfterDays: body.autoLockAfterDays ?? base.autoLockAfterDays,
      },
      // Reuse the existing row's id so a save does not rewrite the primary key.
      current?.id
    )
  );
});

export default settings;
