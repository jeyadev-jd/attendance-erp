"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { PageHeader, Card, CardTitle, Button, Input, Select, Field, Alert, Badge } from "@/components/ui";
import { reportApi, saveBlob, ApiError } from "@/lib/api";
import { useSections, useSemesters, useToken } from "@/lib/hooks";

export default function ReportsPage() {
  const token = useToken();
  const { semesters, semesterId, setSemesterId } = useSemesters();
  const sections = useSections(semesterId);
  const [filters, setFilters] = useState({ sectionId: "", format: "xlsx" as "csv" | "xlsx", dateFrom: "", dateTo: "" });
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState<{ key: string; rowCount: number } | null>(null);

  const generate = useMutation({
    mutationFn: () =>
      reportApi.export(token!, {
        semesterId,
        sectionId: filters.sectionId || undefined,
        format: filters.format,
        dateFrom: filters.dateFrom || undefined,
        dateTo: filters.dateTo || undefined,
      }),
    onSuccess: (res) => {
      setError(null);
      setReady({ key: res.key, rowCount: res.rowCount });
    },
    onError: (err) => {
      setReady(null);
      setError(err instanceof ApiError ? err.message : "Could not generate report");
    },
  });

  const download = useMutation({
    mutationFn: async () => {
      const blob = await reportApi.download(token!, ready!.key);
      saveBlob(blob, ready!.key.split("/").pop() ?? "report");
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Download failed"),
  });

  return (
    <AppShell>
      <PageHeader
        title="Reports"
        subtitle="Export attendance data to Excel or CSV"
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

      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}

        <Card>
          <CardTitle>Filters</CardTitle>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
            <Field label="Format">
              <Select
                value={filters.format}
                onChange={(e) => setFilters({ ...filters, format: e.target.value as "csv" | "xlsx" })}
              >
                <option value="xlsx">Excel (.xlsx)</option>
                <option value="csv">CSV</option>
              </Select>
            </Field>
            <Field label="From">
              <Input type="date" value={filters.dateFrom} onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} />
            </Field>
            <Field label="To">
              <Input type="date" value={filters.dateTo} onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} />
            </Field>
          </div>
          <Button
            onClick={() => generate.mutate()}
            disabled={!semesterId || generate.isPending}
            className="mt-4 w-full sm:w-auto"
          >
            {generate.isPending ? "Generating…" : "Generate report"}
          </Button>
        </Card>

        {ready && (
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>Report ready</CardTitle>
                <p className="mt-1 text-sm text-slate-500">
                  <Badge tone="green">{ready.rowCount} rows</Badge>
                  <span className="ml-2 break-all text-xs">{ready.key.split("/").pop()}</span>
                </p>
              </div>
              <Button onClick={() => download.mutate()} disabled={download.isPending}>
                {download.isPending ? "Downloading…" : "Download"}
              </Button>
            </div>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
