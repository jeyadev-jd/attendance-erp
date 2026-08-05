import { z } from "zod";

export const createDepartmentSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1),
});
export const updateDepartmentSchema = createDepartmentSchema.partial();

export const createSectionSchema = z.object({
  semesterId: z.string().cuid(),
  departmentId: z.string().cuid(),
  name: z.string().min(1),
});
export const updateSectionSchema = createSectionSchema.partial();

export const createSubjectSchema = z.object({
  departmentId: z.string().cuid(),
  code: z.string().min(1).max(20),
  name: z.string().min(1),
  totalHours: z.number().int().min(0).default(0),
  // false for non-academic slots (mentor-mentee, club) — marked, but never counted.
  countsForAttendance: z.boolean().default(true),
});
export const updateSubjectSchema = createSubjectSchema.partial();

export const createTimetableEntrySchema = z.object({
  semesterId: z.string().cuid(),
  sectionId: z.string().cuid(),
  dayOfWeek: z.number().int().min(0).max(6),
  hourNumber: z.number().int().min(1), // first period of the block
  // A multi-period lab is one entry marked once; attendance still records each hour.
  durationHours: z.number().int().min(1).max(8).default(1),
  subjectId: z.string().cuid(),
  facultyId: z.string().cuid(),
});
export const updateTimetableEntrySchema = createTimetableEntrySchema.partial();

// Swaps two weekly slots. Either side may be empty, which turns the swap into a move.
export const swapTimetableSchema = z.object({
  sectionId: z.string().cuid(),
  a: z.object({ dayOfWeek: z.number().int().min(0).max(6), hourNumber: z.number().int().min(1) }),
  b: z.object({ dayOfWeek: z.number().int().min(0).max(6), hourNumber: z.number().int().min(1) }),
});

// Applies one subject+faculty to several hours at once, each as its own 1-hour entry.
export const bulkAssignSchema = z.object({
  semesterId: z.string().cuid(),
  sectionId: z.string().cuid(),
  subjectId: z.string().cuid(),
  facultyId: z.string().cuid(),
  slots: z
    .array(z.object({ dayOfWeek: z.number().int().min(0).max(6), hourNumber: z.number().int().min(1) }))
    .min(1),
  // Replace whatever occupies those slots instead of failing on a clash.
  overwrite: z.boolean().default(false),
});

// One-off change for a single date. subjectId null = period cancelled that day.
export const timetableOverrideSchema = z.object({
  semesterId: z.string().cuid(),
  sectionId: z.string().cuid(),
  date: z.string().date(),
  hourNumber: z.number().int().min(1).max(7),
  durationHours: z.number().int().min(1).max(7).default(1),
  subjectId: z.string().cuid().nullable().optional(),
  facultyId: z.string().cuid().nullable().optional(),
  reason: z.string().optional(),
  // Overrides the subject's own countsForAttendance for just this date+hour. Distinct
  // from cancel (null subjectId): attendance is still marked, so a no-show still
  // trips bunk detection, but omit or set false to keep it out of the percentage.
  countsForAttendance: z.boolean().nullable().optional(),
});

export const overrideListQuerySchema = z.object({
  sectionId: z.string().cuid(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
});

export const bulkTimetableSchema = z.object({
  entries: z.array(createTimetableEntrySchema).min(1),
});
