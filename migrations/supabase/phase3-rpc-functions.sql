-- ============================================================================
-- Phase 3 — analytics RPC functions.
--
-- These exist because PostgREST has no GROUP BY. The alternative would be pulling
-- every attendance row into the Worker and folding it in JavaScript, which for the
-- heatmap is the entire semester's attendance table. Each function below returns
-- only the final UI-sized result: tens of rows, not thousands.
--
-- Written to match the existing D1/Prisma behaviour exactly, including:
--   * countsForAttendance filtering (read from the attendance row, never joined
--     from subjects — see calculators.COUNTS_FOR_ATTENDANCE)
--   * the PRESENT_STATUSES set (PRESENT, LATE, VERY_LATE, MEDICAL, OD)
--   * attendance_pct = present / total * 100, and 0 when total = 0
--
-- SECURITY INVOKER is deliberate: these run as the caller. The Worker calls them
-- with service_role (BYPASSRLS), and anon/authenticated have no EXECUTE grant, so
-- they are unreachable from a browser. SECURITY DEFINER would make them a way
-- around RLS if a grant were ever added by mistake.
--
-- Every function takes p_organization_id and re-proves the semester belongs to that
-- org. The Worker checks this too; doing it here as well means a caller cannot read
-- another tenant's analytics by passing a semesterId they do not own.
--
-- Idempotent: CREATE OR REPLACE throughout. Run in the Supabase SQL Editor.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Supporting indexes.
--
-- The unique/FK indexes came over with the export. These two are new: they serve
-- filters that D1 never had to optimise because SQLite scanned a small local file.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS attendance_semester_counts_date_idx
  ON attendance ("semesterId", "countsForAttendance", "date");

CREATE INDEX IF NOT EXISTS attendance_semester_late_idx
  ON attendance ("semesterId", "date")
  WHERE status = 'LATE';

-- Guard shared by every function below: does this semester belong to this org?
CREATE OR REPLACE FUNCTION assert_semester_in_org(
  p_semester_id     text,
  p_organization_id text
) RETURNS void
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM semesters s
    JOIN academic_years ay ON ay.id = s."academicYearId"
    WHERE s.id = p_semester_id
      AND ay."organizationId" = p_organization_id
  ) THEN
    RAISE EXCEPTION 'Semester not found'
      USING ERRCODE = 'no_data_found';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Heatmap — day-of-week x hour attendance %.
--
-- Replaces analytics.ts:38. Day-of-week was derived in JavaScript under D1 because
-- SQLite had no usable EXTRACT; Postgres does it in SQL, so the fold disappears.
-- Returns at most 7 x ~7 = 49 rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION analytics_heatmap(
  p_semester_id     text,
  p_organization_id text,
  p_date_from       timestamptz DEFAULT NULL,
  p_date_to         timestamptz DEFAULT NULL
) RETURNS TABLE ("dayOfWeek" int, "hourNumber" int, pct double precision, total bigint)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  PERFORM assert_semester_in_org(p_semester_id, p_organization_id);

  RETURN QUERY
  SELECT
    EXTRACT(DOW FROM a."date")::int                          AS "dayOfWeek",
    a."hourNumber",
    CASE WHEN COUNT(*) = 0 THEN 0::double precision
         ELSE COUNT(*) FILTER (
                WHERE a.status IN ('PRESENT','LATE','VERY_LATE','MEDICAL','OD')
              )::double precision * 100.0 / COUNT(*)
    END                                                      AS pct,
    COUNT(*)                                                 AS total
  FROM attendance a
  WHERE a."semesterId" = p_semester_id
    AND a."countsForAttendance" = true
    AND (p_date_from IS NULL OR a."date" >= p_date_from)
    AND (p_date_to   IS NULL OR a."date" <= p_date_to)
  GROUP BY 1, 2
  ORDER BY 1, 2;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Subject comparison — attendance % per subject, worst first.
