"use client";

import { useQuery } from "@tanstack/react-query";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { AppShell } from "@/components/AppShell";
import { PageHeader, Card, CardTitle, Alert, Spinner, EmptyState } from "@/components/ui";
import { studentApi, ApiError } from "@/lib/api";
import { useToken, DAY_SHORT } from "@/lib/hooks";

export default function StudentAnalyticsPage() {
  const token = useToken();
  const { data, isLoading, error } = useQuery({
    queryKey: ["student-analytics"],
    queryFn: () => studentApi.analytics(token!),
    enabled: !!token,
  });

  const dayData = (data?.dayWise ?? [])
    .slice()
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
    .map((d) => ({ label: DAY_SHORT[d.dayOfWeek], pct: Number(d.pct.toFixed(1)) }));

  const hourData = (data?.hourWise ?? [])
    .slice()
    .sort((a, b) => a.hourNumber - b.hourNumber)
    .map((h) => ({ label: `H${h.hourNumber}`, pct: Number(h.pct.toFixed(1)) }));

  const trendData = (data?.trend ?? []).map((t) => ({ label: t.week.split("-W")[1] ?? t.week, pct: Number(t.pct.toFixed(1)) }));

  return (
    <AppShell>
      <PageHeader title="My analytics" subtitle="Patterns in your attendance" />

      {error ? (
        <Alert>{error instanceof ApiError ? error.message : "Could not load analytics"}</Alert>
      ) : isLoading || !data ? (
        <Card>
          <Spinner />
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card>
              <p className="text-xs text-slate-500">Current streak</p>
              <p className="mt-1 text-2xl font-semibold">{data.streaks.current}</p>
            </Card>
            <Card>
              <p className="text-xs text-slate-500">Longest streak</p>
              <p className="mt-1 text-2xl font-semibold">{data.streaks.longest}</p>
            </Card>
            <Card>
              <p className="text-xs text-slate-500">Times late</p>
              <p className="mt-1 text-2xl font-semibold">{data.lateStats.totalLate}</p>
            </Card>
            <Card>
              <p className="text-xs text-slate-500">Most late on</p>
              <p className="mt-1 text-2xl font-semibold">
                {data.lateStats.mostLateDayOfWeek === null ? "—" : DAY_SHORT[data.lateStats.mostLateDayOfWeek]}
              </p>
            </Card>
          </div>

          <Card>
            <CardTitle>Weekly trend</CardTitle>
            {!trendData.length ? (
              <EmptyState message="Not enough data yet." />
            ) : (
              <div className="mt-3 h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trendData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => `${v}%`} labelFormatter={(l) => `Week ${l}`} />
                    <Line type="monotone" dataKey="pct" stroke="#0f172a" strokeWidth={2} dot={{ r: 2 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardTitle>By day of week</CardTitle>
              {!dayData.length ? (
                <EmptyState message="No data." />
              ) : (
                <div className="mt-3 h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dayData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                      <Tooltip formatter={(v) => `${v}%`} />
                      <Bar dataKey="pct" fill="#0f172a" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>

            <Card>
              <CardTitle>By hour</CardTitle>
              {!hourData.length ? (
                <EmptyState message="No data." />
              ) : (
                <div className="mt-3 h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={hourData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                      <Tooltip formatter={(v) => `${v}%`} />
                      <Bar dataKey="pct" fill="#475569" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </AppShell>
  );
}
