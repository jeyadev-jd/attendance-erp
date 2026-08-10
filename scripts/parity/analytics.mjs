// Phase 4 — analytics parity: current D1 implementation vs new Supabase RPCs.
//
// The D1 side here reproduces exactly what apps/api/src/routes/analytics.ts and
// lib/calculators.ts do today: the same SQL-side grouping, the same JavaScript folds,
// the same present-status set, the same formulas. It is a transcription, not a
// reimplementation — if it disagreed with the route, the harness would be testing
// the wrong thing.
//
// The Supabase side calls the RPCs through PostgREST, exactly as the migrated routes
// will.
//
// Neither side is adjusted to make the other agree. A mismatch is reported, not fixed.
import { d1Query, supabaseClient, runPreflight, printCountTable } from "./preflight.mjs";

// ───────────────────────── shared business rules ─────────────────────────
// Mirrors lib/calculators.ts. Duplicated deliberately: the harness must not import
// from the Worker, or a bug in the Worker's constants would cancel itself out.

const PRESENT = new Set(["PRESENT", "LATE", "VERY_LATE", "MEDICAL", "OD"]);
const isPresent = (s) => PRESENT.has(s);
const attendancePct = (present, total) => (total === 0 ? 0 : (present / total) * 100);
const safeBunkHours = (present, total, minPct) => {
  const r = minPct / 100;
  return r === 0 ? 0 : Math.max(0, Math.floor((present - r * total) / r));
};
const recoveryHours = (present, total, minPct) => {
  const r = minPct / 100;
  return r >= 1 ? 0 : Math.max(0, Math.ceil((r * total - present) / (1 - r)));
};

/**
 * SQL date-bound fragment matching schemas/analytics.dateFilter (both bounds UTC midnight).
 *
 * Compares on substr(col, 1, 10) — the YYYY-MM-DD prefix — rather than against a full
 * timestamp literal. SQLite has no date type: these columns are TEXT, and `>=` is a
 * plain string comparison. The dump stores "2026-07-13T00:00:00+00:00" while a JS
 * `toISOString()` literal is "2026-07-13T00:00:00.000Z"; '+' (0x2B) sorts before
 * '.' (0x2E), so the stored value compares as LESS than the same instant written the
 * other way and a `>=` bound silently drops the first day.
 *
 * Prisma does not hit this — it binds a real Date and normalises the format — so this
 * is a hazard of the harness's raw SQL only, not of the production D1 path. Comparing
 * date-only prefixes is exact here because every attendance date is stored at UTC
 * midnight, and it is immune to the timestamp-format difference entirely.
 */
function d1DateClause(range, col = "date") {
  const parts = [];
  if (range.dateFrom) parts.push(`substr(${col},1,10) >= '${range.dateFrom}'`);
  if (range.dateTo) parts.push(`substr(${col},1,10) <= '${range.dateTo}'`);
  return parts.length ? " AND " + parts.join(" AND ") : "";
}

function rpcRange(range) {
  return {
    p_date_from: range.dateFrom ? `${range.dateFrom}T00:00:00.000Z` : null,
    p_date_to: range.dateTo ? `${range.dateTo}T00:00:00.000Z` : null,
  };
}

// ───────────────────────── comparison helpers ─────────────────────────

/** Floating-point tolerance. Postgres double vs JS double can differ in the last bits. */
const EPS = 1e-9;

function classify(d1, sb) {
  const a = JSON.stringify(d1);
  const b = JSON.stringify(sb);
  if (a === b) return { status: "EXACT MATCH", difference: "" };

  // Same multiset, different order?
  if (Array.isArray(d1) && Array.isArray(sb) && d1.length === sb.length) {
    const norm = (x) => JSON.stringify([...x].sort((p, q) => JSON.stringify(p).localeCompare(JSON.stringify(q))));
    if (norm(d1) === norm(sb)) return { status: "ORDER-ONLY DIFFERENCE", difference: "same rows, different order" };
  }

  // Numerically equivalent within epsilon?
  if (numericallyEqual(d1, sb)) {
    return { status: "NUMERICALLY EQUIVALENT", difference: `float representation only (< ${EPS})` };
  }

  return { status: "REAL LOGIC MISMATCH", difference: diffSummary(d1, sb) };
}

