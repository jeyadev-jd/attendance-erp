// Prisma client factory bound to Cloudflare D1 (SQLite).
//
// D1 is exposed to a Worker as a binding, not a connection string, so the client is
// built per-request from `env.DB` rather than from DATABASE_URL. Workers are stateless
// per request; the cache below only avoids re-instantiating within one invocation.
import { PrismaClient } from "@prisma/client";
import { PrismaD1 } from "@prisma/adapter-d1";

export type Env = {
  /** D1 binding declared in wrangler.toml. */
  DB: D1Database;
};

let cached: PrismaClient | null = null;

export function getPrismaClient(env: Env): PrismaClient {
  if (cached) return cached;

  const adapter = new PrismaD1(env.DB);
  cached = new PrismaClient({ adapter });
  return cached;
}

export * from "@prisma/client";

// SQLite has no enum type, so these columns are plain TEXT in the database and the
// allowed values live here instead. Zod schemas at the API boundary do the actual
// validating — these types keep the rest of the codebase honest at compile time.
export type Role = "SUPER_ADMIN" | "ADMIN" | "CLASS_ADMIN" | "FACULTY" | "STUDENT";

export type SemesterStatus = "UPCOMING" | "ACTIVE" | "ARCHIVED";

export type DayType =
  | "WORKING"
  | "HOLIDAY"
  | "EXAM"
  | "INTERNAL_EXAM"
  | "EVENT"
  | "WORKSHOP"
  | "INDUSTRIAL_VISIT"
  | "SPORTS_DAY"
  | "SYMPOSIUM"
  | "STUDY_HOLIDAY"
  | "CUSTOM";

export type AttendanceStatus =
  | "PRESENT"
  | "ABSENT"
  | "LATE"
  | "VERY_LATE"
  | "MEDICAL"
  | "OD"
  | "DUTY_LEAVE"
  | "SPORTS"
  | "WORKSHOP"
  | "EVENT"
  | "CANCELLED";

export type StudentStatus = "ACTIVE" | "INACTIVE" | "GRADUATED" | "TRANSFERRED";

export type BunkFlagType = "SINGLE_HOUR_SKIP" | "MID_CLASS_BUNK";

export type BunkSeverity = "LOW" | "MEDIUM" | "HIGH";

export type RiskLevel = "SAFE" | "WARNING" | "CRITICAL";

export type NotificationType =
  | "RISK_ALERT"
  | "BUNK_FLAG"
  | "ATTENDANCE_EDIT"
  | "SYSTEM"
  | "ANNOUNCEMENT";
