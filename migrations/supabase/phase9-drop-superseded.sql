-- ============================================================================
-- Drop the superseded overall-total batch function.
--
-- batch_attendance_overview returned one row per student with a single combined
-- percentage across every subject. phase8 replaced it with
-- batch_attendance_by_subject, which breaks the same data down per subject —
-- an overall total hid the case this view exists for: a student who is fine on
-- average but failing one subject.
--
-- Nothing calls the old function any more. Dropping it is not about disk space
-- (a plpgsql function is a few KB against a table that grows every marked hour);
-- it is so the next person reading the schema does not find two batch functions
-- with different shapes and have to work out which one is live.
--
-- Safe to run more than once: IF EXISTS.
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS batch_attendance_overview(text, text, timestamptz, timestamptz);

COMMIT;

-- Verification: should return no rows.
SELECT proname
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND proname = 'batch_attendance_overview';
