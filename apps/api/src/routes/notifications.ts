import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { listQuerySchema, broadcastSchema } from "../schemas/notifications";

const notifications = new Hono<AppEnv>();

notifications.get("/", async (c) => {
  const query = listQuerySchema.parse({ isRead: c.req.query("isRead"), limit: c.req.query("limit") });
  const prisma = c.get("prisma");
  const user = c.get("user");

  const list = await prisma.notification.findMany({
    where: { userId: user.sub, ...(query.isRead !== undefined ? { isRead: query.isRead === "true" } : {}) },
    orderBy: { createdAt: "desc" },
    take: query.limit,
  });
  return c.json(list);
});

notifications.get("/unread-count", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const count = await prisma.notification.count({ where: { userId: user.sub, isRead: false } });
  return c.json({ count });
});

notifications.put("/:id/read", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await prisma.notification.findFirst({ where: { id, userId: user.sub } });
  if (!existing) throw new HTTPException(404, { message: "Notification not found" });

  const updated = await prisma.notification.update({ where: { id }, data: { isRead: true } });
  return c.json(updated);
});

notifications.post("/read-all", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const result = await prisma.notification.updateMany({
    where: { userId: user.sub, isRead: false },
    data: { isRead: true },
  });
  return c.json({ updated: result.count });
});

notifications.delete("/:id", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await prisma.notification.findFirst({ where: { id, userId: user.sub } });
  if (!existing) throw new HTTPException(404, { message: "Notification not found" });

  await prisma.notification.delete({ where: { id } });
  return c.json({ deleted: true });
});

/** Admin broadcast: sends an ANNOUNCEMENT to every user matching role and/or section (students only for section scope). */
notifications.post("/broadcast", roleGuard("SUPER_ADMIN", "ADMIN"), async (c) => {
  const body = broadcastSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");

  let userIds: string[];

  if (body.sectionId) {
    const students = await prisma.student.findMany({
      where: { sectionId: body.sectionId, section: { semester: { academicYear: { organizationId: user.organizationId } } } },
      select: { userId: true },
    });
    userIds = students.map((s: any) => s.userId);
  } else {
    const users = await prisma.user.findMany({
      where: { organizationId: user.organizationId, ...(body.role ? { role: body.role } : {}), isActive: true },
      select: { id: true },
    });
    userIds = users.map((u: any) => u.id);
  }

  if (userIds.length === 0) return c.json({ sent: 0 });

  const result = await prisma.notification.createMany({
    data: userIds.map((userId) => ({
      userId,
      type: "ANNOUNCEMENT",
      title: body.title,
      message: body.message,
    })),
  });

  return c.json({ sent: result.count });
});

export default notifications;
