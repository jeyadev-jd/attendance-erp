-- ============================================================================
-- Batch attendance, subject-wise.
--
-- Replaces the earlier overall-total shape: the roll-up of every class into one
-- percentage hid the thing staff actually look for, which is a student who is fine
-- overall but failing one subject.
--
-- Returns one row per (student, subject) pair. The UI pivots that into a grid —
-- students down, subjects across — which is why this does NOT pivot in SQL: the
-- subject set is dynamic, and a pivot would need either a fixed column list or
-- dynamic SQL. Emitting long rows and pivoting in the client is both simpler and
-- keeps the payload small (49 students x ~13 subjects = ~640 short rows).
--
-- Only subjects the student actually has attendance for appear. A student with no
-- marks in a subject is simply absent from the result; the UI renders that cell
-- blank rather than inventing a 0%.
--
-- countsForAttendance is read from the attendance row, never joined from subjects —
-- changing a subject's default must not retroactively rewrite already-marked days.
--
-- Idempotent: CREATE OR REPLACE. Run in the Supabase SQL Editor.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION batch_attendance_by_subject(
  p_section_id      text,
  p_organization_id text,
  p_date_from       timestamptz DEFAULT NULL,
  p_date_to         timestamptz DEFAULT NULL
) RETURNS TABLE (
  "studentId"   text,
  "rollNo"      text,
  "studentName" text,
  "subjectId"   text,
  "subjectCode" text,
  "subjectName" text,
  present       bigint,
  total         bigint,
  pct           double precision
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
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
  SELECT
    st.id,
    st."rollNo",
    st.name,
    sub.id,
    sub.code,
    sub.name,
    COUNT(*) FILTER (
      WHERE a.status IN ('PRESENT','LATE','VERY_LATE','MEDICAL','OD')
    )                                          AS present,
    COUNT(*)                                   AS total,
    CASE WHEN COUNT(*) = 0 THEN 0::double precision
         ELSE COUNT(*) FILTER (
                WHERE a.status IN ('PRESENT','LATE','VERY_LATE','MEDICAL','OD')
              )::double precision * 100.0 / COUNT(*)
    END                                        AS pct
  FROM students st
  JOIN attendance a ON a."studentId" = st.id
                   AND a."countsForAttendance" = true
                   AND (p_date_from IS NULL OR a."date" >= p_date_from)
                   AND (p_date_to   IS NULL OR a."date" <= p_date_to)
  JOIN subjects sub ON sub.id = a."subjectId"
  WHERE st."sectionId" = p_section_id
    AND st.status = 'ACTIVE'
    -- Non-counting subjects (mentor-mentee, club activity) are marked so absences
    -- are on record, but they never move a percentage — so they have no place in a
    -- percentage grid. Excluded here as well as by the row-level flag, because a
    -- subject flagged non-counting after some rows were already marked leaves those
    -- rows with the old snapshot (see phase10).
    AND s."countsForAttendance" = true
  GROUP BY st.id, st."rollNo", st.name, sub.id, sub.code, sub.name
  -- Total order: rollNo then subject code, so the grid builds identically every
  -- time rather than reshuffling between requests.
  ORDER BY st."rollNo" ASC, sub.code ASC;
END $$;

REVOKE ALL  ON FUNCTION batch_attendance_by_subject(text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION batch_attendance_by_subject(text, text, timestamptz, timestamptz) TO service_role;

COMMIT;
