import { z } from "zod";

const timeString = z.string().regex(/^\d{2}:\d{2}$/, "Expected HH:MM");

export const setHourConfigSchema = z.object({
  semesterId: z.string().cuid(),
  dayOfWeek: z.number().int().min(0).max(6),
  hourNumber: z.number().int().min(1),
  startTime: timeString,
  endTime: timeString,
});

export const bulkSetDaySchema = z.object({
  semesterId: z.string().cuid(),
  dayOfWeek: z.number().int().min(0).max(6),
  hours: z
    .array(z.object({ hourNumber: z.number().int().min(1), startTime: timeString, endTime: timeString }))
    .min(1),
});
