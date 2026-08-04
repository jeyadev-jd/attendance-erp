import { z } from "zod";

const dayTypeEnum = z.enum([
  "WORKING",
  "HOLIDAY",
  "EXAM",
  "INTERNAL_EXAM",
  "EVENT",
  "WORKSHOP",
  "INDUSTRIAL_VISIT",
  "SPORTS_DAY",
  "SYMPOSIUM",
  "STUDY_HOLIDAY",
  "CUSTOM",
]);

export const monthQuerySchema = z.object({
  semesterId: z.string().cuid(),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

export const setDaySchema = z.object({
  semesterId: z.string().cuid(),
  date: z.string().date(),
  dayType: dayTypeEnum,
  label: z.string().optional(),
  notes: z.string().optional(),
});

export const bulkSetRangeSchema = z.object({
  semesterId: z.string().cuid(),
  startDate: z.string().date(),
  endDate: z.string().date(),
  dayType: dayTypeEnum,
  label: z.string().optional(),
  notes: z.string().optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(), // restrict to e.g. only Sat/Sun
});

export const hourOverrideSchema = z.object({
  semesterId: z.string().cuid(),
  date: z.string().date(),
  hourNumber: z.number().int().min(1),
  attendanceEnabled: z.boolean(),
});

export const bulkHourOverrideSchema = z.object({
  semesterId: z.string().cuid(),
  date: z.string().date(),
  overrides: z.array(z.object({ hourNumber: z.number().int().min(1), attendanceEnabled: z.boolean() })).min(1),
});
