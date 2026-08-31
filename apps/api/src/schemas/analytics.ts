import { z } from "zod";

/** Optional date window applied to every analytics endpoint; omit both for the whole semester. */
const dateRange = {
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
};

export const semesterRequiredQuerySchema = z.object({
  semesterId: z.string().cuid(),
  ...dateRange,
});

export const leaderboardQuerySchema = z.object({
  semesterId: z.string().cuid(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  ...dateRange,
});

export const dailyBunkersQuerySchema = z.object({
  semesterId: z.string().cuid(),
  date: z.string().date(),
  sectionId: z.string().cuid().optional(),
});

/** Builds the Prisma `date` filter, or nothing when the range is open. */
export function dateFilter(query: { dateFrom?: string; dateTo?: string }) {
  if (!query.dateFrom && !query.dateTo) return {};
  return {
    date: {
      ...(query.dateFrom ? { gte: new Date(`${query.dateFrom}T00:00:00.000Z`) } : {}),
      ...(query.dateTo ? { lte: new Date(`${query.dateTo}T00:00:00.000Z`) } : {}),
    },
  };
}

/** Batch overview: one section's roster with each student's standing. */
export const batchOverviewQuerySchema = z.object({
  sectionId: z.string().cuid(),
  ...dateRange,
});
