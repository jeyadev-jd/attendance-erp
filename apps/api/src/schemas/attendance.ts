import { z } from "zod";

// Manual marking only — admin picks one of these four per student, no arrival-time auto-derivation.
const statusEnum = z.enum(["PRESENT", "ABSENT", "LATE", "OD"]);

export const markQuerySchema = z.object({
  date: z.string().date(),
  sectionId: z.string().cuid(),
  hourNumber: z.coerce.number().int().min(1),
});

export const bulkMarkSchema = z.object({
  date: z.string().date(),
  sectionId: z.string().cuid(),
  hourNumber: z.number().int().min(1),
  records: z
    .array(
      z.object({
        studentId: z.string().cuid(),
        status: statusEnum,
      })
    )
    .min(1),
});

export const editAttendanceSchema = z.object({
  status: statusEnum,
  reason: z.string().min(3, "Reason is required"),
});

export const lockAttendanceSchema = z.object({
  date: z.string().date(),
  sectionId: z.string().cuid(),
  hourNumber: z.number().int().min(1).optional(), // omit to lock the whole day
});

export const auditLogQuerySchema = z.object({
  studentId: z.string().cuid().optional(),
  sectionId: z.string().cuid().optional(),
  subjectId: z.string().cuid().optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
});
