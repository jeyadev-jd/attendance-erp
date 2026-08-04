"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell, navFor } from "@/components/AppShell";
import { PageHeader, Card, CardTitle, Badge, Spinner, EmptyState } from "@/components/ui";
import { analyticsApi, notificationApi } from "@/lib/api";
import { useSemesters, useToken } from "@/lib/hooks";
import { useClaims, isAdminRole } from "@/store/authStore";
import { Select } from "@/components/ui";

export default function DashboardPage() {
  const router = useRouter();
  const claims = useClaims();
  const token = useToken();
  const { semesters, semesterId, setSemesterId } = useSemesters();

  // Students have their own dashboard; bounce them rather than showing admin widgets.
  useEffect(() => {
    if (claims && !isAdminRole(claims.role) && claims.role !== "FACULTY") {
      router.replace("/student/dashboard");
    }
  }, [claims, router]);

  const subjects = useQuery({
    queryKey: ["subject-comparison", semesterId],
    queryFn: () => analyticsApi.subjectComparison(token!, semesterId),
    enabled: !!token && !!semesterId,
  });

  const bunks = useQuery({
    queryKey: ["bunk-leaderboard", semesterId, 5],
    queryFn: () => analyticsApi.bunkLeaderboard(token!, semesterId, 5),
    enabled: !!token && !!semesterId,
  });

  const notifications = useQuery({
    queryKey: ["notifications", "recent"],
    queryFn: () => notificationApi.list(token!, { limit: 5 }),
    enabled: !!token,
  });

  const list = subjects.data ?? [];
  const overall = list.length
    ? list.reduce((sum, s) => sum + s.pct * s.total, 0) / Math.max(list.reduce((sum, s) => sum + s.total, 0), 1)
    : null;
  const belowThreshold = list.filter((s) => s.pct < 80);
  const quickLinks = navFor(claims?.role).filter((i) => i.href !== "/dashboard").slice(0, 6);

  return (
    <AppShell>
      <PageHeader
        title={`Welcome${claims ? "" : ""}`}
        subtitle="Overview of this semester's attendance"
        action={
          semesters.length > 1 ? (
            <Select value={semesterId} onChange={(e) => setSemesterId(e.target.value)} className="w-auto min-w-[10rem]">
              {semesters.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          ) : null
        }
      />

      {!semesterId ? (
        <Card>
          <EmptyState message="No semesters yet. Create one under Semesters to get started." />
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card>
              <p className="text-xs text-slate-500">Overall attendance</p>
              <p className="mt-1 text-2xl font-semibold">{overall === null ? "—" : `${overall.toFixed(1)}%`}</p>
            </Card>
            <Card>
              <p className="text-xs text-slate-500">Subjects tracked</p>
              <p className="mt-1 text-2xl font-semibold">{list.length}</p>
            </Card>
            <Card>
              <p className="text-xs text-slate-500">Below 80%</p>
              <p className="mt-1 text-2xl font-semibold text-red-600">{belowThreshold.length}</p>
            </Card>
            <Card>
              <p className="text-xs text-slate-500">Flagged bunkers</p>
              <p className="mt-1 text-2xl font-semibold">{bunks.data?.length ?? 0}</p>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardTitle>Subject attendance</CardTitle>
              {subjects.isLoading ? (
                <Spinner />
              ) : !list.length ? (
                <EmptyState message="No attendance recorded yet." />
              ) : (
                <ul className="mt-3 space-y-3">
                  {list.slice(0, 6).map((s) => (
                    <li key={s.subjectId}>
                      <div className="flex items-center justify-between text-sm">
                        <span className="truncate pr-2">{s.name}</span>
                        <span className="shrink-0 font-medium">{s.pct.toFixed(1)}%</span>
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
              <CardTitle>Recent alerts</CardTitle>
              {notifications.isLoading ? (
                <Spinner />
              ) : !notifications.data?.length ? (
                <EmptyState message="No notifications." />
              ) : (
                <ul className="mt-3 space-y-3">
                  {notifications.data.map((n) => (
                    <li key={n.id} className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{n.title}</p>
                        <p className="truncate text-xs text-slate-500">{n.message}</p>
                      </div>
                      {!n.isRead && <Badge tone="blue">New</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card>
            <CardTitle>Quick actions</CardTitle>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {quickLinks.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className="rounded-md border px-3 py-3 text-center text-sm text-slate-700 hover:bg-slate-50"
                >
                  {l.label}
                </Link>
              ))}
            </div>
          </Card>
        </div>
      )}
    </AppShell>
  );
}
