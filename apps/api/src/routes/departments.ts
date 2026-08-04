import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { createDepartmentSchema, updateDepartmentSchema } from "../schemas/academic";

const departments = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN");

departments.get("/", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const list = await prisma.department.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { name: "asc" },
  });
  return c.json(list);
});

departments.get("/:id", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const dept = await prisma.department.findFirst({
    where: { id: c.req.param("id"), organizationId: user.organizationId },
    include: { sections: true, subjects: true, faculty: true },
  });
  if (!dept) throw new HTTPException(404, { message: "Department not found" });
  return c.json(dept);
});

departments.post("/", canManage, async (c) => {
  const body = createDepartmentSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");

  const existing = await prisma.department.findUnique({
    where: { organizationId_code: { organizationId: user.organizationId, code: body.code } },
  });
  if (existing) throw new HTTPException(409, { message: "Department code already exists" });

  const dept = await prisma.department.create({
    data: { ...body, organizationId: user.organizationId },
  });
  return c.json(dept, 201);
});

departments.put("/:id", canManage, async (c) => {
  const body = updateDepartmentSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");

  const existing = await prisma.department.findFirst({
    where: { id: c.req.param("id"), organizationId: user.organizationId },
  });
  if (!existing) throw new HTTPException(404, { message: "Department not found" });

  const dept = await prisma.department.update({ where: { id: existing.id }, data: body });
  return c.json(dept);
});

departments.delete("/:id", canManage, async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");

  const existing = await prisma.department.findFirst({
    where: { id: c.req.param("id"), organizationId: user.organizationId },
  });
  if (!existing) throw new HTTPException(404, { message: "Department not found" });

  await prisma.department.delete({ where: { id: existing.id } });
  return c.json({ deleted: true });
});

export default departments;
