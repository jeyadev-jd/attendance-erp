// Timetable, served from Supabase over HTTPS.
//
// Mounted at /api/v2/timetable alongside the Prisma/D1 router.
// Logic, guards, status codes and response shapes unchanged.
//
// The overlap arithmetic stays here, unchanged from the Prisma route: it is pure
// business logic over one section-day's rows, and PostgreSQL has already narrowed
// the candidate set. What did change is how those candidates are fetched — the bulk
// endpoints previously issued two conflict queries per entry, which over HTTP would
// be 2N round trips.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import { requireSupabase } from "../middleware/supabase";
import {
  createTimetableEntrySchema,
  updateTimetableEntrySchema,
  bulkTimetableSchema,
  swapTimetableSchema,
  bulkAssignSchema,
  timetableOverrideSchema,
  overrideListQuerySchema,
} from "../schemas/academic";
import * as repo from "@attendance/db/repos/timetable";
import * as subjectRepo from "@attendance/db/repos/subjects";
import { findSectionInOrg } from "@attendance/db/queries";
import type { SupabaseClient } from "@supabase/supabase-js";

const timetable = new Hono<AppEnv>();
const canManage = roleGuard("SUPER_ADMIN", "ADMIN");

type Entry = {
  semesterId: string;
  sectionId: string;
  dayOfWeek: number;
  hourNumber: number;
  durationHours?: number;
  subjectId: string;
  facultyId: string;
};

/** Two blocks clash when their hour ranges overlap at all, not just when they start together. */
function overlaps(aStart: number, aDuration: number, bStart: number, bDuration: number): boolean {
  return aStart < bStart + bDuration && bStart < aStart + aDuration;
}

const durationOf = (e: { durationHours?: number }) => e.durationHours ?? 1;

/**
 * A candidate row from a conflict lookup, with the embeds the error messages read.
 *
 * The repository returns reshaped rows as Record<string, unknown> because the select
 * strings are too deeply nested for supabase-js to infer. The columns used here are
 * the ones those queries explicitly select, so this names them rather than reaching
 * through `any` at each use site.
 */
type ConflictRow = {
  id: string;
  sectionId: string;
  facultyId: string;
  dayOfWeek: number;
  hourNumber: number;
  durationHours: number;
  subject: { name: string };
  section: { name: string };
};

/**
 * Faculty conflict: same faculty, same day, overlapping hours, different section.
 * Multi-hour labs mean a plain hourNumber equality check is not enough — a 2-hour
 * lab starting at hour 3 also occupies hour 4, so ranges are compared instead.
 */
async function findFacultyConflict(db: SupabaseClient, entry: Entry, excludeId?: string) {
  const sameDay = await repo.facultyDayEntries(
    db,
    entry.facultyId,
    entry.dayOfWeek,
    entry.sectionId,
    excludeId
  );
  return (
    (sameDay as unknown as ConflictRow[]).find((e) =>
      overlaps(entry.hourNumber, durationOf(entry), e.hourNumber, durationOf(e))
    ) ?? null
  );
}

/**
 * Same-section clash. The DB unique constraint only covers identical start hours, so
 * a block overlapping an existing one (e.g. a 2-hour lab landing on an occupied hour)
 * has to be caught here.
 */
async function findSectionOverlap(db: SupabaseClient, entry: Entry, excludeId?: string) {
  const sameDay = await repo.sectionDayEntries(db, entry.sectionId, entry.dayOfWeek, excludeId);
  return (
    (sameDay as unknown as ConflictRow[]).find((e) =>
      overlaps(entry.hourNumber, durationOf(entry), e.hourNumber, durationOf(e))
    ) ?? null
  );
}

async function assertOrgScope(db: SupabaseClient, entry: Entry, organizationId: string) {
  // Three independent lookups; run together rather than serially.
  const [section, subject, faculty] = await Promise.all([
    findSectionInOrg(db, entry.sectionId, organizationId),
    subjectRepo.findInOrg(db, entry.subjectId, organizationId),
    facultyInOrg(db, entry.facultyId, organizationId),
  ]);
  if (!section) throw new HTTPException(404, { message: "Section not found" });
  if (!subject) throw new HTTPException(404, { message: "Subject not found" });
  if (!faculty) throw new HTTPException(404, { message: "Faculty not found" });
}

