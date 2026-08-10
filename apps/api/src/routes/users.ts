// Staff user management, served from Supabase over HTTPS.
//
// Mounted at /api/v2/users alongside the Prisma/D1 router at /api/users.
//
// The authorization guards below (self-demotion, SUPER_ADMIN management) are
// reproduced exactly, in the same order, with the same status codes. They are the
// privilege-escalation boundary for the whole application; a difference here is a
// security bug, not a migration detail.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import bcrypt from "bcryptjs";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { requireSupabase } from "../middleware/supabase";
import { listUsersQuerySchema, createUserSchema, updateUserSchema } from "../schemas/users";
import * as repo from "@attendance/db/repos/users";

const users = new Hono<AppEnv>();

/**
 * Creating or changing who holds admin rights is a privilege-escalation surface, so
 * the whole router is SUPER_ADMIN/ADMIN only. Students are managed via /api/students.
 */
const canManage = roleGuard("SUPER_ADMIN", "ADMIN");
users.use("*", canManage);

users.get("/", async (c) => {
  const query = listUsersQuerySchema.parse({ role: c.req.query("role") });
  const db = requireSupabase(c);
  const actor = c.get("user");
  return c.json(await repo.listStaff(db, actor.organizationId, query.role));
});

/**
 * Creates a staff user with the org's shared temporary password; they must change it
 * (OTP-verified) on first login, exactly like seeded students.
 */
users.post("/", async (c) => {
  const body = createUserSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const actor = c.get("user");

  const existing = await repo.findByEmail(db, actor.organizationId, body.email);
  if (existing) throw new HTTPException(409, { message: "Email already registered" });

  const tempPassword = c.env.TEMP_STUDENT_PASSWORD ?? "Student@123";
  // Hashing stays here, next to the bcrypt import: the repository layer never
  // receives a plaintext credential.
  const created = await repo.create(db, {
    organizationId: actor.organizationId,
    email: body.email,
    name: body.name,
    role: body.role,
    externalId: body.externalId,
    passwordHash: await bcrypt.hash(tempPassword, 10),
    mustChangePassword: true,
  });

  return c.json({ ...created, temporaryPassword: tempPassword }, 201);
});

/** Change a user's role or deactivate them. */
users.put("/:id", async (c) => {
  const body = updateUserSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const actor = c.get("user");
  const id = c.req.param("id");

  const target = await repo.findInOrg(db, id, actor.organizationId);
  if (!target) throw new HTTPException(404, { message: "User not found" });

  // Guard against an admin locking themselves out of their own admin rights.
  if (target.id === actor.sub && (body.role !== undefined || body.isActive === false)) {
    throw new HTTPException(400, {
      message: "You cannot change your own role or deactivate yourself",
    });
  }
  // Only a SUPER_ADMIN may create or modify another SUPER_ADMIN.
  if (
    (target.role === "SUPER_ADMIN" || body.role === "SUPER_ADMIN") &&
    actor.role !== "SUPER_ADMIN"
  ) {
    throw new HTTPException(403, {
      message: "Only a SUPER_ADMIN can manage SUPER_ADMIN accounts",
    });
  }

  return c.json(await repo.update(db, id, body));
});

/**
 * Deactivates rather than deletes: attendance, audit logs and marked-by references
 * must survive, so a hard delete would either cascade away history or fail outright.
 */
users.delete("/:id", async (c) => {
  const db = requireSupabase(c);
  const actor = c.get("user");
  const id = c.req.param("id");

  const target = await repo.findInOrg(db, id, actor.organizationId);
  if (!target) throw new HTTPException(404, { message: "User not found" });
  if (target.id === actor.sub) {
    throw new HTTPException(400, { message: "You cannot deactivate yourself" });
  }
  if (target.role === "SUPER_ADMIN" && actor.role !== "SUPER_ADMIN") {
    throw new HTTPException(403, { message: "Only a SUPER_ADMIN can deactivate a SUPER_ADMIN" });
  }

  await repo.deactivate(db, id);
  return c.json({ deactivated: true });
});

export default users;
