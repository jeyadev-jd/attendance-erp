import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { createSectionSchema, updateSectionSchema } from "../schemas/academic";

const sections = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN");

async function assertSemesterInOrg(prisma: any, semesterId: string, organizationId: string) {
  const semester = await prisma.semester.findFirst({
    where: { id: semesterId, academicYear: { organizationId } },
  });
  if (!semester) throw new HTTPException(404, { message: "Semester not found" });
  return semester;
}

async function assertDepartmentInOrg(prisma: any, departmentId: string, organizationId: string) {
  const dept = await prisma.department.findFirst({ where: { id: departmentId, organizationId } });
  if (!dept) throw new HTTPException(404, { message: "Department not found" });
  return dept;
}

sections.get("/", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const semesterId = c.req.query("semesterId");
  const departmentId = c.req.query("departmentId");

  const list = await prisma.section.findMany({
    where: {
      ...(semesterId ? { semesterId } : {}),
      ...(departmentId ? { departmentId } : {}),
      semester: { academicYear: { organizationId: user.organizationId } },
    },
    orderBy: { name: "asc" },
  });
  return c.json(list);
});

sections.get("/:id", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const section = await prisma.section.findFirst({
    where: { id: c.req.param("id"), semester: { academicYear: { organizationId: user.organizationId } } },
    include: { students: true, timetables: true },
  });
  if (!section) throw new HTTPException(404, { message: "Section not found" });
  return c.json(section);
});

sections.post("/", canManage, async (c) => {
  const body = createSectionSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");

  await assertSemesterInOrg(prisma, body.semesterId, user.organizationId);
  await assertDepartmentInOrg(prisma, body.departmentId, user.organizationId);

  const existing = await prisma.section.findUnique({
    where: {
      semesterId_departmentId_name: {
        semesterId: body.semesterId,
        departmentId: body.departmentId,
        name: body.name,
      },
    },
  });
  if (existing) throw new HTTPException(409, { message: "Section already exists for this semester/department" });

  const section = await prisma.section.create({ data: body });
  return c.json(section, 201);
});

sections.put("/:id", canManage, async (c) => {
  const body = updateSectionSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");

  const existing = await prisma.section.findFirst({
    where: { id: c.req.param("id"), semester: { academicYear: { organizationId: user.organizationId } } },
  });
  if (!existing) throw new HTTPException(404, { message: "Section not found" });

  const section = await prisma.section.update({ where: { id: existing.id }, data: body });
  return c.json(section);
});

sections.delete("/:id", canManage, async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");

  const existing = await prisma.section.findFirst({
    where: { id: c.req.param("id"), semester: { academicYear: { organizationId: user.organizationId } } },
  });
  if (!existing) throw new HTTPException(404, { message: "Section not found" });

  await prisma.section.delete({ where: { id: existing.id } });
  return c.json({ deleted: true });
});

export default sections;
