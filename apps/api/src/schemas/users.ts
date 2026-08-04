import { z } from "zod";

// STUDENT is deliberately excluded — students are created through /api/students so a
// Student profile (roll number + section) is always created alongside the User.
export const staffRoleEnum = z.enum(["SUPER_ADMIN", "ADMIN", "CLASS_ADMIN", "FACULTY"]);

export const listUsersQuerySchema = z.object({
  role: z.enum(["SUPER_ADMIN", "ADMIN", "CLASS_ADMIN", "FACULTY", "STUDENT"]).optional(),
});

export const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: staffRoleEnum,
  externalId: z.string().min(1).optional(),
});

export const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  role: staffRoleEnum.optional(),
  isActive: z.boolean().optional(),
});
