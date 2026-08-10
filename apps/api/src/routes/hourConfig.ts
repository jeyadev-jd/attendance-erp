// Hour config, served from Supabase over HTTPS.
//
// Mounted at /api/v2/hour-config alongside the Prisma/D1 router.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { requireSupabase } from "../middleware/supabase";
import {
  assertSemesterInOrg,
  assertSemesterWritable,
} from "../lib/semesterGuard";
import { setHourConfigSchema, bulkSetDaySchema } from "../schemas/hourConfig";
import * as repo from "@attendance/db/repos/hourConfig";

const hourConfig = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN");

/** Lists all hour configs for a semester, grouped by day of week (0=Sunday..6=Saturday). */
hourConfig.get("/", async (c) => {
  const semesterId = c.req.query("semesterId");
  if (!semesterId) throw new HTTPException(400, { message: "semesterId query param is required" });
  const db = requireSupabase(c);
  const user = c.get("user");
  await assertSemesterInOrg(db, semesterId, user.organizationId);

  const configs = await repo.listBySemester(db, semesterId);

  // Grouping stays in the Worker: the rows are already ordered and bounded by the
  // semester's hour layout (tens of rows, not thousands), and the response shape is
  // a keyed object that SQL would have to build as JSON anyway.
  const grouped: Record<number, typeof configs> = {};
  for (const cfg of configs) {
    (grouped[cfg.dayOfWeek] ??= []).push(cfg);
  }
  return c.json(grouped);
});

/** Upserts a single hour's start/end time for one day of week. */
hourConfig.post("/", canManage, async (c) => {
  const body = setHourConfigSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");
  await assertSemesterWritable(db, body.semesterId, user.organizationId);

  return c.json(await repo.upsert(db, body));
});

/**
 * Replaces the entire hour layout for one day of week in a semester — e.g. set
 * all 6 hours for Monday at once. Different days can have different hour
 * counts, so this fully replaces (delete + recreate) rather than merging.
 */
hourConfig.post("/day", canManage, async (c) => {
  const body = bulkSetDaySchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");
  await assertSemesterWritable(db, body.semesterId, user.organizationId);

  const hoursSet = await repo.replaceDay(db, body.semesterId, body.dayOfWeek, body.hours);
  return c.json({ dayOfWeek: body.dayOfWeek, hoursSet });
});

hourConfig.delete("/:id", canManage, async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await repo.findInOrg(db, id, user.organizationId);
  if (!existing) throw new HTTPException(404, { message: "Hour config not found" });

  await repo.remove(db, id);
  return c.json({ deleted: true });
});

export default hourConfig;