/** Faculty membership check, scoped through department. */
async function facultyInOrg(db: SupabaseClient, facultyId: string, organizationId: string) {
  const { data, error } = await db
    .from("faculty")
    .select("id,departments!inner(organizationId)")
    .eq("id", facultyId)
    .eq("departments.organizationId", organizationId)
    .maybeSingle();
  if (error) throw new Error(`timetable.facultyInOrg: ${error.message}`);
  return data;
}

timetable.get("/", async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  return c.json(
    await repo.listByOrg(db, user.organizationId, {
      sectionId: c.req.query("sectionId"),
      semesterId: c.req.query("semesterId"),
    })
  );
});

timetable.get("/faculty/:facultyId", async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  return c.json(await repo.listByFaculty(db, c.req.param("facultyId"), user.organizationId));
});

timetable.post("/", canManage, async (c) => {
  const body = createTimetableEntrySchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");

  await assertOrgScope(db, body, user.organizationId);

  const overlap = await findSectionOverlap(db, body);
  if (overlap) {
    const span =
      overlap.durationHours > 1
        ? `hours ${overlap.hourNumber}-${overlap.hourNumber + overlap.durationHours - 1}`
        : `hour ${overlap.hourNumber}`;
    throw new HTTPException(409, {
      message: `This section already has ${overlap.subject.name} at ${span}`,
    });
  }

  const conflict = await findFacultyConflict(db, body);
  if (conflict) {
    throw new HTTPException(409, {
      message: `Faculty already teaching ${conflict.subject.name} for section ${conflict.section.name} at this day/hour`,
    });
  }

  const entry = await repo.create(db, body);
  // Null means the unique constraint rejected it — the same 409 Prisma's P2002
  // produced, decided by the database rather than the pre-check above.
  if (!entry) {
    throw new HTTPException(409, {
      message: "This section already has a subject scheduled at this day/hour",
    });
  }
  return c.json(entry, 201);
});

/**
 * Bulk create — validates every entry's faculty-conflict and org scope up front
 * (no partial writes), then inserts in one batch.
 */
timetable.post("/bulk", canManage, async (c) => {
  const body = bulkTimetableSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");

  const errors: { index: number; message: string }[] = [];

  // Every relevant day's entries in ONE request, instead of two conflict queries per
  // entry. The overlap arithmetic below is unchanged; only the fetch was batched.
  const existing = await repo.entriesForDays(
    db,
    body.entries.map((e) => e.facultyId),
    body.entries.map((e) => e.sectionId),
    body.entries.map((e) => e.dayOfWeek)
  );

  for (let i = 0; i < body.entries.length; i++) {
    const entry = body.entries[i];
    try {
      await assertOrgScope(db, entry, user.organizationId);
    } catch {
      errors.push({ index: i, message: "Invalid section/subject/faculty reference" });
      continue;
    }

    const conflict = existing.find(
      (e: any) =>
        e.facultyId === entry.facultyId &&
        e.dayOfWeek === entry.dayOfWeek &&
        e.sectionId !== entry.sectionId &&
        overlaps(entry.hourNumber, durationOf(entry), e.hourNumber, durationOf(e))
    );
    if (conflict) {
      errors.push({
        index: i,
        message: `Faculty conflict with section ${(conflict as any).section.name} at day ${entry.dayOfWeek} hour ${entry.hourNumber}`,
      });
    }

    // Conflicts within the same batch (two entries claiming the same faculty/day/hour).
    const dupInBatch = body.entries.some(
      (other, j) =>
        j !== i &&
        other.facultyId === entry.facultyId &&
        other.dayOfWeek === entry.dayOfWeek &&
        other.hourNumber === entry.hourNumber &&
        other.sectionId !== entry.sectionId
    );
    if (dupInBatch) {
      errors.push({ index: i, message: "Conflicts with another entry in this same request" });
    }
  }

  if (errors.length > 0) {
    return c.json({ inserted: false, errors }, 422);
  }

  const count = await repo.createMany(db, body.entries);
  return c.json({ inserted: true, count }, 201);
});

// ── One-off, date-specific changes ──────────────────────────────────────────
// Registered before the "/:id" routes below: Hono matches in declaration order, so
// "/overrides" would otherwise be swallowed as an :id parameter.

