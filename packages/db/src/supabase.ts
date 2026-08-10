// Supabase HTTP transport for the Cloudflare Worker.
//
// Architecture: Worker -> @supabase/supabase-js -> HTTPS -> Supabase -> PostgreSQL.
// PostgREST over HTTPS, not a database driver. A pooled TCP path was trialled and
// removed: Workers cannot hold a connection between requests, so pooled sockets went
// stale and surfaced as intermittent 500s. HTTPS is stateless — nothing to go stale.
//
// Security model (C-3): every table in `public` has RLS enabled + forced with no
// policies, and anon/authenticated have no grants. The Worker connects with the
// service_role key, which holds BYPASSRLS, and is therefore the only database
// gateway. Authorization stays where it is today — the Worker's own HS256 JWT and
// roleGuard. Nothing here re-implements it.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type SupabaseEnv = {
  /** Project URL, e.g. https://<ref>.supabase.co. Not a secret. */
  SUPABASE_URL: string;
  /**
   * service_role key. Bypasses RLS, so it is a full-access database credential:
   * set only via `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`, never in
   * wrangler.toml [vars], never in apps/web, never in a client bundle.
   */
  SUPABASE_SERVICE_ROLE_KEY: string;
};

/**
 * Builds a Supabase client for one request.
 *
 * Intentionally not cached. The client is a thin wrapper over `fetch` and holds no
 * socket, so construction is cheap and there is no connection state to reuse — the
 * caching that a TCP pool needs is exactly what made the previous architecture fail.
 *
 * Auth is disabled: this database has no Supabase Auth users (login is the Worker's
 * own bcrypt + HS256 flow), so session persistence and token refresh would be dead
 * weight in a Worker isolate.
 */
export function getSupabase(env: SupabaseEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "X-Client-Info": "attendance-erp-worker" } },
  });
}

// ───────────────────────── error mapping ─────────────────────────

/**
 * PostgREST error shape. `code` is the Postgres SQLSTATE for database errors
 * (23505 unique violation, 23503 FK violation, ...) or a PGRSTnnn code for
 * request-level problems.
 */
export type PostgrestErrorLike = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

/** Unique violation — the Postgres equivalent of Prisma's P2002. */
export const UNIQUE_VIOLATION = "23505";
/** Foreign key violation — Prisma's P2003. */
export const FOREIGN_KEY_VIOLATION = "23503";
/** Not-null violation. */
export const NOT_NULL_VIOLATION = "23502";

export function isUniqueViolation(err: PostgrestErrorLike | null | undefined): boolean {
  return err?.code === UNIQUE_VIOLATION;
}

export function isForeignKeyViolation(err: PostgrestErrorLike | null | undefined): boolean {
  return err?.code === FOREIGN_KEY_VIOLATION;
}

/**
 * Maps a PostgREST error to the HTTP status the route layer already returns, so
 * migrated endpoints keep their current status codes.
 *
 * Prisma threw typed errors that routes caught by code; PostgREST returns SQLSTATEs
 * in a result object instead. The translation lives here so no route has to know
 * either dialect.
 */
export function statusForError(err: PostgrestErrorLike | null | undefined): number {
  switch (err?.code) {
    case UNIQUE_VIOLATION:
      return 409;
    case FOREIGN_KEY_VIOLATION:
    case NOT_NULL_VIOLATION:
      return 400;
    // Permission denied. Under C-3 this means the Worker is not using the
    // service_role key — a misconfiguration, not a client error.
    case "42501":
      return 500;
    default:
      return 500;
  }
}

/** Thrown by the unwrap helpers; routes convert this to their HTTPException. */
export class SupabaseQueryError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: string | null;

  constructor(err: PostgrestErrorLike, context: string) {
    super(`${context}: ${err.message ?? "unknown Supabase error"}`);
    this.name = "SupabaseQueryError";
    this.status = statusForError(err);
    this.code = err.code ?? null;
    this.details = err.details ?? null;
  }
}

type Result<T> = { data: T | null; error: PostgrestErrorLike | null };

// ───────────────────────── timestamp normalisation ─────────────────────────

/**
 * Rewrites a PostgREST timestamptz into the format Prisma emitted.
 *
 * The two serialise the same instant differently:
 *   Prisma/D1  "2026-07-12T18:30:00.000Z"     (Date -> toISOString)
 *   PostgREST  "2026-07-12T18:30:00+00:00"    (Postgres timestamptz)
 *
 * Both parse to the same moment, but they are different strings, and the API
 * contract is the string: the frontend compares, sorts and displays these values.
 * Returning the PostgREST form would be a silent contract break that typechecks.
 *
 * Applied at the repository boundary so routes and the frontend never see the
 * difference. Values that are not timestamps pass through untouched.
 */
const TIMESTAMPTZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/;

export function toPrismaIso(value: string): string {
  return TIMESTAMPTZ.test(value) ? new Date(value).toISOString() : value;
}

/**
 * Recursively normalises timestamp strings in a PostgREST result.
 *
 * `fields` names the columns to convert. Only the named ones are touched, so a
 * string column that happens to look like a timestamp is never rewritten.
 */
export function normaliseDates<T>(row: T, fields: readonly string[]): T {
  if (row === null || typeof row !== "object") return row;
  if (Array.isArray(row)) return row.map((r) => normaliseDates(r, fields)) as unknown as T;

  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const key of Object.keys(out)) {
    const v = out[key];
    if (fields.includes(key) && typeof v === "string") {
      out[key] = toPrismaIso(v);
    } else if (v && typeof v === "object") {
      out[key] = normaliseDates(v, fields);
    }
  }
  return out as T;
}

/** Timestamp columns across the schema, for use with normaliseDates. */
export const DATE_FIELDS = [
  "date",
  "startDate",
  "endDate",
  "createdAt",
  "updatedAt",
  "markedAt",
  "changedAt",
  "otpExpiresAt",
] as const;

/**
 * Unwraps a multi-row result. Returns [] rather than null so callers can iterate
 * unconditionally, matching Prisma's findMany.
 */
export function many<T>(result: Result<T[]>, context: string): T[] {
  if (result.error) throw new SupabaseQueryError(result.error, context);
  return result.data ?? [];
}

/**
 * Unwraps an optional single row — the equivalent of findFirst/findUnique.
 * Use with `.maybeSingle()`, which returns null (not an error) for no match.
 */
export function maybeOne<T>(result: Result<T>, context: string): T | null {
  if (result.error) throw new SupabaseQueryError(result.error, context);
  return result.data;
}

/**
 * Unwraps a row that must exist. Use for writes with `.select().single()`, where a
 * missing row means the write silently did nothing and the caller's invariant broke.
 */
export function one<T>(result: Result<T>, context: string): T {
  if (result.error) throw new SupabaseQueryError(result.error, context);
  if (result.data === null || result.data === undefined) {
    throw new SupabaseQueryError({ message: "expected exactly one row, got none" }, context);
  }
  return result.data;
}

/**
 * Unwraps a `{ count }` result from `.select("*", { count: "exact", head: true })`.
 * `head: true` transfers no rows — only the Content-Range header — so this is the
 * cheap way to count and must not be replaced by fetching rows and reading .length.
 */
export function count(
  result: { count: number | null; error: PostgrestErrorLike | null },
  context: string
): number {
  if (result.error) throw new SupabaseQueryError(result.error, context);
  return result.count ?? 0;
}