function numericallyEqual(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < EPS;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => numericallyEqual(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (JSON.stringify(ka) !== JSON.stringify(kb)) return false;
    return ka.every((k) => numericallyEqual(a[k], b[k]));
  }
  return a === b;
}

function diffSummary(d1, sb) {
  if (Array.isArray(d1) && Array.isArray(sb)) {
    if (d1.length !== sb.length) return `row count D1=${d1.length} Supabase=${sb.length}`;
    for (let i = 0; i < d1.length; i++) {
      const a = JSON.stringify(d1[i]);
      const b = JSON.stringify(sb[i]);
      if (a !== b) return `first diff at index ${i}: D1=${a.slice(0, 120)} vs SB=${b.slice(0, 120)}`;
    }
  }
  return `D1=${JSON.stringify(d1).slice(0, 150)} vs SB=${JSON.stringify(sb).slice(0, 150)}`;
}

// ───────────────────────── tests ─────────────────────────

/** 1. Heatmap — day-of-week x hour attendance %. Replaces analytics.ts:38. */
async function testHeatmap(db, semesterId, orgId, range) {
  // D1: group in SQL, derive day-of-week in JS (SQLite has no usable EXTRACT).
  const rows = d1Query(
    `SELECT date, hourNumber, status, COUNT(*) AS n FROM attendance
     WHERE semesterId='${semesterId}' AND countsForAttendance=1${d1DateClause(range)}
     GROUP BY date, hourNumber, status;`
  );
  const buckets = new Map();
  for (const g of rows) {
    const dow = new Date(g.date).getUTCDay();
    const key = `${dow}-${g.hourNumber}`;
    const b = buckets.get(key) ?? { present: 0, total: 0 };
    b.total += g.n;
    if (isPresent(g.status)) b.present += g.n;
    buckets.set(key, b);
  }
  const d1Result = [...buckets.entries()]
    .map(([k, v]) => {
      const [dayOfWeek, hourNumber] = k.split("-").map(Number);
      return { dayOfWeek, hourNumber, pct: attendancePct(v.present, v.total), total: v.total };
    })
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.hourNumber - b.hourNumber);

  const { data, error } = await db.rpc("analytics_heatmap", {
    p_semester_id: semesterId,
    p_organization_id: orgId,
    ...rpcRange(range),
  });
  if (error) throw new Error(`heatmap RPC: ${error.message}`);
  const sbResult = (data ?? [])
    .map((r) => ({
      dayOfWeek: Number(r.dayOfWeek),
      hourNumber: Number(r.hourNumber),
      pct: Number(r.pct),
      total: Number(r.total),
    }))
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.hourNumber - b.hourNumber);

  return { d1: d1Result, sb: sbResult };
}

/** 2. Subject comparison — attendance % per subject. Replaces analytics.ts:76. */
async function testSubjectComparison(db, semesterId, orgId, range) {
  const rows = d1Query(
    `SELECT a.subjectId, s.name, a.status, COUNT(*) AS n
     FROM attendance a JOIN subjects s ON s.id = a.subjectId
     WHERE a.semesterId='${semesterId}' AND a.countsForAttendance=1${d1DateClause(range, "a.date")}
     GROUP BY a.subjectId, s.name, a.status;`
  );
  const buckets = new Map();
  for (const g of rows) {
    const b = buckets.get(g.subjectId) ?? { present: 0, total: 0, name: g.name };
    b.total += g.n;
    if (isPresent(g.status)) b.present += g.n;
    buckets.set(g.subjectId, b);
  }
  const d1Result = [...buckets.entries()]
    .map(([subjectId, v]) => ({
      subjectId,
      name: v.name,
      pct: attendancePct(v.present, v.total),
      total: v.total,
    }))
    .sort((a, b) => a.pct - b.pct || a.subjectId.localeCompare(b.subjectId));

  const { data, error } = await db.rpc("analytics_subject_comparison", {
    p_semester_id: semesterId,
    p_organization_id: orgId,
    ...rpcRange(range),
  });
  if (error) throw new Error(`subject-comparison RPC: ${error.message}`);
  const sbResult = (data ?? [])
    .map((r) => ({
      subjectId: r.subjectId,
      name: r.name,
      pct: Number(r.pct),
      total: Number(r.total),
    }))
    .sort((a, b) => a.pct - b.pct || a.subjectId.localeCompare(b.subjectId));

  return { d1: d1Result, sb: sbResult };
}

