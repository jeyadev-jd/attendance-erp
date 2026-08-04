import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { assertSemesterInOrg, assertSemesterWritable } from "../lib/semesterGuard";
import { setHourConfigSchema, bulkSetDaySchema } from "../schemas/hourConfig";

const hourConfig = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN");

/** Lists all hour configs for a semester, grouped by day of week (0=Sunday..6=Saturday). */
hourConfig.get("/", async (c) => {
  const semesterId = c.req.query("semesterId");
  if (!semesterId) throw new HTTPException(400, { message: "semesterId query param is required" });
  const prisma = c.get("prisma");
  const user = c.get("user");
  await assertSemesterInOrg(prisma, semesterId, user.organizationId);

  const configs = await prisma.hourConfig.findMany({
    where: { semesterId },
    orderBy: [{ dayOfWeek: "asc" }, { hourNumber: "asc" }],
  });

  const grouped: Record<number, typeof configs> = {};
  for (const cfg of configs) {
    (grouped[cfg.dayOfWeek] ??= []).push(cfg);
  }
  return c.json(grouped);
});

/** Upserts a single hour's start/end time for one day of week. */
hourConfig.post("/", canManage, async (c) => {
  const body = setHourConfigSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");
  await assertSemesterWritable(prisma, body.semesterId, user.organizationId);

  const config = await prisma.hourConfig.upsert({
    where: {
      semesterId_dayOfWeek_hourNumber: {
        semesterId: body.semesterId,
        dayOfWeek: body.dayOfWeek,
        hourNumber: body.hourNumber,
      },
    },
    update: { startTime: body.startTime, endTime: body.endTime },
    create: body,
  });
  return c.json(config);
});

/**
 * Replaces the entire hour layout for one day of week in a semester — e.g. set
 * all 6 hours for Monday at once. Different days can have different hour
 * counts, so this fully replaces (delete + recreate) rather than merging.
 */
hourConfig.post("/day", canManage, async (c) => {
  const body = bulkSetDaySchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");
  await assertSemesterWritable(prisma, body.semesterId, user.organizationId);

  await prisma.$transaction([
    prisma.hourConfig.deleteMany({ where: { semesterId: body.semesterId, dayOfWeek: body.dayOfWeek } }),
    prisma.hourConfig.createMany({
      data: body.hours.map((h) => ({
        semesterId: body.semesterId,
        dayOfWeek: body.dayOfWeek,
        hourNumber: h.hourNumber,
        startTime: h.startTime,
        endTime: h.endTime,
      })),
    }),
  ]);

  return c.json({ dayOfWeek: body.dayOfWeek, hoursSet: body.hours.length });
});

hourConfig.delete("/:id", canManage, async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await prisma.hourConfig.findFirst({
    where: { id, semester: { academicYear: { organizationId: user.organizationId } } },
  });
  if (!existing) throw new HTTPException(404, { message: "Hour config not found" });

  await prisma.hourConfig.delete({ where: { id } });
  return c.json({ deleted: true });
});

export default hourConfig;