--
-- Replaces analytics.ts:76 plus its follow-up subject-name lookup: the join happens
-- in SQL, so the second round trip disappears. ~10 rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION analytics_subject_comparison(
  p_semester_id     text,
  p_organization_id text,
  p_date_from       timestamptz DEFAULT NULL,
  p_date_to         timestamptz DEFAULT NULL
) RETURNS TABLE ("subjectId" text, name text, pct double precision, total bigint)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  PERFORM assert_semester_in_org(p_semester_id, p_organization_id);

  RETURN QUERY
  SELECT
    a."subjectId",
    s.name,
    CASE WHEN COUNT(*) = 0 THEN 0::double precision
         ELSE COUNT(*) FILTER (
                WHERE a.status IN ('PRESENT','LATE','VERY_LATE','MEDICAL','OD')
              )::double precision * 100.0 / COUNT(*)
    END          AS pct,
    COUNT(*)     AS total
  FROM attendance a
  JOIN subjects s ON s.id = a."subjectId"
  WHERE a."semesterId" = p_semester_id
    AND a."countsForAttendance" = true
    AND (p_date_from IS NULL OR a."date" >= p_date_from)
    AND (p_date_to   IS NULL OR a."date" <= p_date_to)
  GROUP BY a."subjectId", s.name
  ORDER BY pct ASC;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Bunk leaderboard — students ranked by flag count, worst first.
