// Admin analytics, served from Supabase over HTTPS.
//
// Mounted at /api/v2/admin/analytics alongside the Prisma/D1 router.
//
// Every endpoint here is a single RPC call. The aggregation that Prisma expressed as
// groupBy + a JavaScript fold now runs in PostgreSQL (see
// backups/phase3-rpc-functions.sql), so the Worker receives tens of rows instead of
// the semester's entire attendance table. The route's job is reduced to: authorize,
// validate, call one function, return.
//
// Parity for these five is verified end-to-end by scripts/parity/analytics.mjs, which
// runs the D1 implementation and the RPC over identical inputs and diffs the results.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { requireSupabase } from "../middleware/supabase";
import { attendancePct, isPresentStatus } from "../lib/calculators";
import {
  semesterRequiredQuerySchema,
  leaderboardQuerySchema,
  dailyBunkersQuerySchema,
  batchOverviewQuerySchema,
} from "../schemas/analytics";
import * as repo from "@attendance/db/repos/analytics";
import * as attendanceRepo from "@attendance/db/repos/attendance";
import { findSemesterInOrg, findSectionInOrg } from "@attendance/db/queries";
import type { SupabaseClient } from "@supabase/supabase-js";

const analytics = new Hono<AppEnv>();
// FACULTY is included at the router level so staff can reach the batch overview and
// the coverage reports. The bunk-prediction endpoints re-guard themselves below:
// safe-bunk maths tells a student exactly how much they can skip, which is a
// student-facing planning tool rather than something staff should hand out.
analytics.use("*", roleGuard("SUPER_ADMIN", "ADMIN", "CLASS_ADMIN", "FACULTY"));

/** Endpoints that expose bunk-prediction rather than plain attendance. */
const notFaculty = roleGuard("SUPER_ADMIN", "ADMIN", "CLASS_ADMIN");

/**
 * Mirrors the assertSemesterInOrg guard in the Prisma router, including its 404.
 *
 * The RPCs re-prove org ownership themselves, so this is defence in depth rather
 * than the only check — but it is what produces the 404 the API contract promises,
 * instead of a Postgres exception surfacing as a 500.
 */
async function assertSemesterInOrg(
  db: SupabaseClient,
  semesterId: string,
  organizationId: string
) {
  const semester = await findSemesterInOrg(db, semesterId, organizationId);
  if (!semester) throw new HTTPException(404, { message: "Semester not found" });
  return semester;
}

/** Day (0-6) × hour matrix of attendance % across the whole semester. */
analytics.get("/heatmap", async (c) => {
  const query = semesterRequiredQuerySchema.parse({
    semesterId: c.req.query("semesterId"),
    dateFrom: c.req.query("dateFrom"),
    dateTo: c.req.query("dateTo"),
  });
  const db = requireSupabase(c);
  const user = c.get("user");
  await assertSemesterInOrg(db, query.semesterId, user.organizationId);

  // Grouped and day-of-week-derived in SQL: at most 7 days x 7 hours of rows reach
  // the Worker, rather than the semester's entire attendance table.
  const cells = await repo.heatmap(db, query.semesterId, user.organizationId, query);
  return c.json({ cells });
});

/** Attendance % per subject, org-wide for the semester. */
analytics.get("/subject-comparison", async (c) => {
  const query = semesterRequiredQuerySchema.parse({
    semesterId: c.req.query("semesterId"),
    dateFrom: c.req.query("dateFrom"),
    dateTo: c.req.query("dateTo"),
  });
  const db = requireSupabase(c);
  const user = c.get("user");
  await assertSemesterInOrg(db, query.semesterId, user.organizationId);

  // The subject-name join happens in SQL, so the follow-up lookup the Prisma route
  // needed is gone.
  return c.json(await repo.subjectComparison(db, query.semesterId, user.organizationId, query));
});

/** Students ranked by bunk-flag count (mid-class bunk pattern detections), worst first. */
analytics.get("/bunk-leaderboard", notFaculty, async (c) => {
  const query = leaderboardQuerySchema.parse({
    semesterId: c.req.query("semesterId"),
    limit: c.req.query("limit"),
    dateFrom: c.req.query("dateFrom"),
    dateTo: c.req.query("dateTo"),
  });
  const db = requireSupabase(c);
  const user = c.get("user");
  await assertSemesterInOrg(db, query.semesterId, user.organizationId);

  // Ranked and limited in SQL: students outside the top `limit` never leave the
  // database. The Prisma route loaded every student's flags to return five rows.
  return c.json(
    await repo.bunkLeaderboard(db, query.semesterId, user.organizationId, query.limit, query)
  );
});

