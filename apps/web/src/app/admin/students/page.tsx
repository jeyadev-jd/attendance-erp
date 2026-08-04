"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { PageHeader, Card, CardTitle, Button, Input, Select, Field, Alert, Spinner, EmptyState, Badge } from "@/components/ui";
import { studentApiAdmin, departmentApi, ApiError } from "@/lib/api";
import { useSections, useSemesters, useToken } from "@/lib/hooks";

export default function StudentsPage() {
  const token = useToken();
  const qc = useQueryClient();
  const { semesters, semesterId, setSemesterId } = useSemesters();
  const sections = useSections(semesterId);
  const [sectionId, setSectionId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{ ok: boolean; text: string; rows?: { row: number; message: string }[] } | null>(
    null
  );

  const [departmentId, setDepartmentId] = useState("");

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: () => departmentApi.list(token!),
    enabled: !!token,
  });

  const students = useQuery({
    queryKey: ["students", sectionId],
    queryFn: () => studentApiAdmin.list(token!, sectionId || undefined),
    enabled: !!token,
  });

  // The API filters by section only, so department narrowing happens client-side.
  const visibleStudents = (students.data ?? []).filter(
    (s) => !departmentId || s.section?.departmentId === departmentId
  );
  const sectionOptions = (sections.data ?? []).filter((s) => !departmentId || s.departmentId === departmentId);

  const [form, setForm] = useState({ rollNo: "", name: "", email: "" });
  const create = useMutation({
    mutationFn: () => studentApiAdmin.create(token!, { ...form, sectionId }),
    onSuccess: () => {
      setForm({ rollNo: "", name: "", email: "" });
      setError(null);
      qc.invalidateQueries({ queryKey: ["students"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not add student"),
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => studentApiAdmin.remove(token!, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["students"] }),
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not remove student"),
  });

  const importCsv = useMutation({
    mutationFn: (csv: string) => studentApiAdmin.importCsv(token!, semesterId, csv),
    onSuccess: (res) => {
      if (res.imported) {
        setImportResult({ ok: true, text: `Imported ${res.count} students.` });
        qc.invalidateQueries({ queryKey: ["students"] });
      } else {
        // Nothing was written — every row error is listed so they can be fixed and re-uploaded.
        setImportResult({ ok: false, text: `No rows imported — ${res.errors.length} of ${res.totalRows} rows failed.`, rows: res.errors });
      }
    },
    onError: (err) => setImportResult({ ok: false, text: err instanceof ApiError ? err.message : "Import failed" }),
  });

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportResult(null);
    importCsv.mutate(await file.text());
    e.target.value = "";
  }

  return (
    <AppShell>
      <PageHeader
        title="Students"
        subtitle="Enrollment and bulk import"
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
        <Card>
          <CardTitle>Bulk import (CSV)</CardTitle>
          <p className="mt-1 text-xs text-slate-500">
            Header: <code>rollNo,name,email,sectionName</code> — optional <code>departmentCode</code>. Nothing is saved
            unless every row is valid.
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={onFile}
            disabled={!semesterId || importCsv.isPending}
            className="mt-3 block w-full text-sm file:mr-3 file:min-h-[40px] file:rounded-md file:border-0 file:bg-slate-900 file:px-4 file:text-sm file:text-white"
          />
          {importCsv.isPending && <p className="mt-2 text-sm text-slate-500">Importing…</p>}
          {importResult && (
            <div className="mt-3 space-y-2">
              <Alert tone={importResult.ok ? "green" : "red"}>{importResult.text}</Alert>
              {importResult.rows && (
                <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2 text-xs text-slate-600">
                  {importResult.rows.map((r) => (
                    <li key={r.row}>
                      Row {r.row}: {r.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Card>

        <Card>
          <CardTitle>Add single student</CardTitle>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <Field label="Roll no">
              <Input value={form.rollNo} onChange={(e) => setForm({ ...form, rollNo: e.target.value })} />
            </Field>
            <Field label="Name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Email">
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Department">
              <Select
                value={departmentId}
                onChange={(e) => {
                  setDepartmentId(e.target.value);
                  setSectionId(""); // section list is department-scoped, so the old pick may no longer apply
                }}
              >
                <option value="">All departments</option>
                {departments.data?.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Section">
              <Select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
                <option value="">Select…</option>
                {sectionOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    Section {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {error && (
            <div className="mt-3">
              <Alert>{error}</Alert>
            </div>
          )}
          <Button
            onClick={() => create.mutate()}
            disabled={!form.rollNo || !form.name || !form.email || !sectionId || create.isPending}
            className="mt-3 w-full sm:w-auto"
          >
            Add student
          </Button>
        </Card>

        <Card className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <CardTitle>{sectionId ? "Section roster" : "All students"}</CardTitle>
            <Select value={sectionId} onChange={(e) => setSectionId(e.target.value)} className="w-auto min-w-[9rem]">
              <option value="">All sections</option>
              {sectionOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  Section {s.name}
                </option>
              ))}
            </Select>
          </div>
          {students.isLoading ? (
            <Spinner />
          ) : !visibleStudents.length ? (
            <EmptyState message="No students found." />
          ) : (
            <ul className="divide-y">
              {visibleStudents.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {s.rollNo} · {s.name}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      {s.section?.department?.name ?? "—"}
                      {s.section?.name ? ` · Section ${s.section.name}` : ""} · {s.user?.email}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {s.status !== "ACTIVE" && <Badge tone="slate">{s.status}</Badge>}
                    <button onClick={() => deactivate.mutate(s.id)} className="text-sm text-red-600">
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
