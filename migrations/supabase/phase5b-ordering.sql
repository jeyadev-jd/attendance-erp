-- ============================================================================
-- Phase 5b — deterministic ordering for student_subject_totals.
--
-- The function had no ORDER BY, so Postgres returned grouped rows in whatever order
-- the aggregate produced them. Prisma's groupBy happened to be stable, so the
-- student dashboard and subject planner listed subjects consistently; without an
-- explicit sort the same request can return the same subjects in a different
-- sequence.
--
-- Verified before fixing: zero field-level differences, ordering only — no count or
-- percentage was ever wrong.
--
-- subjectId ASC is arbitrary but total and stable. The routes that consume this
-- apply their own display sort afterwards (the planner sorts by currentPct), so this
-- only needs to make the underlying sequence deterministic.
--
-- Idempotent: CREATE OR REPLACE. Run in the Supabase SQL Editor.
-- ============================================================================

BEGIN;

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
  GROUP BY a."subjectId"
  ORDER BY a."subjectId" ASC;
END $$;

REVOKE ALL  ON FUNCTION student_subject_totals(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION student_subject_totals(text, text, text) TO service_role;

COMMIT;
