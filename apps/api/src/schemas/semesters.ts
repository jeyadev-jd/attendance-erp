import { z } from "zod";

export const createSemesterSchema = z.object({
  academicYearId: z.string().cuid(),
  name: z.string().min(1),
  startDate: z.string().date(),
  endDate: z.string().date(),
  minAttendancePct: z.number().min(0).max(100).default(80),
});

export const updateSemesterSchema = z.object({
  name: z.string().min(1).optional(),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
  minAttendancePct: z.number().min(0).max(100).optional(),
  status: z.enum(["UPCOMING", "ACTIVE", "ARCHIVED"]).optional(),
});

export const cloneSemesterSchema = z.object({
  name: z.string().min(1),
  startDate: z.string().date(),
  endDate: z.string().date(),
  academicYearId: z.string().cuid().optional(), // defaults to the source semester's academic year
});
