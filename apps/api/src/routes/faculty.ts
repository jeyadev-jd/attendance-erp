import { Hono } from "hono";
import type { AppEnv } from "../types";

const faculty = new Hono<AppEnv>();

/**
 * Read-only faculty directory, org-scoped. Exists so the timetable builder and
 * report filters can offer a faculty picker; faculty records themselves are
 * created through user onboarding, not here.
 */
faculty.get("/", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const departmentId = c.req.query("departmentId");

  const list = await prisma.faculty.findMany({
    where: {
      ...(departmentId ? { departmentId } : {}),
      department: { organizationId: user.organizationId },
    },
    include: { user: { select: { email: true } } },
    orderBy: { name: "asc" },
  });

  return c.json(
    list.map((f: any) => ({
      id: f.id,
      employeeId: f.employeeId,
      departmentId: f.departmentId,
      name: f.name,
      email: f.user?.email ?? "",
    }))
  );
});

export default faculty;
