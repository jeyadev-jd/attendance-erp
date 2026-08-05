import type { Role } from "@/store/authStore";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}, token?: string | null): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as any).error ?? "Request failed");
  return data as T;
}

/** Posts raw text (CSV imports send the file body as-is, not JSON). */
async function requestText<T>(path: string, body: string, token: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${token}` },
    body,
  });
  const data = await res.json().catch(() => ({}));
  // 422 carries row-level validation errors as a normal payload — the caller renders them.
  if (!res.ok && res.status !== 422) throw new ApiError(res.status, (data as any).error ?? "Request failed");
  return data as T;
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!entries.length) return "";
  return "?" + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
}

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

export type MarkStudentRow = {
  studentId: string;
  rollNo: string;
  name: string;
  status: AttendanceStatus | null;
  isLocked: boolean;
  attendanceId: string | null;
};

export type DashboardData = {
  overallPct: number;
  riskLevel: "SAFE" | "WARNING" | "CRITICAL";
  safeBunkHours: number;
  recoveryHours: number;
  lateCount: number;
  projectedEndPct: number;
  subjectWise: { subjectId: string; name: string; pct: number; present: number; total: number }[];
  todayTimeline: { hourNumber: number; subject: string; status: string }[];
};

export type Semester = {
  id: string;
  academicYearId: string;
  name: string;
  startDate: string;
  endDate: string;
  minAttendancePct: number;
  status: "UPCOMING" | "ACTIVE" | "ARCHIVED";
};

export type SettingsData = {
  minAttendancePct: number;
  gracePeriodMinutes: number;
  lateThresholdMinutes: number;
  veryLateThresholdMinutes: number;
  editWindowHours: number;
  autoLockAfterDays: number;
};

export type Department = { id: string; name: string; code: string };
export type Section = { id: string; name: string; semesterId: string; departmentId: string };
/** Subjects belong to a department (not a semester) — they're reused across semesters via the timetable. */
export type Subject = {
  id: string;
  code: string;
  name: string;
  totalHours: number;
  departmentId: string;
  /** False for slots like mentor-mentee or club activity: marked, but excluded from percentages. */
  countsForAttendance: boolean;
};
export type Student = {
  id: string;
  rollNo: string;
  name: string; // stored on the Student profile, not the User
  sectionId: string;
  status: string;
  user: { email: string; mustChangePassword: boolean };
  section?: { id: string; name: string; departmentId: string; department?: Department };
};
export type TimetableEntry = {
  id: string;
  sectionId: string;
  dayOfWeek: number;
  /** First period of the block; a lab spanning several periods is one entry. */
  hourNumber: number;
  durationHours: number;
  subjectId: string;
  facultyId: string;
  subject?: { name: string; code: string; countsForAttendance?: boolean };
  faculty?: { name: string };
};

export const authApi = {
  login: (email: string, password: string) =>
    request<{ token?: string; requiresOtp?: boolean; requiresPasswordChange?: boolean; email?: string }>(
      "/api/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }) }
    ),
  requestOtp: (email: string) =>
    request<{ sent: boolean }>("/api/auth/request-otp", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  completeFirstLogin: (email: string, otp: string, newPassword: string) =>
    request<{ token: string }>("/api/auth/complete-first-login", {
      method: "POST",
      body: JSON.stringify({ email, otp, newPassword }),
    }),
};

export const studentApi = {
  getDashboard: (token: string) => request<DashboardData>("/api/student/dashboard", {}, token),
  /** One entry per date that has records — days with no marks are simply absent from the list. */
  timeline: (token: string, from?: string, to?: string) =>
    request<
      { date: string; dayPct: number; hours: { hourNumber: number; subject: string; status: AttendanceStatus }[] }[]
    >(`/api/student/timeline${qs({ from, to })}`, {}, token),
  analytics: (token: string) =>
    request<{
      trend: { week: string; pct: number }[];
      dayWise: { dayOfWeek: number; pct: number }[];
      hourWise: { hourNumber: number; pct: number }[];
      streaks: { current: number; longest: number };
      lateStats: { totalLate: number; mostLateDayOfWeek: number | null };
    }>("/api/student/analytics", {}, token),
  /** "bunk" mode: simulate skipping more classes (a count, or exact date+hour picks). */
  simulateBunk: (
    token: string,
    body: { subjectId?: string; n?: number; hours?: { date: string; hourNumber: number }[] }
  ) =>
    request<{ present: number; total: number; currentPct: number; simulatedPct: number; additionalAbsences: number }>(
      "/api/student/simulate",
      { method: "POST", body: JSON.stringify({ ...body, mode: "bunk" }) },
      token
    ),
  /**
   * Per-subject planner: current standing plus the projected dates the student would
   * cross the target — falling below by skipping, or recovering by attending everything.
   */
  subjectPlanner: (token: string, targetPct?: number) =>
    request<{
      targetPct: number;
      semesterEndDate: string;
      subjects: {
        subjectId: string;
        code: string;
        name: string;
        present: number;
        total: number;
        currentPct: number;
        targetPct: number;
        onTrack: boolean;
        safeBunkHours: number;
        recoveryHours: number;
        remainingClasses: number;
        fallBelowOn: { date: string; afterClasses: number } | null;
        recoverOn: { date: string; afterClasses: number } | null;
      }[];
    }>(`/api/student/subject-planner${qs({ targetPct })}`, {}, token),
  /** "target" mode: how many more classes are needed to reach targetPct. */
  simulateTarget: (token: string, body: { subjectId?: string; targetPct: number }) =>
    request<{
      present: number;
      total: number;
      currentPct: number;
      targetPct: number;
      classesNeeded: number;
      projectedPct: number;
    }>("/api/student/simulate", { method: "POST", body: JSON.stringify({ ...body, mode: "target" }) }, token),
};

/** Optional date window shared by every analytics call; omit for the whole semester. */
export type DateRange = { dateFrom?: string; dateTo?: string };

export const analyticsApi = {
  heatmap: (token: string, semesterId: string, range: DateRange = {}) =>
    request<{ cells: { dayOfWeek: number; hourNumber: number; pct: number; total: number }[] }>(
      `/api/admin/analytics/heatmap${qs({ semesterId, ...range })}`,
      {},
      token
    ),
  subjectComparison: (token: string, semesterId: string, range: DateRange = {}) =>
    request<{ subjectId: string; name: string; pct: number; total: number }[]>(
      `/api/admin/analytics/subject-comparison${qs({ semesterId, ...range })}`,
      {},
      token
    ),
  bunkLeaderboard: (token: string, semesterId: string, limit = 10, range: DateRange = {}) =>
    request<{ studentId: string; rollNo: string; name: string; bunkFlagCount: number }[]>(
      `/api/admin/analytics/bunk-leaderboard${qs({ semesterId, limit, ...range })}`,
      {},
      token
    ),
  lateAnalytics: (token: string, semesterId: string, range: DateRange = {}) =>
    request<{
      totalLateMarks: number;
      mostLateStudents: { rollNo: string; name: string; count: number }[];
      mostLateDayOfWeek: number | null;
      mostLateHour: number | null;
    }>(`/api/admin/analytics/late-analytics${qs({ semesterId, ...range })}`, {}, token),
  /** Per subject, so a lab and its theory paper stay separate rows even with shared faculty. */
  subjectReport: (token: string, semesterId: string, range: DateRange = {}) =>
    request<
      {
        subjectId: string;
        code: string;
        name: string;
        faculty: string;
        countsForAttendance: boolean;
        weeklyHours: number;
        scheduledHours: number;
        markedHours: number;
        coveragePct: number;
        attendancePct: number;
        studentCount: number;
        corrections: number;
      }[]
    >(`/api/admin/analytics/subject-report${qs({ semesterId, ...range })}`, {}, token),
  /** Who was absent on a given date, and exactly which hours/subjects — a daily roll call. */
  dailyBunkers: (token: string, semesterId: string, date: string, sectionId?: string) =>
    request<
      { studentId: string; rollNo: string; name: string; absences: { hourNumber: number; subject: string }[] }[]
    >(`/api/admin/analytics/daily-bunkers${qs({ semesterId, date, sectionId })}`, {}, token),
};

/** Marking is manual: the API accepts only these four, no arrival-time derivation. */
export type MarkableStatus = "PRESENT" | "ABSENT" | "LATE" | "OD";

export const attendanceApi = {
  getMarkList: (token: string, date: string, sectionId: string, hourNumber: number) =>
    request<{
      subject: { name: string; code?: string };
      faculty: { name: string };
      /** Start of the block, which may differ from the hour requested. */
      hourNumber: number;
      durationHours: number;
      coveredHours: number[];
      countsForAttendance: boolean;
      /** True when a one-off override replaced the usual weekly class for this date. */
      isOverride: boolean;
      overrideReason: string | null;
      students: MarkStudentRow[];
    }>(`/api/attendance/mark${qs({ date, sectionId, hourNumber })}`, {}, token),
  postMark: (
    token: string,
    payload: { date: string; sectionId: string; hourNumber: number; records: { studentId: string; status: MarkableStatus }[] }
  ) =>
    request<{ written: number; skippedLocked: string[] }>(
      "/api/attendance/mark",
      { method: "POST", body: JSON.stringify(payload) },
      token
    ),
  /** Reason is mandatory — the API writes an audit log entry for every edit. */
  edit: (token: string, id: string, status: MarkableStatus, reason: string) =>
    request<{ id: string; status: AttendanceStatus }>(
      `/api/attendance/${id}`,
      { method: "PUT", body: JSON.stringify({ status, reason }) },
      token
    ),
  /** Omit hourNumber to lock the entire day for that section. */
  lock: (token: string, payload: { date: string; sectionId: string; hourNumber?: number }) =>
    request<{ locked: number }>("/api/attendance/lock", { method: "POST", body: JSON.stringify(payload) }, token),
};

export type AuditLog = {
  id: string;
  attendanceId: string;
  oldStatus: string | null;
  newStatus: string;
  reason: string;
  createdAt: string;
  changedByUser?: { id: string; name: string } | null;
  attendance?: {
    date: string;
    hourNumber: number;
    student?: { rollNo: string; user?: { name: string } };
    subject?: { name: string };
  } | null;
};

export const auditApi = {
  list: (
    token: string,
    filters: { studentId?: string; sectionId?: string; subjectId?: string; dateFrom?: string; dateTo?: string }
  ) => request<AuditLog[]>(`/api/audit-logs${qs(filters)}`, {}, token),
};

export type AcademicYear = { id: string; label: string; startDate: string; endDate: string };

export const academicYearApi = {
  list: (token: string) => request<AcademicYear[]>("/api/academic-years", {}, token),
  create: (token: string, body: { label: string; startDate: string; endDate: string }) =>
    request<AcademicYear>("/api/academic-years", { method: "POST", body: JSON.stringify(body) }, token),
  update: (token: string, id: string, body: Partial<{ label: string; startDate: string; endDate: string }>) =>
    request<AcademicYear>(`/api/academic-years/${id}`, { method: "PUT", body: JSON.stringify(body) }, token),
  remove: (token: string, id: string) => request<{ deleted: true }>(`/api/academic-years/${id}`, { method: "DELETE" }, token),
};

export const semesterApi = {
  list: (token: string) => request<Semester[]>("/api/semesters", {}, token),
  get: (token: string, id: string) => request<Semester>(`/api/semesters/${id}`, {}, token),
  create: (
    token: string,
    body: { academicYearId: string; name: string; startDate: string; endDate: string; minAttendancePct?: number }
  ) => request<Semester>("/api/semesters", { method: "POST", body: JSON.stringify(body) }, token),
  update: (token: string, id: string, body: Partial<Semester>) =>
    request<Semester>(`/api/semesters/${id}`, { method: "PUT", body: JSON.stringify(body) }, token),
  archive: (token: string, id: string) =>
    request<{ id: string; status: string }>(`/api/semesters/${id}/archive`, { method: "POST" }, token),
  clone: (token: string, id: string, body: { name: string; startDate: string; endDate: string; academicYearId?: string }) =>
    request<{ semester: Semester; sectionsCopied: number; hourConfigsCopied: number; timetablesCopied: number }>(
      `/api/semesters/${id}/clone`,
      { method: "POST", body: JSON.stringify(body) },
      token
    ),
};

export type CalendarDay = {
  id: string;
  date: string;
  dayType: DayType;
  label: string | null;
  notes: string | null;
  hourOverrides: { id: string; hourNumber: number; attendanceEnabled: boolean }[];
};

export const calendarApi = {
  month: (token: string, semesterId: string, year: number, month: number) =>
    request<CalendarDay[]>(`/api/calendar/month${qs({ semesterId, year, month })}`, {}, token),
  setDay: (token: string, body: { semesterId: string; date: string; dayType: DayType; label?: string; notes?: string }) =>
    request<CalendarDay>("/api/calendar/day", { method: "POST", body: JSON.stringify(body) }, token),
  /** daysOfWeek restricts the range to e.g. only Sat/Sun; omit to apply to every date. */
  bulkRange: (
    token: string,
    body: {
      semesterId: string;
      startDate: string;
      endDate: string;
      dayType: DayType;
      label?: string;
      notes?: string;
      daysOfWeek?: number[];
    }
  ) => request<{ updated: number }>("/api/calendar/bulk-range", { method: "POST", body: JSON.stringify(body) }, token),
  setHourOverride: (
    token: string,
    body: { semesterId: string; date: string; hourNumber: number; attendanceEnabled: boolean }
  ) =>
    request<{ id: string; hourNumber: number; attendanceEnabled: boolean }>(
      "/api/calendar/hour-override",
      { method: "PUT", body: JSON.stringify(body) },
      token
    ),
  bulkHourOverrides: (
    token: string,
    body: { semesterId: string; date: string; overrides: { hourNumber: number; attendanceEnabled: boolean }[] }
  ) => request<{ updated: number }>("/api/calendar/hour-overrides/bulk", { method: "PUT", body: JSON.stringify(body) }, token),
};

export type HourConfig = { id: string; dayOfWeek: number; hourNumber: number; startTime: string; endTime: string };

export const hourConfigApi = {
  /** Keyed by day of week (0=Sunday..6=Saturday); days with no hours are absent from the map. */
  list: (token: string, semesterId: string) =>
    request<Record<string, HourConfig[]>>(`/api/hour-config${qs({ semesterId })}`, {}, token),
  setDay: (
    token: string,
    body: { semesterId: string; dayOfWeek: number; hours: { hourNumber: number; startTime: string; endTime: string }[] }
  ) =>
    request<{ dayOfWeek: number; hoursSet: number }>(
      "/api/hour-config/day",
      { method: "POST", body: JSON.stringify(body) },
      token
    ),
  remove: (token: string, id: string) => request<{ deleted: true }>(`/api/hour-config/${id}`, { method: "DELETE" }, token),
};

export const departmentApi = {
  list: (token: string) => request<Department[]>("/api/departments", {}, token),
  create: (token: string, body: { name: string; code: string }) =>
    request<Department>("/api/departments", { method: "POST", body: JSON.stringify(body) }, token),
  update: (token: string, id: string, body: Partial<Department>) =>
    request<Department>(`/api/departments/${id}`, { method: "PUT", body: JSON.stringify(body) }, token),
  remove: (token: string, id: string) => request<{ ok: true }>(`/api/departments/${id}`, { method: "DELETE" }, token),
};

export const sectionApi = {
  list: (token: string, semesterId?: string) => request<Section[]>(`/api/sections${qs({ semesterId })}`, {}, token),
  create: (token: string, body: { name: string; semesterId: string; departmentId: string }) =>
    request<Section>("/api/sections", { method: "POST", body: JSON.stringify(body) }, token),
  update: (token: string, id: string, body: Partial<Section>) =>
    request<Section>(`/api/sections/${id}`, { method: "PUT", body: JSON.stringify(body) }, token),
  remove: (token: string, id: string) => request<{ ok: true }>(`/api/sections/${id}`, { method: "DELETE" }, token),
};

export const subjectApi = {
  list: (token: string, departmentId?: string) => request<Subject[]>(`/api/subjects${qs({ departmentId })}`, {}, token),
  create: (
    token: string,
    body: { code: string; name: string; departmentId: string; totalHours: number; countsForAttendance?: boolean }
  ) => request<Subject>("/api/subjects", { method: "POST", body: JSON.stringify(body) }, token),
  update: (token: string, id: string, body: Partial<Subject>) =>
    request<Subject>(`/api/subjects/${id}`, { method: "PUT", body: JSON.stringify(body) }, token),
  remove: (token: string, id: string) => request<{ ok: true }>(`/api/subjects/${id}`, { method: "DELETE" }, token),
};

export const studentApiAdmin = {
  list: (token: string, sectionId?: string) => request<Student[]>(`/api/students${qs({ sectionId })}`, {}, token),
  create: (token: string, body: { rollNo: string; name: string; email: string; sectionId: string }) =>
    request<Student>("/api/students", { method: "POST", body: JSON.stringify(body) }, token),
  update: (token: string, id: string, body: Partial<{ rollNo: string; sectionId: string; status: string }>) =>
    request<Student>(`/api/students/${id}`, { method: "PUT", body: JSON.stringify(body) }, token),
  remove: (token: string, id: string) => request<{ deactivated: true }>(`/api/students/${id}`, { method: "DELETE" }, token),
  /**
   * Server validates every row first and writes nothing if any row fails (422 with row errors).
   * CSV header: rollNo,name,email,sectionName[,departmentCode]
   */
  importCsv: (token: string, semesterId: string, csv: string) =>
    requestText<
      | { imported: true; count: number }
      | { imported: false; totalRows: number; errors: { row: number; message: string }[] }
    >(`/api/students/import${qs({ semesterId })}`, csv, token),
};

export type Faculty = { id: string; employeeId: string; departmentId: string; name: string; email: string };

export type StaffRole = "SUPER_ADMIN" | "ADMIN" | "CLASS_ADMIN" | "FACULTY";

export type ManagedUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  externalId: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  hasStudentProfile: boolean;
};

export const userApi = {
  /** Defaults to staff only; pass a role to filter (including STUDENT). */
  list: (token: string, role?: Role) => request<ManagedUser[]>(`/api/users${qs({ role })}`, {}, token),
  create: (token: string, body: { email: string; name: string; role: StaffRole; externalId?: string }) =>
    request<ManagedUser & { temporaryPassword: string }>(
      "/api/users",
      { method: "POST", body: JSON.stringify(body) },
      token
    ),
  update: (token: string, id: string, body: Partial<{ name: string; role: StaffRole; isActive: boolean }>) =>
    request<ManagedUser>(`/api/users/${id}`, { method: "PUT", body: JSON.stringify(body) }, token),
  /** Deactivates rather than deletes, so attendance and audit history survive. */
  deactivate: (token: string, id: string) =>
    request<{ deactivated: true }>(`/api/users/${id}`, { method: "DELETE" }, token),
};

export const facultyApi = {
  list: (token: string, departmentId?: string) => request<Faculty[]>(`/api/faculty${qs({ departmentId })}`, {}, token),
};

export const timetableApi = {
  list: (token: string, params: { sectionId?: string; semesterId?: string }) =>
    request<TimetableEntry[]>(`/api/timetable${qs(params)}`, {}, token),
  /** API returns 409 when the same faculty is already booked that day+hour in another section. */
  create: (
    token: string,
    body: {
      semesterId: string;
      sectionId: string;
      dayOfWeek: number;
      hourNumber: number;
      durationHours?: number;
      subjectId: string;
      facultyId: string;
    }
  ) => request<TimetableEntry>("/api/timetable", { method: "POST", body: JSON.stringify(body) }, token),
  update: (
    token: string,
    id: string,
    body: Partial<{ subjectId: string; facultyId: string; durationHours: number }>
  ) => request<TimetableEntry>(`/api/timetable/${id}`, { method: "PUT", body: JSON.stringify(body) }, token),
  remove: (token: string, id: string) => request<{ deleted: true }>(`/api/timetable/${id}`, { method: "DELETE" }, token),

  /** Swaps two weekly slots; if only one is occupied the entry moves instead. */
  swap: (
    token: string,
    body: {
      sectionId: string;
      a: { dayOfWeek: number; hourNumber: number };
      b: { dayOfWeek: number; hourNumber: number };
    }
  ) => request<{ swapped: true; moved: number }>("/api/timetable/swap", { method: "POST", body: JSON.stringify(body) }, token),

  /** Applies one subject+faculty to several slots, each as its own 1-hour entry. */
  bulkAssign: (
    token: string,
    body: {
      semesterId: string;
      sectionId: string;
      subjectId: string;
      facultyId: string;
      slots: { dayOfWeek: number; hourNumber: number }[];
      overwrite?: boolean;
    }
  ) =>
    request<
      | { assigned: true; count: number }
      | { assigned: false; errors: { dayOfWeek: number; hourNumber: number; message: string }[] }
    >("/api/timetable/bulk-assign", { method: "POST", body: JSON.stringify(body) }, token),
};

export type TimetableOverride = {
  id: string;
  sectionId: string;
  date: string;
  hourNumber: number;
  durationHours: number;
  subjectId: string | null;
  facultyId: string | null;
  reason: string | null;
  /** Null means "use the subject's own default". */
  countsForAttendance: boolean | null;
  subject?: { code: string; name: string } | null;
  faculty?: { name: string } | null;
  createdBy?: { name: string | null };
};

/** One-off, date-specific schedule changes that leave the weekly timetable untouched. */
export const timetableOverrideApi = {
  list: (token: string, params: { sectionId: string; dateFrom?: string; dateTo?: string }) =>
    request<TimetableOverride[]>(`/api/timetable/overrides${qs(params)}`, {}, token),
  /**
   * subjectId null cancels that period for the date (no attendance taken).
   * countsForAttendance false tracks attendance (bunk detection still applies)
   * without moving anyone's percentage; omit/true to use the subject's own default.
   */
  set: (
    token: string,
    body: {
      semesterId: string;
      sectionId: string;
      date: string;
      hourNumber: number;
      durationHours?: number;
      subjectId?: string | null;
      facultyId?: string | null;
      reason?: string;
      countsForAttendance?: boolean;
    }
  ) => request<TimetableOverride>("/api/timetable/overrides", { method: "PUT", body: JSON.stringify(body) }, token),
  remove: (token: string, id: string) =>
    request<{ deleted: true }>(`/api/timetable/overrides/${id}`, { method: "DELETE" }, token),
};

export const settingsApi = {
  get: (token: string) => request<SettingsData>("/api/settings", {}, token),
  update: (token: string, body: Partial<SettingsData>) =>
    request<SettingsData>("/api/settings", { method: "PUT", body: JSON.stringify(body) }, token),
};

export type Notification = {
  id: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
};

export const notificationApi = {
  list: (token: string, filters: { isRead?: "true" | "false"; limit?: number } = {}) =>
    request<Notification[]>(`/api/notifications${qs(filters)}`, {}, token),
  unreadCount: (token: string) => request<{ count: number }>("/api/notifications/unread-count", {}, token),
  markRead: (token: string, id: string) => request<Notification>(`/api/notifications/${id}/read`, { method: "PUT" }, token),
  markAllRead: (token: string) => request<{ updated: number }>("/api/notifications/read-all", { method: "POST" }, token),
  remove: (token: string, id: string) => request<{ deleted: true }>(`/api/notifications/${id}`, { method: "DELETE" }, token),
  broadcast: (token: string, body: { title: string; message: string; role?: Role; sectionId?: string }) =>
    request<{ sent: number }>("/api/notifications/broadcast", { method: "POST", body: JSON.stringify(body) }, token),
};

export const reportApi = {
  /**
   * Generates the report and returns its bytes in one request — the endpoint is
   * JWT-guarded, so a bare <a href> would 401. Row count rides along in a header
   * so the caller can report it without parsing the file.
   */
  export: async (
    token: string,
    params: { semesterId: string; sectionId?: string; format?: "csv" | "xlsx"; dateFrom?: string; dateTo?: string }
  ): Promise<{ blob: Blob; filename: string; rowCount: number }> => {
    const res = await fetch(`${API_URL}/api/reports/export${qs(params)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, (data as any).error ?? "Export failed");
    }

    const disposition = res.headers.get("Content-Disposition") ?? "";
    const filename =
      disposition.match(/filename="(.+?)"/)?.[1] ?? `attendance.${params.format ?? "csv"}`;

    return {
      blob: await res.blob(),
      filename,
      rowCount: Number(res.headers.get("X-Row-Count") ?? 0),
    };
  },
};

/** Triggers a browser save dialog for a fetched blob. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
