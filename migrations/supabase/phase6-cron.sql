-- ============================================================================
-- Phase 6 — timetable_counts_by_section.
--
-- The nightly job needs each section's weekly timetable hour count. Prisma expressed
-- it as groupBy({ by: ["sectionId"], _count }); PostgREST has no GROUP BY, and the
-- alternative — fetching every timetable row to count them in the Worker — is the
-- pattern this migration exists to remove.
--
-- Weekly hours are a property of the SECTION, not the student: several students share
-- one, so counting per section rather than per student is what keeps the job's inner
-- loop query-free.
--
-- Idempotent: CREATE OR REPLACE. Run in the Supabase SQL Editor.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION timetable_counts_by_section(p_section_ids text[])
RETURNS TABLE ("sectionId" text, "weeklyHours" bigint)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT t."sectionId", COUNT(*) AS "weeklyHours"
  FROM timetables t
  WHERE t."sectionId" = ANY(p_section_ids)
  GROUP BY t."sectionId"
  ORDER BY t."sectionId" ASC;
END $$;

REVOKE ALL  ON FUNCTION timetable_counts_by_section(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION timetable_counts_by_section(text[]) TO service_role;

COMMIT;
