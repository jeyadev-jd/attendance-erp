import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import bcrypt from "bcryptjs";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { createStudentSchema, updateStudentSchema, csvRowSchema } from "../schemas/students";
import { parseCsvWithHeader } from "../lib/csv";

const students = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN", "CLASS_ADMIN");

async function assertSectionInOrg(prisma: any, sectionId: string, organizationId: string) {
  const section = await prisma.section.findFirst({
    where: { id: sectionId, semester: { academicYear: { organizationId } } },
  });
  if (!section) throw new HTTPException(404, { message: "Section not found" });
  return section;
}

students.get("/", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const sectionId = c.req.query("sectionId");

  const list = await prisma.student.findMany({
    where: {
      ...(sectionId ? { sectionId } : {}),
      section: { semester: { academicYear: { organizationId: user.organizationId } } },
    },
    // Department comes through the section so the roster can group/label by it.
    include: {
      user: { select: { email: true, mustChangePassword: true } },
      section: { include: { department: true } },
    },
    orderBy: { rollNo: "asc" },
  });
  return c.json(list);
});

students.get("/:id", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const student = await prisma.student.findFirst({
    where: { id: c.req.param("id"), section: { semester: { academicYear: { organizationId: user.organizationId } } } },
    include: { user: { select: { email: true, mustChangePassword: true, isActive: true } }, section: true },
  });
  if (!student) throw new HTTPException(404, { message: "Student not found" });
  return c.json(student);
});

/** Single student create — makes the User (shared temp password) + Student profile together. */
students.post("/", canManage, async (c) => {
  const body = createStudentSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");

  await assertSectionInOrg(prisma, body.sectionId, user.organizationId);

  const existingEmail = await prisma.user.findUnique({
    where: { organizationId_email: { organizationId: user.organizationId, email: body.email } },
  });
  if (existingEmail) throw new HTTPException(409, { message: "Email already registered" });

  const existingRoll = await prisma.student.findUnique({
    where: { sectionId_rollNo: { sectionId: body.sectionId, rollNo: body.rollNo } },
  });
  if (existingRoll) throw new HTTPException(409, { message: "Roll number already exists in this section" });

  const tempPassword = c.env.TEMP_STUDENT_PASSWORD ?? "Student@123";
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  // Nested create rather than an interactive $transaction: D1 has no interactive
  // transaction mode, and a nested write is a single atomic statement anyway.
  const newUser = await prisma.user.create({
    data: {
      organizationId: user.organizationId,
      email: body.email,
      name: body.name,
      role: "STUDENT",
      passwordHash,
      mustChangePassword: true,
      student: {
        create: { sectionId: body.sectionId, rollNo: body.rollNo, name: body.name },
      },
    },
    include: { student: true },
  });
  const created = newUser.student;

  return c.json(created, 201);
});

students.put("/:id", canManage, async (c) => {
  const body = updateStudentSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await prisma.student.findFirst({
    where: { id, section: { semester: { academicYear: { organizationId: user.organizationId } } } },
  });
  if (!existing) throw new HTTPException(404, { message: "Student not found" });

  if (body.sectionId) await assertSectionInOrg(prisma, body.sectionId, user.organizationId);

  if (body.rollNo) {
    const conflict = await prisma.student.findFirst({
      where: {
        sectionId: body.sectionId ?? existing.sectionId,
        rollNo: body.rollNo,
        id: { not: id },
      },
    });
    if (conflict) throw new HTTPException(409, { message: "Roll number already exists in this section" });
  }

  const updated = await prisma.student.update({ where: { id }, data: body });

  if (body.name) {
    await prisma.user.update({ where: { id: existing.userId }, data: { name: body.name } });
  }

  return c.json(updated);
});

/** Deactivates the student and their login rather than hard-deleting attendance history. */
students.delete("/:id", canManage, async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await prisma.student.findFirst({
    where: { id, section: { semester: { academicYear: { organizationId: user.organizationId } } } },
  });
  if (!existing) throw new HTTPException(404, { message: "Student not found" });

  await prisma.$transaction([
    prisma.student.update({ where: { id }, data: { status: "INACTIVE" } }),
    prisma.user.update({ where: { id: existing.userId }, data: { isActive: false } }),
  ]);

  return c.json({ deactivated: true });
});

