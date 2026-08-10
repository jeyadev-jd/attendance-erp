// Students, served from Supabase over HTTPS.
//
// Mounted at /api/v2/students alongside the Prisma/D1 router at /api/students.
// Logic, guards, status codes and response shapes unchanged.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import bcrypt from "bcryptjs";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { requireSupabase } from "../middleware/supabase";
import { createStudentSchema, updateStudentSchema, csvRowSchema } from "../schemas/students";
import { parseCsvWithHeader } from "../lib/csv";
import * as repo from "@attendance/db/repos/students";
import * as userRepo from "@attendance/db/repos/users";
import { findSectionInOrg, findSemesterInOrg } from "@attendance/db/queries";
import type { SupabaseClient } from "@supabase/supabase-js";

const students = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN", "CLASS_ADMIN");

/** Mirrors assertSectionInOrg in the Prisma router, including its 404. */
async function assertSectionInOrg(
  db: SupabaseClient,
  sectionId: string,
  organizationId: string
) {
  const section = await findSectionInOrg(db, sectionId, organizationId);
  if (!section) throw new HTTPException(404, { message: "Section not found" });
  return section;
}

students.get("/", async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  return c.json(await repo.listByOrg(db, user.organizationId, c.req.query("sectionId")));
});

students.get("/:id", async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  const student = await repo.findWithRelations(db, c.req.param("id"), user.organizationId);
  if (!student) throw new HTTPException(404, { message: "Student not found" });
  return c.json(student);
});

/** Single student create — makes the User (shared temp password) + Student profile together. */
students.post("/", canManage, async (c) => {
  const body = createStudentSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");

  await assertSectionInOrg(db, body.sectionId, user.organizationId);

  // Both uniqueness checks are independent lookups, so they run together.
  const [existingEmail, existingRoll] = await Promise.all([
    userRepo.findByEmail(db, user.organizationId, body.email),
    repo.findByRollNo(db, body.sectionId, body.rollNo),
  ]);
  if (existingEmail) throw new HTTPException(409, { message: "Email already registered" });
  if (existingRoll) {
    throw new HTTPException(409, { message: "Roll number already exists in this section" });
  }

  const tempPassword = c.env.TEMP_STUDENT_PASSWORD ?? "Student@123";
  const created = await repo.createWithUser(db, {
    organizationId: user.organizationId,
    email: body.email,
    name: body.name,
    passwordHash: await bcrypt.hash(tempPassword, 10),
    sectionId: body.sectionId,
    rollNo: body.rollNo,
  });
  // Null means an insert lost a race with a concurrent create; the unique constraint
  // decides, producing the same 409 as the pre-checks above.
  if (!created) throw new HTTPException(409, { message: "Email or roll number already exists" });

  return c.json(created, 201);
});

students.put("/:id", canManage, async (c) => {
  const body = updateStudentSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await repo.findInOrg(db, id, user.organizationId);
  if (!existing) throw new HTTPException(404, { message: "Student not found" });

  if (body.sectionId) await assertSectionInOrg(db, body.sectionId, user.organizationId);

  if (body.rollNo) {
    const conflict = await repo.findRollNoConflict(
      db,
      body.sectionId ?? existing.sectionId,
      body.rollNo,
      id
    );
    if (conflict) {
      throw new HTTPException(409, { message: "Roll number already exists in this section" });
    }
  }

  const updated = await repo.update(db, id, body);

  // The login's display name tracks the student's, as in the Prisma route.
  if (body.name) await userRepo.setName(db, existing.userId, body.name);

  return c.json(updated);
});

/** Deactivates the student and their login rather than hard-deleting attendance history. */
students.delete("/:id", canManage, async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await repo.findInOrg(db, id, user.organizationId);
  if (!existing) throw new HTTPException(404, { message: "Student not found" });

  await repo.deactivate(db, id, existing.userId);
  return c.json({ deactivated: true });
});

/**
 * CSV bulk import. Body is raw CSV text with header: rollNo,name,email,sectionName[,departmentCode]
 * Validates every row (schema + section resolution + duplicate checks against DB and within the
 * file itself) and returns row-level errors WITHOUT writing anything if any row fails. Only when
 * every row is clean does it insert, in one batch.
 */
