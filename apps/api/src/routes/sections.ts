// Sections, served from Supabase over HTTPS.
//
// Mounted at /api/v2/sections alongside the Prisma/D1 router at /api/sections, which
// still serves production. Logic, guards, status codes and response shapes are
// unchanged — only the transport moved.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { requireSupabase } from "../middleware/supabase";
import { createSectionSchema, updateSectionSchema } from "../schemas/academic";
import * as repo from "@attendance/db/repos/sections";
import * as deptRepo from "@attendance/db/repos/departments";
import { findSemesterInOrg } from "@attendance/db/queries";
import type { SupabaseClient } from "@supabase/supabase-js";

const sections = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN");

/** Mirrors the assertSemesterInOrg guard in the Prisma router, including its 404. */
async function assertSemesterInOrg(
  db: SupabaseClient,
  semesterId: string,
  organizationId: string
) {
  const semester = await findSemesterInOrg(db, semesterId, organizationId);
  if (!semester) throw new HTTPException(404, { message: "Semester not found" });
  return semester;
}

/** Mirrors the assertDepartmentInOrg guard in the Prisma router, including its 404. */
async function assertDepartmentInOrg(
  db: SupabaseClient,
  departmentId: string,
  organizationId: string
) {
  const dept = await deptRepo.findInOrg(db, departmentId, organizationId);
  if (!dept) throw new HTTPException(404, { message: "Department not found" });
  return dept;
}

sections.get("/", async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  return c.json(
    await repo.listByOrg(db, user.organizationId, {
      semesterId: c.req.query("semesterId"),
      departmentId: c.req.query("departmentId"),
    })
  );
});

sections.get("/:id", async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  const section = await repo.findWithRelations(db, c.req.param("id"), user.organizationId);
  if (!section) throw new HTTPException(404, { message: "Section not found" });
  return c.json(section);
});

sections.post("/", canManage, async (c) => {
  const body = createSectionSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");

  // Both parents are checked before the insert, exactly as the Prisma route does.
  // They are independent lookups, so they run together rather than serially — one
  // round trip instead of two.
  await Promise.all([
    assertSemesterInOrg(db, body.semesterId, user.organizationId),
    assertDepartmentInOrg(db, body.departmentId, user.organizationId),
  ]);

  const existing = await repo.findByKey(db, body.semesterId, body.departmentId, body.name);
  if (existing) {
    throw new HTTPException(409, {
      message: "Section already exists for this semester/department",
    });
  }

  const section = await repo.create(db, body);
  if (!section) {
    throw new HTTPException(409, {
      message: "Section already exists for this semester/department",
    });
  }
  return c.json(section, 201);
});

sections.put("/:id", canManage, async (c) => {
  const body = updateSectionSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");

  const existing = await repo.findInOrg(db, c.req.param("id"), user.organizationId);
  if (!existing) throw new HTTPException(404, { message: "Section not found" });

  return c.json(await repo.update(db, existing.id, body));
});

sections.delete("/:id", canManage, async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");

  const existing = await repo.findInOrg(db, c.req.param("id"), user.organizationId);
  if (!existing) throw new HTTPException(404, { message: "Section not found" });

  await repo.remove(db, existing.id);
  return c.json({ deleted: true });
});

export default sections;
