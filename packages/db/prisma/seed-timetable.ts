/**
 * Seeds the AIDA / Batch-2 Semester-5 timetable: hour configs, faculty, subjects
 * and the weekly grid.
 *
 * Multi-hour labs are ONE entry with durationHours > 1 — marked once, but attendance
 * writes a record per covered hour so a 2-hour lab counts as 2 hours.
 *
 * Mentor-Mentee and Club Activity are real slots (attendance is taken) but carry
 * countsForAttendance = false, so they never affect a percentage.
 *
 * Idempotent: upserts everything, safe to re-run.
 *
 * Run: DATABASE_URL=... npx tsx prisma/seed-timetable.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEPARTMENT_CODE = "ADA";
const SECTION_NAME = "Batch-2";

const MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5, SAT = 6;

/**
 * Period timings. Breaks (09:50–10:10 morning, 12:00–13:00 lunch, 14:40–14:55
 * afternoon) are simply the gaps between periods — they are not stored as hours,
 * so no attendance can be marked against them.
 */
const HOURS: { hourNumber: number; startTime: string; endTime: string }[] = [
  { hourNumber: 1, startTime: "08:00", endTime: "08:55" },
  { hourNumber: 2, startTime: "08:55", endTime: "09:50" },
  // morning break 09:50–10:10
  { hourNumber: 3, startTime: "10:10", endTime: "11:05" },
  { hourNumber: 4, startTime: "11:05", endTime: "12:00" },
  // lunch 12:00–13:00
  { hourNumber: 5, startTime: "13:00", endTime: "13:50" },
  { hourNumber: 6, startTime: "13:50", endTime: "14:40" },
  // afternoon break 14:40–14:55
  { hourNumber: 7, startTime: "14:55", endTime: "15:45" },
];

const TEACHING_DAYS = [MON, TUE, WED, THU, FRI, SAT];

const FACULTY: { employeeId: string; name: string }[] = [
  { employeeId: "F-LEKHA", name: "Ms. C. Lekha" },
  { employeeId: "F-DEEPIKA", name: "Ms. P. Deepika" },
  { employeeId: "F-SUJA", name: "Dr. S. Suja Golden Shiny" },
  { employeeId: "F-GEETHA", name: "Ms. A. V. Geetha" },
  { employeeId: "F-POORNIMA", name: "Dr. M. Poornima Devi" },
  { employeeId: "F-DEENA", name: "Ms. S. Deena" },
  { employeeId: "F-EXTERNAL", name: "External Faculty" },
];

const SUBJECTS: { code: string; name: string; countsForAttendance?: boolean }[] = [
  { code: "CSE23CT301", name: "Computer Networks" },
  { code: "CSE23CL301", name: "Computer Networks Lab" },
  { code: "ADA23CT302", name: "Data Mining" },
  { code: "ADA23CL302", name: "Data Mining Lab" },
  { code: "ADA23DEU04", name: "Natural Language Processing" },
  { code: "ADA23DLU04", name: "NLP Lab" },
  { code: "ADA23CT301", name: "Deep Learning" },
  { code: "ADA23CL301", name: "Deep Learning Lab" },
  { code: "CSE23CT302", name: "Theory of Computation & Compiler Design" },
  { code: "CSE23AE301", name: "Professional Competency Development V" },
  { code: "CSE23AE302", name: "Professional Coding Practice IV" },
  { code: "ADA23SLU07", name: "Research Productivity Tools" },
  // Attendance is marked here, but it is excluded from every percentage.
  // (Club Activity has no subject at all — it is absent from the timetable, so
  // attendance simply cannot be taken for that period.)
  { code: "MM", name: "Mentor-Mentee Meeting", countsForAttendance: false },
];

/** hour = the FIRST period of the block; duration collapses multi-period labs into one entry. */
type Slot = { day: number; hour: number; duration?: number; code: string; faculty: string };

