// Students repository — PostgREST equivalents of apps/api/src/routes/students.ts.
//
// A student is two rows: a `users` row (login) and a `students` row (roll number,
// section). Prisma created both in one nested write, which was a single atomic
// statement. PostgREST has no nested insert, so creation here is two requests with
// an explicit compensating delete — see createWithUser.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many, maybeOne, one, isUniqueViolation, normaliseDates, DATE_FIELDS } from "../supabase";
import { cuid } from "../ids";

export type Student = {
  id: string;
  userId: string;
  sectionId: string;
  rollNo: string;
  name: string;
  status: string;
};

const COLS = "id,userId,sectionId,rollNo,name,status";

/** Org scoping: student -> section -> semester -> academicYear -> organizationId. */
const ORG_EMBED = "sections!inner(id,semesters!inner(id,academic_years!inner(organizationId)))";
const ORG_PATH = "sections.semesters.academic_years.organizationId";

/** Drops the `sections` key the org-scoping embed adds. */
function strip<T extends Record<string, unknown>>(row: T): Omit<T, "sections"> {
  const { sections: _embed, ...rest } = row as T & { sections?: unknown };
  return rest;
}

/**
 * Reshapes a PostgREST row into the shape Prisma returned.
 *
 * The two name embedded relations differently, and the API contract follows Prisma:
 *   Prisma     user  / section  / department   (relation names, singular)
 *   PostgREST  users / sections / departments  (table names, plural)
 *
 * The org-scoping join also adds a nested `semesters` object that Prisma's response
 * never contained. Returning the PostgREST shape would rename three fields the
 * frontend reads and add a fourth — a contract break that typechecks cleanly.
 */
function toPrismaShape(row: Record<string, unknown>): Record<string, unknown> {
  const { users, sections, ...rest } = row as {
    users?: unknown;
    sections?: Record<string, unknown>;
  } & Record<string, unknown>;

  const out: Record<string, unknown> = { ...rest };
  if (users !== undefined) out.user = users;

  if (sections) {
    // Drop the scoping-only `semesters` embed; keep department, renamed.
    const { departments, semesters: _scoping, ...sectionRest } = sections as {
      departments?: unknown;
      semesters?: unknown;
    } & Record<string, unknown>;
    out.section = departments === undefined
      ? sectionRest
      : { ...sectionRest, department: departments };
  }

  return out;
}

/**
 * Student roster for an organization, optionally narrowed to one section.
 *
 * Replaces prisma.student.findMany with `include: { user, section: { include:
 * { department } } }`. All three relations arrive as embeds in one request; the
 * department comes through the section so the roster can group and label by it.
 *
 * The org-scoping embed and the display embeds are the same `sections` key, so this
 * selects the display shape and filters on the nested path — one embed serving both
 * purposes rather than two joins of the same table.
 */
