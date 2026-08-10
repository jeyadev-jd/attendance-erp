// Subjects, served from Supabase over HTTPS.
//
// Mounted at /api/v2/subjects alongside the Prisma/D1 router at /api/subjects, which
// still serves production. Logic, guards, status codes and response shapes are
// unchanged — only the transport moved.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { requireSupabase } from "../middleware/supabase";
import { createSubjectSchema, updateSubjectSchema } from "../schemas/academic";
import * as repo from "@attendance/db/repos/subjects";
import * as deptRepo from "@attendance/db/repos/departments";

const subjects = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN");

subjects.get("/", async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  const departmentId = c.req.query("departmentId");
  return c.json(await repo.listByOrg(db, user.organizationId, departmentId));
});

subjects.get("/:id", async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  const subject = await repo.findInOrg(db, c.req.param("id"), user.organizationId);
  if (!subject) throw new HTTPException(404, { message: "Subject not found" });
  return c.json(subject);
});

subjects.post("/", canManage, async (c) => {
  const body = createSubjectSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");

  // The department must belong to the caller's org — otherwise a subject could be
  // attached to another tenant's department by passing its id.
  const dept = await deptRepo.findInOrg(db, body.departmentId, user.organizationId);
  if (!dept) throw new HTTPException(404, { message: "Department not found" });

  const existing = await repo.findByCode(db, body.departmentId, body.code);
  if (existing) {
    throw new HTTPException(409, { message: "Subject code already exists in department" });
  }

  const subject = await repo.create(db, body);
  // Null means the insert lost a race with a concurrent create; the unique
  // constraint decides, producing the same 409 as the pre-check above.
  if (!subject) {
    throw new HTTPException(409, { message: "Subject code already exists in department" });
  }
  return c.json(subject, 201);
});

subjects.put("/:id", canManage, async (c) => {
  const body = updateSubjectSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");

  const existing = await repo.findInOrg(db, c.req.param("id"), user.organizationId);
  if (!existing) throw new HTTPException(404, { message: "Subject not found" });

  return c.json(await repo.update(db, existing.id, body));
});

subjects.delete("/:id", canManage, async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");

  const existing = await repo.findInOrg(db, c.req.param("id"), user.organizationId);
  if (!existing) throw new HTTPException(404, { message: "Subject not found" });

  await repo.remove(db, existing.id);
  return c.json({ deleted: true });
});

export default subjects;
