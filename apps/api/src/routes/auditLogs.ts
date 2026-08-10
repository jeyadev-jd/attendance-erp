// Audit logs, served from Supabase over HTTPS.
//
// Mounted at /api/v2/audit-logs alongside the Prisma/D1 router.
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireSupabase } from "../middleware/supabase";
import { auditLogQuerySchema } from "../schemas/attendance";
import * as repo from "@attendance/db/repos/auditLogs";

const auditLogs = new Hono<AppEnv>();

auditLogs.get("/", async (c) => {
  const query = auditLogQuerySchema.parse({
    studentId: c.req.query("studentId"),
    sectionId: c.req.query("sectionId"),
    subjectId: c.req.query("subjectId"),
    dateFrom: c.req.query("dateFrom"),
    dateTo: c.req.query("dateTo"),
  });
  const db = requireSupabase(c);
  const user = c.get("user");

  // Every filter runs in PostgreSQL against the joined attendance row, so the
  // Worker receives only the logs the caller asked for.
  return c.json(await repo.listByOrg(db, user.organizationId, query));
});

export default auditLogs;