/**
 * Everyone who was absent from at least one class on a given date, with exactly
 * which hours (and which subjects) they missed that day — the "who bunked today
 * and when" view. Distinct from bunk-leaderboard, which ranks by the mid-class
 * P->A pattern over a range; this is a flat per-day roll call.
 */
analytics.get("/daily-bunkers", notFaculty, async (c) => {
  const query = dailyBunkersQuerySchema.parse({
    semesterId: c.req.query("semesterId"),
    date: c.req.query("date"),
    sectionId: c.req.query("sectionId"),
  });
  const db = requireSupabase(c);
  const user = c.get("user");
  await assertSemesterInOrg(db, query.semesterId, user.organizationId);

  // Not an RPC: this is a per-day roll call, so the rows themselves are the answer.
  // One date for one section is bounded by the roster times the day's hours — tens
  // of rows — and filtering/ordering both happen in PostgreSQL.
  const records = await attendanceRepo.listAbsentOnDate(
    db,
    query.semesterId,
    new Date(`${query.date}T00:00:00.000Z`),
    query.sectionId
  );

  type BunkerEntry = {
    studentId: string;
    rollNo: string;
    name: string;
    absences: { hourNumber: number; subject: string }[];
  };

  const byStudent = new Map<string, BunkerEntry>();
  for (const r of records as any[]) {
    const entry: BunkerEntry = byStudent.get(r.studentId) ?? {
      studentId: r.studentId,
      rollNo: r.student.rollNo,
      name: r.student.name,
      absences: [],
    };
    entry.absences.push({ hourNumber: r.hourNumber, subject: r.subject.name });
    byStudent.set(r.studentId, entry);
  }

  return c.json([...byStudent.values()].sort((a, b) => b.absences.length - a.absences.length));
});

/** Most-late students + which day/hour sees the most LATE marks. */
analytics.get("/late-analytics", async (c) => {
  const query = semesterRequiredQuerySchema.parse({
    semesterId: c.req.query("semesterId"),
    dateFrom: c.req.query("dateFrom"),
    dateTo: c.req.query("dateTo"),
  });
  const db = requireSupabase(c);
  const user = c.get("user");
  await assertSemesterInOrg(db, query.semesterId, user.organizationId);

  // Two groupBys, a student lookup and two JavaScript sorts collapse into one call.
  return c.json(await repo.lateAnalytics(db, query.semesterId, user.organizationId, query));
});

/**
 * Per subject: how many scheduled hours have actually been marked ("coverage"),
 * the attendance % across them, and how many records were later corrected.
 *
 * Reported per subject rather than per faculty because one faculty member often
 * teaches both a theory paper and its lab (e.g. Data Mining + Data Mining Lab),
 * and merging those hides that a lab is being skipped while the theory is not.
 * Lab and theory are separate subjects, so they stay separate rows.
 */
analytics.get("/subject-report", async (c) => {
  const query = semesterRequiredQuerySchema.parse({
    semesterId: c.req.query("semesterId"),
    dateFrom: c.req.query("dateFrom"),
    dateTo: c.req.query("dateTo"),
  });
  const db = requireSupabase(c);
  const user = c.get("user");
  await assertSemesterInOrg(db, query.semesterId, user.organizationId);

  // Five queries and several folds in the Prisma route — including a two-step
  // correction lookup that mapped audit rows back to subjects — collapse into one.
  return c.json(await repo.subjectReport(db, query.semesterId, user.organizationId, query));
});

/**
 * Every active student in one section with their attendance standing — the batch
 * roll-up staff and admins use instead of opening students one at a time.
 *
 * Plain attendance only: present/absent/late counts and a percentage. No safe-bunk
 * or recovery projection, so this stays available to FACULTY.
 */
analytics.get("/batch-overview", async (c) => {
  const query = batchOverviewQuerySchema.parse({
    sectionId: c.req.query("sectionId"),
    dateFrom: c.req.query("dateFrom"),
    dateTo: c.req.query("dateTo"),
  });
  const db = requireSupabase(c);
  const user = c.get("user");

  // Section ownership is proven inside the RPC as well; this produces the 404 the
  // API contract promises rather than letting a Postgres exception surface as 500.
  const section = await findSectionInOrg(db, query.sectionId, user.organizationId);
  if (!section) throw new HTTPException(404, { message: "Section not found" });

  return c.json(await repo.batchOverview(db, query.sectionId, user.organizationId, query));
});

export default analytics;
