// Faculty directory, served from Supabase over HTTPS.
//
// Mounted at /api/v2/faculty alongside the Prisma/D1 router at /api/faculty.
// Read-only, as the original is: faculty records are created through user
// onboarding, not here.
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireSupabase } from "../middleware/supabase";
import * as repo from "@attendance/db/repos/faculty";

const faculty = new Hono<AppEnv>();

faculty.get("/", async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  return c.json(await repo.listByOrg(db, user.organizationId, c.req.query("departmentId")));
});

export default faculty;
