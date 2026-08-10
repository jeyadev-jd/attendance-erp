// Domain types for the application.
//
// These were previously re-exported from packages/db/src/index.ts alongside Prisma's
// generated client. They are hand-written and always were: the columns they describe
// are TEXT in the database, not native enums, because the schema kept string unions
// when it moved to D1/SQLite and carried them over to Postgres unchanged. Zod schemas
// at the API boundary do the actual validating; these keep the rest of the codebase
// honest at compile time.
//
// Living in their own module means the Prisma barrel can be deleted at cutover
// without taking the type system with it. Nothing here imports @prisma/client.

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
