-- ============================================================================
-- Correct attendance rows whose countsForAttendance disagrees with their subject.
--
-- countsForAttendance is snapshotted onto each attendance row when it is marked,
-- deliberately: changing a subject's default later must not retroactively rewrite
-- the meaning of days already marked. A period that genuinely counted when it was
-- taken should keep counting.
--
-- That protection has a gap. Mentor-Mentee Meeting was created as a normal subject
-- and only later flagged countsForAttendance = false. The 98 rows marked before the
-- flag was set (2026-07-16 and 2026-07-18, 49 students x 2 dates) kept
-- countsForAttendance = true and have been inflating every percentage since.
--
-- These rows are not a legitimate historical record of a counting period — the
-- subject was never meant to count, the flag was simply set late. So they are
-- corrected to match the subject.
--
-- Scope is deliberately narrow: only rows whose subject is flagged non-counting
-- AND which have no timetable override for that date+hour. An override is an
-- explicit, per-date decision ("track this one-off seminar but do not count it",
-- or the reverse) and must win over the subject default — those rows are left
-- exactly as they are.
--
-- Idempotent: re-running changes nothing once the rows agree.
-- ============================================================================

BEGIN;

-- What will change, before changing it.
SELECT s.name AS subject, COUNT(*) AS rows_to_fix
FROM attendance a
JOIN subjects s ON s.id = a."subjectId"
WHERE s."countsForAttendance" = false
  AND a."countsForAttendance" = true
  AND NOT EXISTS (
    SELECT 1 FROM timetable_overrides o
    WHERE o."sectionId" = a."sectionId"
      AND o."date" = a."date"
      AND o."hourNumber" = a."hourNumber"
      AND o."countsForAttendance" IS NOT NULL
  )
GROUP BY s.name;

UPDATE attendance a
SET "countsForAttendance" = false
FROM subjects s
WHERE s.id = a."subjectId"
  AND s."countsForAttendance" = false
  AND a."countsForAttendance" = true
  AND NOT EXISTS (
    SELECT 1 FROM timetable_overrides o
    WHERE o."sectionId" = a."sectionId"
      AND o."date" = a."date"
      AND o."hourNumber" = a."hourNumber"
      AND o."countsForAttendance" IS NOT NULL
  );

COMMIT;

-- Verification: must return no rows.
SELECT s.name, COUNT(*) AS still_wrong
FROM attendance a
JOIN subjects s ON s.id = a."subjectId"
WHERE s."countsForAttendance" = false
  AND a."countsForAttendance" = true
  AND NOT EXISTS (
    SELECT 1 FROM timetable_overrides o
    WHERE o."sectionId" = a."sectionId"
      AND o."date" = a."date"
      AND o."hourNumber" = a."hourNumber"
      AND o."countsForAttendance" IS NOT NULL
  )
GROUP BY s.name;
