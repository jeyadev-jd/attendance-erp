import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types";
import { roleGuard } from "../middleware/roleGuard";
import {
  createTimetableEntrySchema,
  updateTimetableEntrySchema,
  bulkTimetableSchema,
  swapTimetableSchema,
  bulkAssignSchema,
  timetableOverrideSchema,
  overrideListQuerySchema,
} from "../schemas/academic";

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
 * Faculty conflict: same faculty, same day, overlapping hours, different section.
 * Multi-hour labs mean a plain hourNumber equality check is not enough — a 2-hour
 * lab starting at hour 3 also occupies hour 4, so ranges are compared instead.
 */
async function findFacultyConflict(prisma: any, entry: Entry, excludeId?: string) {
  const sameDay = await prisma.timetable.findMany({
    where: {
      facultyId: entry.facultyId,
      dayOfWeek: entry.dayOfWeek,
      sectionId: { not: entry.sectionId },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    include: { section: true, subject: true },
  });
  return (
    sameDay.find((e: any) => overlaps(entry.hourNumber, durationOf(entry), e.hourNumber, durationOf(e))) ?? null
  );
}

/**
 * Same-section clash. The DB unique constraint only covers identical start hours, so
 * a block overlapping an existing one (e.g. a 2-hour lab landing on an occupied hour)
 * has to be caught here.
 */
async function findSectionOverlap(prisma: any, entry: Entry, excludeId?: string) {
  const sameDay = await prisma.timetable.findMany({
    where: {
      sectionId: entry.sectionId,
      dayOfWeek: entry.dayOfWeek,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    include: { subject: true },
  });
  return (
    sameDay.find((e: any) => overlaps(entry.hourNumber, durationOf(entry), e.hourNumber, durationOf(e))) ?? null
  );
}

async function assertOrgScope(prisma: any, entry: Entry, organizationId: string) {
  const section = await prisma.section.findFirst({
    where: { id: entry.sectionId, semester: { academicYear: { organizationId } } },
  });
  if (!section) throw new HTTPException(404, { message: "Section not found" });

  const subject = await prisma.subject.findFirst({
    where: { id: entry.subjectId, department: { organizationId } },
  });
  if (!subject) throw new HTTPException(404, { message: "Subject not found" });

  const faculty = await prisma.faculty.findFirst({
    where: { id: entry.facultyId, department: { organizationId } },
  });
  if (!faculty) throw new HTTPException(404, { message: "Faculty not found" });
}

timetable.get("/", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const sectionId = c.req.query("sectionId");
  const semesterId = c.req.query("semesterId");

  const list = await prisma.timetable.findMany({
    where: {
      ...(sectionId ? { sectionId } : {}),
      ...(semesterId ? { semesterId } : {}),
      section: { semester: { academicYear: { organizationId: user.organizationId } } },
    },
    include: { subject: true, faculty: true, section: true },
    orderBy: [{ dayOfWeek: "asc" }, { hourNumber: "asc" }],
  });
  return c.json(list);
});

timetable.get("/faculty/:facultyId", async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const list = await prisma.timetable.findMany({
    where: {
      facultyId: c.req.param("facultyId"),
      section: { semester: { academicYear: { organizationId: user.organizationId } } },
    },
    include: { subject: true, section: true },
    orderBy: [{ dayOfWeek: "asc" }, { hourNumber: "asc" }],
  });
  return c.json(list);
});

timetable.post("/", canManage, async (c) => {
  const body = createTimetableEntrySchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");

  await assertOrgScope(prisma, body, user.organizationId);

  const overlap = await findSectionOverlap(prisma, body);
  if (overlap) {
    const span =
      overlap.durationHours > 1
        ? `hours ${overlap.hourNumber}-${overlap.hourNumber + overlap.durationHours - 1}`
        : `hour ${overlap.hourNumber}`;
    throw new HTTPException(409, {
      message: `This section already has ${overlap.subject.name} at ${span}`,
    });
  }

  const conflict = await findFacultyConflict(prisma, body);
  if (conflict) {
    throw new HTTPException(409, {
      message: `Faculty already teaching ${conflict.subject.name} for section ${conflict.section.name} at this day/hour`,
    });
  }

  try {
    const entry = await prisma.timetable.create({ data: body });
    return c.json(entry, 201);
  } catch (err: any) {
    if (err.code === "P2002") {
      throw new HTTPException(409, { message: "This section already has a subject scheduled at this day/hour" });
    }
    throw err;
  }
});

/**
 * Bulk create — validates every entry's faculty-conflict and org scope up front
 * (no partial writes), then inserts transactionally.
 */
