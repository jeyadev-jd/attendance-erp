"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { PageHeader, Card, CardTitle, Button, Input, Select, Field, Alert, Spinner, EmptyState, Badge } from "@/components/ui";
import { departmentApi, sectionApi, subjectApi, ApiError } from "@/lib/api";
import { useSemesters, useToken } from "@/lib/hooks";

type Tab = "departments" | "sections" | "subjects";

export default function StructurePage() {
  const token = useToken();
  const qc = useQueryClient();
  const { semesters, semesterId, setSemesterId } = useSemesters();
  const [tab, setTab] = useState<Tab>("departments");
  const [error, setError] = useState<string | null>(null);

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: () => departmentApi.list(token!),
    enabled: !!token,
  });
  const sections = useQuery({
    queryKey: ["sections", semesterId],
    queryFn: () => sectionApi.list(token!, semesterId),
    enabled: !!token && !!semesterId,
  });
  // Subjects hang off a department, not a semester — no semester needed to load them.
  const subjects = useQuery({
    queryKey: ["subjects"],
    queryFn: () => subjectApi.list(token!),
    enabled: !!token,
  });

  function onError(err: unknown) {
    setError(err instanceof ApiError ? err.message : "Request failed");
  }

  // Inline edit drafts — one open row per entity type at a time.
  const [editDept, setEditDept] = useState<{ id: string; name: string; code: string } | null>(null);
  const [editSection, setEditSection] = useState<{ id: string; name: string; departmentId: string } | null>(null);
  const [editSubject, setEditSubject] = useState<{
    id: string;
    code: string;
    name: string;
    totalHours: number;
    departmentId: string;
  } | null>(null);

  const [deptForm, setDeptForm] = useState({ name: "", code: "" });
  const createDept = useMutation({
    mutationFn: () => departmentApi.create(token!, deptForm),
    onSuccess: () => {
      setDeptForm({ name: "", code: "" });
      setError(null);
      qc.invalidateQueries({ queryKey: ["departments"] });
    },
    onError,
  });
  const updateDept = useMutation({
    mutationFn: () => departmentApi.update(token!, editDept!.id, { name: editDept!.name, code: editDept!.code }),
    onSuccess: () => {
      setEditDept(null);
      setError(null);
      qc.invalidateQueries({ queryKey: ["departments"] });
    },
    onError,
  });
  const removeDept = useMutation({
    mutationFn: (id: string) => departmentApi.remove(token!, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["departments"] }),
    onError,
  });

  const [sectionForm, setSectionForm] = useState({ name: "", departmentId: "" });
  const createSection = useMutation({
    mutationFn: () => sectionApi.create(token!, { ...sectionForm, semesterId }),
    onSuccess: () => {
      setSectionForm({ name: "", departmentId: "" });
      setError(null);
      qc.invalidateQueries({ queryKey: ["sections"] });
    },
    onError,
  });
  const updateSection = useMutation({
    mutationFn: () =>
      sectionApi.update(token!, editSection!.id, { name: editSection!.name, departmentId: editSection!.departmentId }),
    onSuccess: () => {
      setEditSection(null);
      setError(null);
      qc.invalidateQueries({ queryKey: ["sections"] });
    },
    onError,
  });
  const removeSection = useMutation({
    mutationFn: (id: string) => sectionApi.remove(token!, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sections"] }),
    onError,
  });

  const [subjectForm, setSubjectForm] = useState({
    code: "",
    name: "",
    totalHours: 60,
    departmentId: "",
    countsForAttendance: true,
  });
  const createSubject = useMutation({
    mutationFn: () => subjectApi.create(token!, subjectForm),
    onSuccess: () => {
      setSubjectForm({ code: "", name: "", totalHours: 60, departmentId: "", countsForAttendance: true });
      setError(null);
      qc.invalidateQueries({ queryKey: ["subjects"] });
    },
    onError,
  });
  const updateSubject = useMutation({
    mutationFn: () =>
      subjectApi.update(token!, editSubject!.id, {
        code: editSubject!.code,
        name: editSubject!.name,
        totalHours: editSubject!.totalHours,
        departmentId: editSubject!.departmentId,
      }),
    onSuccess: () => {
      setEditSubject(null);
      setError(null);
      qc.invalidateQueries({ queryKey: ["subjects"] });
    },
    onError,
  });
  const removeSubject = useMutation({
    mutationFn: (id: string) => subjectApi.remove(token!, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["subjects"] }),
    onError,
  });

  const tabs: { key: Tab; label: string }[] = [
    { key: "departments", label: "Departments" },
    { key: "sections", label: "Sections" },
    { key: "subjects", label: "Subjects" },
  ];

  return (
    <AppShell>
      <PageHeader
        title="Structure"
        subtitle="Departments, sections and subjects"
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

      <div className="mb-4 flex gap-2 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`min-h-[40px] shrink-0 rounded-full px-4 text-sm ${
              tab === t.key ? "bg-slate-900 text-white" : "border bg-white text-slate-600"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}

      {/* Sections need a semester; subjects only need a department. Say so rather than silently disabling the form. */}
      {!semesterId && tab === "sections" && (
        <div className="mb-3">
          <Alert tone="amber">
            No semester yet. Create an academic year and semester under <strong>Semesters</strong> first.
          </Alert>
        </div>
      )}
      {tab !== "departments" && !departments.data?.length && (
        <div className="mb-3">
          <Alert tone="amber">Add a department first — sections and subjects both belong to one.</Alert>
        </div>
      )}

      {tab === "departments" && (
        <div className="space-y-4">
          <Card>
            <CardTitle>Add department</CardTitle>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field label="Name">
                <Input value={deptForm.name} onChange={(e) => setDeptForm({ ...deptForm, name: e.target.value })} />
              </Field>
              <Field label="Code">
                <Input value={deptForm.code} onChange={(e) => setDeptForm({ ...deptForm, code: e.target.value })} />
              </Field>
              <div className="flex items-end">
                <Button
                  onClick={() => createDept.mutate()}
                  disabled={!deptForm.name || !deptForm.code || createDept.isPending}
                  className="w-full"
                >
                  Add
                </Button>
              </div>
            </div>
          </Card>

          <Card className="p-0">
            {departments.isLoading ? (
              <Spinner />
            ) : !departments.data?.length ? (
              <EmptyState message="No departments yet." />
            ) : (
              <ul className="divide-y">
                {departments.data.map((d) => (
                  <li key={d.id} className="px-4 py-3">
                    {editDept?.id === d.id ? (
                      <div className="space-y-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Field label="Name">
                            <Input value={editDept.name} onChange={(e) => setEditDept({ ...editDept, name: e.target.value })} />
                          </Field>
                          <Field label="Code">
                            <Input value={editDept.code} onChange={(e) => setEditDept({ ...editDept, code: e.target.value })} />
                          </Field>
                        </div>
                        <div className="flex gap-2">
                          <Button onClick={() => updateDept.mutate()} disabled={updateDept.isPending}>
                            {updateDept.isPending ? "Saving…" : "Save"}
                          </Button>
                          <Button variant="secondary" onClick={() => setEditDept(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{d.name}</p>
                          <p className="text-xs text-slate-500">{d.code}</p>
                        </div>
                        <div className="flex shrink-0 gap-3">
                          <button
                            onClick={() => setEditDept({ id: d.id, name: d.name, code: d.code })}
                            className="text-sm text-slate-700"
                          >
                            Edit
                          </button>
                          <button onClick={() => removeDept.mutate(d.id)} className="text-sm text-red-600">
                            Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {tab === "sections" && (
        <div className="space-y-4">
          <Card>
            <CardTitle>Add section</CardTitle>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field label="Name">
                <Input
                  value={sectionForm.name}
                  onChange={(e) => setSectionForm({ ...sectionForm, name: e.target.value })}
                  placeholder="A"
                />
              </Field>
              <Field label="Department">
                <Select
                  value={sectionForm.departmentId}
                  onChange={(e) => setSectionForm({ ...sectionForm, departmentId: e.target.value })}
                >
                  <option value="">Select…</option>
                  {departments.data?.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-end">
                <Button
                  onClick={() => createSection.mutate()}
                  disabled={!sectionForm.name || !sectionForm.departmentId || !semesterId || createSection.isPending}
                  className="w-full"
                >
                  Add
                </Button>
              </div>
            </div>
          </Card>

          <Card className="p-0">
            {sections.isLoading ? (
              <Spinner />
            ) : !sections.data?.length ? (
              <EmptyState message="No sections in this semester." />
            ) : (
              <ul className="divide-y">
                {sections.data.map((s) => (
                  <li key={s.id} className="px-4 py-3">
                    {editSection?.id === s.id ? (
                      <div className="space-y-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Field label="Name">
                            <Input
                              value={editSection.name}
                              onChange={(e) => setEditSection({ ...editSection, name: e.target.value })}
                            />
                          </Field>
                          <Field label="Department">
                            <Select
                              value={editSection.departmentId}
                              onChange={(e) => setEditSection({ ...editSection, departmentId: e.target.value })}
                            >
                              {departments.data?.map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.name}
                                </option>
                              ))}
                            </Select>
                          </Field>
                        </div>
                        <div className="flex gap-2">
                          <Button onClick={() => updateSection.mutate()} disabled={updateSection.isPending}>
                            {updateSection.isPending ? "Saving…" : "Save"}
                          </Button>
                          <Button variant="secondary" onClick={() => setEditSection(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">Section {s.name}</p>
                          <p className="text-xs text-slate-500">
                            {departments.data?.find((d) => d.id === s.departmentId)?.name ?? ""}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-3">
                          <button
                            onClick={() => setEditSection({ id: s.id, name: s.name, departmentId: s.departmentId })}
                            className="text-sm text-slate-700"
                          >
                            Edit
                          </button>
                          <button onClick={() => removeSection.mutate(s.id)} className="text-sm text-red-600">
                            Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {tab === "subjects" && (
        <div className="space-y-4">
          <Card>
            <CardTitle>Add subject</CardTitle>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Field label="Code">
                <Input value={subjectForm.code} onChange={(e) => setSubjectForm({ ...subjectForm, code: e.target.value })} />
              </Field>
              <Field label="Name">
                <Input value={subjectForm.name} onChange={(e) => setSubjectForm({ ...subjectForm, name: e.target.value })} />
              </Field>
              <Field label="Department">
                <Select
                  value={subjectForm.departmentId}
                  onChange={(e) => setSubjectForm({ ...subjectForm, departmentId: e.target.value })}
                >
                  <option value="">Select…</option>
                  {departments.data?.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Total hours">
                <Input
                  type="number"
                  value={subjectForm.totalHours}
                  onChange={(e) => setSubjectForm({ ...subjectForm, totalHours: Number(e.target.value) })}
                />
              </Field>
              <div className="flex items-end">
                <Button
                  onClick={() => createSubject.mutate()}
                  disabled={!subjectForm.code || !subjectForm.name || !subjectForm.departmentId || createSubject.isPending}
                  className="w-full"
                >
                  Add
                </Button>
              </div>
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={subjectForm.countsForAttendance}
                onChange={(e) => setSubjectForm({ ...subjectForm, countsForAttendance: e.target.checked })}
                className="h-4 w-4"
              />
              Counts toward attendance percentage
              <span className="text-xs text-slate-500">
                (uncheck for mentor-mentee, club activity — attendance is still marked)
              </span>
            </label>
          </Card>

          <Card className="p-0">
            {subjects.isLoading ? (
              <Spinner />
            ) : !subjects.data?.length ? (
              <EmptyState message="No subjects yet." />
            ) : (
              <ul className="divide-y">
                {subjects.data.map((s) => (
                  <li key={s.id} className="px-4 py-3">
                    {editSubject?.id === s.id ? (
                      <div className="space-y-3">
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          <Field label="Code">
                            <Input value={editSubject.code} onChange={(e) => setEditSubject({ ...editSubject, code: e.target.value })} />
                          </Field>
                          <Field label="Name">
                            <Input value={editSubject.name} onChange={(e) => setEditSubject({ ...editSubject, name: e.target.value })} />
                          </Field>
                          <Field label="Department">
                            <Select
                              value={editSubject.departmentId}
                              onChange={(e) => setEditSubject({ ...editSubject, departmentId: e.target.value })}
                            >
                              {departments.data?.map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.name}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          <Field label="Total hours">
                            <Input
                              type="number"
                              value={editSubject.totalHours}
                              onChange={(e) => setEditSubject({ ...editSubject, totalHours: Number(e.target.value) })}
                            />
                          </Field>
                        </div>
                        <div className="flex gap-2">
                          <Button onClick={() => updateSubject.mutate()} disabled={updateSubject.isPending}>
                            {updateSubject.isPending ? "Saving…" : "Save"}
                          </Button>
                          <Button variant="secondary" onClick={() => setEditSubject(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-medium">{s.name}</p>
                            {!s.countsForAttendance && <Badge tone="slate">Not counted</Badge>}
                          </div>
                          <p className="text-xs text-slate-500">
                            {s.code} · {departments.data?.find((d) => d.id === s.departmentId)?.name ?? "—"} · {s.totalHours} hrs
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-3">
                          <button
                            onClick={() =>
                              setEditSubject({
                                id: s.id,
                                code: s.code,
                                name: s.name,
                                totalHours: s.totalHours,
                                departmentId: s.departmentId,
                              })
                            }
                            className="text-sm text-slate-700"
                          >
                            Edit
                          </button>
                          <button onClick={() => removeSubject.mutate(s.id)} className="text-sm text-red-600">
                            Delete
                          </button>
                        </div>
                      </div>
                    )}
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