/** 3. Bunk leaderboard — flag counts, ranked. Replaces analytics.ts:125. */
async function testBunkLeaderboard(db, semesterId, orgId, limit, range) {
  const rows = d1Query(
    `SELECT bf.studentId, bf.flagType, COUNT(*) AS n, st.rollNo, st.name
     FROM bunk_flags bf
     JOIN students st ON st.id = bf.studentId
     JOIN sections sec ON sec.id = st.sectionId
     WHERE sec.semesterId='${semesterId}'${d1DateClause(range, "bf.date")}
     GROUP BY bf.studentId, bf.flagType, st.rollNo, st.name;`
  );
  const counts = new Map();
  for (const g of rows) {
    const e = counts.get(g.studentId) ?? {
      total: 0,
      single: 0,
      mid: 0,
      rollNo: g.rollNo,
      name: g.name,
    };
    e.total += g.n;
    if (g.flagType === "SINGLE_HOUR_SKIP") e.single += g.n;
    if (g.flagType === "MID_CLASS_BUNK") e.mid += g.n;
    counts.set(g.studentId, e);
  }
  const d1Result = [...counts.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, limit)
    .map(([studentId, v]) => ({
      studentId,
      rollNo: v.rollNo,
      name: v.name,
      bunkFlagCount: v.total,
      singleHourSkips: v.single,
      midClassBunks: v.mid,
    }));

  const { data, error } = await db.rpc("analytics_bunk_leaderboard", {
    p_semester_id: semesterId,
    p_organization_id: orgId,
    p_limit: limit,
    ...rpcRange(range),
  });
  if (error) throw new Error(`bunk-leaderboard RPC: ${error.message}`);
  const sbResult = (data ?? []).map((r) => ({
    studentId: r.studentId,
    rollNo: r.rollNo,
    name: r.name,
    bunkFlagCount: Number(r.bunkFlagCount),
    singleHourSkips: Number(r.singleHourSkips),
    midClassBunks: Number(r.midClassBunks),
  }));

  // Ties on total are ordered arbitrarily by both engines; compare as multisets.
  const key = (x) => `${x.studentId}:${x.bunkFlagCount}:${x.singleHourSkips}:${x.midClassBunks}`;
  return {
    d1: [...d1Result].sort((a, b) => key(a).localeCompare(key(b))),
    sb: [...sbResult].sort((a, b) => key(a).localeCompare(key(b))),
    note: "sorted by key; ties are order-indeterminate on both engines",
  };
}

