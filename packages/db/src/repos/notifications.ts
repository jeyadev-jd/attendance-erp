// Notifications repository — PostgREST equivalents of
// apps/api/src/routes/notifications.ts.
//
// Scoping is per-user (userId = the JWT subject), not per-org: a notification belongs
// to one recipient. The broadcast endpoint is the exception and resolves its audience
// through org-scoped queries first.
import type { SupabaseClient } from "@supabase/supabase-js";
import { many, maybeOne, one, count, normaliseDates, DATE_FIELDS } from "../supabase";
import { cuid } from "../ids";

export type Notification = {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
};

const COLS = "id,userId,type,title,message,isRead,createdAt";

/** A user's notifications, newest first, optionally filtered by read state. */
export async function listForUser(
  db: SupabaseClient,
  userId: string,
  opts: { isRead?: boolean; limit: number }
) {
  let q = db.from("notifications").select(COLS).eq("userId", userId);
  if (opts.isRead !== undefined) q = q.eq("isRead", opts.isRead);

  return normaliseDates(
    many<Notification>(
      await q.order("createdAt", { ascending: false }).limit(opts.limit),
      "notifications.listForUser"
    ),
    DATE_FIELDS
  );
}

/**
 * Unread count for the bell badge.
 *
 * `head: true` transfers no rows — only the count — so this stays cheap even for a
 * user with a long notification history.
 */
export async function unreadCount(db: SupabaseClient, userId: string) {
  return count(
    await db
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("userId", userId)
      .eq("isRead", false),
    "notifications.unreadCount"
  );
}

/** One notification belonging to this user. Replaces the findFirst ownership guard. */
export async function findForUser(db: SupabaseClient, id: string, userId: string) {
  return maybeOne<Notification>(
    await db.from("notifications").select(COLS).eq("id", id).eq("userId", userId).maybeSingle(),
    "notifications.findForUser"
  );
}

/** Marks one notification read. The route has already proven ownership. */
export async function markRead(db: SupabaseClient, id: string) {
  return normaliseDates(
    one<Notification>(
      await db.from("notifications").update({ isRead: true }).eq("id", id).select(COLS).single(),
      "notifications.markRead"
    ),
    DATE_FIELDS
  );
}

/**
 * Marks every unread notification read, returning how many changed.
 *
 * Replaces updateMany, whose `result.count` the route echoes back. PostgREST does not
 * return an affected-row count, so the ids are selected first and the update is
 * filtered to exactly those — the length is then the count, and the second statement
 * cannot affect rows the first did not see.
 */
export async function markAllRead(db: SupabaseClient, userId: string): Promise<number> {
  const rows = many<{ id: string }>(
    await db.from("notifications").select("id").eq("userId", userId).eq("isRead", false),
    "notifications.markAllRead (select)"
  );
  if (rows.length === 0) return 0;

  const { error } = await db
    .from("notifications")
    .update({ isRead: true })
    .in(
      "id",
      rows.map((r) => r.id)
    );
  if (error) throw new Error(`notifications.markAllRead: ${error.message}`);
  return rows.length;
}

/** Deletes one notification. The route has already proven ownership. */
export async function remove(db: SupabaseClient, id: string) {
  const { error } = await db.from("notifications").delete().eq("id", id);
  if (error) throw new Error(`notifications.remove: ${error.message}`);
}

/** User ids of students in a section, org-scoped. Broadcast audience resolution. */
export async function studentUserIdsInSection(
  db: SupabaseClient,
  sectionId: string,
  organizationId: string
): Promise<string[]> {
  const rows = many<{ userId: string }>(
    (await db
      .from("students")
      .select("userId,sections!inner(id,semesters!inner(id,academic_years!inner(organizationId)))")
      .eq("sectionId", sectionId)
      .eq("sections.semesters.academic_years.organizationId", organizationId)) as unknown as {
      data: { userId: string }[] | null;
      error: { code?: string | null; message?: string | null } | null;
    },
    "notifications.studentUserIdsInSection"
  );
  return rows.map((r) => r.userId);
}

/** Ids of active users in an org, optionally filtered by role. Broadcast audience. */
export async function activeUserIds(
  db: SupabaseClient,
  organizationId: string,
  role?: string
): Promise<string[]> {
  let q = db
    .from("users")
    .select("id")
    .eq("organizationId", organizationId)
    .eq("isActive", true);
  if (role) q = q.eq("role", role);

  const rows = many<{ id: string }>(await q, "notifications.activeUserIds");
  return rows.map((r) => r.id);
}

/**
 * Creates one notification per recipient in a single batched insert.
 *
 * Replaces createMany. One HTTP request regardless of audience size — issuing one
 * insert per recipient would be an N+1 that scales with the whole organization.
 */
export async function createMany(
  db: SupabaseClient,
  userIds: string[],
  data: { type: string; title: string; message: string }
): Promise<number> {
  if (userIds.length === 0) return 0;
  const now = new Date().toISOString();

  const { error } = await db.from("notifications").insert(
    userIds.map((userId) => ({
      id: cuid(),
      userId,
      isRead: false,
      createdAt: now,
      ...data,
    }))
  );
  if (error) throw new Error(`notifications.createMany: ${error.message}`);
  return userIds.length;
}
