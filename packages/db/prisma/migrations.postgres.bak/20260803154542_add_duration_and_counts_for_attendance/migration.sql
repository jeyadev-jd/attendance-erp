-- AlterTable
ALTER TABLE "subjects" ADD COLUMN     "countsForAttendance" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "timetables" ADD COLUMN     "durationHours" INTEGER NOT NULL DEFAULT 1;
