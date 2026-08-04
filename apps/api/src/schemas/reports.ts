import { z } from "zod";

export const exportQuerySchema = z.object({
  semesterId: z.string().cuid(),
  sectionId: z.string().cuid().optional(),
  format: z.enum(["csv", "xlsx"]).default("csv"),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
});

export const downloadQuerySchema = z.object({
  key: z.string().min(1),
});

// Attendance backfill import: date,hourNumber,rollNo,status
export const importRowSchema = z.object({
  date: z.string().date(),
  hourNumber: z.string().regex(/^\d+$/),
  rollNo: z.string().min(1),
  status: z.enum(["PRESENT", "ABSENT", "LATE", "OD"]),
});
