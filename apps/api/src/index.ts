import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import type { AppEnv } from "./types";
import { supabaseMiddleware } from "./middleware/supabase";
import { jwtMiddleware } from "./middleware/auth";
import auth from "./routes/auth";
import departments from "./routes/departments";
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
import { getSupabase } from "@attendance/db/supabase";
import { runNightlyJob } from "./lib/cron";

const app = new Hono<AppEnv>();

app.use(
  "*",
  cors({
    origin: "*", // tighten to your deployed web origin before production
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// Every route reads its data through this client. It is built per request: the
// client wraps fetch and holds no socket, so there is no connection state to pool
// or to go stale between invocations.
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

  async scheduled(_event: ScheduledEvent, env: AppEnv["Bindings"], ctx: ExecutionContext) {
    const db = getSupabase({
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    });
    ctx.waitUntil(
      runNightlyJob(db).then((result) => {
        console.log("Nightly cron completed", JSON.stringify(result));
      })
    );
  },
};