/** 4. Late analytics — counts + worst day/hour. Replaces analytics.ts:233-234. */
async function testLateAnalytics(db, semesterId, orgId, range) {
  const byStudent = d1Query(
    `SELECT a.studentId, COUNT(*) AS n, st.rollNo, st.name
     FROM attendance a JOIN students st ON st.id = a.studentId
     WHERE a.semesterId='${semesterId}' AND a.status='LATE'${d1DateClause(range, "a.date")}
     GROUP BY a.studentId, st.rollNo, st.name;`
  );
  const byDayHour = d1Query(
    `SELECT date, hourNumber, COUNT(*) AS n FROM attendance
     WHERE semesterId='${semesterId}' AND status='LATE'${d1DateClause(range)}
     GROUP BY date, hourNumber;`
  );

  const byDay = new Map();
  const byHour = new Map();
  let totalLateMarks = 0;
  for (const g of byDayHour) {
    totalLateMarks += g.n;
    const dow = new Date(g.date).getUTCDay();
    byDay.set(dow, (byDay.get(dow) ?? 0) + g.n);
    byHour.set(g.hourNumber, (byHour.get(g.hourNumber) ?? 0) + g.n);
  }
  const topLate = [...byStudent].sort((a, b) => b.n - a.n).slice(0, 10);

  const d1Result = {
    totalLateMarks,
    mostLateStudents: topLate.map((g) => ({ rollNo: g.rollNo, name: g.name, count: g.n })),
    mostLateDayOfWeek: [...byDay.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    mostLateHour: [...byHour.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  };

  const { data, error } = await db.rpc("analytics_late", {
    p_semester_id: semesterId,
    p_organization_id: orgId,
    ...rpcRange(range),
  });
  if (error) throw new Error(`late RPC: ${error.message}`);
  const sbResult = {
    totalLateMarks: Number(data?.totalLateMarks ?? 0),
    mostLateStudents: (data?.mostLateStudents ?? []).map((s) => ({
      rollNo: s.rollNo,
      name: s.name,
      count: Number(s.count),
    })),
    mostLateDayOfWeek: data?.mostLateDayOfWeek ?? null,
    mostLateHour: data?.mostLateHour ?? null,
  };

  // Student ties are order-indeterminate; compare the list as a multiset.
  const sortStudents = (xs) =>
    [...xs].sort((a, b) => b.count - a.count || a.rollNo.localeCompare(b.rollNo));
  d1Result.mostLateStudents = sortStudents(d1Result.mostLateStudents);
  sbResult.mostLateStudents = sortStudents(sbResult.mostLateStudents);

  return { d1: d1Result, sb: sbResult };
}

/** 5. Subject report — coverage/attendance/corrections. Replaces analytics.ts:340. */
async function testSubjectReport(db, semesterId, orgId, range) {
  const semRows = d1Query(`SELECT startDate, endDate FROM semesters WHERE id='${semesterId}';`);
  const sem = semRows[0];

  const timetables = d1Query(
    `SELECT t.subjectId, t.durationHours, f.name AS facultyName, s.code, s.name, s.countsForAttendance
     FROM timetables t
     JOIN faculty f ON f.id = t.facultyId
     JOIN subjects s ON s.id = t.subjectId
     WHERE t.semesterId='${semesterId}';`
  );
  if (timetables.length === 0) return { d1: [], sb: [], note: "no timetable rows" };

  const studentCount =
    d1Query(
      `SELECT COUNT(*) AS n FROM students st JOIN sections sec ON sec.id = st.sectionId
       WHERE sec.semesterId='${semesterId}' AND st.status='ACTIVE';`
    )[0]?.n ?? 0;

  const windowStart = range.dateFrom ? new Date(`${range.dateFrom}T00:00:00.000Z`) : new Date(sem.startDate);
  const windowEnd = range.dateTo ? new Date(`${range.dateTo}T00:00:00.000Z`) : new Date();
  const elapsedMs = Math.max(0, windowEnd.getTime() - windowStart.getTime());
  const elapsedWeeks = Math.max(1, Math.ceil(elapsedMs / (7 * 24 * 60 * 60 * 1000)));

  const buckets = new Map();
  for (const t of timetables) {
    const b = buckets.get(t.subjectId) ?? {
      subjectId: t.subjectId,
      code: t.code,
      name: t.name,
      countsForAttendance: !!t.countsForAttendance,
      weeklyHours: 0,
      faculty: new Set(),
    };
    b.weeklyHours += t.durationHours;
    b.faculty.add(t.facultyName);
    buckets.set(t.subjectId, b);
  }

  const grouped = d1Query(
    `SELECT subjectId, date, hourNumber, status, COUNT(*) AS n FROM attendance
     WHERE semesterId='${semesterId}'${d1DateClause(range)}
     GROUP BY subjectId, date, hourNumber, status;`
  );
  const stats = new Map();
  for (const g of grouped) {
    const s = stats.get(g.subjectId) ?? { present: 0, total: 0, hours: new Set() };
    s.total += g.n;
    if (isPresent(g.status)) s.present += g.n;
    s.hours.add(`${String(g.date).slice(0, 10)}-${g.hourNumber}`);
    stats.set(g.subjectId, s);
  }

  const corrections = d1Query(
    `SELECT a.subjectId, COUNT(*) AS n FROM audit_logs al
     JOIN attendance a ON a.id = al.attendanceId
     WHERE a.semesterId='${semesterId}'${d1DateClause(range, "a.date")}
     GROUP BY a.subjectId;`
  );
  const corrBySubject = new Map(corrections.map((c) => [c.subjectId, c.n]));

  const d1Result = [...buckets.values()]
    .map((b) => {
      const s = stats.get(b.subjectId) ?? { present: 0, total: 0, hours: new Set() };
      const scheduledHours = b.weeklyHours * elapsedWeeks;
      const markedHours = s.hours.size;
      return {
        subjectId: b.subjectId,
        code: b.code,
        weeklyHours: b.weeklyHours,
        scheduledHours,
        markedHours,
        coveragePct: scheduledHours > 0 ? Math.min(100, (markedHours / scheduledHours) * 100) : 0,
        attendancePct: attendancePct(s.present, s.total),
        studentCount,
        corrections: corrBySubject.get(b.subjectId) ?? 0,
      };
    })
    .sort((a, b) => a.coveragePct - b.coveragePct || a.subjectId.localeCompare(b.subjectId));

  const { data, error } = await db.rpc("analytics_subject_report", {
    p_semester_id: semesterId,
    p_organization_id: orgId,
    ...rpcRange(range),
  });
  if (error) throw new Error(`subject-report RPC: ${error.message}`);
  const sbResult = (data ?? [])
    .map((r) => ({
      subjectId: r.subjectId,
      code: r.code,
      weeklyHours: Number(r.weeklyHours),
      scheduledHours: Number(r.scheduledHours),
      markedHours: Number(r.markedHours),
      coveragePct: Number(r.coveragePct),
      attendancePct: Number(r.attendancePct),
      studentCount: Number(r.studentCount),
      corrections: Number(r.corrections),
    }))
    .sort((a, b) => a.coveragePct - b.coveragePct || a.subjectId.localeCompare(b.subjectId));

  return { d1: d1Result, sb: sbResult };
}

/**
 * 6. Student-level maths — attendance %, safe-bunk, recovery hours.
 *
 * These are pure functions over aggregated counts, so the only thing that can differ
 * is the aggregation feeding them. Compares per-student present/total from both
 * engines, then applies the identical formulas to each.
 */
async function testStudentMaths(db, semesterId, orgId, minPct) {
  const d1Rows = d1Query(
    `SELECT studentId, status, COUNT(*) AS n FROM attendance
     WHERE semesterId='${semesterId}' AND countsForAttendance=1
     GROUP BY studentId, status;`
  );
  const d1Agg = new Map();
  for (const r of d1Rows) {
    const e = d1Agg.get(r.studentId) ?? { present: 0, total: 0, late: 0 };
    e.total += r.n;
    if (isPresent(r.status)) e.present += r.n;
    if (r.status === "LATE") e.late += r.n;
    d1Agg.set(r.studentId, e);
  }

  // Supabase side: aggregate in SQL via RPC.
  //
  // This originally selected the raw rows and folded them here, mirroring the D1
  // side. That was wrong twice over: PostgREST caps an unbounded select at 1000 rows
  // by default, so 2450 matching rows came back as 1000 with no error and every
  // derived figure was silently understated; and pulling per-row data to count it in
  // JavaScript is the exact pattern this migration exists to remove.
  const { data, error } = await db.rpc("student_attendance_totals", {
    p_semester_id: semesterId,
    p_organization_id: orgId,
  });
  if (error) throw new Error(`student maths RPC: ${error.message}`);
  const sbAgg = new Map();
  for (const r of data ?? []) {
    sbAgg.set(r.studentId, {
      present: Number(r.present),
      total: Number(r.total),
      late: Number(r.lateCount),
    });
  }

  const shape = (agg) =>
    [...agg.entries()]
      .map(([studentId, v]) => ({
        studentId,
        present: v.present,
        total: v.total,
        lateCount: v.late,
        pct: attendancePct(v.present, v.total),
        safeBunk: safeBunkHours(v.present, v.total, minPct),
        recovery: recoveryHours(v.present, v.total, minPct),
      }))
      .sort((a, b) => a.studentId.localeCompare(b.studentId));

  return { d1: shape(d1Agg), sb: shape(sbAgg) };
}

// ───────────────────────── runner ─────────────────────────

async function main() {
  console.log("Phase 4 parity harness — local D1 vs Supabase (read-only)\n");

  const pre = await runPreflight();
  printCountTable(pre.rows);
  if (!pre.ok) {
    console.error("\nPREFLIGHT FAILED — analytics comparison ABORTED.");
    console.error("Row counts differ; analytics results would not be comparable.\n");
    for (const m of pre.mismatches) {
      console.error(`  ${m.table}: D1=${m.d1} Supabase=${m.supabase} (delta ${m.supabase - m.d1})`);
    }
    process.exit(1);
  }
  console.log("\nPREFLIGHT PASSED — proceeding to analytics.\n");

  const db = supabaseClient();

  // Discover real ids and boundary dates from the data rather than hardcoding.
  const sem = d1Query(
    `SELECT s.id, s.minAttendancePct, s.startDate, s.endDate, ay.organizationId
     FROM semesters s JOIN academic_years ay ON ay.id = s.academicYearId LIMIT 1;`
  )[0];
  const dates = d1Query(
    `SELECT MIN(date) AS lo, MAX(date) AS hi FROM attendance WHERE semesterId='${sem.id}';`
  )[0];
  const loDay = String(dates.lo).slice(0, 10);
  const hiDay = String(dates.hi).slice(0, 10);

  const results = [];
  const record = async (name, input, fn) => {
    try {
      const { d1, sb, note } = await fn();
      const { status, difference } = classify(d1, sb);
      results.push({ name, input, status, difference, note, d1, sb });
      const flag = status === "REAL LOGIC MISMATCH" ? "  <-- MISMATCH" : "";
      console.log(`${status.padEnd(24)} ${name} [${input}]${flag}`);
    } catch (e) {
      results.push({ name, input, status: "ERROR", difference: e.message });
      console.log(`${"ERROR".padEnd(24)} ${name} [${input}] — ${e.message}`);
    }
  };

  const FULL = {};
  const NARROW = { dateFrom: loDay, dateTo: hiDay };
  const SINGLE = { dateFrom: loDay, dateTo: loDay };
  const EMPTY = { dateFrom: "2099-01-01", dateTo: "2099-12-31" };
  const OPEN_FROM = { dateFrom: loDay };
  const OPEN_TO = { dateTo: hiDay };

  await record("heatmap", "full semester", () => testHeatmap(db, sem.id, sem.organizationId, FULL));
  await record("heatmap", `range ${loDay}..${hiDay}`, () => testHeatmap(db, sem.id, sem.organizationId, NARROW));
  await record("heatmap", `single day ${loDay}`, () => testHeatmap(db, sem.id, sem.organizationId, SINGLE));
  await record("heatmap", "empty range (2099)", () => testHeatmap(db, sem.id, sem.organizationId, EMPTY));
  await record("heatmap", "open-ended dateFrom", () => testHeatmap(db, sem.id, sem.organizationId, OPEN_FROM));
  await record("heatmap", "open-ended dateTo", () => testHeatmap(db, sem.id, sem.organizationId, OPEN_TO));

  await record("subject-comparison", "full semester", () =>
    testSubjectComparison(db, sem.id, sem.organizationId, FULL)
  );
  await record("subject-comparison", `range ${loDay}..${hiDay}`, () =>
    testSubjectComparison(db, sem.id, sem.organizationId, NARROW)
  );
  await record("subject-comparison", "empty range", () =>
    testSubjectComparison(db, sem.id, sem.organizationId, EMPTY)
  );

  await record("bunk-leaderboard", "limit 5, full", () =>
    testBunkLeaderboard(db, sem.id, sem.organizationId, 5, FULL)
  );
  await record("bunk-leaderboard", "limit 100, full", () =>
    testBunkLeaderboard(db, sem.id, sem.organizationId, 100, FULL)
  );
  await record("bunk-leaderboard", "limit 5, empty range", () =>
    testBunkLeaderboard(db, sem.id, sem.organizationId, 5, EMPTY)
  );

  await record("late-analytics", "full semester", () => testLateAnalytics(db, sem.id, sem.organizationId, FULL));
  await record("late-analytics", `range ${loDay}..${hiDay}`, () =>
    testLateAnalytics(db, sem.id, sem.organizationId, NARROW)
  );
  await record("late-analytics", "empty range", () => testLateAnalytics(db, sem.id, sem.organizationId, EMPTY));

  await record("subject-report", "full semester", () => testSubjectReport(db, sem.id, sem.organizationId, FULL));
  await record("subject-report", `range ${loDay}..${hiDay}`, () =>
    testSubjectReport(db, sem.id, sem.organizationId, NARROW)
  );

  await record(`student maths (min ${sem.minAttendancePct}%)`, "all students", () =>
    testStudentMaths(db, sem.id, sem.organizationId, sem.minAttendancePct)
  );
  await record("student maths (min 80%)", "exactly-80 boundary", () => testStudentMaths(db, sem.id, sem.organizationId, 80));
  await record("student maths (min 100%)", "upper boundary", () => testStudentMaths(db, sem.id, sem.organizationId, 100));
  await record("student maths (min 0%)", "lower boundary", () => testStudentMaths(db, sem.id, sem.organizationId, 0));

  // ───────── report ─────────
  console.log("\n\nANALYTICS PARITY");
  console.log("----------------");
  console.log("test                                          | status                   | difference");
  console.log("----------------------------------------------+--------------------------+-----------");
  for (const r of results) {
    console.log(
      `${`${r.name} [${r.input}]`.padEnd(45)} | ${r.status.padEnd(24)} | ${(r.difference || "").slice(0, 60)}`
    );
  }

  const bad = results.filter((r) => r.status === "REAL LOGIC MISMATCH" || r.status === "ERROR");
  console.log("\n\nMISMATCHES");
  console.log("----------");
  if (bad.length === 0) {
    console.log("none");
  } else {
    for (const r of bad) {
      console.log(`\nendpoint : ${r.name}`);
      console.log(`input    : ${r.input}`);
      console.log(`D1       : ${JSON.stringify(r.d1).slice(0, 400)}`);
      console.log(`Supabase : ${JSON.stringify(r.sb).slice(0, 400)}`);
      console.log(`difference: ${r.difference}`);
      console.log(`severity : ${r.status === "ERROR" ? "BLOCKER" : "HIGH"}`);
    }
  }

  const counts = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
  console.log(`\n\nSUMMARY: ${JSON.stringify(counts)}`);
  console.log(bad.length === 0 ? "\nPARITY PASSED" : `\nPARITY FAILED — ${bad.length} problem(s)`);
  process.exit(bad.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`HARNESS ERROR: ${e.message}`);
  process.exit(1);
});
