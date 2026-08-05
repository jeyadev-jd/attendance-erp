-- AlterTable: snapshot countsForAttendance onto each attendance row at write time,
-- so a one-off override can be tracked (bunk detection still applies) without moving
-- anyone's percentage, independent of the subject's own default.
ALTER TABLE "attendance" ADD COLUMN "countsForAttendance" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable: lets a specific date's timetable override opt out of (or back into)
-- counting toward attendance, overriding the subject's own setting for just that slot.
ALTER TABLE "timetable_overrides" ADD COLUMN "countsForAttendance" BOOLEAN;