export async function listByOrg(
  db: SupabaseClient,
  organizationId: string,
  sectionId?: string
) {
  let q = db
    .from("students")
    .select(
      `${COLS},` +
        "users(email,mustChangePassword)," +
        "sections!inner(id,semesterId,departmentId,name," +
        "departments(id,organizationId,code,name)," +
        "semesters!inner(id,academic_years!inner(organizationId)))"
    )
    .eq(ORG_PATH, organizationId);
  if (sectionId) q = q.eq("sectionId", sectionId);

  // Cast: supabase-js cannot infer a select string this deeply nested and falls back
  // to GenericStringError. The query itself is valid — verified against the live
  // schema — so the result is typed here rather than simplifying the embed and
  // paying extra round trips.
  const rows = many<Record<string, unknown>>(
    (await q.order("rollNo", { ascending: true })) as unknown as {
      data: Record<string, unknown>[] | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "students.listByOrg"
  );
  return rows.map(toPrismaShape);
}

/** One student with user and section, org-scoped. Replaces findFirst with includes. */
export async function findWithRelations(
  db: SupabaseClient,
  id: string,
  organizationId: string
) {
  const row = maybeOne<Record<string, unknown>>(
    (await db
      .from("students")
      .select(
        `${COLS},` +
          "users(email,mustChangePassword,isActive)," +
          "sections!inner(id,semesterId,departmentId,name," +
          "semesters!inner(id,academic_years!inner(organizationId)))"
      )
      .eq("id", id)
      .eq(ORG_PATH, organizationId)
      .maybeSingle()) as unknown as {
      data: Record<string, unknown> | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "students.findWithRelations"
  );
  return row ? toPrismaShape(row) : null;
}

/** Org-scoped existence check. Replaces the findFirst guard before update/delete. */
export async function findInOrg(
  db: SupabaseClient,
  id: string,
  organizationId: string
): Promise<Student | null> {
  const row = maybeOne<Student & { sections?: unknown }>(
    await db
      .from("students")
      .select(`${COLS},${ORG_EMBED}`)
      .eq("id", id)
      .eq(ORG_PATH, organizationId)
      .maybeSingle(),
    "students.findInOrg"
  );
  return row ? (strip(row) as Student) : null;
}

/** Looks up by the (sectionId, rollNo) unique key. Replaces findUnique. */
export async function findByRollNo(db: SupabaseClient, sectionId: string, rollNo: string) {
  return maybeOne<Student>(
    await db
      .from("students")
      .select(COLS)
      .eq("sectionId", sectionId)
      .eq("rollNo", rollNo)
      .maybeSingle(),
    "students.findByRollNo"
  );
}

/** Finds a roll-number clash excluding one student — used when editing. */
export async function findRollNoConflict(
  db: SupabaseClient,
  sectionId: string,
  rollNo: string,
  excludeId: string
) {
  return maybeOne<{ id: string }>(
    await db
      .from("students")
      .select("id")
      .eq("sectionId", sectionId)
      .eq("rollNo", rollNo)
      .neq("id", excludeId)
      .maybeSingle(),
    "students.findRollNoConflict"
  );
}

/**
 * Creates the user + student pair.
 *
 * Prisma did this as one nested write, which was atomic. PostgREST cannot nest an
 * insert, so the two rows go in separately and the user row is deleted if the
 * student insert fails — otherwise a failure would strand a login with no student
 * profile, which nothing in the app would surface or clean up.
 *
 * Returns null when either insert hits a unique violation, so the route raises its
 * existing 409 rather than a 500.
 */
export async function createWithUser(
  db: SupabaseClient,
  data: {
    organizationId: string;
    email: string;
    name: string;
    passwordHash: string;
    sectionId: string;
    rollNo: string;
  }
): Promise<Student | null> {
  const now = new Date().toISOString();
  const userId = cuid();

  const userResult = await db.from("users").insert({
    id: userId,
    organizationId: data.organizationId,
    email: data.email,
    name: data.name,
    role: "STUDENT",
    passwordHash: data.passwordHash,
    mustChangePassword: true,
    isActive: true,
    otpAttempts: 0,
    createdAt: now,
    updatedAt: now,
  });
  if (isUniqueViolation(userResult.error)) return null;
  if (userResult.error) throw new Error(`students.createWithUser (user): ${userResult.error.message}`);

  const studentResult = await db
    .from("students")
    .insert({
      id: cuid(),
      userId,
      sectionId: data.sectionId,
      rollNo: data.rollNo,
      name: data.name,
      status: "ACTIVE",
    })
    .select(COLS)
    .single();

  if (studentResult.error) {
    // Compensating delete: without it the orphaned user row would block the email
    // for any retry, with no student record to explain why.
    await db.from("users").delete().eq("id", userId);
    if (isUniqueViolation(studentResult.error)) return null;
    throw new Error(`students.createWithUser (student): ${studentResult.error.message}`);
  }

  return one<Student>(studentResult, "students.createWithUser");
}

/** Updates a student. Caller has already proven org membership. */
export async function update(
  db: SupabaseClient,
  id: string,
  data: Partial<{ rollNo: string; name: string; sectionId: string; status: string }>
) {
  return one<Student>(
    await db.from("students").update(data).eq("id", id).select(COLS).single(),
    "students.update"
  );
}

/**
 * Deactivates the student and their login.
 *
 * Replaces a two-statement $transaction. The updates target different tables, so
 * they cannot be one PostgREST request; they run in parallel because neither depends
 * on the other, and both are idempotent — a partial failure leaves a state the same
 * call can safely repair.
 */
export async function deactivate(db: SupabaseClient, studentId: string, userId: string) {
  const [studentRes, userRes] = await Promise.all([
    db.from("students").update({ status: "INACTIVE" }).eq("id", studentId),
    db
      .from("users")
      .update({ isActive: false, updatedAt: new Date().toISOString() })
      .eq("id", userId),
  ]);
  if (studentRes.error) throw new Error(`students.deactivate (student): ${studentRes.error.message}`);
  if (userRes.error) throw new Error(`students.deactivate (user): ${userRes.error.message}`);
}

// ───────────────────────── CSV import ─────────────────────────

/**
 * Resolves a section by name within a semester, optionally disambiguated by
 * department code. Returns every match so the caller can report ambiguity.
 */
export async function findSectionsByName(
  db: SupabaseClient,
  semesterId: string,
  name: string,
  departmentCode?: string
) {
  let q = db
    .from("sections")
    .select("id,departments!inner(code)")
    .eq("semesterId", semesterId)
    .eq("name", name);
  if (departmentCode) q = q.eq("departments.code", departmentCode);

  return many<{ id: string }>(
    (await q) as unknown as {
      data: { id: string }[] | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "students.findSectionsByName"
  );
}

/**
 * Bulk-creates validated import rows.
 *
 * Two batched inserts rather than one pair per student: the Prisma version issued N
 * nested creates inside a $transaction, which from a Worker would be 2N HTTP
 * requests. Ids are generated up front so the student rows can reference their users
 * without reading anything back.
 *
 * The route has already validated every row and refuses to call this unless all of
 * them are clean, so a failure here is infrastructural rather than per-row; the user
 * batch is deleted to avoid stranding logins without student profiles.
 */
export async function bulkCreateWithUsers(
  db: SupabaseClient,
  organizationId: string,
  passwordHash: string,
  rows: { rollNo: string; name: string; email: string; sectionId: string }[]
): Promise<number> {
  if (rows.length === 0) return 0;
  const now = new Date().toISOString();

  const pairs = rows.map((r) => ({ userId: cuid(), studentId: cuid(), row: r }));

  const userRes = await db.from("users").insert(
    pairs.map(({ userId, row }) => ({
      id: userId,
      organizationId,
      email: row.email,
      name: row.name,
      role: "STUDENT",
      passwordHash,
      mustChangePassword: true,
      isActive: true,
      otpAttempts: 0,
      createdAt: now,
      updatedAt: now,
    }))
  );
  if (userRes.error) throw new Error(`students.bulkCreate (users): ${userRes.error.message}`);

  const studentRes = await db.from("students").insert(
    pairs.map(({ userId, studentId, row }) => ({
      id: studentId,
      userId,
      sectionId: row.sectionId,
      rollNo: row.rollNo,
      name: row.name,
      status: "ACTIVE",
    }))
  );

  if (studentRes.error) {
    await db.from("users").delete().in(
      "id",
      pairs.map((p) => p.userId)
    );
    throw new Error(`students.bulkCreate (students): ${studentRes.error.message}`);
  }

  return pairs.length;
}

/** Emails already registered in this org, from a candidate list. For import validation. */
export async function findExistingEmails(
  db: SupabaseClient,
  organizationId: string,
  emails: string[]
): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const rows = many<{ email: string }>(
    await db
      .from("users")
      .select("email")
      .eq("organizationId", organizationId)
      .in("email", emails),
    "students.findExistingEmails"
  );
  return new Set(rows.map((r) => r.email));
}

/**
 * Existing (sectionId, rollNo) pairs from a candidate list, as "sectionId::rollNo".
 *
 * One query for the whole file rather than one per row: the Prisma import ran a
 * findUnique per student, which over HTTP would be an N+1.
 */
export async function findExistingRollNos(
  db: SupabaseClient,
  sectionIds: string[],
  rollNos: string[]
): Promise<Set<string>> {
  if (sectionIds.length === 0 || rollNos.length === 0) return new Set();
  const rows = many<{ sectionId: string; rollNo: string }>(
    await db
      .from("students")
      .select("sectionId,rollNo")
      .in("sectionId", sectionIds)
      .in("rollNo", rollNos),
    "students.findExistingRollNos"
  );
  return new Set(rows.map((r) => `${r.sectionId}::${r.rollNo}`));
}