const TIMETABLE: Slot[] = [
  // ── Monday ──
  { day: MON, hour: 1, code: "CSE23CT301", faculty: "F-LEKHA" },
  { day: MON, hour: 2, code: "ADA23DEU04", faculty: "F-SUJA" },
  { day: MON, hour: 3, duration: 2, code: "ADA23CL302", faculty: "F-DEEPIKA" }, // 10:10–12:00
  { day: MON, hour: 5, duration: 2, code: "CSE23AE302", faculty: "F-EXTERNAL" }, // 13:00–14:40
  { day: MON, hour: 7, code: "CSE23CT302", faculty: "F-POORNIMA" },

  // ── Tuesday ──
  { day: TUE, hour: 1, code: "ADA23CT302", faculty: "F-DEEPIKA" },
  { day: TUE, hour: 2, code: "ADA23DEU04", faculty: "F-SUJA" },
  { day: TUE, hour: 3, duration: 2, code: "ADA23CL301", faculty: "F-GEETHA" }, // 10:10–12:00
  { day: TUE, hour: 5, code: "CSE23AE301", faculty: "F-EXTERNAL" },
  // hour 6 free
  { day: TUE, hour: 7, code: "CSE23CT302", faculty: "F-POORNIMA" },

  // ── Wednesday ──
  { day: WED, hour: 1, duration: 2, code: "ADA23DLU04", faculty: "F-SUJA" }, // 08:00–09:50
  { day: WED, hour: 3, code: "CSE23AE301", faculty: "F-EXTERNAL" },
  // Wed hour 4 is Club Activity — deliberately left off the timetable so no
  // attendance can be marked for it at all.
  { day: WED, hour: 5, code: "CSE23CT301", faculty: "F-LEKHA" },
  { day: WED, hour: 6, code: "ADA23CT301", faculty: "F-GEETHA" },
  { day: WED, hour: 7, code: "CSE23CT301", faculty: "F-LEKHA" },

  // ── Thursday ──
  { day: THU, hour: 1, code: "ADA23CT302", faculty: "F-DEEPIKA" },
  { day: THU, hour: 2, code: "MM", faculty: "F-EXTERNAL" },
  { day: THU, hour: 3, code: "ADA23CT302", faculty: "F-DEEPIKA" },
  { day: THU, hour: 4, code: "CSE23CT302", faculty: "F-POORNIMA" },
  { day: THU, hour: 5, code: "CSE23CT302", faculty: "F-POORNIMA" },
  { day: THU, hour: 6, code: "ADA23CT301", faculty: "F-GEETHA" },
  { day: THU, hour: 7, code: "ADA23DEU04", faculty: "F-SUJA" },

  // ── Friday ──
  { day: FRI, hour: 1, duration: 2, code: "CSE23CL301", faculty: "F-LEKHA" }, // 08:00–09:50
  { day: FRI, hour: 3, duration: 2, code: "CSE23AE302", faculty: "F-EXTERNAL" }, // 10:10–12:00
  { day: FRI, hour: 5, code: "ADA23SLU07", faculty: "F-DEENA" },
  // hour 6 free
  { day: FRI, hour: 7, code: "ADA23CT301", faculty: "F-GEETHA" },

  // ── Saturday ──
  { day: SAT, hour: 1, code: "CSE23CT301", faculty: "F-LEKHA" },
  { day: SAT, hour: 2, code: "MM", faculty: "F-EXTERNAL" },
  { day: SAT, hour: 3, code: "CSE23CT302", faculty: "F-POORNIMA" },
  { day: SAT, hour: 4, code: "ADA23SLU07", faculty: "F-DEENA" },
  { day: SAT, hour: 5, code: "ADA23DEU04", faculty: "F-SUJA" },
  { day: SAT, hour: 6, code: "ADA23CT301", faculty: "F-GEETHA" },
  { day: SAT, hour: 7, code: "ADA23CT302", faculty: "F-DEEPIKA" },
];

