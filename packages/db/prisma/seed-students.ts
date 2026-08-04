/**
 * Creates Student profiles for the AIDA / Batch-2 roster, linking each to the User
 * row already created by `seed.ts` (matched on externalId, which is the UID/roll number).
 *
 * seed.ts could not do this itself: a Student requires a sectionId, and sections
 * only exist once an academic year + semester + section have been set up.
 *
 * Idempotent — re-running skips students that already exist.
 *
 * Run: DATABASE_URL=... npx tsx prisma/seed-students.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEPARTMENT_CODE = "ADA"; // AIDA
const SECTION_NAME = "Batch-2";

async function main() {
  const org = await prisma.organization.findFirst();
  if (!org) throw new Error("No organization found — run seed.ts first.");

  const department = await prisma.department.findFirst({
    where: { organizationId: org.id, code: DEPARTMENT_CODE },
  });
  if (!department) throw new Error(`Department ${DEPARTMENT_CODE} not found — create it in the admin UI first.`);

  const section = await prisma.section.findFirst({
    where: {
      name: SECTION_NAME,
      departmentId: department.id,
      semester: { status: "ACTIVE", academicYear: { organizationId: org.id } },
    },
    include: { semester: true },
  });
  if (!section) {
    throw new Error(`Section "${SECTION_NAME}" not found in an ACTIVE semester — create it in the admin UI first.`);
  }

  // Every person on the roster gets a Student profile, including the class admins —
  // they are students in this batch who also hold admin rights, and without a profile
  // their attendance could never be marked. Role and Student profile are independent.
  const users = await prisma.user.findMany({
    where: { organizationId: org.id, externalId: { not: null } },
    orderBy: { externalId: "asc" },
  });

  let created = 0;
  let skipped = 0;

  for (const user of users) {
    const existing = await prisma.student.findFirst({ where: { userId: user.id } });
    if (existing) {
      skipped++;
      continue;
    }

    await prisma.student.create({
      data: {
        userId: user.id,
        sectionId: section.id,
        rollNo: user.externalId!, // UID is the roll number
        name: user.name,
        status: "ACTIVE",
      },
    });
    created++;
  }

  console.log(
    `Section "${section.name}" (${department.name}, ${section.semester.name}): ` +
      `${created} students created, ${skipped} already existed.`
  );
}

main()
  .catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
