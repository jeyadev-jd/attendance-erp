import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { createAcademicYearSchema, updateAcademicYearSchema } from "../schemas/academicYears";

const academicYears = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN");

/**
 * Academic years are the root of the structural chain
 * (academic_year -> semester -> section -> attendance), so without at least one
 * the rest of setup is unreachable.
 */
academicYears.get("/", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const list = await prisma.academicYear.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { startDate: "desc" },
  });
  return c.json(list);
});

academicYears.post("/", canManage, async (c) => {
  const body = createAcademicYearSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");

  const created = await prisma.academicYear.create({
    data: {
      organizationId: user.organizationId,
      label: body.label,
      startDate: new Date(`${body.startDate}T00:00:00.000Z`),
      endDate: new Date(`${body.endDate}T00:00:00.000Z`),
    },
  });
  return c.json(created, 201);
});

academicYears.put("/:id", canManage, async (c) => {
  const body = updateAcademicYearSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await prisma.academicYear.findFirst({ where: { id, organizationId: user.organizationId } });
  if (!existing) throw new HTTPException(404, { message: "Academic year not found" });

  const updated = await prisma.academicYear.update({
    where: { id },
    data: {
      ...(body.label ? { label: body.label } : {}),
      ...(body.startDate ? { startDate: new Date(`${body.startDate}T00:00:00.000Z`) } : {}),
      ...(body.endDate ? { endDate: new Date(`${body.endDate}T00:00:00.000Z`) } : {}),
    },
  });
  return c.json(updated);
});

/** Refuses to delete while semesters still hang off it — cascading would wipe attendance history. */
academicYears.delete("/:id", canManage, async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await prisma.academicYear.findFirst({
    where: { id, organizationId: user.organizationId },
    include: { _count: { select: { semesters: true } } },
  });
  if (!existing) throw new HTTPException(404, { message: "Academic year not found" });
  if (existing._count.semesters > 0) {
    throw new HTTPException(409, { message: "Archive or remove its semesters first" });
  }

  await prisma.academicYear.delete({ where: { id } });
  return c.json({ deleted: true });
});

export default academicYears;
