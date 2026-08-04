// One-time data load from "Name and mailid.txt": creates a User row per student
// with their college-issued externalId, name, and email. All seeded users share
// one temporary password and must change it (OTP-verified) on first login —
// same flow as apps/api/src/routes/auth.ts `mustChangePassword`.
//
// Run: DATABASE_URL=... SEED_TEMP_PASSWORD=... npx tsx prisma/seed.ts
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// Admin role assigned per user request; everyone else defaults to STUDENT.
const ADMIN_IDS = new Set(["E0324090", "E0324085", "E0324052"]);

const PEOPLE: { externalId: string; name: string }[] = [
  { externalId: "E0324052", name: "REA SOPHY G P" },
  { externalId: "E0324053", name: "P MAHATHI" },
  { externalId: "E0324054", name: "PRAVEEN KUMAR U" },
  { externalId: "E0324055", name: "SANJAY M" },
  { externalId: "E0324056", name: "M M SHRINGHESH" },
  { externalId: "E0324057", name: "PRIYADHARSHINI S" },
  { externalId: "E0324058", name: "AZHAGU PANDIAN R" },
  { externalId: "E0324059", name: "ENUGURTHI MOKSHITHA" },
  { externalId: "E0324060", name: "MEERA K" },
  { externalId: "E0324061", name: "Y PRATHIBHA" },
  { externalId: "E0324062", name: "VASUNDRA M A" },
  { externalId: "E0324063", name: "T SUBASELVAN" },
  { externalId: "E0324064", name: "CHRISTINE FEDORA R" },
  { externalId: "E0324065", name: "KIRUBADHARSHINI A S" },
  { externalId: "E0324066", name: "KASTHURI MANOJ" },
  { externalId: "E0324067", name: "N JAYASREE" },
  { externalId: "E0324068", name: "PAMUR SAHASRA" },
  { externalId: "E0324069", name: "DEEPAK V" },
  { externalId: "E0324070", name: "RESHMA T" },
  { externalId: "E0324071", name: "SHRI NIKETH R" },
  { externalId: "E0324072", name: "BADUR CHARISHMA" },
  { externalId: "E0324073", name: "JUDE AATISH" },
  { externalId: "E0324074", name: "VETRISELVAN S" },
  { externalId: "E0324075", name: "M JYOTHIKA" },
  { externalId: "E0324076", name: "KOYI MOHITH" },
  { externalId: "E0324077", name: "ROHITH RAMAKRISHNAN P" },
  { externalId: "E0324078", name: "SOWMIYA R" },
  { externalId: "E0324079", name: "A SURYA KUMAR" },
  { externalId: "E0324080", name: "SANJAY S P" },
  { externalId: "E0324081", name: "KISHORE KUMAR M" },
  { externalId: "E0324082", name: "AADIL AHMED A" },
  { externalId: "E0324083", name: "S VARUN VAIBHAV" },
  { externalId: "E0324084", name: "SYED MUSHAHID ALI S" },
  { externalId: "E0324085", name: "VAIDANI NAVEEN SOMASEKHAR VARMA" },
  { externalId: "E0324086", name: "NAKSHATRA A R" },
  { externalId: "E0324087", name: "PRIYADARSHINI D" },
  { externalId: "E0324088", name: "UPPARA CHAITANYA" },
  { externalId: "E0324089", name: "I G VARSHAA" },
  { externalId: "E0324090", name: "R JEYADEV" },
  { externalId: "E0324091", name: "ADITHYA M" },
  { externalId: "E0324092", name: "HARISHA K" },
  { externalId: "E0324093", name: "PRADEEP KUMAR M" },
  { externalId: "E0324095", name: "NETHRA J" },
  { externalId: "E0324096", name: "YOGESH E" },
  { externalId: "E0324097", name: "ASHWIN ASHOK" },
  { externalId: "E0324098", name: "J R NIKILESH GAJAN" },
  { externalId: "E0324099", name: "A JENIFER" },
  { externalId: "E0324100", name: "SHAHEEN BANU B" },
  { externalId: "E0324101", name: "K NETHRA" },
];

function emailFor(externalId: string): string {
  // File's mail-id list is the same ids lowercased @sriher.edu.in — derive rather than hardcode twice.
  return `${externalId.toLowerCase()}@sriher.edu.in`;
}

async function main() {
  const tempPassword = process.env.SEED_TEMP_PASSWORD ?? "Sriher@123";

  let org = await prisma.organization.findFirst();
  if (!org) {
    org = await prisma.organization.create({ data: { name: "SRIHER" } });
    console.log(`Created organization ${org.id}`);
  }

  const passwordHash = await bcrypt.hash(tempPassword, 10);

  for (const person of PEOPLE) {
    const role = ADMIN_IDS.has(person.externalId) ? "ADMIN" : "STUDENT";
    const email = emailFor(person.externalId);

    await prisma.user.upsert({
      where: { organizationId_externalId: { organizationId: org.id, externalId: person.externalId } },
      update: { name: person.name, email, role },
      create: {
        organizationId: org.id,
        externalId: person.externalId,
        name: person.name,
        email,
        role,
        passwordHash,
        mustChangePassword: true,
      },
    });
  }

  console.log(`Seeded ${PEOPLE.length} users (${ADMIN_IDS.size} admins) under org ${org.id}.`);
  console.log(`Shared temporary password: ${tempPassword} — each user must change it via OTP on first login.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