timetable.post("/bulk", canManage, async (c) => {
  const body = bulkTimetableSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");

  const errors: { index: number; message: string }[] = [];

  for (let i = 0; i < body.entries.length; i++) {
    const entry = body.entries[i];
    try {
      await assertOrgScope(prisma, entry, user.organizationId);
    } catch {
      errors.push({ index: i, message: "Invalid section/subject/faculty reference" });
      continue;
    }
    const conflict = await findFacultyConflict(prisma, entry);
    if (conflict) {
      errors.push({
        index: i,
        message: `Faculty conflict with section ${conflict.section.name} at day ${entry.dayOfWeek} hour ${entry.hourNumber}`,
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
    if (dupInBatch) errors.push({ index: i, message: "Conflicts with another entry in this same request" });
  }

  if (errors.length > 0) {
    return c.json({ inserted: false, errors }, 422);
  }

  const created = await prisma.$transaction(
    body.entries.map((entry) => prisma.timetable.create({ data: entry }))
  );
  return c.json({ inserted: true, count: created.length }, 201);
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
  const prisma = c.get("prisma");
  const user = c.get("user");

  const list = await prisma.timetableOverride.findMany({
    where: {
      sectionId: query.sectionId,
      section: { semester: { academicYear: { organizationId: user.organizationId } } },
      ...(query.dateFrom || query.dateTo
        ? {
            date: {
              ...(query.dateFrom ? { gte: new Date(`${query.dateFrom}T00:00:00.000Z`) } : {}),
              ...(query.dateTo ? { lte: new Date(`${query.dateTo}T00:00:00.000Z`) } : {}),
            },
          }
        : {}),
    },
    include: { subject: true, faculty: true, createdBy: { select: { name: true } } },
    orderBy: [{ date: "asc" }, { hourNumber: "asc" }],
  });
  return c.json(list);
});

/** Creates or replaces a single date's override. subjectId null cancels the period. */
timetable.put("/overrides", canManage, async (c) => {
  const body = timetableOverrideSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");

  const section = await prisma.section.findFirst({
    where: { id: body.sectionId, semester: { academicYear: { organizationId: user.organizationId } } },
  });
  if (!section) throw new HTTPException(404, { message: "Section not found" });

  if (body.subjectId) {
    const subject = await prisma.subject.findFirst({
      where: { id: body.subjectId, department: { organizationId: user.organizationId } },
    });
    if (!subject) throw new HTTPException(404, { message: "Subject not found" });
    if (!body.facultyId) throw new HTTPException(400, { message: "Faculty is required when a subject is set" });

    const faculty = await prisma.faculty.findFirst({
      where: { id: body.facultyId, department: { organizationId: user.organizationId } },
    });
    if (!faculty) throw new HTTPException(404, { message: "Faculty not found" });
  }

  const date = new Date(`${body.date}T00:00:00.000Z`);
  const override = await prisma.timetableOverride.upsert({
    where: { sectionId_date_hourNumber: { sectionId: body.sectionId, date, hourNumber: body.hourNumber } },
    update: {
      durationHours: body.durationHours,
      subjectId: body.subjectId ?? null,
      facultyId: body.facultyId ?? null,
      reason: body.reason,
      countsForAttendance: body.countsForAttendance ?? null,
      createdById: user.sub,
    },
    create: {
      semesterId: body.semesterId,
      sectionId: body.sectionId,
      date,
      hourNumber: body.hourNumber,
      durationHours: body.durationHours,
      subjectId: body.subjectId ?? null,
      facultyId: body.facultyId ?? null,
      reason: body.reason,
      countsForAttendance: body.countsForAttendance ?? null,
      createdById: user.sub,
    },
    include: { subject: true, faculty: true },
  });

  return c.json(override);
});

/** Removes an override so the date falls back to the regular weekly timetable. */
timetable.delete("/overrides/:id", canManage, async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await prisma.timetableOverride.findFirst({
    where: { id, section: { semester: { academicYear: { organizationId: user.organizationId } } } },
  });
  if (!existing) throw new HTTPException(404, { message: "Override not found" });

  await prisma.timetableOverride.delete({ where: { id } });
  return c.json({ deleted: true });
});

timetable.put("/:id", canManage, async (c) => {
  const body = updateTimetableEntrySchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await prisma.timetable.findFirst({
    where: { id, section: { semester: { academicYear: { organizationId: user.organizationId } } } },
  });
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

  await assertOrgScope(prisma, merged, user.organizationId);

  const selfOverlap = await findSectionOverlap(prisma, merged, id);
  if (selfOverlap) {
    throw new HTTPException(409, {
      message: `This section already has ${selfOverlap.subject.name} overlapping those hours`,
    });
  }

  const conflict = await findFacultyConflict(prisma, merged, id);
  if (conflict) {
    throw new HTTPException(409, {
      message: `Faculty already teaching ${conflict.subject.name} for section ${conflict.section.name} at this day/hour`,
    });
  }

  try {
    const entry = await prisma.timetable.update({ where: { id }, data: body });
    return c.json(entry);
  } catch (err: any) {
    if (err.code === "P2002") {
      throw new HTTPException(409, { message: "This section already has a subject scheduled at this day/hour" });
    }
    throw err;
  }
});

timetable.delete("/:id", canManage, async (c) => {
  const prisma = c.get("prisma");
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await prisma.timetable.findFirst({
    where: { id, section: { semester: { academicYear: { organizationId: user.organizationId } } } },
  });
  if (!existing) throw new HTTPException(404, { message: "Timetable entry not found" });

  await prisma.timetable.delete({ where: { id } });
  return c.json({ deleted: true });
});

/**
 * Swaps the subject+faculty of two weekly slots. If only one side is occupied the
 * entry simply moves. Done in a transaction via a temporary negative hourNumber,
 * because writing A's values onto B directly would collide with the
 * (sectionId, dayOfWeek, hourNumber) unique constraint mid-swap.
 */
timetable.post("/swap", canManage, async (c) => {
  const body = swapTimetableSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = c.get("user");

  const section = await prisma.section.findFirst({
    where: { id: body.sectionId, semester: { academicYear: { organizationId: user.organizationId } } },
  });
  if (!section) throw new HTTPException(404, { message: "Section not found" });

  const [entryA, entryB] = await Promise.all([
    prisma.timetable.findFirst({
      where: { sectionId: body.sectionId, dayOfWeek: body.a.dayOfWeek, hourNumber: body.a.hourNumber },
    }),
    prisma.timetable.findFirst({
      where: { sectionId: body.sectionId, dayOfWeek: body.b.dayOfWeek, hourNumber: body.b.hourNumber },
    }),
  ]);

  if (!entryA && !entryB) throw new HTTPException(400, { message: "Both slots are empty — nothing to swap" });

  // Multi-hour blocks would land on hours they do not own, so keep swaps to 1-hour slots.
  if ((entryA && entryA.durationHours > 1) || (entryB && entryB.durationHours > 1)) {
    throw new HTTPException(400, {
      message: "Cannot swap a multi-hour block — edit it directly instead",
    });
  }

  // Batched array rather than an interactive callback — D1 has no interactive
  // transaction mode. The order is fixed and needs no intermediate results, so a
  // batch is equivalent and still atomic.
  if (entryA && entryB) {
    await prisma.$transaction([
      // Park A out of the way first, so moving B into A's slot can't collide on the
      // (sectionId, dayOfWeek, hourNumber) unique constraint.
      prisma.timetable.update({ where: { id: entryA.id }, data: { hourNumber: -1 } }),
      prisma.timetable.update({
        where: { id: entryB.id },
        data: { dayOfWeek: body.a.dayOfWeek, hourNumber: body.a.hourNumber },
      }),
      prisma.timetable.update({
        where: { id: entryA.id },
        data: { dayOfWeek: body.b.dayOfWeek, hourNumber: body.b.hourNumber },
      }),
    ]);
  } else if (entryA) {
    await prisma.timetable.update({
      where: { id: entryA.id },
      data: { dayOfWeek: body.b.dayOfWeek, hourNumber: body.b.hourNumber },
    });
  } else if (entryB) {
    await prisma.timetable.update({
      where: { id: entryB.id },
      data: { dayOfWeek: body.a.dayOfWeek, hourNumber: body.a.hourNumber },
    });
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
  const prisma = c.get("prisma");
  const user = c.get("user");

  await assertOrgScope(
    prisma,
    { ...body, dayOfWeek: 0, hourNumber: 1, durationHours: 1 } as Entry,
    user.organizationId
  );

  const errors: { dayOfWeek: number; hourNumber: number; message: string }[] = [];
  const existingBySlot = new Map<string, any>();

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

    const occupied = await findSectionOverlap(prisma, entry);
    if (occupied) {
      if (!body.overwrite) {
        errors.push({ ...slot, message: `Already has ${occupied.subject.name}` });
        continue;
      }
      existingBySlot.set(`${slot.dayOfWeek}-${slot.hourNumber}`, occupied);
    }

    const conflict = await findFacultyConflict(prisma, entry);
    if (conflict) {
      errors.push({
        ...slot,
        message: `Faculty busy with ${conflict.subject.name} (section ${conflict.section.name})`,
      });
    }
  }

  if (errors.length > 0) return c.json({ assigned: false, errors }, 422);

  // Built as one ordered batch (D1 has no interactive transactions). Each slot's
  // delete is queued before its create so an overwrite can't collide with itself.
  const ops = body.slots.flatMap((slot) => {
    const occupied = existingBySlot.get(`${slot.dayOfWeek}-${slot.hourNumber}`);
    return [
      ...(occupied ? [prisma.timetable.delete({ where: { id: occupied.id } })] : []),
      prisma.timetable.create({
        data: {
          semesterId: body.semesterId,
          sectionId: body.sectionId,
          dayOfWeek: slot.dayOfWeek,
          hourNumber: slot.hourNumber,
          durationHours: 1,
          subjectId: body.subjectId,
          facultyId: body.facultyId,
        },
      }),
    ];
  });

  await prisma.$transaction(ops);

  return c.json({ assigned: true, count: body.slots.length }, 201);
});

export default timetable;