/**
 * CSV bulk import. Body is raw CSV text with header: rollNo,name,email,sectionName[,departmentCode]
 * Validates every row (schema + section resolution + duplicate checks against DB and within the
 * file itself) and returns row-level errors WITHOUT writing anything if any row fails. Only when
 * every row is clean does it insert, transactionally, in one batch.
 */
students.post("/import", canManage, async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const semesterId = c.req.query("semesterId");
  if (!semesterId) throw new HTTPException(400, { message: "semesterId query param is required" });

  const semester = await prisma.semester.findFirst({
    where: { id: semesterId, academicYear: { organizationId: user.organizationId } },
  });
  if (!semester) throw new HTTPException(404, { message: "Semester not found" });

  const csvText = await c.req.text();
  if (!csvText.trim()) throw new HTTPException(400, { message: "Empty CSV body" });

  const rawRows = parseCsvWithHeader(csvText);
  if (rawRows.length === 0) throw new HTTPException(400, { message: "No data rows found" });

  type RowError = { row: number; message: string };
  const errors: RowError[] = [];
  const validRows: { rollNo: string; name: string; email: string; sectionId: string }[] = [];

  const sectionCache = new Map<string, string | null>(); // "sectionName::departmentCode" -> sectionId | null

  for (let i = 0; i < rawRows.length; i++) {
    const rowNum = i + 2; // +1 for 0-index, +1 for header row
    const raw = rawRows[i];

    const parsed = csvRowSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push({ row: rowNum, message: parsed.error.issues.map((iss) => iss.message).join("; ") });
      continue;
    }
    const { rollNo, name, email, sectionName } = parsed.data;
    const departmentCode = raw.departmentCode?.trim() || undefined;

    const cacheKey = `${sectionName}::${departmentCode ?? ""}`;
    let sectionId = sectionCache.get(cacheKey);
    if (sectionId === undefined) {
      const matches = await prisma.section.findMany({
        where: {
          semesterId,
          name: sectionName,
          ...(departmentCode ? { department: { code: departmentCode } } : {}),
        },
      });
      if (matches.length === 0) {
        sectionId = null;
        errors.push({ row: rowNum, message: `Section "${sectionName}" not found in this semester` });
      } else if (matches.length > 1) {
        sectionId = null;
        errors.push({
          row: rowNum,
          message: `Section name "${sectionName}" is ambiguous across departments — specify departmentCode`,
        });
      } else {
        sectionId = matches[0].id;
      }
      sectionCache.set(cacheKey, sectionId);
    }
    if (!sectionId) continue;

    const emailTaken = await prisma.user.findUnique({
      where: { organizationId_email: { organizationId: user.organizationId, email } },
    });
    if (emailTaken) {
      errors.push({ row: rowNum, message: `Email ${email} already registered` });
      continue;
    }

    const rollTaken = await prisma.student.findUnique({
      where: { sectionId_rollNo: { sectionId, rollNo } },
    });
    if (rollTaken) {
      errors.push({ row: rowNum, message: `Roll number ${rollNo} already exists in section ${sectionName}` });
      continue;
    }

    const dupInFile = validRows.some((r) => r.email === email || (r.sectionId === sectionId && r.rollNo === rollNo));
    if (dupInFile) {
      errors.push({ row: rowNum, message: `Duplicate email or roll number within the uploaded file` });
      continue;
    }

    validRows.push({ rollNo, name, email, sectionId });
  }

  if (errors.length > 0) {
    return c.json({ imported: false, totalRows: rawRows.length, errors }, 422);
  }

  const tempPassword = c.env.TEMP_STUDENT_PASSWORD ?? "Student@123";
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  const created = await prisma.$transaction(
    validRows.map((row) =>
      prisma.user.create({
        data: {
          organizationId: user.organizationId,
          email: row.email,
          name: row.name,
          role: "STUDENT",
          passwordHash,
          mustChangePassword: true,
          student: {
            create: { sectionId: row.sectionId, rollNo: row.rollNo, name: row.name },
          },
        },
      })
    )
  );

  return c.json({ imported: true, count: created.length }, 201);
});

export default students;