students.post("/import", canManage, async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  const semesterId = c.req.query("semesterId");
  if (!semesterId) throw new HTTPException(400, { message: "semesterId query param is required" });

  const semester = await findSemesterInOrg(db, semesterId, user.organizationId);
  if (!semester) throw new HTTPException(404, { message: "Semester not found" });

  const csvText = await c.req.text();
  if (!csvText.trim()) throw new HTTPException(400, { message: "Empty CSV body" });

  const rawRows = parseCsvWithHeader(csvText);
  if (rawRows.length === 0) throw new HTTPException(400, { message: "No data rows found" });

  type RowError = { row: number; message: string };
  const errors: RowError[] = [];
  const parsedRows: {
    rowNum: number;
    rollNo: string;
    name: string;
    email: string;
    sectionName: string;
    departmentCode?: string;
  }[] = [];

  // Pass 1 — schema validation only. Nothing here touches the database.
  for (let i = 0; i < rawRows.length; i++) {
    const rowNum = i + 2; // +1 for 0-index, +1 for header row
    const parsed = csvRowSchema.safeParse(rawRows[i]);
    if (!parsed.success) {
      errors.push({
        row: rowNum,
        message: parsed.error.issues.map((iss) => iss.message).join("; "),
      });
      continue;
    }
    parsedRows.push({
      rowNum,
      ...parsed.data,
      departmentCode: rawRows[i].departmentCode?.trim() || undefined,
    });
  }

  // Pass 2 — resolve each distinct section name once.
  //
  // The Prisma import cached this per file too, but every miss was a query; here a
  // repeated section name costs nothing beyond the first lookup, which matters more
  // now that each lookup is an HTTP round trip.
  const sectionCache = new Map<string, string | null>();
  for (const row of parsedRows) {
    const cacheKey = `${row.sectionName}::${row.departmentCode ?? ""}`;
    if (sectionCache.has(cacheKey)) continue;

    const matches = await repo.findSectionsByName(
      db,
      semesterId,
      row.sectionName,
      row.departmentCode
    );
    sectionCache.set(cacheKey, matches.length === 1 ? matches[0].id : null);
    if (matches.length === 0) {
      errors.push({
        row: row.rowNum,
        message: `Section "${row.sectionName}" not found in this semester`,
      });
    } else if (matches.length > 1) {
      errors.push({
        row: row.rowNum,
        message: `Section name "${row.sectionName}" is ambiguous across departments — specify departmentCode`,
      });
    }
  }

  // Pass 3 — duplicate checks, batched.
  //
  // The Prisma version issued two findUnique calls PER ROW (email, then roll number).
  // Over HTTP that is 2N requests for an N-row file — the N+1 this migration must not
  // reproduce. Two queries now cover the whole file regardless of size.
  const resolved = parsedRows
    .map((r) => ({ ...r, sectionId: sectionCache.get(`${r.sectionName}::${r.departmentCode ?? ""}`) }))
    .filter((r): r is typeof r & { sectionId: string } => !!r.sectionId);

  const [takenEmails, takenRollNos] = await Promise.all([
    repo.findExistingEmails(db, user.organizationId, resolved.map((r) => r.email)),
    repo.findExistingRollNos(
      db,
      [...new Set(resolved.map((r) => r.sectionId))],
      [...new Set(resolved.map((r) => r.rollNo))]
    ),
  ]);

  const validRows: { rollNo: string; name: string; email: string; sectionId: string }[] = [];
  for (const row of resolved) {
    if (takenEmails.has(row.email)) {
      errors.push({ row: row.rowNum, message: `Email ${row.email} already registered` });
      continue;
    }
    if (takenRollNos.has(`${row.sectionId}::${row.rollNo}`)) {
      errors.push({
        row: row.rowNum,
        message: `Roll number ${row.rollNo} already exists in section ${row.sectionName}`,
      });
      continue;
    }
    const dupInFile = validRows.some(
      (r) => r.email === row.email || (r.sectionId === row.sectionId && r.rollNo === row.rollNo)
    );
    if (dupInFile) {
      errors.push({
        row: row.rowNum,
        message: `Duplicate email or roll number within the uploaded file`,
      });
      continue;
    }
    validRows.push({
      rollNo: row.rollNo,
      name: row.name,
      email: row.email,
      sectionId: row.sectionId,
    });
  }

  // All-or-nothing: a single bad row writes nothing, as before.
  if (errors.length > 0) {
    errors.sort((a, b) => a.row - b.row);
    return c.json({ imported: false, totalRows: rawRows.length, errors }, 422);
  }

  const tempPassword = c.env.TEMP_STUDENT_PASSWORD ?? "Student@123";
  const count = await repo.bulkCreateWithUsers(
    db,
    user.organizationId,
    await bcrypt.hash(tempPassword, 10),
    validRows
  );

  return c.json({ imported: true, count }, 201);
});

export default students;
