import { z } from "zod";

export const listQuerySchema = z.object({
  isRead: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const broadcastSchema = z.object({
  title: z.string().min(1),
  message: z.string().min(1),
  role: z.enum(["SUPER_ADMIN", "ADMIN", "CLASS_ADMIN", "FACULTY", "STUDENT"]).optional(),
  sectionId: z.string().cuid().optional(), // scopes to students in one section
});
