import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import bcrypt from "bcryptjs";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { listUsersQuerySchema, createUserSchema, updateUserSchema } from "../schemas/users";

const users = new Hono<AppEnv>();

/**
 * Staff/admin user management. Creating or changing who holds admin rights is a
 * privilege-escalation surface, so the whole router is SUPER_ADMIN/ADMIN only.
 * Students are managed via /api/students instead (they need a roll number + section).
 */
const canManage = roleGuard("SUPER_ADMIN", "ADMIN");
users.use("*", canManage);

users.get("/", async (c) => {
  const query = listUsersQuerySchema.parse({ role: c.req.query("role") });
  const prisma = c.get("prisma");
  const actor = c.get("user");

  const list = await prisma.user.findMany({
    where: {
      organizationId: actor.organizationId,
      ...(query.role ? { role: query.role } : { role: { not: "STUDENT" } }),
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      externalId: true,
      isActive: true,
      mustChangePassword: true,
      createdAt: true,
      student: { select: { id: true } },
    },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });

  return c.json(list.map(({ student, ...u }: any) => ({ ...u, hasStudentProfile: !!student })));
});

/**
 * Creates a staff user with the org's shared temporary password; they must change it
 * (OTP-verified) on first login, exactly like seeded students.
 */
users.post("/", async (c) => {
  const body = createUserSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const actor = c.get("user");

  const existing = await prisma.user.findUnique({
    where: { organizationId_email: { organizationId: actor.organizationId, email: body.email } },
  });
  if (existing) throw new HTTPException(409, { message: "Email already registered" });

  const tempPassword = c.env.TEMP_STUDENT_PASSWORD ?? "Student@123";
  const created = await prisma.user.create({
    data: {
      organizationId: actor.organizationId,
      email: body.email,
      name: body.name,
      role: body.role,
      externalId: body.externalId,
      passwordHash: await bcrypt.hash(tempPassword, 10),
      mustChangePassword: true,
    },
    select: { id: true, email: true, name: true, role: true, externalId: true, isActive: true },
  });

  return c.json({ ...created, temporaryPassword: tempPassword }, 201);
});

/** Change a user's role or deactivate them. */
users.put("/:id", async (c) => {
  const body = updateUserSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const actor = c.get("user");
  const id = c.req.param("id");

  const target = await prisma.user.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!target) throw new HTTPException(404, { message: "User not found" });

  // Guard against an admin locking themselves out of their own admin rights.
  if (target.id === actor.sub && (body.role !== undefined || body.isActive === false)) {
    throw new HTTPException(400, { message: "You cannot change your own role or deactivate yourself" });
  }
  // Only a SUPER_ADMIN may create or modify another SUPER_ADMIN.
  if ((target.role === "SUPER_ADMIN" || body.role === "SUPER_ADMIN") && actor.role !== "SUPER_ADMIN") {
    throw new HTTPException(403, { message: "Only a SUPER_ADMIN can manage SUPER_ADMIN accounts" });
  }

  const updated = await prisma.user.update({
    where: { id },
    data: body,
    select: { id: true, email: true, name: true, role: true, isActive: true },
  });
  return c.json(updated);
});

/**
 * Deactivates rather than deletes: attendance, audit logs and marked-by references
 * must survive, so a hard delete would either cascade away history or fail outright.
 */
users.delete("/:id", async (c) => {
  const prisma = c.get("prisma");
  const actor = c.get("user");
  const id = c.req.param("id");

  const target = await prisma.user.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!target) throw new HTTPException(404, { message: "User not found" });
  if (target.id === actor.sub) throw new HTTPException(400, { message: "You cannot deactivate yourself" });
  if (target.role === "SUPER_ADMIN" && actor.role !== "SUPER_ADMIN") {
    throw new HTTPException(403, { message: "Only a SUPER_ADMIN can deactivate a SUPER_ADMIN" });
  }

  await prisma.user.update({ where: { id }, data: { isActive: false } });
  return c.json({ deactivated: true });
});

export default users;
