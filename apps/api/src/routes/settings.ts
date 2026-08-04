import { Hono } from "hono";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { getSettings } from "../lib/settings";
import { updateSettingsSchema } from "../schemas/settings";

const settings = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN");

/** Returns the org's settings, or the documented defaults if none have been saved yet. */
settings.get("/", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const current = await getSettings(prisma, user.organizationId);
  return c.json(current);
});

/** Upserts the org's settings — nothing else in the system hardcodes these values. */
settings.put("/", canManage, async (c) => {
  const body = updateSettingsSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");

  const updated = await prisma.settings.upsert({
    where: { organizationId: user.organizationId },
    update: body,
    create: {
      organizationId: user.organizationId,
      minAttendancePct: body.minAttendancePct ?? 80,
      gracePeriodMinutes: body.gracePeriodMinutes ?? 5,
      lateThresholdMinutes: body.lateThresholdMinutes ?? 15,
      veryLateThresholdMinutes: body.veryLateThresholdMinutes ?? 30,
      editWindowHours: body.editWindowHours ?? 24,
      autoLockAfterDays: body.autoLockAfterDays ?? 3,
    },
  });

  return c.json(updated);
});

export default settings;
