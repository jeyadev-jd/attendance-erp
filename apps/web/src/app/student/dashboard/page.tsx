"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { PageHeader, Card, CardTitle, Badge, Alert, Spinner, EmptyState } from "@/components/ui";
import { studentApi, ApiError } from "@/lib/api";
import { useToken } from "@/lib/hooks";

const RISK_TONE = { SAFE: "green", WARNING: "amber", CRITICAL: "red" } as const;

const STATUS_TONE: Record<string, "green" | "red" | "amber" | "blue" | "slate"> = {
  PRESENT: "green",
  LATE: "amber",
  VERY_LATE: "amber",
  ABSENT: "red",
  MEDICAL: "blue",
  OD: "blue",
  DUTY_LEAVE: "blue",
  CANCELLED: "slate",
};

/** Local YYYY-MM-DD, not toISOString — that shifts the date for anyone behind UTC. */
function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function StudentDashboardPage() {
  const token = useToken();
  const [day, setDay] = useState(todayInput());

  // `day` is part of the key so switching dates refetches, and React Query keeps
  // each day cached — flipping back and forth costs no extra requests.
  const { data, isLoading, error } = useQuery({
    queryKey: ["student-dashboard", day],
    queryFn: () => studentApi.getDashboard(token!, day),
    enabled: !!token,
    // The summary stats above are semester-wide and identical across days, so
    // holding the previous data avoids the whole page blanking on a date change.
    placeholderData: (prev) => prev,
  });

  return (
    <AppShell>
      <PageHeader title="My Attendance" subtitle="Your attendance health this semester" />

      {error ? (
        <Alert>{error instanceof ApiError ? error.message : "Failed to load dashboard"}</Alert>
      ) : isLoading || !data ? (
        <Card>
          <Spinner />
        </Card>
      ) : (
        <div className="space-y-4">
          <Card>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm text-slate-500">Overall attendance</p>
                <p className="text-4xl font-bold">{data.overallPct.toFixed(0)}%</p>
              </div>
              <Badge tone={RISK_TONE[data.riskLevel]} className="px-3 py-1 text-sm">
                {data.riskLevel}
              </Badge>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Safe bunk hours" value={data.safeBunkHours} hint="Hours you can miss and stay above the minimum" />
              <Stat label="Recovery hours" value={data.recoveryHours} hint="Hours to attend to get back above it" />
              <Stat label="Late count" value={data.lateCount} />
              <Stat label="Projected end %" value={`${data.projectedEndPct.toFixed(0)}%`} />
            </div>
          </Card>

          <Card>
            <CardTitle>Subject-wise attendance</CardTitle>
            {!data.subjectWise.length ? (
              <EmptyState message="No records yet." />
            ) : (
              <ul className="mt-3 space-y-3">
                {data.subjectWise.map((s) => (
                  <li key={s.subjectId}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="truncate pr-2">{s.name}</span>
                      <span className="shrink-0 text-slate-500">
                        {s.present}/{s.total} · <span className="font-medium text-slate-900">{s.pct.toFixed(0)}%</span>
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                      <div
                        className={`h-1.5 rounded-full ${s.pct < 80 ? "bg-red-500" : "bg-emerald-500"}`}
                        style={{ width: `${Math.min(s.pct, 100)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>{day === todayInput() ? "Today" : "Attendance"}</CardTitle>
              <input
                type="date"
                value={day}
                max={todayInput()}
                onChange={(e) => setDay(e.target.value || todayInput())}
                className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                aria-label="Show attendance for date"
              />
            </div>
            {!data.todayTimeline.length ? (
              <EmptyState
                message={
                  day === todayInput()
                    ? "No classes marked today."
                    : "No classes marked on this date."
                }
              />
            ) : (
              <ul className="mt-3 divide-y">
                {data.todayTimeline.map((t) => (
                  <li key={t.hourNumber} className="flex items-center justify-between py-2 text-sm">
                    <span className="truncate pr-2">
                      <span className="text-slate-500">H{t.hourNumber}</span> · {t.subject}
                    </span>
                    <Badge tone={STATUS_TONE[t.status] ?? "slate"}>{t.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </AppShell>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
      {hint && <p className="mt-0.5 text-[10px] leading-tight text-slate-400">{hint}</p>}
    </div>
  );
}
