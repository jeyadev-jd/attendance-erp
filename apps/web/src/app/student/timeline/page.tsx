"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { PageHeader, Card, CardTitle, Input, Field, Alert, Spinner, EmptyState, Badge, cn } from "@/components/ui";
import { studentApi, ApiError, type AttendanceStatus } from "@/lib/api";
import { useToken, toDateInput } from "@/lib/hooks";

const STATUS_COLOR: Record<string, string> = {
  PRESENT: "bg-emerald-500",
  LATE: "bg-amber-400",
  VERY_LATE: "bg-amber-600",
  ABSENT: "bg-red-500",
  MEDICAL: "bg-blue-400",
  OD: "bg-blue-500",
  DUTY_LEAVE: "bg-indigo-400",
  SPORTS: "bg-lime-500",
  WORKSHOP: "bg-teal-500",
  EVENT: "bg-purple-400",
  CANCELLED: "bg-slate-300",
};

const STATUS_TONE: Record<string, "green" | "red" | "amber" | "blue" | "slate"> = {
  PRESENT: "green",
  LATE: "amber",
  VERY_LATE: "amber",
  ABSENT: "red",
  MEDICAL: "blue",
  OD: "blue",
};

export default function StudentTimelinePage() {
  const token = useToken();
  // Default to the last 30 days — enough context without a huge first payload.
  const today = new Date();
  const monthAgo = new Date(today.getTime() - 30 * 86400_000);
  const [range, setRange] = useState({ from: toDateInput(monthAgo), to: toDateInput(today) });
  const [openDate, setOpenDate] = useState<string | null>(null);

  const timeline = useQuery({
    queryKey: ["student-timeline", range],
    queryFn: () => studentApi.timeline(token!, range.from, range.to),
    enabled: !!token,
  });

  const days = timeline.data ?? [];
  const openDay = days.find((d) => d.date.slice(0, 10) === openDate);

  return (
    <AppShell>
      <PageHeader title="Timeline" subtitle="Colour-coded history — tap a day for detail" />

      <div className="space-y-4">
        <Card>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From">
              <Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            </Field>
            <Field label="To">
              <Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
            </Field>
          </div>
        </Card>

        {timeline.error ? (
          <Alert>{timeline.error instanceof ApiError ? timeline.error.message : "Could not load timeline"}</Alert>
        ) : timeline.isLoading ? (
          <Card>
            <Spinner />
          </Card>
        ) : !days.length ? (
          <Card>
            <EmptyState message="No attendance in this range." />
          </Card>
        ) : (
          <Card className="p-0">
            <ul className="divide-y">
              {days.map((day) => {
                const dateKey = day.date.slice(0, 10);
                const absent = day.hours.filter((h) => h.status === "ABSENT").length;
                return (
                  <li key={dateKey}>
                    <button
                      onClick={() => setOpenDate(openDate === dateKey ? null : dateKey)}
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {new Date(dateKey).toLocaleDateString(undefined, {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                          })}
                        </p>
                        <p className="text-xs text-slate-500">
                          {day.hours.length} hours · {day.dayPct.toFixed(0)}%
                          {absent > 0 && ` · ${absent} absent`}
                        </p>
                      </div>
                      {/* Each hour is a coloured pip so a whole day reads at a glance. */}
                      <div className="flex shrink-0 gap-1">
                        {day.hours.map((h) => (
                          <span
                            key={h.hourNumber}
                            title={`H${h.hourNumber}: ${h.status}`}
                            className={cn("h-4 w-4 rounded-sm", STATUS_COLOR[h.status] ?? "bg-slate-300")}
                          />
                        ))}
                      </div>
                    </button>

                    {openDate === dateKey && openDay && (
                      <div className="border-t bg-slate-50 px-4 py-3">
                        {!openDay.hours.length ? (
                          <p className="text-sm text-slate-500">No classes scheduled.</p>
                        ) : (
                          <ul className="space-y-2">
                            {openDay.hours.map((h) => (
                              <li key={h.hourNumber} className="flex items-center justify-between text-sm">
                                <span className="truncate pr-2">
                                  <span className="text-slate-500">H{h.hourNumber}</span> · {h.subject}
                                </span>
                                <Badge tone={STATUS_TONE[h.status] ?? "slate"}>{h.status}</Badge>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        <Card>
          <CardTitle>Legend</CardTitle>
          <div className="mt-2 flex flex-wrap gap-3">
            {(Object.keys(STATUS_COLOR) as AttendanceStatus[]).map((s) => (
              <span key={s} className="flex items-center gap-1.5 text-xs text-slate-600">
                <span className={cn("h-3 w-3 rounded-sm", STATUS_COLOR[s])} />
                {s.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
