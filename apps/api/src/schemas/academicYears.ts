import { z } from "zod";

export const createAcademicYearSchema = z.object({
  label: z.string().min(1), // e.g. "2025-2026"
  startDate: z.string().date(),
  endDate: z.string().date(),
});

export const updateAcademicYearSchema = z.object({
  label: z.string().min(1).optional(),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
});