timetable.get("/overrides", async (c) => {
  const query = overrideListQuerySchema.parse({
    sectionId: c.req.query("sectionId"),
    dateFrom: c.req.query("dateFrom"),
    dateTo: c.req.query("dateTo"),
  });
  const db = requireSupabase(c);
  const user = c.get("user");

  return c.json(await repo.listOverrides(db, query.sectionId, user.organizationId, query));
});

/** Creates or replaces a single date's override. subjectId null cancels the period. */
timetable.put("/overrides", canManage, async (c) => {
  const body = timetableOverrideSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");

  const section = await findSectionInOrg(db, body.sectionId, user.organizationId);
  if (!section) throw new HTTPException(404, { message: "Section not found" });

  if (body.subjectId) {
    const subject = await subjectRepo.findInOrg(db, body.subjectId, user.organizationId);
    if (!subject) throw new HTTPException(404, { message: "Subject not found" });
    if (!body.facultyId) {
      throw new HTTPException(400, { message: "Faculty is required when a subject is set" });
    }
    const faculty = await facultyInOrg(db, body.facultyId, user.organizationId);
    if (!faculty) throw new HTTPException(404, { message: "Faculty not found" });
  }

  return c.json(
    await repo.upsertOverride(db, {
      semesterId: body.semesterId,
      sectionId: body.sectionId,
      date: new Date(`${body.date}T00:00:00.000Z`),
      hourNumber: body.hourNumber,
      durationHours: body.durationHours,
      subjectId: body.subjectId ?? null,
      facultyId: body.facultyId ?? null,
      countsForAttendance: body.countsForAttendance ?? null,
      reason: body.reason,
      createdById: user.sub,
    })
  );
});

/** Removes an override so the date falls back to the regular weekly timetable. */
timetable.delete("/overrides/:id", canManage, async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await repo.findOverrideInOrg(db, id, user.organizationId);
  if (!existing) throw new HTTPException(404, { message: "Override not found" });

  await repo.removeOverride(db, id);
  return c.json({ deleted: true });
});

timetable.put("/:id", canManage, async (c) => {
  const body = updateTimetableEntrySchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await repo.findInOrg(db, id, user.organizationId);
  if (!existing) throw new HTTPException(404, { message: "Timetable entry not found" });

  const merged: Entry = {
    semesterId: body.semesterId ?? existing.semesterId,
    sectionId: body.sectionId ?? existing.sectionId,
    dayOfWeek: body.dayOfWeek ?? existing.dayOfWeek,
    hourNumber: body.hourNumber ?? existing.hourNumber,
    // Carried through so overlap checks below see the block's real span.
    durationHours: body.durationHours ?? existing.durationHours,
    subjectId: body.subjectId ?? existing.subjectId,
    facultyId: body.facultyId ?? existing.facultyId,
  };

  await assertOrgScope(db, merged, user.organizationId);

  const selfOverlap = await findSectionOverlap(db, merged, id);
  if (selfOverlap) {
    throw new HTTPException(409, {
      message: `This section already has ${selfOverlap.subject.name} overlapping those hours`,
    });
  }

  const conflict = await findFacultyConflict(db, merged, id);
  if (conflict) {
    throw new HTTPException(409, {
      message: `Faculty already teaching ${conflict.subject.name} for section ${conflict.section.name} at this day/hour`,
    });
  }

  const entry = await repo.update(db, id, body);
  if (!entry) {
    throw new HTTPException(409, {
      message: "This section already has a subject scheduled at this day/hour",
    });
  }
  return c.json(entry);
});

timetable.delete("/:id", canManage, async (c) => {
  const db = requireSupabase(c);
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await repo.findInOrg(db, id, user.organizationId);
  if (!existing) throw new HTTPException(404, { message: "Timetable entry not found" });

  await repo.remove(db, id);
  return c.json({ deleted: true });
});

/**
 * Swaps the subject+faculty of two weekly slots. If only one side is occupied the
 * entry simply moves. Uses a temporary negative hourNumber, because writing A's
 * values onto B directly would collide with the (sectionId, dayOfWeek, hourNumber)
 * unique constraint mid-swap.
 */
