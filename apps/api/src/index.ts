import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import type { AppEnv } from "./types";
import { prismaMiddleware } from "./middleware/prisma";
import { supabaseMiddleware } from "./middleware/supabase";
import { jwtMiddleware } from "./middleware/auth";
import auth from "./routes/auth";
import departments from "./routes/departments";
import departmentsSupabase from "./routes/departmentsSupabase";
import subjectsSupabase from "./routes/subjectsSupabase";
import sectionsSupabase from "./routes/sectionsSupabase";
import facultySupabase from "./routes/facultySupabase";
import academicYearsSupabase from "./routes/academicYearsSupabase";
import semestersSupabase from "./routes/semestersSupabase";
import studentsSupabase from "./routes/studentsSupabase";
import usersSupabase from "./routes/usersSupabase";
import notificationsSupabase from "./routes/notificationsSupabase";
import settingsSupabase from "./routes/settingsSupabase";
import auditLogsSupabase from "./routes/auditLogsSupabase";
import hourConfigSupabase from "./routes/hourConfigSupabase";
import calendarSupabase from "./routes/calendarSupabase";
import timetableSupabase from "./routes/timetableSupabase";
import attendanceSupabase from "./routes/attendanceSupabase";
import studentPortalSupabase from "./routes/studentPortalSupabase";
import analyticsSupabase from "./routes/analyticsSupabase";
import reportsSupabase from "./routes/reportsSupabase";
import sections from "./routes/sections";
import subjects from "./routes/subjects";
import timetable from "./routes/timetable";
import students from "./routes/students";
import faculty from "./routes/faculty";
import academicYears from "./routes/academicYears";
import users from "./routes/users";
import attendance from "./routes/attendance";
import auditLogs from "./routes/auditLogs";
import studentPortal from "./routes/studentPortal";
import analytics from "./routes/analytics";
import semesters from "./routes/semesters";
import calendar from "./routes/calendar";
import hourConfig from "./routes/hourConfig";
import settings from "./routes/settings";
import reports from "./routes/reports";
import notifications from "./routes/notifications";
import { getPrismaClient } from "@attendance/db";
import { runNightlyJob } from "./lib/cron";
import { runNightlyJob as runNightlyJobSupabase } from "./lib/cronSupabase";
import { getSupabase } from "@attendance/db/supabase";

const app = new Hono<AppEnv>();

app.use(
  "*",
  cors({
    origin: "*", // tighten to your deployed web origin before production
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

app.use("*", prismaMiddleware);
// No-op unless SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set, so production —
// which sets neither — keeps serving every route from D1.
app.use("*", supabaseMiddleware);

app.onError((err, c) => {
  if (err instanceof ZodError) {
    return c.json({ error: "Validation failed", issues: err.issues }, 400);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

// Public routes
app.route("/api/auth", auth);

// Everything below requires a valid JWT.
app.use("/api/*", jwtMiddleware);

app.get("/api/health", (c) => c.json({ ok: true }));

app.route("/api/departments", departments);

// Migration preview: the same endpoints served from Supabase over HTTPS, mounted in
// parallel so both paths can be exercised with one JWT against one dataset. Returns
// 500 ("Supabase is not configured") wherever the Supabase vars are absent, which is
// everywhere except the preview configuration. Retired at cutover, when these
// replace their /api counterparts.
app.route("/api/v2/departments", departmentsSupabase);
app.route("/api/v2/subjects", subjectsSupabase);
app.route("/api/v2/sections", sectionsSupabase);
app.route("/api/v2/faculty", facultySupabase);
app.route("/api/v2/academic-years", academicYearsSupabase);
app.route("/api/v2/semesters", semestersSupabase);
app.route("/api/v2/students", studentsSupabase);
app.route("/api/v2/users", usersSupabase);
app.route("/api/v2/notifications", notificationsSupabase);
app.route("/api/v2/settings", settingsSupabase);
app.route("/api/v2/audit-logs", auditLogsSupabase);
app.route("/api/v2/hour-config", hourConfigSupabase);
app.route("/api/v2/calendar", calendarSupabase);
app.route("/api/v2/timetable", timetableSupabase);
app.route("/api/v2/attendance", attendanceSupabase);
app.route("/api/v2/student", studentPortalSupabase);
app.route("/api/v2/admin/analytics", analyticsSupabase);
app.route("/api/v2/reports", reportsSupabase);
app.route("/api/sections", sections);
app.route("/api/subjects", subjects);
app.route("/api/timetable", timetable);
app.route("/api/students", students);
app.route("/api/faculty", faculty);
app.route("/api/users", users);
app.route("/api/attendance", attendance);
app.route("/api/audit-logs", auditLogs);
app.route("/api/student", studentPortal);
app.route("/api/admin/analytics", analytics);
app.route("/api/academic-years", academicYears);
app.route("/api/semesters", semesters);
app.route("/api/calendar", calendar);
app.route("/api/hour-config", hourConfig);
app.route("/api/settings", settings);
app.route("/api/reports", reports);
app.route("/api/notifications", notifications);

export default {
  fetch: app.fetch,

  /**
   * Nightly job. Runs against Supabase when the Worker is configured for it, and
   * falls back to D1 otherwise.
   *
   * The fallback is deliberate here, and is the one place in the migration where a
   * fallback is correct: unlike a request handler, nothing observes a cron failure
   * until the next morning's missing alerts. Production sets no Supabase vars, so it
   * keeps running the D1 job unchanged; the preview configuration runs the Supabase
   * one. At cutover the D1 branch goes away with the rest of Prisma.
   */
  async scheduled(_event: ScheduledEvent, env: AppEnv["Bindings"], ctx: ExecutionContext) {
    if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
      const db = getSupabase({
        SUPABASE_URL: env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
      });
      ctx.waitUntil(
        runNightlyJobSupabase(db).then((result) => {
          console.log("Nightly cron completed (Supabase)", JSON.stringify(result));
        })
      );
      return;
    }

    const prisma = getPrismaClient({ DB: env.DB });
    ctx.waitUntil(
      runNightlyJob(prisma).then((result) => {
        console.log("Nightly cron completed", JSON.stringify(result));
      })
    );
  },
};
