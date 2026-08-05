import type { AttendanceStatus } from "@attendance/db";

// Statuses that count toward "present" for percentage purposes.
export const PRESENT_STATUSES: AttendanceStatus[] = ["PRESENT", "LATE", "VERY_LATE", "MEDICAL", "OD"];

/**
 * Prisma `where` fragment restricting a query to attendance rows that count toward
 * a percentage. Non-academic slots (mentor-mentee, club activity) and one-off
 * "tracked but not counted" overrides still have attendance marked so absences are
 * recorded and bunk detection still applies, but must never move a percentage —
 * spread this into every query whose result feeds a calculation.
 *
 * Read from the attendance row itself (snapshotted at write time from the override
 * or subject), not a live join to Subject — a later change to a subject's default
 * must not retroactively rewrite the meaning of already-marked days.
 */
export const COUNTS_FOR_ATTENDANCE = { countsForAttendance: true } as const;

/**
 * Accepts a bare string because D1/SQLite stores status as TEXT — rows read back from
 * the database are typed `string`, not the narrow union. Unknown values simply count
 * as "not present" rather than throwing, so a bad row can't break a whole report.
 */
export function isPresentStatus(status: string): boolean {
  return (PRESENT_STATUSES as string[]).includes(status);
}

/** attendance_pct = (present_count / total_count) * 100 */
export function attendancePct(present: number, total: number): number {
  if (total === 0) return 0;
  return (present / total) * 100;
}

/** safe_bunk_hours = floor((present - min_pct/100 * total) / (min_pct/100)), min 0 */
export function safeBunkHours(present: number, total: number, minPct: number): number {
  const ratio = minPct / 100;
  if (ratio === 0) return 0;
  return Math.max(0, Math.floor((present - ratio * total) / ratio));
}

/** recovery_hours = ceil((min_pct/100 * total - present) / (1 - min_pct/100)), min 0 */
export function recoveryHours(present: number, total: number, minPct: number): number {
  const ratio = minPct / 100;
  if (ratio >= 1) return 0;
  return Math.max(0, Math.ceil((ratio * total - present) / (1 - ratio)));
}

/** bunk_simulator(n) = (present / (total + n)) * 100 */
export function bunkSimulator(present: number, total: number, n: number): number {
  if (total + n === 0) return 0;
  return (present / (total + n)) * 100;
}

/** projected_end_pct = ((present + remaining_hours * attend_rate) / (total + remaining_hours)) * 100 */
export function projectedEndPct(
  present: number,
  total: number,
  remainingHours: number,
  attendRate: number
): number {
  const denom = total + remainingHours;
  if (denom === 0) return 0;
  return ((present + remainingHours * attendRate) / denom) * 100;
}

/**
 * Bunk detection over one day's hourly statuses for a student.
 *
 * A bunk is: the student attended a period, then was absent from the very next one.
 * Someone genuinely absent (sick, travelling) never shows up at all, so their day
 * starts absent and is not flagged — the tell is being *present first*, then leaving.
 *
 * SINGLE_HOUR_SKIP — absent for exactly one period, then back (P-A-P): skipped one class.
 * MID_CLASS_BUNK   — absent for two or more consecutive periods after attending, or
 *                    left partway through the day and never returned.
 *
 * Sequence must be ordered by hourNumber; "P" = present-like (isPresentStatus).
 */
export function detectMidClassBunk(
  statusesByHour: AttendanceStatus[]
): { flagType: "SINGLE_HOUR_SKIP" | "MID_CLASS_BUNK"; startIndex: number }[] {
  const pattern = statusesByHour.map((s) => (isPresentStatus(s) ? "P" : "A"));
  const flags: { flagType: "SINGLE_HOUR_SKIP" | "MID_CLASS_BUNK"; startIndex: number }[] = [];

  for (let i = 0; i < pattern.length - 1; i++) {
    // The transition that defines a bunk: attended this period, gone the next.
    if (pattern[i] !== "P" || pattern[i + 1] !== "A") continue;

    // Measure how long the absence runs so one gap yields one flag, not several.
    let end = i + 1;
    while (end + 1 < pattern.length && pattern[end + 1] === "A") end++;
    const gapLength = end - i;

    flags.push({
      flagType: gapLength === 1 ? "SINGLE_HOUR_SKIP" : "MID_CLASS_BUNK",
      startIndex: i + 1, // the first missed period
    });

    i = end; // skip past this gap; the next iteration looks for a fresh P->A edge
  }

  return flags;
}
