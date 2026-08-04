import { z } from "zod";

export const createStudentSchema = z.object({
  sectionId: z.string().cuid(),
  rollNo: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
});

export const updateStudentSchema = z.object({
  sectionId: z.string().cuid().optional(),
  rollNo: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "GRADUATED", "TRANSFERRED"]).optional(),
});

// One CSV row before section is resolved (sectionId is looked up from sectionName+rollNo prefix
// at import time, since a CSV is more naturally authored with human-readable section names).
export const csvRowSchema = z.object({
  rollNo: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  sectionName: z.string().min(1),
});

export type CsvRow = z.infer<typeof csvRowSchema>;
