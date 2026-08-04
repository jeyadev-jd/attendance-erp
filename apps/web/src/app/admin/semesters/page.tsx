"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { PageHeader, Card, CardTitle, Button, Input, Select, Field, Alert, Spinner, EmptyState, Badge } from "@/components/ui";
import { semesterApi, academicYearApi, ApiError, type Semester, type AcademicYear } from "@/lib/api";
import { useToken } from "@/lib/hooks";

const STATUS_TONE = { ACTIVE: "green", UPCOMING: "blue", ARCHIVED: "slate" } as const;
const STATUSES: Semester["status"][] = ["UPCOMING", "ACTIVE", "ARCHIVED"];

type YearDraft = { label: string; startDate: string; endDate: string };
type SemDraft = { name: string; startDate: string; endDate: string; minAttendancePct: number; status: Semester["status"] };

export default function SemestersPage() {
  const token = useToken();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cloneOf, setCloneOf] = useState<Semester | null>(null);
  const [cloneForm, setCloneForm] = useState({ name: "", startDate: "", endDate: "" });
  const [yearForm, setYearForm] = useState<YearDraft>({ label: "", startDate: "", endDate: "" });
  const [semForm, setSemForm] = useState({ academicYearId: "", name: "", startDate: "", endDate: "", minAttendancePct: 80 });

  // Inline edit state: only one row of each kind is open at a time.
  const [editYear, setEditYear] = useState<{ id: string; draft: YearDraft } | null>(null);
  const [editSem, setEditSem] = useState<{ id: string; draft: SemDraft } | null>(null);

  const years = useQuery({
    queryKey: ["academic-years"],
    queryFn: () => academicYearApi.list(token!),
    enabled: !!token,
  });
  const semesters = useQuery({
    queryKey: ["semesters"],
    queryFn: () => semesterApi.list(token!),
    enabled: !!token,
  });

  function onError(err: unknown) {
    setError(err instanceof ApiError ? err.message : "Request failed");
    setNotice(null);
  }
  function succeed(message: string, keys: string[]) {
    setError(null);
    setNotice(message);
    for (const k of keys) qc.invalidateQueries({ queryKey: [k] });
  }

  const createYear = useMutation({
    mutationFn: () => academicYearApi.create(token!, yearForm),
    onSuccess: (created) => {
      setYearForm({ label: "", startDate: "", endDate: "" });
      setSemForm((f) => ({ ...f, academicYearId: created.id }));
      succeed(`Academic year "${created.label}" created.`, ["academic-years"]);
    },
    onError,
  });

  const updateYear = useMutation({
    mutationFn: () => academicYearApi.update(token!, editYear!.id, editYear!.draft),
    onSuccess: (updated) => {
      setEditYear(null);
      succeed(`Academic year "${updated.label}" updated.`, ["academic-years"]);
    },
    onError,
  });

  const removeYear = useMutation({
    mutationFn: (id: string) => academicYearApi.remove(token!, id),
    onSuccess: () => succeed("Academic year deleted.", ["academic-years"]),
    onError,
  });

  const createSemester = useMutation({
    mutationFn: () => semesterApi.create(token!, semForm),
    onSuccess: (created) => {
      setSemForm({ academicYearId: created.academicYearId, name: "", startDate: "", endDate: "", minAttendancePct: 80 });
      succeed(`Semester "${created.name}" created — set it ACTIVE to start using it.`, ["semesters"]);
    },
    onError,
  });

  const updateSemester = useMutation({
    mutationFn: () => semesterApi.update(token!, editSem!.id, editSem!.draft),
    onSuccess: (updated) => {
      setEditSem(null);
      succeed(`Semester "${updated.name}" updated.`, ["semesters"]);
    },
    onError,
  });

  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: Semester["status"] }) => semesterApi.update(token!, v.id, { status: v.status }),
    onSuccess: (updated) => succeed(`"${updated.name}" is now ${updated.status}.`, ["semesters"]),
    onError,
  });

  const archive = useMutation({
    mutationFn: (id: string) => semesterApi.archive(token!, id),
    onSuccess: () => succeed("Semester archived — its data is now read-only.", ["semesters"]),
    onError,
  });

  const clone = useMutation({
    mutationFn: () => semesterApi.clone(token!, cloneOf!.id, cloneForm),
    onSuccess: (res) => {
      setCloneOf(null);
      setCloneForm({ name: "", startDate: "", endDate: "" });
      succeed(
        `Created "${res.semester.name}" — copied ${res.sectionsCopied} sections, ${res.hourConfigsCopied} hour configs, ${res.timetablesCopied} timetable entries.`,
        ["semesters"]
      );
    },
    onError,
  });

  const hasYears = !!years.data?.length;
  const hasActive = semesters.data?.some((s) => s.status === "ACTIVE");
  const yearLabel = (id: string) => years.data?.find((y) => y.id === id)?.label ?? "";

  function beginEditYear(y: AcademicYear) {
    setEditYear({
      id: y.id,
      draft: { label: y.label, startDate: y.startDate.slice(0, 10), endDate: y.endDate.slice(0, 10) },
    });
  }
  function beginEditSem(s: Semester) {
    setEditSem({
      id: s.id,
      draft: {
        name: s.name,
        startDate: s.startDate.slice(0, 10),
        endDate: s.endDate.slice(0, 10),
        minAttendancePct: s.minAttendancePct,
        status: s.status,
      },
    });
  }

  return (
    <AppShell>
      <PageHeader title="Semesters" subtitle="Academic years, semesters, and their lifecycle" />

      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {notice && <Alert tone="green">{notice}</Alert>}

        {/* Setup order matters: an academic year must exist before a semester,
            and an ACTIVE semester before sections/marking become usable. */}
        {!hasYears && !years.isLoading && (
          <Alert tone="amber">Start here: create an academic year, then a semester, then mark it ACTIVE.</Alert>
        )}
        {hasYears && !hasActive && !semesters.isLoading && (
          <Alert tone="amber">No ACTIVE semester — sections and attendance marking stay empty until you set one.</Alert>
        )}

        <Card>
          <CardTitle>New academic year</CardTitle>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Label">
              <Input
                value={yearForm.label}
                onChange={(e) => setYearForm({ ...yearForm, label: e.target.value })}
                placeholder="2025-2026"
              />
            </Field>
            <Field label="Start date">
              <Input type="date" value={yearForm.startDate} onChange={(e) => setYearForm({ ...yearForm, startDate: e.target.value })} />
            </Field>
            <Field label="End date">
              <Input type="date" value={yearForm.endDate} onChange={(e) => setYearForm({ ...yearForm, endDate: e.target.value })} />
            </Field>
          </div>
          <Button
            onClick={() => createYear.mutate()}
            disabled={!yearForm.label || !yearForm.startDate || !yearForm.endDate || createYear.isPending}
            className="mt-3 w-full sm:w-auto"
          >
            {createYear.isPending ? "Creating…" : "Create academic year"}
          </Button>
        </Card>

        <Card className="p-0">
          <div className="border-b px-4 py-3">
            <CardTitle>Academic years</CardTitle>
          </div>
          {years.isLoading ? (
            <Spinner />
          ) : !years.data?.length ? (
            <EmptyState message="No academic years yet." />
          ) : (
            <ul className="divide-y">
              {years.data.map((y) => (
                <li key={y.id} className="px-4 py-3">
                  {editYear?.id === y.id ? (
                    <div className="space-y-3">
                      <div className="grid gap-3 sm:grid-cols-3">
                        <Field label="Label">
                          <Input
                            value={editYear.draft.label}
                            onChange={(e) => setEditYear({ ...editYear, draft: { ...editYear.draft, label: e.target.value } })}
                          />
                        </Field>
                        <Field label="Start date">
                          <Input
                            type="date"
                            value={editYear.draft.startDate}
                            onChange={(e) => setEditYear({ ...editYear, draft: { ...editYear.draft, startDate: e.target.value } })}
                          />
                        </Field>
                        <Field label="End date">
                          <Input
                            type="date"
                            value={editYear.draft.endDate}
                            onChange={(e) => setEditYear({ ...editYear, draft: { ...editYear.draft, endDate: e.target.value } })}
                          />
                        </Field>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button onClick={() => updateYear.mutate()} disabled={updateYear.isPending}>
                          {updateYear.isPending ? "Saving…" : "Save"}
                        </Button>
                        <Button variant="secondary" onClick={() => setEditYear(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{y.label}</p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {y.startDate.slice(0, 10)} → {y.endDate.slice(0, 10)}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-3">
                        <button onClick={() => beginEditYear(y)} className="text-sm text-slate-700">
                          Edit
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`Delete academic year "${y.label}"?`)) removeYear.mutate(y.id);
                          }}
                          className="text-sm text-red-600"
                        >
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

        <Card>
          <CardTitle>New semester</CardTitle>
          {!hasYears ? (
            <EmptyState message="Create an academic year first." />
          ) : (
            <>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <Field label="Academic year">
                  <Select
                    value={semForm.academicYearId}
                    onChange={(e) => setSemForm({ ...semForm, academicYearId: e.target.value })}
                  >
                    <option value="">Select…</option>
                    {years.data?.map((y) => (
                      <option key={y.id} value={y.id}>
                        {y.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Name">
                  <Input
                    value={semForm.name}
                    onChange={(e) => setSemForm({ ...semForm, name: e.target.value })}
                    placeholder="Semester 1"
                  />
                </Field>
                <Field label="Start date">
                  <Input type="date" value={semForm.startDate} onChange={(e) => setSemForm({ ...semForm, startDate: e.target.value })} />
                </Field>
                <Field label="End date">
                  <Input type="date" value={semForm.endDate} onChange={(e) => setSemForm({ ...semForm, endDate: e.target.value })} />
                </Field>
                <Field label="Min attendance %">
                  <Input
                    type="number"
                    value={semForm.minAttendancePct}
                    onChange={(e) => setSemForm({ ...semForm, minAttendancePct: Number(e.target.value) })}
                  />
                </Field>
              </div>
              <Button
                onClick={() => createSemester.mutate()}
                disabled={
                  !semForm.academicYearId || !semForm.name || !semForm.startDate || !semForm.endDate || createSemester.isPending
                }
                className="mt-3 w-full sm:w-auto"
              >
                {createSemester.isPending ? "Creating…" : "Create semester"}
              </Button>
            </>
          )}
        </Card>

        {cloneOf && (
          <Card>
            <CardTitle>Clone “{cloneOf.name}”</CardTitle>
            <p className="mt-1 text-xs text-slate-500">
              Copies sections, hour configs and timetable. Calendar, attendance and enrollment start clean.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field label="New semester name">
                <Input value={cloneForm.name} onChange={(e) => setCloneForm({ ...cloneForm, name: e.target.value })} />
              </Field>
              <Field label="Start date">
                <Input type="date" value={cloneForm.startDate} onChange={(e) => setCloneForm({ ...cloneForm, startDate: e.target.value })} />
              </Field>
              <Field label="End date">
                <Input type="date" value={cloneForm.endDate} onChange={(e) => setCloneForm({ ...cloneForm, endDate: e.target.value })} />
              </Field>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                onClick={() => clone.mutate()}
                disabled={!cloneForm.name || !cloneForm.startDate || !cloneForm.endDate || clone.isPending}
              >
                {clone.isPending ? "Cloning…" : "Create clone"}
              </Button>
              <Button variant="secondary" onClick={() => setCloneOf(null)}>
                Cancel
              </Button>
            </div>
          </Card>
        )}

        <Card className="p-0">
          <div className="border-b px-4 py-3">
            <CardTitle>All semesters</CardTitle>
          </div>
          {semesters.isLoading ? (
            <Spinner />
          ) : !semesters.data?.length ? (
            <EmptyState message="No semesters yet." />
          ) : (
            <ul className="divide-y">
              {semesters.data.map((s) => (
                <li key={s.id} className="px-4 py-3">
                  {editSem?.id === s.id ? (
                    <div className="space-y-3">
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                        <Field label="Name">
                          <Input
                            value={editSem.draft.name}
                            onChange={(e) => setEditSem({ ...editSem, draft: { ...editSem.draft, name: e.target.value } })}
                          />
                        </Field>
                        <Field label="Start date">
                          <Input
                            type="date"
                            value={editSem.draft.startDate}
                            onChange={(e) => setEditSem({ ...editSem, draft: { ...editSem.draft, startDate: e.target.value } })}
                          />
                        </Field>
                        <Field label="End date">
                          <Input
                            type="date"
                            value={editSem.draft.endDate}
                            onChange={(e) => setEditSem({ ...editSem, draft: { ...editSem.draft, endDate: e.target.value } })}
                          />
                        </Field>
                        <Field label="Min attendance %">
                          <Input
                            type="number"
                            value={editSem.draft.minAttendancePct}
                            onChange={(e) =>
                              setEditSem({ ...editSem, draft: { ...editSem.draft, minAttendancePct: Number(e.target.value) } })
                            }
                          />
                        </Field>
                        <Field label="Status">
                          <Select
                            value={editSem.draft.status}
                            onChange={(e) =>
                              setEditSem({ ...editSem, draft: { ...editSem.draft, status: e.target.value as Semester["status"] } })
                            }
                          >
                            {STATUSES.map((st) => (
                              <option key={st} value={st}>
                                {st}
                              </option>
                            ))}
                          </Select>
                        </Field>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button onClick={() => updateSemester.mutate()} disabled={updateSemester.isPending}>
                          {updateSemester.isPending ? "Saving…" : "Save"}
                        </Button>
                        <Button variant="secondary" onClick={() => setEditSem(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium">{s.name}</p>
                          <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
                        </div>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {yearLabel(s.academicYearId) && `${yearLabel(s.academicYearId)} · `}
                          {s.startDate.slice(0, 10)} → {s.endDate.slice(0, 10)} · min {s.minAttendancePct}%
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-3">
                        <button onClick={() => beginEditSem(s)} className="text-sm text-slate-700">
                          Edit
                        </button>
                        {s.status !== "ACTIVE" && s.status !== "ARCHIVED" && (
                          <button onClick={() => setStatus.mutate({ id: s.id, status: "ACTIVE" })} className="text-sm text-emerald-700">
                            Set active
                          </button>
                        )}
                        <button
                          onClick={() => {
                            setCloneOf(s);
                            setCloneForm({ name: "", startDate: "", endDate: "" });
                          }}
                          className="text-sm text-slate-700"
                        >
                          Clone
                        </button>
                        {s.status !== "ARCHIVED" && (
                          <button
                            onClick={() => {
                              if (confirm(`Archive "${s.name}"? Its data becomes read-only.`)) archive.mutate(s.id);
                            }}
                            className="text-sm text-red-600"
                          >
                            Archive
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
