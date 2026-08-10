// Departments, served from Supabase over HTTPS.
//
// Mounted at /api/v2/departments alongside the existing Prisma/D1 router at
// /api/departments, which is untouched and still serves production. Running both in
// parallel means the two can be compared against the same live JWT and the same data
// before anything is cut over; when the migration completes this file replaces
// routes/departments.ts and the /v2 prefix goes away.
//
// Business logic is unchanged from the original: same role guards, same org scoping,
// same status codes, same response shapes. Only the transport moved.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { requireSupabase } from "../middleware/supabase";
import { createDepartmentSchema, updateDepartmentSchema } from "../schemas/academic";
import * as repo from "@attendance/db/repos/departments";

const departments = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN");

departments.get("/", async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  return c.json(await repo.listByOrg(db, user.organizationId));
});

departments.get("/:id", async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  const dept = await repo.findWithRelations(db, c.req.param("id"), user.organizationId);
  if (!dept) throw new HTTPException(404, { message: "Department not found" });
  return c.json(dept);
});

departments.post("/", canManage, async (c) => {
  const body = createDepartmentSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");

  const existing = await repo.findByCode(db, user.organizationId, body.code);
  if (existing) throw new HTTPException(409, { message: "Department code already exists" });

  const dept = await repo.create(db, { ...body, organizationId: user.organizationId });
  // Null means the insert lost a race with a concurrent create — same 409 the
  // pre-check above would have produced, decided by the unique constraint instead.
  if (!dept) throw new HTTPException(409, { message: "Department code already exists" });
  return c.json(dept, 201);
});

departments.put("/:id", canManage, async (c) => {
  const body = updateDepartmentSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");

  const existing = await repo.findInOrg(db, c.req.param("id"), user.organizationId);
  if (!existing) throw new HTTPException(404, { message: "Department not found" });

  return c.json(await repo.update(db, existing.id, body));
});

departments.delete("/:id", canManage, async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");

  const existing = await repo.findInOrg(db, c.req.param("id"), user.organizationId);
  if (!existing) throw new HTTPException(404, { message: "Department not found" });

  await repo.remove(db, existing.id);
  return c.json({ deleted: true });
});

export default departments;
