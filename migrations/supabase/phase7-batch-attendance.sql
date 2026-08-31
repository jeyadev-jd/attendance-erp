-- ============================================================================
-- Batch attendance overview — one row per student in a section.
--
-- Feeds the admin/staff "batch view": every student's standing in one table,
-- rather than opening each student individually.
--
-- Aggregated in PostgreSQL for the usual reason: a section's semester of
-- attendance is thousands of rows, well past PostgREST's 1000-row default, and
-- folding it in the Worker would both truncate silently and burn CPU. This
-- returns one row per student — tens of rows.
--
-- The org check is inside the function, not just in the Worker: a caller cannot
-- read another tenant's batch by passing a sectionId they do not own.
--
-- countsForAttendance is read from the attendance row itself, never joined from
-- subjects — a later change to a subject's default must not retroactively
-- rewrite the meaning of already-marked days.
--
-- Idempotent: CREATE OR REPLACE. Run in the Supabase SQL Editor.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION batch_attendance_overview(
  p_section_id      text,
  p_organization_id text,
  p_date_from       timestamptz DEFAULT NULL,
  p_date_to         timestamptz DEFAULT NULL
) RETURNS TABLE (
  "studentId"   text,
  "rollNo"      text,
  name          text,
  present       bigint,
  total         bigint,
  "lateCount"   bigint,
  "absentCount" bigint,
  pct           double precision
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  -- Section must belong to the caller's organization.
  IF NOT EXISTS (
    SELECT 1
    FROM sections sec
    JOIN semesters s       ON s.id  = sec."semesterId"
    JOIN academic_years ay ON ay.id = s."academicYearId"
    WHERE sec.id = p_section_id
      AND ay."organizationId" = p_organization_id
  ) THEN
    RAISE EXCEPTION 'Section not found' USING ERRCODE = 'no_data_found';
  END IF;

  RETURN QUERY
  -- LEFT JOIN so a student with no marked attendance still appears, at 0%,
  -- rather than vanishing from the roster.
  SELECT
    st.id,
    st."rollNo",
    st.name,
    COUNT(a.id) FILTER (
      WHERE a.status IN ('PRESENT','LATE','VERY_LATE','MEDICAL','OD')
    )                                                    AS present,
    COUNT(a.id)                                          AS total,
    COUNT(a.id) FILTER (WHERE a.status = 'LATE')         AS "lateCount",
    COUNT(a.id) FILTER (WHERE a.status = 'ABSENT')       AS "absentCount",
    CASE WHEN COUNT(a.id) = 0 THEN 0::double precision
         ELSE COUNT(a.id) FILTER (
                WHERE a.status IN ('PRESENT','LATE','VERY_LATE','MEDICAL','OD')
              )::double precision * 100.0 / COUNT(a.id)
    END                                                  AS pct
  FROM students st
  LEFT JOIN attendance a
         ON a."studentId" = st.id
        AND a."countsForAttendance" = true
        AND (p_date_from IS NULL OR a."date" >= p_date_from)
        AND (p_date_to   IS NULL OR a."date" <= p_date_to)
  WHERE st."sectionId" = p_section_id
    AND st.status = 'ACTIVE'
  GROUP BY st.id, st."rollNo", st.name
  -- rollNo makes the order total and stable: students tie on pct constantly
  -- (everyone at 100% early in a semester), and an unstable sort would reshuffle
  -- the table between identical requests.
  ORDER BY pct ASC, st."rollNo" ASC;
END $$;

REVOKE ALL  ON FUNCTION batch_attendance_overview(text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION batch_attendance_overview(text, text, timestamptz, timestamptz) TO service_role;

COMMIT;