--
-- Replaces analytics.ts:125 plus the student lookup. ORDER BY + LIMIT run in SQL,
-- so unranked students never leave the database — previously every student's flags
-- were loaded to return five rows. Returns exactly p_limit rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION analytics_bunk_leaderboard(
  p_semester_id     text,
  p_organization_id text,
  p_limit           int         DEFAULT 5,
  p_date_from       timestamptz DEFAULT NULL,
  p_date_to         timestamptz DEFAULT NULL
) RETURNS TABLE (
  "studentId"       text,
  "rollNo"          text,
  name              text,
  "bunkFlagCount"   bigint,
  "singleHourSkips" bigint,
  "midClassBunks"   bigint
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  PERFORM assert_semester_in_org(p_semester_id, p_organization_id);

  RETURN QUERY
  SELECT
    bf."studentId",
    st."rollNo",
    st.name,
    COUNT(*)                                                          AS "bunkFlagCount",
    COUNT(*) FILTER (WHERE bf."flagType" = 'SINGLE_HOUR_SKIP')        AS "singleHourSkips",
    COUNT(*) FILTER (WHERE bf."flagType" = 'MID_CLASS_BUNK')          AS "midClassBunks"
  FROM bunk_flags bf
  JOIN students st ON st.id = bf."studentId"
  JOIN sections  sec ON sec.id = st."sectionId"
  WHERE sec."semesterId" = p_semester_id
    AND (p_date_from IS NULL OR bf."date" >= p_date_from)
    AND (p_date_to   IS NULL OR bf."date" <= p_date_to)
  GROUP BY bf."studentId", st."rollNo", st.name
  ORDER BY COUNT(*) DESC
  LIMIT p_limit;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Late analytics — top-10 late students + worst day/hour.
--
-- Replaces analytics.ts:233-234 (two groupBys) plus the student lookup, and the two
-- JavaScript sorts. Returns a single JSON object rather than a row set because the
-- shape is heterogeneous: a list plus three scalars.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION analytics_late(
  p_semester_id     text,
  p_organization_id text,
  p_date_from       timestamptz DEFAULT NULL,
  p_date_to         timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM assert_semester_in_org(p_semester_id, p_organization_id);

  WITH late AS (
    SELECT a."studentId", a."date", a."hourNumber"
    FROM attendance a
    WHERE a."semesterId" = p_semester_id
      AND a.status = 'LATE'
      AND (p_date_from IS NULL OR a."date" >= p_date_from)
      AND (p_date_to   IS NULL OR a."date" <= p_date_to)
  ),
  top_students AS (
    SELECT st."rollNo", st.name, COUNT(*) AS cnt
    FROM late l
    JOIN students st ON st.id = l."studentId"
    GROUP BY st."rollNo", st.name
    ORDER BY COUNT(*) DESC
    LIMIT 10
  ),
  by_day AS (
    SELECT EXTRACT(DOW FROM l."date")::int AS dow, COUNT(*) AS cnt
    FROM late l GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1
  ),
  by_hour AS (
    SELECT l."hourNumber" AS hr, COUNT(*) AS cnt
    FROM late l GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1
  )
  SELECT jsonb_build_object(
    'totalLateMarks',     (SELECT COUNT(*) FROM late),
    'mostLateStudents',   COALESCE(
                            (SELECT jsonb_agg(
                                      jsonb_build_object('rollNo', "rollNo", 'name', name, 'count', cnt)
                                      ORDER BY cnt DESC)
                             FROM top_students),
                            '[]'::jsonb),
    'mostLateDayOfWeek',  (SELECT dow FROM by_day),
    'mostLateHour',       (SELECT hr  FROM by_hour)
  ) INTO v_result;

  RETURN v_result;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Subject report — coverage, attendance %, corrections per subject.
--
-- Replaces analytics.ts:340 + :357 + the corrected-rows lookup: five queries and
-- several JavaScript folds collapse into one. The correction count in particular
-- was a two-step (groupBy auditLog -> findMany attendance to map ids to subjects);
-- here it is a plain join.
--
-- Scheduled hours are estimated exactly as the current code does: weekly timetable
-- hours x elapsed weeks over the reporting window, with a multi-hour lab counting
-- its full span. Coverage is capped at 100 because a rescheduled or extra class can
-- push marked hours past the estimate.
--
-- markedHours counts DISTINCT (date, hour) pairs, so it is independent of class size.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION analytics_subject_report(
  p_semester_id     text,
  p_organization_id text,
  p_date_from       timestamptz DEFAULT NULL,
  p_date_to         timestamptz DEFAULT NULL
) RETURNS TABLE (
  "subjectId"           text,
  code                  text,
  name                  text,
  faculty               text,
  "countsForAttendance" boolean,
  "weeklyHours"         bigint,
  "scheduledHours"      bigint,
  "markedHours"         bigint,
  "coveragePct"         double precision,
  "attendancePct"       double precision,
  "studentCount"        bigint,
  corrections           bigint
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_start         timestamptz;
  v_end           timestamptz;
  v_elapsed_weeks int;
  v_students      bigint;
BEGIN
  PERFORM assert_semester_in_org(p_semester_id, p_organization_id);

  SELECT COALESCE(p_date_from, s."startDate"), COALESCE(p_date_to, now())
    INTO v_start, v_end
  FROM semesters s WHERE s.id = p_semester_id;

  -- Mirrors the JS: ceil(elapsedMs / 1 week), floored at 1.
  v_elapsed_weeks := GREATEST(1, CEIL(GREATEST(0, EXTRACT(EPOCH FROM (v_end - v_start))) / 604800.0)::int);

  SELECT COUNT(*) INTO v_students
  FROM students st
  JOIN sections sec ON sec.id = st."sectionId"
  WHERE sec."semesterId" = p_semester_id AND st.status = 'ACTIVE';

  RETURN QUERY
  WITH sched AS (
    SELECT
      t."subjectId",
      SUM(t."durationHours")                      AS weekly_hours,
      string_agg(DISTINCT f.name, ', ')           AS faculty_names
    FROM timetables t
    JOIN faculty f ON f.id = t."facultyId"
    WHERE t."semesterId" = p_semester_id
    GROUP BY t."subjectId"
  ),
  marks AS (
    SELECT
      a."subjectId",
      COUNT(*)                                                    AS total,
      COUNT(*) FILTER (
        WHERE a.status IN ('PRESENT','LATE','VERY_LATE','MEDICAL','OD')
      )                                                           AS present,
      COUNT(DISTINCT (a."date", a."hourNumber"))                  AS marked_hours
    FROM attendance a
    WHERE a."semesterId" = p_semester_id
      AND (p_date_from IS NULL OR a."date" >= p_date_from)
      AND (p_date_to   IS NULL OR a."date" <= p_date_to)
    GROUP BY a."subjectId"
  ),
  corr AS (
    SELECT a."subjectId", COUNT(*) AS corrections
    FROM audit_logs al
    JOIN attendance a ON a.id = al."attendanceId"
    WHERE a."semesterId" = p_semester_id
      AND (p_date_from IS NULL OR a."date" >= p_date_from)
      AND (p_date_to   IS NULL OR a."date" <= p_date_to)
    GROUP BY a."subjectId"
  )
  SELECT
    sub.id,
    sub.code,
    sub.name,
    COALESCE(sched.faculty_names, ''),
    sub."countsForAttendance",
    sched.weekly_hours,
    sched.weekly_hours * v_elapsed_weeks                                   AS scheduled_hours,
    COALESCE(m.marked_hours, 0)                                            AS marked_hours,
    CASE WHEN sched.weekly_hours * v_elapsed_weeks > 0
         THEN LEAST(100.0, COALESCE(m.marked_hours, 0)::double precision * 100.0
                           / (sched.weekly_hours * v_elapsed_weeks))
         ELSE 0::double precision END                                      AS coverage_pct,
    CASE WHEN COALESCE(m.total, 0) = 0 THEN 0::double precision
         ELSE m.present::double precision * 100.0 / m.total END            AS attendance_pct,
    v_students,
    COALESCE(c.corrections, 0)
  FROM sched
  JOIN subjects sub ON sub.id = sched."subjectId"
  LEFT JOIN marks m ON m."subjectId" = sched."subjectId"
  LEFT JOIN corr  c ON c."subjectId" = sched."subjectId"
  ORDER BY coverage_pct ASC;
END $$;

-- ---------------------------------------------------------------------------
-- Grants.
--
-- service_role only. anon and authenticated get nothing, matching the C-3 model —
-- without this the functions would be callable through the publishable key even
-- though the underlying tables are locked.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION assert_semester_in_org(text, text)                                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION analytics_heatmap(text, text, timestamptz, timestamptz)                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION analytics_subject_comparison(text, text, timestamptz, timestamptz)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION analytics_bunk_leaderboard(text, text, int, timestamptz, timestamptz)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION analytics_late(text, text, timestamptz, timestamptz)                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION analytics_subject_report(text, text, timestamptz, timestamptz)              FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION analytics_heatmap(text, text, timestamptz, timestamptz)                  TO service_role;
GRANT EXECUTE ON FUNCTION analytics_subject_comparison(text, text, timestamptz, timestamptz)       TO service_role;
GRANT EXECUTE ON FUNCTION analytics_bunk_leaderboard(text, text, int, timestamptz, timestamptz)    TO service_role;
GRANT EXECUTE ON FUNCTION analytics_late(text, text, timestamptz, timestamptz)                     TO service_role;
GRANT EXECUTE ON FUNCTION analytics_subject_report(text, text, timestamptz, timestamptz)           TO service_role;

COMMIT;

-- ============================================================================
-- Verification (run after COMMIT).
-- ============================================================================

-- V1. All five analytics functions present, SECURITY INVOKER (prosecdef = false).
SELECT proname, prosecdef AS is_security_definer
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND proname LIKE 'analytics_%'
ORDER BY proname;

-- V2. No EXECUTE grant to anon/authenticated. MUST return 0 rows.
SELECT routine_name, grantee
FROM information_schema.role_routine_grants
WHERE routine_schema = 'public' AND grantee IN ('anon', 'authenticated');

-- ============================================================================
-- Addendum — student aggregate RPC.
--
-- Added during Phase 4 after the parity harness exposed a real defect: fetching
-- attendance rows through PostgREST to fold them in JavaScript silently truncated
-- at PostgREST's default 1000-row limit (2450 rows matched, 1000 returned, no
-- error). Every derived figure — attendance %, safe-bunk, recovery hours — was
-- wrong, and would have been wrong in production had the rows been read this way.
--
-- Aggregating in SQL removes the truncation risk entirely and returns one row per
-- student instead of one per attendance record.
-- ============================================================================

CREATE OR REPLACE FUNCTION student_attendance_totals(
  p_semester_id     text,
  p_organization_id text
) RETURNS TABLE ("studentId" text, present bigint, total bigint, "lateCount" bigint)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  PERFORM assert_semester_in_org(p_semester_id, p_organization_id);

  RETURN QUERY
  SELECT
    a."studentId",
    COUNT(*) FILTER (
      WHERE a.status IN ('PRESENT','LATE','VERY_LATE','MEDICAL','OD')
    )                                             AS present,
    COUNT(*)                                      AS total,
    COUNT(*) FILTER (WHERE a.status = 'LATE')     AS "lateCount"
  FROM attendance a
  WHERE a."semesterId" = p_semester_id
    AND a."countsForAttendance" = true
  GROUP BY a."studentId";
END $$;

REVOKE ALL  ON FUNCTION student_attendance_totals(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION student_attendance_totals(text, text) TO service_role;
