import { z } from "zod";

export const updateSettingsSchema = z.object({
  minAttendancePct: z.number().min(0).max(100).optional(),
  gracePeriodMinutes: z.number().int().min(0).optional(),
  lateThresholdMinutes: z.number().int().min(0).optional(),
  veryLateThresholdMinutes: z.number().int().min(0).optional(),
  editWindowHours: z.number().int().min(0).optional(),
  autoLockAfterDays: z.number().int().min(0).optional(),
});
