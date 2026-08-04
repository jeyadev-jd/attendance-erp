"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { AppShell } from "@/components/AppShell";
import {
  PageHeader,
  Card,
  CardTitle,
  Select,
  Spinner,
  EmptyState,
  Badge,
  cn,
  TableScroll,
  Button,
  Input,
  Field,
} from "@/components/ui";
import { analyticsApi, type DateRange } from "@/lib/api";
import { useSemesters, useSections, useToken, DAY_SHORT, toDateInput } from "@/lib/hooks";

const HOURS = [1, 2, 3, 4, 5, 6, 7, 8];
const WEEKDAYS = [1, 2, 3, 4, 5, 6];

/** Green → red scale; null (no classes that slot) renders as an empty cell. */
function heatColor(pct: number | null): string {
  if (pct === null) return "bg-slate-50 text-slate-300";
  if (pct >= 90) return "bg-emerald-600 text-white";
  if (pct >= 80) return "bg-emerald-400 text-white";
  if (pct >= 70) return "bg-amber-400 text-white";
  if (pct >= 60) return "bg-orange-500 text-white";
  return "bg-red-600 text-white";
}

export default function AdminAnalyticsPage() {
  const token = useToken();
  const { semesters, semesterId, setSemesterId } = useSemesters();
  const sections = useSections(semesterId);

  // `draft` is what the inputs show; `range` is what queries actually use, so typing
  // a half-finished date doesn't refetch on every keystroke.
  const [draft, setDraft] = useState({ dateFrom: "", dateTo: "" });
  const [range, setRange] = useState<DateRange>({});
  const enabled = !!token && !!semesterId;
  const rangeKey = `${range.dateFrom ?? ""}:${range.dateTo ?? ""}`;

  const [bunkerDate, setBunkerDate] = useState(toDateInput(new Date()));
  const [bunkerSectionId, setBunkerSectionId] = useState("");

  function applyPreset(days: number) {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400_000);
    const next = { dateFrom: toDateInput(from), dateTo: toDateInput(to) };
    setDraft(next);
    setRange(next);
  }

  function clearRange() {
    setDraft({ dateFrom: "", dateTo: "" });
    setRange({});
  }

  const heatmap = useQuery({
    queryKey: ["heatmap", semesterId, rangeKey],
    queryFn: () => analyticsApi.heatmap(token!, semesterId, range),
    enabled,
  });
  const subjects = useQuery({
    queryKey: ["subject-comparison", semesterId, rangeKey],
    queryFn: () => analyticsApi.subjectComparison(token!, semesterId, range),
    enabled,
  });
  const bunks = useQuery({
    queryKey: ["bunk-leaderboard", semesterId, 10, rangeKey],
    queryFn: () => analyticsApi.bunkLeaderboard(token!, semesterId, 10, range),
    enabled,
  });
  const late = useQuery({
    queryKey: ["late-analytics", semesterId, rangeKey],
    queryFn: () => analyticsApi.lateAnalytics(token!, semesterId, range),
    enabled,
  });
  const subjectReport = useQuery({
    queryKey: ["subject-report", semesterId, rangeKey],
    queryFn: () => analyticsApi.subjectReport(token!, semesterId, range),
    enabled,
  });
  const dailyBunkers = useQuery({
    queryKey: ["daily-bunkers", semesterId, bunkerDate, bunkerSectionId],
    queryFn: () => analyticsApi.dailyBunkers(token!, semesterId, bunkerDate, bunkerSectionId || undefined),
    enabled: !!token && !!semesterId && !!bunkerDate,
  });

  const cellMap = new Map((heatmap.data?.cells ?? []).map((c) => [`${c.dayOfWeek}-${c.hourNumber}`, c]));
  const subjectChart = (subjects.data ?? []).slice(0, 10).map((s) => ({
    label: s.name.length > 12 ? `${s.name.slice(0, 12)}…` : s.name,
    pct: Number(s.pct.toFixed(1)),
  }));

  return (
    <AppShell>
      <PageHeader
        title="Analytics"
        subtitle="Attendance patterns across the semester"
        action={
          <Select value={semesterId} onChange={(e) => setSemesterId(e.target.value)} className="w-auto min-w-[10rem]">
            {semesters.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        }
      />

      {!semesterId ? (
        <Card>
          <EmptyState message="No semester selected." />
        </Card>
      ) : (
        <div className="space-y-4">
          <Card>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="From">
                <Input
                  type="date"
                  value={draft.dateFrom}
                  onChange={(e) => setDraft({ ...draft, dateFrom: e.target.value })}
                />
              </Field>
              <Field label="To">
                <Input type="date" value={draft.dateTo} onChange={(e) => setDraft({ ...draft, dateTo: e.target.value })} />
              </Field>
              <div className="flex items-end gap-2">
                <Button onClick={() => setRange(draft)} className="flex-1">
                  Apply
                </Button>
                <Button variant="secondary" onClick={clearRange}>
                  Clear
                </Button>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <Button variant="secondary" onClick={() => applyPreset(7)} className="px-3 text-xs">
                  7 days
                </Button>
                <Button variant="secondary" onClick={() => applyPreset(30)} className="px-3 text-xs">
                  30 days
                </Button>
                <Button variant="secondary" onClick={() => applyPreset(90)} className="px-3 text-xs">
                  90 days
                </Button>
              </div>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {range.dateFrom || range.dateTo
                ? `Showing ${range.dateFrom || "semester start"} → ${range.dateTo || "today"}`
                : "Showing the whole semester"}
            </p>
          </Card>
          <Card>
            <CardTitle>Today's bunkers</CardTitle>
            <p className="mt-1 text-xs text-slate-500">
              Who was absent on a given date, and exactly which hours — the fastest way to catch a bunk.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Date">
                <Input type="date" value={bunkerDate} onChange={(e) => setBunkerDate(e.target.value)} />
              </Field>
              <Field label="Section">
                <Select value={bunkerSectionId} onChange={(e) => setBunkerSectionId(e.target.value)}>
                  <option value="">All sections</option>
                  {sections.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {dailyBunkers.isLoading ? (
              <Spinner />
            ) : !dailyBunkers.data?.length ? (
              <EmptyState message="Nobody absent that day — clean sheet." />
            ) : (
              <ul className="mt-3 divide-y">
                {dailyBunkers.data.map((s) => (
                  <li key={s.studentId} className="flex items-start justify-between gap-3 py-2 text-sm">
                    <span className="truncate pr-2">
                      {s.rollNo} · {s.name}
                    </span>
                    <div className="flex shrink-0 flex-wrap justify-end gap-1">
                      {s.absences.map((a) => (
                        <Badge key={a.hourNumber} tone="red">
                          H{a.hourNumber} {a.subject}
                        </Badge>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardTitle>Heatmap — day × hour</CardTitle>
            <p className="mt-1 text-xs text-slate-500">Attendance % by weekday and period.</p>
            {heatmap.isLoading ? (
              <Spinner />
            ) : (
              <TableScroll>
                <table className="mt-3 w-full min-w-[420px] border-separate border-spacing-1 text-center text-[11px]">
                  <thead>
                    <tr>
                      <th className="w-10" />
                      {HOURS.map((h) => (
                        <th key={h} className="font-medium text-slate-500">
                          H{h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {WEEKDAYS.map((day) => (
                      <tr key={day}>
                        <td className="text-right font-medium text-slate-500">{DAY_SHORT[day]}</td>
                        {HOURS.map((hour) => {
                          const cell = cellMap.get(`${day}-${hour}`);
                          const pct = cell && cell.total > 0 ? cell.pct : null;
                          return (
                            <td key={hour}>
                              <div
                                title={cell ? `${cell.pct.toFixed(1)}% of ${cell.total}` : "No classes"}
                                className={cn("flex h-9 items-center justify-center rounded", heatColor(pct))}
                              >
                                {pct === null ? "—" : pct.toFixed(0)}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Card>

          <Card>
            <CardTitle>Subject comparison</CardTitle>
            {subjects.isLoading ? (
              <Spinner />
            ) : !subjectChart.length ? (
              <EmptyState message="No attendance recorded yet." />
            ) : (
              <div className="mt-3 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={subjectChart} margin={{ top: 5, right: 5, left: -20, bottom: 40 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} angle={-35} textAnchor="end" interval={0} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => `${v}%`} />
                    <Bar dataKey="pct" fill="#0f172a" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardTitle>Bunk leaderboard</CardTitle>
              <p className="mt-1 text-xs text-slate-500">Detected mid-class bunk patterns, worst first.</p>
              {bunks.isLoading ? (
                <Spinner />
              ) : !bunks.data?.length ? (
                <EmptyState message="No bunk patterns detected." />
              ) : (
                <ul className="mt-3 divide-y">
                  {bunks.data.map((s) => (
                    <li key={s.studentId} className="flex items-center justify-between py-2 text-sm">
                      <span className="truncate pr-2">
                        {s.rollNo} · {s.name}
                      </span>
                      <Badge tone="red">{s.bunkFlagCount}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardTitle>Late analytics</CardTitle>
              {late.isLoading ? (
                <Spinner />
              ) : !late.data ? (
                <EmptyState message="No data." />
              ) : (
                <>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg bg-slate-50 p-2">
                      <p className="text-xs text-slate-500">Total late</p>
                      <p className="text-lg font-semibold">{late.data.totalLateMarks}</p>
                    </div>
                    <div className="rounded-lg bg-slate-50 p-2">
                      <p className="text-xs text-slate-500">Worst day</p>
                      <p className="text-lg font-semibold">
                        {late.data.mostLateDayOfWeek === null ? "—" : DAY_SHORT[late.data.mostLateDayOfWeek]}
                      </p>
                    </div>
                    <div className="rounded-lg bg-slate-50 p-2">
                      <p className="text-xs text-slate-500">Worst hour</p>
                      <p className="text-lg font-semibold">
                        {late.data.mostLateHour === null ? "—" : `H${late.data.mostLateHour}`}
                      </p>
                    </div>
                  </div>
                  {!!late.data.mostLateStudents.length && (
                    <ul className="mt-3 divide-y">
                      {late.data.mostLateStudents.map((s) => (
                        <li key={s.rollNo} className="flex items-center justify-between py-2 text-sm">
                          <span className="truncate pr-2">
                            {s.rollNo} · {s.name}
                          </span>
                          <Badge tone="amber">{s.count}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </Card>
          </div>

          <Card>
            <CardTitle>Subject report</CardTitle>
            <p className="mt-1 text-xs text-slate-500">
              Hours marked vs scheduled, per subject. Labs and theory papers are separate subjects, so they stay on
              separate rows even when the same faculty teaches both.
            </p>
            {subjectReport.isLoading ? (
              <Spinner />
            ) : !subjectReport.data?.length ? (
              <EmptyState message="No timetable set up for this semester." />
            ) : (
              <TableScroll>
                <table className="mt-3 w-full min-w-[640px] text-left text-sm">
                  <thead>
                    <tr className="border-b text-xs text-slate-500">
                      <th className="py-2 pr-3 font-medium">Subject</th>
                      <th className="py-2 pr-3 font-medium">Hrs/wk</th>
                      <th className="py-2 pr-3 font-medium">Marked</th>
                      <th className="py-2 pr-3 font-medium">Scheduled</th>
                      <th className="py-2 pr-3 font-medium">Coverage</th>
                      <th className="py-2 pr-3 font-medium">Attendance</th>
                      <th className="py-2 font-medium">Edits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subjectReport.data.map((s) => (
                      <tr key={s.subjectId} className="border-b last:border-0">
                        <td className="py-2 pr-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium">{s.name}</span>
                            {!s.countsForAttendance && <Badge tone="slate">Not counted</Badge>}
                          </div>
                          <p className="text-xs text-slate-500">
                            {s.code} · {s.faculty}
                          </p>
                        </td>
                        <td className="py-2 pr-3 text-slate-600">{s.weeklyHours}</td>
                        <td className="py-2 pr-3 text-slate-600">{s.markedHours}</td>
                        <td className="py-2 pr-3 text-slate-600">{s.scheduledHours}</td>
                        <td className="py-2 pr-3">
                          <Badge tone={s.coveragePct >= 90 ? "green" : s.coveragePct >= 70 ? "amber" : "red"}>
                            {s.coveragePct.toFixed(0)}%
                          </Badge>
                        </td>
                        <td className="py-2 pr-3">
                          {s.markedHours === 0 ? (
                            <span className="text-slate-400">—</span>
                          ) : (
                            <Badge tone={s.attendancePct >= 80 ? "green" : s.attendancePct >= 70 ? "amber" : "red"}>
                              {s.attendancePct.toFixed(0)}%
                            </Badge>
                          )}
                        </td>
                        <td className="py-2 text-slate-600">{s.corrections}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Card>
        </div>
      )}
    </AppShell>
  );
}
