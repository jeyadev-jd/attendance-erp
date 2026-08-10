// Notifications, served from Supabase over HTTPS.
//
// Mounted at /api/v2/notifications alongside the Prisma/D1 router.
// Logic, guards, status codes and response shapes unchanged.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { requireSupabase } from "../middleware/supabase";
import { listQuerySchema, broadcastSchema } from "../schemas/notifications";
import * as repo from "@attendance/db/repos/notifications";

const notifications = new Hono<AppEnv>();

notifications.get("/", async (c) => {
  const query = listQuerySchema.parse({
    isRead: c.req.query("isRead"),
    limit: c.req.query("limit"),
  });
  const db = requireSupabase(c);
  const user = c.get("user");

  return c.json(
    await repo.listForUser(db, user.sub, {
      isRead: query.isRead !== undefined ? query.isRead === "true" : undefined,
      limit: query.limit,
    })
  );
});

notifications.get("/unread-count", async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  return c.json({ count: await repo.unreadCount(db, user.sub) });
});

notifications.put("/:id/read", async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await repo.findForUser(db, id, user.sub);
  if (!existing) throw new HTTPException(404, { message: "Notification not found" });

  return c.json(await repo.markRead(db, id));
});

notifications.post("/read-all", async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  return c.json({ updated: await repo.markAllRead(db, user.sub) });
});

notifications.delete("/:id", async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await repo.findForUser(db, id, user.sub);
  if (!existing) throw new HTTPException(404, { message: "Notification not found" });

  await repo.remove(db, id);
  return c.json({ deleted: true });
});

/** Admin broadcast: sends an ANNOUNCEMENT to every user matching role and/or section (students only for section scope). */
notifications.post("/broadcast", roleGuard("SUPER_ADMIN", "ADMIN"), async (c) => {
  const body = broadcastSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");

  // The audience is resolved to ids in one query, then written in one batched
  // insert — two requests regardless of how many recipients there are.
  const userIds = body.sectionId
    ? await repo.studentUserIdsInSection(db, body.sectionId, user.organizationId)
    : await repo.activeUserIds(db, user.organizationId, body.role);

  if (userIds.length === 0) return c.json({ sent: 0 });

  const sent = await repo.createMany(db, userIds, {
    type: "ANNOUNCEMENT",
    title: body.title,
    message: body.message,
  });
  return c.json({ sent });
});

export default notifications;
