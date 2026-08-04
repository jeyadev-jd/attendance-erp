import { z } from "zod";

export const semesterQuerySchema = z.object({
  semesterId: z.string().cuid().optional(),
});

export const timelineQuerySchema = z.object({
  semesterId: z.string().cuid().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});

// Two independent what-if modes, both scoped to an optional subject and an optional
// set of specific dates/hours (whole-day if hourNumber omitted for that date).
// "bunk" — simulate skipping N more hours (optionally the exact ones picked).
// "target" — how many more classes must be attended to reach targetPct.
export const simulateSchema = z
  .object({
    semesterId: z.string().cuid().optional(),
    subjectId: z.string().cuid().optional(),
    mode: z.enum(["bunk", "target"]).default("bunk"),
    // Explicit hours to simulate skipping, e.g. picking specific periods across specific days.
    hours: z
      .array(z.object({ date: z.string().date(), hourNumber: z.number().int().min(1) }))
      .max(500)
      .optional(),
    // Fallback when no explicit hours are given: just "skip N more of this subject".
    n: z.number().int().min(0).max(500).optional(),
    targetPct: z.number().min(0).max(100).optional(),
  })
  .refine((v) => v.mode !== "target" || v.targetPct !== undefined, {
    message: "targetPct is required when mode is 'target'",
  });

export const bunkersQuerySchema = z.object({
  semesterId: z.string().cuid(),
  date: z.string().date(),
  sectionId: z.string().cuid().optional(),
});

// Per-subject planner: current standing plus forward projection to the date the
// student would cross the target (falling below by skipping, or recovering by attending).
export const subjectPlannerQuerySchema = z.object({
  semesterId: z.string().cuid().optional(),
  targetPct: z.coerce.number().min(0).max(100).optional(),
});
