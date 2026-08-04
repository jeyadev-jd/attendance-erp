import { HTTPException } from "hono/http-exception";

/** Confirms the semester belongs to the caller's org and (for writes) isn't archived. */
export async function assertSemesterWritable(prisma: any, semesterId: string, organizationId: string) {
  const semester = await prisma.semester.findFirst({
    where: { id: semesterId, academicYear: { organizationId } },
  });
  if (!semester) throw new HTTPException(404, { message: "Semester not found" });
  if (semester.status === "ARCHIVED") {
    throw new HTTPException(403, { message: "Semester is archived and read-only" });
  }
  return semester;
}

export async function assertSemesterInOrg(prisma: any, semesterId: string, organizationId: string) {
  const semester = await prisma.semester.findFirst({
    where: { id: semesterId, academicYear: { organizationId } },
  });
  if (!semester) throw new HTTPException(404, { message: "Semester not found" });
  return semester;
}
