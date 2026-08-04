-- CreateTable
CREATE TABLE "timetable_overrides" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "semesterId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "hourNumber" INTEGER NOT NULL,
    "durationHours" INTEGER NOT NULL DEFAULT 1,
    "subjectId" TEXT,
    "facultyId" TEXT,
    "reason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timetable_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "timetable_overrides_sectionId_date_idx" ON "timetable_overrides"("sectionId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_overrides_sectionId_date_hourNumber_key" ON "timetable_overrides"("sectionId", "date", "hourNumber");

-- AddForeignKey
ALTER TABLE "timetable_overrides" ADD CONSTRAINT "timetable_overrides_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_overrides" ADD CONSTRAINT "timetable_overrides_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "semesters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_overrides" ADD CONSTRAINT "timetable_overrides_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_overrides" ADD CONSTRAINT "timetable_overrides_facultyId_fkey" FOREIGN KEY ("facultyId") REFERENCES "faculty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_overrides" ADD CONSTRAINT "timetable_overrides_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