async function main() {
  const org = await prisma.organization.findFirst();
  if (!org) throw new Error("No organization found — run seed.ts first.");

  const department = await prisma.department.findFirst({
    where: { organizationId: org.id, code: DEPARTMENT_CODE },
  });
  if (!department) throw new Error(`Department ${DEPARTMENT_CODE} not found.`);

  const section = await prisma.section.findFirst({
    where: {
      name: SECTION_NAME,
      departmentId: department.id,
      semester: { status: "ACTIVE", academicYear: { organizationId: org.id } },
    },
    include: { semester: true },
  });
  if (!section) throw new Error(`Section "${SECTION_NAME}" not found in an ACTIVE semester.`);

  const semesterId = section.semesterId;

  // ── Hour configs, same period grid on every teaching day ──
  for (const day of TEACHING_DAYS) {
    for (const h of HOURS) {
      await prisma.hourConfig.upsert({
        where: { semesterId_dayOfWeek_hourNumber: { semesterId, dayOfWeek: day, hourNumber: h.hourNumber } },
        update: { startTime: h.startTime, endTime: h.endTime },
        create: { semesterId, dayOfWeek: day, ...h },
      });
    }
  }

  // ── Faculty ──
  const facultyByEmployeeId = new Map<string, string>();
  for (const f of FACULTY) {
    // Faculty needs a backing User row; these are placeholder logins that must set a
    // password via the normal OTP flow before they can sign in.
    const email = `${f.employeeId.toLowerCase().replace(/[^a-z0-9]/g, "")}@sriher.edu.in`;
    const user = await prisma.user.upsert({
      where: { organizationId_email: { organizationId: org.id, email } },
      update: { name: f.name },
      create: {
        organizationId: org.id,
        email,
        name: f.name,
        role: "FACULTY",
        passwordHash: "!", // unusable hash — must reset via OTP before first sign-in
        mustChangePassword: true,
      },
    });

    const faculty = await prisma.faculty.upsert({
      where: { departmentId_employeeId: { departmentId: department.id, employeeId: f.employeeId } },
      update: { name: f.name },
      create: { userId: user.id, departmentId: department.id, employeeId: f.employeeId, name: f.name },
    });
    facultyByEmployeeId.set(f.employeeId, faculty.id);
  }

  // ── Subjects ──
  const subjectByCode = new Map<string, string>();
  for (const s of SUBJECTS) {
    const subject = await prisma.subject.upsert({
      where: { departmentId_code: { departmentId: department.id, code: s.code } },
      update: { name: s.name, countsForAttendance: s.countsForAttendance ?? true },
      create: {
        departmentId: department.id,
        code: s.code,
        name: s.name,
        countsForAttendance: s.countsForAttendance ?? true,
      },
    });
    subjectByCode.set(s.code, subject.id);
  }

  // ── Timetable ──
  // Wipe first: a stale entry at an hour no longer used would otherwise linger,
  // since upsert only ever adds or updates.
  await prisma.timetable.deleteMany({ where: { sectionId: section.id } });

  for (const slot of TIMETABLE) {
    const subjectId = subjectByCode.get(slot.code);
    const facultyId = facultyByEmployeeId.get(slot.faculty);
    if (!subjectId) throw new Error(`Unknown subject code ${slot.code}`);
    if (!facultyId) throw new Error(`Unknown faculty ${slot.faculty}`);

    await prisma.timetable.create({
      data: {
        semesterId,
        sectionId: section.id,
        dayOfWeek: slot.day,
        hourNumber: slot.hour,
        durationHours: slot.duration ?? 1,
        subjectId,
        facultyId,
      },
    });
  }

  const totalHours = TIMETABLE.reduce((sum, s) => sum + (s.duration ?? 1), 0);
  console.log(
    `Seeded ${section.name} (${department.name}, ${section.semester.name}):\n` +
      `  ${HOURS.length} periods x ${TEACHING_DAYS.length} days of hour configs\n` +
      `  ${FACULTY.length} faculty, ${SUBJECTS.length} subjects\n` +
      `  ${TIMETABLE.length} timetable entries covering ${totalHours} hours/week`
  );
}

main()
  .catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
