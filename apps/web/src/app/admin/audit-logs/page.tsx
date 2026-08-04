"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { PageHeader, Card, Button, Input, Select, Field, Spinner, EmptyState, Badge } from "@/components/ui";
import { auditApi } from "@/lib/api";
import { useSections, useSemesters, useToken } from "@/lib/hooks";

export default function AuditLogsPage() {
  const token = useToken();
  const { semesterId } = useSemesters();
  const sections = useSections(semesterId);
  const [filters, setFilters] = useState({ sectionId: "", dateFrom: "", dateTo: "" });
  const [applied, setApplied] = useState(filters);

  const logs = useQuery({
    queryKey: ["audit-logs", applied],
    queryFn: () =>
      auditApi.list(token!, {
        sectionId: applied.sectionId || undefined,
        dateFrom: applied.dateFrom || undefined,
        dateTo: applied.dateTo || undefined,
      }),
    enabled: !!token,
  });

  return (
    <AppShell>
      <PageHeader title="Audit logs" subtitle="Every attendance edit, with old and new status" />

      <div className="space-y-4">
        <Card>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Section">
              <Select value={filters.sectionId} onChange={(e) => setFilters({ ...filters, sectionId: e.target.value })}>
                <option value="">All sections</option>
                {sections.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    Section {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="From">
              <Input type="date" value={filters.dateFrom} onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} />
            </Field>
            <Field label="To">
              <Input type="date" value={filters.dateTo} onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} />
            </Field>
            <div className="flex items-end">
              <Button onClick={() => setApplied(filters)} className="w-full">
                Apply
              </Button>
            </div>
          </div>
        </Card>

        <Card className="p-0">
          {logs.isLoading ? (
            <Spinner />
          ) : !logs.data?.length ? (
            <EmptyState message="No edits recorded for this filter." />
          ) : (
            <ul className="divide-y">
              {logs.data.map((log) => (
                <li key={log.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone="slate">{log.oldStatus ?? "—"}</Badge>
                    <span className="text-slate-400">→</span>
                    <Badge tone="blue">{log.newStatus}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-slate-700">
                    {log.attendance?.student?.rollNo ?? "—"} {log.attendance?.student?.user?.name ?? ""}
                    {log.attendance?.subject?.name ? ` · ${log.attendance.subject.name}` : ""}
                    {log.attendance ? ` · hour ${log.attendance.hourNumber}` : ""}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {log.attendance?.date?.slice(0, 10) ?? ""} · by {log.changedByUser?.name ?? "unknown"} ·{" "}
                    {new Date(log.createdAt).toLocaleString()}
                  </p>
                  <p className="mt-1 text-xs italic text-slate-600">“{log.reason}”</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
