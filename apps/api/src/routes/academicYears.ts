// Academic years, served from Supabase over HTTPS.
//
// Mounted at /api/v2/academic-years alongside the Prisma/D1 router at
// /api/academic-years. Logic, guards, status codes and response shapes unchanged.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { requireSupabase } from "../middleware/supabase";
import { createAcademicYearSchema, updateAcademicYearSchema } from "../schemas/academicYears";
import * as repo from "@attendance/db/repos/academicYears";

const academicYears = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN");

academicYears.get("/", async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  return c.json(await repo.listByOrg(db, user.organizationId));
});

academicYears.post("/", canManage, async (c) => {
  const body = createAcademicYearSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");

  // Dates arrive as YYYY-MM-DD and are stored at UTC midnight, matching the Prisma
  // route's `new Date(\`${body.startDate}T00:00:00.000Z\`)`.
  const created = await repo.create(db, {
    organizationId: user.organizationId,
    label: body.label,
    startDate: `${body.startDate}T00:00:00.000Z`,
    endDate: `${body.endDate}T00:00:00.000Z`,
  });
  return c.json(created, 201);
});

academicYears.put("/:id", canManage, async (c) => {
  const body = updateAcademicYearSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await repo.findInOrg(db, id, user.organizationId);
  if (!existing) throw new HTTPException(404, { message: "Academic year not found" });

  return c.json(
    await repo.update(db, id, {
      ...(body.label ? { label: body.label } : {}),
      ...(body.startDate ? { startDate: `${body.startDate}T00:00:00.000Z` } : {}),
      ...(body.endDate ? { endDate: `${body.endDate}T00:00:00.000Z` } : {}),
    })
  );
});

/** Refuses to delete while semesters still hang off it — cascading would wipe attendance history. */
academicYears.delete("/:id", canManage, async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await repo.findInOrg(db, id, user.organizationId);
  if (!existing) throw new HTTPException(404, { message: "Academic year not found" });

  // Counted in PostgreSQL with head:true — no semester rows cross the wire, only
  // the number. Replaces Prisma's `_count` include.
  const semesterCount = await repo.countSemesters(db, id);
  if (semesterCount > 0) {
    throw new HTTPException(409, { message: "Archive or remove its semesters first" });
  }

  await repo.remove(db, id);
  return c.json({ deleted: true });
});

export default academicYears;
