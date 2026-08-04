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
  const [done, setDone] = useState<{ filename: string; rowCount: number } | null>(null);

  // One step: the export request returns the file itself, so it saves immediately.
  const generate = useMutation({
    mutationFn: async () => {
      const res = await reportApi.export(token!, {
        semesterId,
        sectionId: filters.sectionId || undefined,
        format: filters.format,
        dateFrom: filters.dateFrom || undefined,
        dateTo: filters.dateTo || undefined,
      });
      saveBlob(res.blob, res.filename);
      return res;
    },
    onSuccess: (res) => {
      setError(null);
      setDone({ filename: res.filename, rowCount: res.rowCount });
    },
    onError: (err) => {
      setDone(null);
      setError(err instanceof ApiError ? err.message : "Could not generate report");
    },
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
            {generate.isPending ? "Generating…" : "Download report"}
          </Button>
        </Card>

        {done && (
          <Card>
            <CardTitle>Downloaded</CardTitle>
            <p className="mt-1 text-sm text-slate-500">
              <Badge tone="green">{done.rowCount} rows</Badge>
              <span className="ml-2 break-all text-xs">{done.filename}</span>
            </p>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
