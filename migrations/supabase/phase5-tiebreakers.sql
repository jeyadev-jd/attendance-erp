-- ============================================================================
-- Phase 5 — deterministic tiebreakers for ranked analytics.
--
-- analytics_bunk_leaderboard and analytics_late rank by a count and cut with LIMIT.
-- Ties at the cut line were previously broken arbitrarily by whichever row the
-- engine happened to return first, so D1 and Postgres disagreed on WHICH tied
-- student appeared — and either engine could reorder between identical requests.
--
-- The parity harness classified this as engine behaviour rather than a defect, and
-- that was correct: no count is wrong, only the choice among equals. But arbitrary
-- is still arbitrary, and at cutover the visible leaderboard would change for no
-- reason a user could explain.
--
-- Adding rollNo as a secondary sort makes the result total-ordered and stable. It
-- does not change any count, and it does not change who is genuinely top-ranked.
--
-- Idempotent: CREATE OR REPLACE. Run in the Supabase SQL Editor.
-- ============================================================================

BEGIN;

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
  -- rollNo breaks ties deterministically; the count ordering is unchanged.
  ORDER BY COUNT(*) DESC, st."rollNo" ASC
  LIMIT p_limit;
END $$;

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
    ORDER BY COUNT(*) DESC, st."rollNo" ASC
    LIMIT 10
  ),
  by_day AS (
    SELECT EXTRACT(DOW FROM l."date")::int AS dow, COUNT(*) AS cnt
    FROM late l GROUP BY 1 ORDER BY COUNT(*) DESC, 1 ASC LIMIT 1
  ),
  by_hour AS (
    SELECT l."hourNumber" AS hr, COUNT(*) AS cnt
    FROM late l GROUP BY 1 ORDER BY COUNT(*) DESC, 1 ASC LIMIT 1
  )
  SELECT jsonb_build_object(
    'totalLateMarks',     (SELECT COUNT(*) FROM late),
    'mostLateStudents',   COALESCE(
                            (SELECT jsonb_agg(
                                      jsonb_build_object('rollNo', "rollNo", 'name', name, 'count', cnt)
                                      ORDER BY cnt DESC, "rollNo" ASC)
                             FROM top_students),
                            '[]'::jsonb),
    'mostLateDayOfWeek',  (SELECT dow FROM by_day),
    'mostLateHour',       (SELECT hr  FROM by_hour)
  ) INTO v_result;

  RETURN v_result;
END $$;

COMMIT;

-- Verification: both functions still SECURITY INVOKER, still service_role only.
SELECT proname, prosecdef AS is_security_definer
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND proname IN ('analytics_bunk_leaderboard','analytics_late');

-- ============================================================================
-- student_subject_totals — per-subject counts for ONE student.
--
-- Feeds the student dashboard, the what-if simulator and the subject planner.
-- Replaces prisma.attendance.groupBy({ by: ["subjectId", "status"] }).
--
-- Aggregated here rather than in the Worker for the usual two reasons: a student's
-- semester exceeds PostgREST's 1000-row default (so a plain select would silently
-- truncate and understate every percentage), and the fold belongs in SQL.
--
-- p_subject_id narrows to a single subject for the simulator; NULL means all.
--
-- countsForAttendance is read from the attendance row itself, never joined from
-- subjects — changing a subject's default must not retroactively rewrite the
-- meaning of already-marked days.
-- ============================================================================

CREATE OR REPLACE FUNCTION student_subject_totals(
  p_student_id  text,
  p_semester_id text,
  p_subject_id  text DEFAULT NULL
) RETURNS TABLE ("subjectId" text, present bigint, total bigint, "lateCount" bigint)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    a."subjectId",
    COUNT(*) FILTER (
      WHERE a.status IN ('PRESENT','LATE','VERY_LATE','MEDICAL','OD')
    )                                          AS present,
    COUNT(*)                                   AS total,
    COUNT(*) FILTER (WHERE a.status = 'LATE')  AS "lateCount"
  FROM attendance a
  WHERE a."studentId" = p_student_id
    AND a."semesterId" = p_semester_id
    AND a."countsForAttendance" = true
    AND (p_subject_id IS NULL OR a."subjectId" = p_subject_id)
  GROUP BY a."subjectId";
END $$;

REVOKE ALL  ON FUNCTION student_subject_totals(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION student_subject_totals(text, text, text) TO service_role;

-- ============================================================================
-- Tiebreakers for the two remaining ranked analytics functions.
--
-- subject_comparison sorts by attendance %, subject_report by coverage %. Subjects
-- sharing an identical percentage were ordered arbitrarily, so D1 and Postgres
-- disagreed on their relative position — same rows, same values, different sequence.
-- Verified: zero field-level differences, ordering only.
--
-- code ASC is the secondary sort: stable, human-meaningful, and already unique
-- within a department.
-- ============================================================================

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
  GROUP BY a."subjectId", s.name, s.code
  ORDER BY pct ASC, s.code ASC;
END $$;

REVOKE ALL  ON FUNCTION analytics_subject_comparison(text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION analytics_subject_comparison(text, text, timestamptz, timestamptz) TO service_role;

-- subject_report: same tiebreaker rationale as above — equal coverage percentages
-- were ordered arbitrarily. code ASC makes the sequence deterministic.
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
  ORDER BY coverage_pct ASC, sub.code ASC;
END $$;
REVOKE ALL  ON FUNCTION analytics_subject_report(text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION analytics_subject_report(text, text, timestamptz, timestamptz) TO service_role;
