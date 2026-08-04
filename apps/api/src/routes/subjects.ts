import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { createSubjectSchema, updateSubjectSchema } from "../schemas/academic";

const subjects = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN");

subjects.get("/", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const departmentId = c.req.query("departmentId");

  const list = await prisma.subject.findMany({
    where: {
      ...(departmentId ? { departmentId } : {}),
      department: { organizationId: user.organizationId },
    },
    orderBy: { name: "asc" },
  });
  return c.json(list);
});

subjects.get("/:id", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const subject = await prisma.subject.findFirst({
    where: { id: c.req.param("id"), department: { organizationId: user.organizationId } },
  });
  if (!subject) throw new HTTPException(404, { message: "Subject not found" });
  return c.json(subject);
});

subjects.post("/", canManage, async (c) => {
  const body = createSubjectSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");

  const dept = await prisma.department.findFirst({
    where: { id: body.departmentId, organizationId: user.organizationId },
  });
  if (!dept) throw new HTTPException(404, { message: "Department not found" });

  const existing = await prisma.subject.findUnique({
    where: { departmentId_code: { departmentId: body.departmentId, code: body.code } },
  });
  if (existing) throw new HTTPException(409, { message: "Subject code already exists in department" });

  const subject = await prisma.subject.create({ data: body });
  return c.json(subject, 201);
});

subjects.put("/:id", canManage, async (c) => {
  const body = updateSubjectSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");

  const existing = await prisma.subject.findFirst({
    where: { id: c.req.param("id"), department: { organizationId: user.organizationId } },
  });
  if (!existing) throw new HTTPException(404, { message: "Subject not found" });

  const subject = await prisma.subject.update({ where: { id: existing.id }, data: body });
  return c.json(subject);
});

subjects.delete("/:id", canManage, async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");

  const existing = await prisma.subject.findFirst({
    where: { id: c.req.param("id"), department: { organizationId: user.organizationId } },
  });
  if (!existing) throw new HTTPException(404, { message: "Subject not found" });

  await prisma.subject.delete({ where: { id: existing.id } });
  return c.json({ deleted: true });
});

export default subjects;