timetable.post("/swap", canManage, async (c) => {
  const body = swapTimetableSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");

  const section = await findSectionInOrg(db, body.sectionId, user.organizationId);
  if (!section) throw new HTTPException(404, { message: "Section not found" });

  const [entryA, entryB] = await Promise.all([
    repo.findSlot(db, body.sectionId, body.a.dayOfWeek, body.a.hourNumber),
    repo.findSlot(db, body.sectionId, body.b.dayOfWeek, body.b.hourNumber),
  ]);

  if (!entryA && !entryB) {
    throw new HTTPException(400, { message: "Both slots are empty — nothing to swap" });
  }

  // Multi-hour blocks would land on hours they do not own, so keep swaps to 1-hour slots.
  if ((entryA && entryA.durationHours > 1) || (entryB && entryB.durationHours > 1)) {
    throw new HTTPException(400, {
      message: "Cannot swap a multi-hour block — edit it directly instead",
    });
  }

  if (entryA && entryB) {
    // Sequential, and necessarily so: PostgREST has no interactive transaction, and
    // each step depends on the previous one having freed its slot. Parking A at
    // hour -1 first is what keeps the unique constraint satisfied throughout.
    await repo.moveTo(db, entryA.id, entryA.dayOfWeek, -1);
    await repo.moveTo(db, entryB.id, body.a.dayOfWeek, body.a.hourNumber);
    await repo.moveTo(db, entryA.id, body.b.dayOfWeek, body.b.hourNumber);
  } else if (entryA) {
    await repo.moveTo(db, entryA.id, body.b.dayOfWeek, body.b.hourNumber);
  } else if (entryB) {
    await repo.moveTo(db, entryB.id, body.a.dayOfWeek, body.a.hourNumber);
  }

  return c.json({ swapped: true, moved: entryA && entryB ? 2 : 1 });
});

/**
 * Applies one subject+faculty to several slots at once, each as its own 1-hour entry
 * (not a merged block). Validates everything up front so a clash aborts the whole
 * batch rather than leaving half the slots written.
 */
timetable.post("/bulk-assign", canManage, async (c) => {
  const body = bulkAssignSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = c.get("user");

  await assertOrgScope(
    db,
    { ...body, dayOfWeek: 0, hourNumber: 1, durationHours: 1 } as Entry,
    user.organizationId
  );

  const errors: { dayOfWeek: number; hourNumber: number; message: string }[] = [];
  const existingBySlot = new Map<string, any>();

  // One request covering every day the batch touches, rather than two per slot.
  const dayEntries = await repo.entriesForDays(
    db,
    [body.facultyId],
    [body.sectionId],
    body.slots.map((s) => s.dayOfWeek)
  );

  for (const slot of body.slots) {
    const entry: Entry = {
      semesterId: body.semesterId,
      sectionId: body.sectionId,
      dayOfWeek: slot.dayOfWeek,
      hourNumber: slot.hourNumber,
      durationHours: 1,
      subjectId: body.subjectId,
      facultyId: body.facultyId,
    };

    const occupied = dayEntries.find(
      (e: any) =>
        e.sectionId === entry.sectionId &&
        e.dayOfWeek === entry.dayOfWeek &&
        overlaps(entry.hourNumber, 1, e.hourNumber, durationOf(e))
    );
    if (occupied) {
      if (!body.overwrite) {
        errors.push({ ...slot, message: `Already has ${(occupied as any).subject.name}` });
        continue;
      }
      existingBySlot.set(`${slot.dayOfWeek}-${slot.hourNumber}`, occupied);
    }

    const conflict = dayEntries.find(
      (e: any) =>
        e.facultyId === entry.facultyId &&
        e.dayOfWeek === entry.dayOfWeek &&
        e.sectionId !== entry.sectionId &&
        overlaps(entry.hourNumber, 1, e.hourNumber, durationOf(e))
    );
    if (conflict) {
      errors.push({
        ...slot,
        message: `Faculty busy with ${(conflict as any).subject.name} (section ${(conflict as any).section.name})`,
      });
    }
  }

  if (errors.length > 0) return c.json({ assigned: false, errors }, 422);

  // Deletes first, then one batched insert — an overwrite cannot collide with itself.
  await repo.removeMany(db, [...existingBySlot.values()].map((e) => e.id));
  await repo.createMany(
    db,
    body.slots.map((slot) => ({
      semesterId: body.semesterId,
      sectionId: body.sectionId,
      dayOfWeek: slot.dayOfWeek,
      hourNumber: slot.hourNumber,
      durationHours: 1,
      subjectId: body.subjectId,
      facultyId: body.facultyId,
    }))
  );

  return c.json({ assigned: true, count: body.slots.length }, 201);
});

export default timetable;
